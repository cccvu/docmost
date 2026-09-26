import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { HttpException } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../../core/page/services/page.service';
import { AuthzOutboxInstaller } from '../../service-bridge/authz-outbox.installer';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';

// PageService imports the collab gateway, whose lib0/hocuspocus ESM graph jest cannot load; create never touches it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { IdempotentPageCreateController } from './idempotent-page-create.controller';
import { IdempotencyLedgerInstaller } from './idempotency-ledger.installer';
import { IdempotencyLedgerService, namespaceDigest, sha256hex, userPrincipal } from './idempotency-ledger.service';
import { jsonToText } from '../../collaboration/collaboration.util';

/**
 * #616 `POST /api/pages/idempotent-create` on real Postgres, through the REAL upstream create path (PageService /
 * PageRepo with the caller transaction) and the real authz outbox trigger:
 *   - the same key twice → ONE page; the retry is `replayed: true` with the same id and re-runs nothing (no insert, no
 *     PAGE_CREATED event, no watcher, no audit, no outbox row);
 *   - the same key concurrently → ONE page, both answers carry its id (one of them waited inside its INSERT);
 *   - a first attempt that rolls back leaves no page, no ledger row and no outbox row, and its waiting twin creates;
 *   - the same key with a different body → 409 `idempotency_key_reused`, nothing created;
 *   - the key is bound to the fork-authenticated user: another user (or another namespace) with the same key, the same
 *     namespace string and the same body gets its OWN page — never the first caller's;
 *   - a ledger row held elsewhere past lock_timeout → 503 `engine_busy`, nothing created;
 *   - content is parsed before the transaction and stored exactly as the native create stores it.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG idempotent page create gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'idempotent_page_create_pg_spec';
const WS = uuid(100);
const S1 = uuid(50);
const ALICE = uuid(900);
const BOB = uuid(901);
const WORKSPACE = { id: WS } as never;
const FP = 'd'.repeat(64);
const FP2 = 'e'.repeat(64);

d('IdempotentPageCreateController on real Postgres (#616)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let controller: IdempotentPageCreateController;
  /** Runs inside the create's transaction right after the page insert (the creator-watcher insert). */
  let inCreate: (() => Promise<void>) | null = null;
  const events: string[] = [];
  const watchers: string[] = [];
  const audits: string[] = [];

  const user = (id: string) => ({ id }) as never;
  const body = (over: Record<string, unknown> = {}) =>
    ({
      spaceId: S1,
      title: 'Keyed page',
      idempotencyKey: 'key-1',
      idempotencyNamespace: `user:${ALICE}`,
      fingerprint: FP,
      ...over,
    }) as never;
  const pages = () =>
    pg<{ id: string; title: string; creatorId: string }[]>`
      select id, title, creator_id as "creatorId" from pages order by created_at`;
  const ledgerRows = () =>
    pg<{ resourceId: string | null }[]>`select resource_id as "resourceId" from ccc_idempotency_ledger`;
  const outboxPages = async () =>
    (await pg<{ c: number }[]>`select count(*)::int as c from authz_outbox where table_name = 'pages'`)[0].c;
  const waitForLockWaiter = async () => {
    for (let i = 0; i < 150; i++) {
      const [{ c }] = await pg<{ c: number }[]>`select count(*)::int as c from pg_locks where not granted`;
      if (c > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no session ever waited on a lock');
  };
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      (r) => `${(r as { replayed: boolean }).replayed ? 'replayed' : 'created'}:${(r as { id: string }).id}`,
      (e) =>
        e instanceof HttpException
          ? `${e.getStatus()}:${(e.getResponse() as { code?: string }).code ?? ''}`
          : `error:${(e as { code?: string }).code ?? (e as Error).message}`,
    );

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 2);
    appPg = mkReadModelPg(SCHEMA, 8);
    db = mkReadModelDb(appPg);
    await pg`create table spaces (id uuid primary key, name varchar, slug varchar, workspace_id uuid not null, deleted_at timestamptz)`;
    await pg`
      create table space_members (
        id uuid primary key default gen_random_uuid(), user_id uuid, group_id uuid,
        space_id uuid not null references spaces (id) on delete cascade, role varchar not null, deleted_at timestamptz
      )`;
    await pg`create table group_users (id uuid primary key default gen_random_uuid(), user_id uuid not null, group_id uuid not null)`;
    await pg`
      create table pages (
        id uuid primary key default gen_random_uuid(), slug_id varchar, title varchar, icon varchar, cover_photo varchar,
        position varchar, parent_page_id uuid references pages (id) on delete cascade, creator_id uuid,
        last_updated_by_id uuid, space_id uuid not null references spaces (id) on delete cascade,
        workspace_id uuid not null, is_locked boolean not null default false, is_base boolean not null default false,
        contributor_ids uuid[], content jsonb, text_content text, ydoc bytea,
        created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default now(),
        deleted_at timestamptz, deleted_by_id uuid
      )`;
    await pg`
      create table page_access (
        id uuid primary key default gen_random_uuid(), page_id uuid not null unique references pages (id) on delete cascade,
        workspace_id uuid not null, space_id uuid not null, access_level varchar not null
      )`;
    await pg`
      create table page_permissions (
        id uuid primary key default gen_random_uuid(), page_access_id uuid not null references page_access (id) on delete cascade,
        user_id uuid, group_id uuid, role varchar not null
      )`;
    await pg`insert into spaces (id, workspace_id) values (${S1}, ${WS})`;

    await (new AuthzOutboxInstaller(db as never, 'remote') as unknown as { install(): Promise<void> }).install();
    await new IdempotencyLedgerInstaller(db as never, 'remote').install();

    const emitter = { emit: (name: string) => (events.push(name), true) };
    const pageRepo = new PageRepo(db as never, {} as never, emitter as never);
    const queue = { add: async () => undefined };
    const pageService = new PageService(
      pageRepo,
      {} as never,
      {} as never,
      db as never,
      {} as never,
      queue as never,
      queue as never,
      { add: async (job: string) => void events.push(`queued:${job}`) } as never,
      emitter as never,
      {} as never,
      {
        addPageWatchers: async (userIds: string[], pageId: string, _s: string, _w: string, trx: unknown) => {
          expect(trx).toBeDefined(); // the watcher joins the create's transaction
          if (inCreate) {
            const hook = inCreate;
            inCreate = null;
            await hook();
          }
          watchers.push(`${userIds.join(',')}:${pageId}`);
        },
      } as never,
      {} as never,
    );
    const allow = { can: () => true, cannot: () => false };
    controller = new IdempotentPageCreateController(
      db as never,
      pageRepo,
      pageService,
      {
        validateCanEdit: async () => ({ hasRestriction: false }),
        validateCanViewWithPermissions: async () => ({ canEdit: true, hasRestriction: false }),
      } as never,
      { createForUser: async () => allow } as never,
      { log: (p: { event: string }) => audits.push(p.event) } as never,
      new IdempotencyLedgerService(),
    );
  });

  afterEach(async () => {
    inCreate = null;
    events.length = 0;
    watchers.length = 0;
    audits.length = 0;
    await pg`delete from ccc_idempotency_ledger`;
    await pg`delete from pages`;
    await pg`delete from authz_outbox`;
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  it('the same key twice: ONE page; the retry replays its id and re-runs nothing', async () => {
    const first = (await controller.create(body(), user(ALICE), WORKSPACE)) as { id: string; replayed: boolean; permissions: unknown };
    expect(first).toMatchObject({ replayed: false, title: 'Keyed page', spaceId: S1, permissions: { canEdit: true, hasRestriction: false } });
    expect({ events: [...events], watchers: [...watchers], audits: [...audits], outbox: await outboxPages() }).toEqual({
      events: ['page.created'],
      watchers: [`${ALICE}:${first.id}`],
      audits: ['page.created'],
      outbox: 1,
    });
    events.length = watchers.length = audits.length = 0;

    const again = (await controller.create(body(), user(ALICE), WORKSPACE)) as { id: string; replayed: boolean };
    expect(again).toEqual({ ...first, replayed: true });
    expect(await pages()).toEqual([{ id: first.id, title: 'Keyed page', creatorId: ALICE }]);
    expect({ events, watchers, audits, outbox: await outboxPages() }).toEqual({ events: [], watchers: [], audits: [], outbox: 1 });
    expect(await ledgerRows()).toEqual([{ resourceId: first.id }]);
  });

  it('the same key concurrently (no choreography): ONE page, both answers carry its id', async () => {
    const results = await Promise.all([0, 1].map(() => outcome(controller.create(body(), user(ALICE), WORKSPACE))));
    const [only] = await pages();
    expect((await pages()).length).toBe(1);
    expect(results.sort()).toEqual([`created:${only.id}`, `replayed:${only.id}`]);
  });

  it('a twin that arrives while the first is inside its create WAITS, then replays the committed page', async () => {
    let twin!: Promise<string>;
    inCreate = async () => {
      twin = outcome(controller.create(body(), user(ALICE), WORKSPACE));
      await waitForLockWaiter();
    };
    const first = await outcome(controller.create(body(), user(ALICE), WORKSPACE));
    const [only] = await pages();
    expect([first, await twin]).toEqual([`created:${only.id}`, `replayed:${only.id}`]);
    expect(audits).toEqual(['page.created']);
  });

  it('a first attempt that rolls back leaves nothing (no page, no ledger row, no outbox row); its waiting twin creates', async () => {
    let twin!: Promise<string>;
    inCreate = async () => {
      twin = outcome(controller.create(body(), user(ALICE), WORKSPACE));
      await waitForLockWaiter();
      throw new Error('the create failed after the insert');
    };
    expect(await outcome(controller.create(body(), user(ALICE), WORKSPACE))).toBe('error:the create failed after the insert');
    const created = await twin;
    const all = await pages();
    expect(all).toHaveLength(1);
    expect(created).toBe(`created:${all[0].id}`);
    expect(await ledgerRows()).toEqual([{ resourceId: all[0].id }]);
    expect(await outboxPages()).toBe(1);
  });

  it('a failed create leaves no ledger row: the retry with the same key creates', async () => {
    inCreate = async () => {
      throw new Error('boom');
    };
    expect(await outcome(controller.create(body(), user(ALICE), WORKSPACE))).toBe('error:boom');
    expect({ pages: await pages(), ledger: await ledgerRows(), outbox: await outboxPages(), audits }).toEqual({
      pages: [],
      ledger: [],
      outbox: 0,
      audits: [],
    });
    expect(await outcome(controller.create(body(), user(ALICE), WORKSPACE))).toMatch(/^created:/);
  });

  it('the same key with a different body → 409 idempotency_key_reused, nothing created', async () => {
    await controller.create(body(), user(ALICE), WORKSPACE);
    expect(await outcome(controller.create(body({ title: 'Other', fingerprint: FP2 }), user(ALICE), WORKSPACE))).toBe(
      '409:idempotency_key_reused',
    );
    expect(await pages()).toHaveLength(1);
  });

  it('bound to the authenticated user: another user with the same key, namespace string and body gets their OWN page', async () => {
    const alice = (await controller.create(body(), user(ALICE), WORKSPACE)) as { id: string };
    const bob = (await controller.create(body(), user(BOB), WORKSPACE)) as { id: string; replayed: boolean; creatorId: string };
    expect(bob.replayed).toBe(false);
    expect(bob.id).not.toBe(alice.id);
    expect(bob.creatorId).toBe(BOB);
    // And the same user under another namespace (e.g. an MCP connection acting for them) is a separate key too.
    const obo = (await controller.create(body({ idempotencyNamespace: `mcp:obo:${ALICE}` }), user(ALICE), WORKSPACE)) as {
      replayed: boolean;
    };
    expect(obo.replayed).toBe(false);
    expect(await pages()).toHaveLength(3);
  });

  it('a ledger row held elsewhere past lock_timeout → 503 engine_busy, nothing created', async () => {
    const side = await appPg.reserve();
    try {
      await side`begin`;
      const ns = namespaceDigest({ workspaceId: WS, principal: userPrincipal(ALICE), namespace: `user:${ALICE}` });
      await side`insert into ccc_idempotency_ledger (namespace_digest, op, key_digest, fingerprint)
                 values (${ns}, 'page.create', ${sha256hex('key-1')}, ${FP})`;
      expect(await outcome(controller.create(body(), user(ALICE), WORKSPACE))).toBe('503:engine_busy');
    } finally {
      await side`rollback`;
      side.release();
    }
    expect(await pages()).toEqual([]);
  });

  it('content is parsed before the transaction and stored as the native create stores it (JSON and HTML)', async () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello json' }] }] };
    const j = (await controller.create(body({ content: doc, format: 'json' }), user(ALICE), WORKSPACE)) as { id: string };
    const [stored] = await pg<{ content: unknown; textContent: string; hasYdoc: boolean }[]>`
      select content, text_content as "textContent", ydoc is not null as "hasYdoc" from pages where id = ${j.id}`;
    expect(stored).toEqual({ content: doc, textContent: jsonToText(doc as never), hasYdoc: true });

    const h = (await controller.create(
      body({ idempotencyKey: 'key-2', content: '<p>hello <strong>html</strong></p>', format: 'html', fingerprint: FP2 }),
      user(ALICE),
      WORKSPACE,
    )) as { id: string; content?: unknown };
    expect(h).not.toHaveProperty('content'); // the native create response carries no content
    const [html] = await pg<{ content: { type: string }; textContent: string }[]>`
      select content, text_content as "textContent" from pages where id = ${h.id}`;
    expect(html.content.type).toBe('doc');
    expect(html.textContent).toContain('hello html');
  });
});
