import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { NotFoundException } from '@nestjs/common';

// See comment-resolution.service.spec.ts: the gateway's module drags in lib0 ESM, which jest cannot parse.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

import { CommentRepo } from '@docmost/db/repos/comment/comment.repo';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
} from '../../service-bridge/read-model-pg.testkit';
import { CommentResolutionService } from './comment-resolution.service';

/**
 * Real-Postgres proof of the comment-resolution write (#615). The unit spec pins the compare-and-set through a
 * Kysely spy, which cannot tell whether the guard actually serializes two requests — so here two resolves race
 * on real rows with both reads forced to happen before either write, and exactly one of them may report the
 * transition (one audit event, one notification). Also proves reopen clears both columns and that the upstream
 * `CommentRepo` re-read returns the joined creator / resolvedBy the socket event and the relay rely on.
 *
 * The upstream `CommentRepo` is the real one; the page lookup, the permission check, the collab gateway, the
 * socket, the queue and the audit sink are stubs. Lives in the `docmost-authz-pg` CI lane, which collects
 * `src/(service-bridge|authz)/**.pg.spec.ts`; self-skips without AUTHZ_TEST_PG_URL.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG comment resolution', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'comment_resolution_pg_spec';
const WS = uuid(100);
const SPACE = uuid(1);
const PAGE = uuid(200);
const COMMENT = uuid(300);
const AUTHOR = uuid(10);
const ALICE = uuid(11);
const BOB = uuid(12);

d('CommentResolutionService on real Postgres (#615)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let audit: jest.Mock;
  let notify: jest.Mock;
  let ws: jest.Mock;
  /** When set, every comment read waits on it — used to hold both racers between their read and their write. */
  let gate: Promise<void> | null;
  let reads: number;

  const page = { id: PAGE, spaceId: SPACE, workspaceId: WS, deletedAt: null };
  const workspace = { id: WS } as any;
  const who = (id: string) => ({ id }) as any;
  const row = async () =>
    (
      await pg<{ resolvedAt: Date | null; resolvedById: string | null }[]>`
        select resolved_at as "resolvedAt", resolved_by_id as "resolvedById" from comments where id = ${COMMENT}`
    )[0];

  const service = () => {
    const realRepo = new CommentRepo(db as any);
    const commentRepo = {
      findById: async (id: string, opts?: any) => {
        const found = await realRepo.findById(id, opts);
        reads += 1;
        if (gate) await gate;
        return found;
      },
    };
    return new CommentResolutionService(
      db as any,
      { findById: async () => page } as any,
      commentRepo as any,
      { validateCanComment: async () => undefined } as any,
      { handleYjsEvent: async () => undefined } as any,
      { emitCommentEvent: ws } as any,
      { add: notify } as any,
      { log: audit } as any,
    );
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 2);
    appPg = mkReadModelPg(SCHEMA, 4);
    await pg`create table users (id uuid primary key, name varchar, avatar_url varchar)`;
    await pg`
      create table comments (
        id uuid primary key, content jsonb, selection varchar, type varchar, creator_id uuid,
        page_id uuid not null, parent_comment_id uuid, resolved_by_id uuid, resolved_at timestamptz,
        space_id uuid not null, workspace_id uuid not null, last_edited_by_id uuid,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        edited_at timestamptz, deleted_at timestamptz
      )`;
    await pg`insert into users (id, name) values (${AUTHOR}, 'Author'), (${ALICE}, 'Alice'), (${BOB}, 'Bob')`;
    db = mkReadModelDb(appPg);
  });

  afterAll(async () => {
    await appPg?.end({ timeout: 5 });
    await pg?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await pg`truncate comments`;
    await pg`
      insert into comments (id, type, creator_id, page_id, space_id, workspace_id)
      values (${COMMENT}, 'page', ${AUTHOR}, ${PAGE}, ${SPACE}, ${WS})`;
    audit = jest.fn();
    notify = jest.fn(async () => undefined);
    ws = jest.fn(async () => undefined);
    gate = null;
    reads = 0;
  });

  it('resolve stores who and when, and returns the re-read row with creator and resolvedBy', async () => {
    const out: any = await service().setResolved(
      { commentId: COMMENT, pageId: PAGE, resolved: true },
      who(ALICE),
      workspace,
    );
    const stored = await row();
    expect(stored.resolvedById).toBe(ALICE);
    expect(stored.resolvedAt).toBeInstanceOf(Date);
    expect(out.resolvedById).toBe(ALICE);
    expect(out.creator).toEqual({ id: AUTHOR, name: 'Author', avatarUrl: null });
    expect(out.resolvedBy).toEqual({ id: ALICE, name: 'Alice', avatarUrl: null });
    expect(ws).toHaveBeenCalledWith(SPACE, PAGE, expect.objectContaining({ comment: out }));
  });

  it('reopen clears both columns', async () => {
    await pg`update comments set resolved_at = now(), resolved_by_id = ${ALICE} where id = ${COMMENT}`;
    const out: any = await service().setResolved(
      { commentId: COMMENT, pageId: PAGE, resolved: false },
      who(BOB),
      workspace,
    );
    expect(await row()).toEqual({ resolvedAt: null, resolvedById: null });
    expect(out.resolvedBy).toBeNull();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'comment.reopened' }));
  });

  it('two racing resolves that both read an open thread: exactly one reports the transition', async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const svc = service();
    const a = svc.setResolved({ commentId: COMMENT, pageId: PAGE, resolved: true }, who(ALICE), workspace);
    const b = svc.setResolved({ commentId: COMMENT, pageId: PAGE, resolved: true }, who(BOB), workspace);
    // Both requests have read the OPEN row before either may write.
    while (reads < 2) await new Promise((r) => setImmediate(r));
    gate = null;
    release();
    const [ra, rb]: any[] = await Promise.all([a, b]);

    const stored = await row();
    expect([ALICE, BOB]).toContain(stored.resolvedById);
    // Both callers see the winner's row; only the winner emitted anything.
    expect(ra.resolvedById).toBe(stored.resolvedById);
    expect(rb.resolvedById).toBe(stored.resolvedById);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ws).toHaveBeenCalledTimes(1);
  });

  it('a comment deleted between the read and the write loses the compare-and-set → 404, nothing emitted', async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const pending = service().setResolved(
      { commentId: COMMENT, pageId: PAGE, resolved: true },
      who(ALICE),
      workspace,
    );
    while (reads < 1) await new Promise((r) => setImmediate(r));
    gate = null;
    await pg`update comments set deleted_at = now() where id = ${COMMENT}`;
    release();
    await expect(pending).rejects.toBeInstanceOf(NotFoundException);
    expect((await row()).resolvedAt).toBeNull();
    expect(audit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
