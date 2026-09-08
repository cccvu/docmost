import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { NotFoundException } from '@nestjs/common';
import { ServiceSpaceService } from './service-space.service';
import {
  PG_URL,
  uuid,
  fakeWorkspaceResolver,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
} from './read-model-pg.testkit';

/**
 * Real-Postgres proof of the space control-plane READ paths (issue #174 remainder, item 2). The unit spec
 * (`service-space.service.spec.ts`) covers only `create` transactional atomicity and the `archive` UPDATE
 * string; `list`, `listMembers`, and `loadSpace`/`getDetail` had NO test at all. These are a privileged data
 * plane, so their tenant/liveness guards (`workspace_id`, `coalesce(is_personal,false)=false`,
 * `deleted_at is null`) must be proven to EXCLUDE on the engine, not merely appear in the SQL text.
 *
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG space read gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'service_space_pg_spec';
const DEFAULT_WS = uuid(100);
const FOREIGN_WS = uuid(200);

const S_VISIBLE = uuid(1);
const S_ARCHIVED = uuid(2);
const S_PERSONAL = uuid(3);
const S_FOREIGN = uuid(4);

d('ServiceSpaceService reads on real Postgres (list / members / detail confidentiality)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: ServiceSpaceService;

  const insertSpace = (
    id: string,
    name: string,
    opts: { workspaceId?: string; personal?: boolean; deleted?: boolean } = {},
  ) =>
    pg`
      insert into spaces (id, name, slug, description, visibility, is_personal, workspace_id, created_at, updated_at, deleted_at)
      values (${id}, ${name}, ${'slug-' + id.slice(-3)}, null, 'private', ${opts.personal ?? false},
              ${opts.workspaceId ?? DEFAULT_WS}, now(), now(), ${opts.deleted ? pg`now()` : null})`;

  const insertMember = (id: string, spaceId: string, userId: string, deleted = false) =>
    pg`
      insert into space_members (id, user_id, group_id, space_id, role, added_by_id, created_at, updated_at, deleted_at)
      values (${id}, ${userId}, null, ${spaceId}, 'writer', ${userId}, now(), now(), ${deleted ? pg`now()` : null})`;

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
    svc = new ServiceSpaceService(db as any, fakeWorkspaceResolver(DEFAULT_WS), {} as any);

    await insertSpace(S_VISIBLE, 'alpha');
    await insertSpace(S_ARCHIVED, 'beta', { deleted: true });
    await insertSpace(S_PERSONAL, 'gamma', { personal: true });
    await insertSpace(S_FOREIGN, 'delta', { workspaceId: FOREIGN_WS });

    // S_VISIBLE has one live member and one soft-deleted member (member_count must count only the live one).
    await insertMember(uuid(20), S_VISIBLE, uuid(30));
    await insertMember(uuid(21), S_VISIBLE, uuid(31), true);
  });

  afterAll(async () => {
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
    await appPg?.end?.({ timeout: 5 });
  });

  it('list() returns only the live, non-personal, in-tenant space, with a live-only member count', async () => {
    const res = await svc.list();
    expect(res.map((s) => s.id)).toEqual([S_VISIBLE]);
    expect(res[0]).toMatchObject({ archived: false, memberCount: 1 });
  });

  it('list(includeArchived=true) adds the archived space (nulls-first) but still excludes personal and foreign', async () => {
    const res = await svc.list(true);
    // ORDER BY deleted_at nulls first: the live space precedes the archived one.
    expect(res.map((s) => s.id)).toEqual([S_VISIBLE, S_ARCHIVED]);
    expect(res.find((s) => s.id === S_ARCHIVED)).toMatchObject({ archived: true });
    expect(res.map((s) => s.id)).not.toContain(S_PERSONAL);
    expect(res.map((s) => s.id)).not.toContain(S_FOREIGN);
  });

  it('getDetail loads an in-tenant space (archived included) but 404s a foreign one', async () => {
    await expect(svc.getDetail(S_VISIBLE)).resolves.toMatchObject({ id: S_VISIBLE, archived: false });
    await expect(svc.getDetail(S_ARCHIVED)).resolves.toMatchObject({ id: S_ARCHIVED, archived: true });
    await expect(svc.getDetail(S_FOREIGN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listMembers returns only live members and 404s (via loadSpace) for a foreign space', async () => {
    const members = await svc.listMembers(S_VISIBLE);
    expect(members.map((m) => m.userId)).toEqual([uuid(30)]);
    await expect(svc.listMembers(S_FOREIGN)).rejects.toBeInstanceOf(NotFoundException);
  });
});
