import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { HttpException, Logger } from '@nestjs/common';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageRestrictionService } from './page-restriction.service';
import { listRestrictedPagesWithGroupGrants } from './grant-ceiling';
import { ACL_ADMIN_OVERRIDE_EVENT } from './acl-audit';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
} from '../../service-bridge/read-model-pg.testkit';

/**
 * #797 on real Postgres — the restricted-page grant ceilings against real tables, a real outbox position and real
 * transactions (the unit spec, page-grant-ceiling.spec.ts, pins the decision matrix):
 *   - INV-4's race: a grant racing a just-committed restriction is refused. The restrict commits (with its outbox row)
 *     but the relay has not projected it, so the PDP still answers `space->view - locked` = view for a space member.
 *     The fence is read under the ACL lock AFTER the ACL, so it asks the platform to settle PAST the restriction:
 *     unprojected → 503 (never decided on the stale PDP); projected → 403. Nothing is written either way.
 *   - The fence runs while the write's transaction holds NO xid (`pg_stat_activity.backend_xid`), so it never holds
 *     the relay back — on add and on an update raise (whose row lock comes after the fence).
 *   - The actor's own rows decide without a fence, a grandfathered group grant included (found through `group_users`).
 *   - INV-6 / INV-5: the default (`is_default`) group, like any group, is refused on add, raise and preview; a
 *     grandfathered group grant can be lowered and removed; the read-only report lists the grandfathered grants.
 *   - The admin override row is emitted only when the admin disjunct alone grants.
 * The upstream `PagePermissionRepo` is the real one; the platform is a fake that models what the fence relies on.
 * Lives in the `docmost-authz-pg` lane; self-skips without AUTHZ_TEST_PG_URL.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG page grant ceilings', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'page_grant_ceiling_pg_spec';
const WS = uuid(100);
const OTHER_WS = uuid(101);
const SPACE = uuid(1);
const ACTOR = uuid(10);
const OTHER = uuid(11);
const THIRD = uuid(12);
const DEFAULT_GROUP = uuid(60);
const ACTOR_GROUP = uuid(61);
const TEAM_GROUP = uuid(62);

/** "<xact_id>.<id>" → comparable pair. */
const atOrPast = (a: string, b: string) => {
  const [ax, ai] = a.split('.').map(BigInt);
  const [bx, bi] = b.split('.').map(BigInt);
  return ax !== bx ? ax > bx : ai >= bi;
};

d('PageRestrictionService grant ceilings on real Postgres (#797)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: PageRestrictionService;
  const audits: Array<{ event: string; metadata?: Record<string, unknown> }> = [];

  /**
   * The fake platform: the relay's cursor, the restrictions it has projected, and who holds `admin_cascade` /
   * a page-scoped binding. `page#view|edit` for the actor: projected-restricted → only a page binding; otherwise the
   * space role (every actor here views and edits the space).
   */
  const platform = {
    cursor: '0.0',
    projectedRestricted: new Set<string>(),
    admins: new Set<string>(),
    pageBinding: new Map<string, 'view' | 'edit'>(),
    settles: [] as string[],
    /** `backend_xid` of every OTHER backend in the db, sampled while the fence is awaited. */
    xidsAtFence: [] as Array<string | null>,
    pageChecks: [] as string[],
  };
  const authz = {
    settleProjection: async (position: string) => {
      platform.settles.push(position);
      const rows = await pg<{ xid: string | null }[]>`
        select backend_xid::text as xid from pg_stat_activity
         where datname = current_database() and pid <> pg_backend_pid() and backend_xid is not null`;
      platform.xidsAtFence.push(...rows.map((r) => r.xid));
      return atOrPast(platform.cursor, position)
        ? ({ status: 'confirmed' } as const)
        : ({ status: 'pending', reason: 'timeout' } as const);
    },
    tryCheckBulk: async (
      subject: { externalId?: string },
      checks: Array<{ permission: string; resourceType: string; resourceId: string }>,
    ) => {
      const who = subject.externalId!;
      return checks.map((c) => {
        if (c.resourceType === 'space') return true; // administer (the gate) and view: every actor here
        if (c.resourceType === 'workspace') return platform.admins.has(who);
        platform.pageChecks.push(`${c.permission}:${c.resourceId}`);
        if (!platform.projectedRestricted.has(c.resourceId)) return true; // the space role
        const b = platform.pageBinding.get(`${who}:${c.resourceId}`);
        return c.permission === 'view' ? !!b : b === 'edit';
      });
    },
  };
  /** The relay catches up: everything committed is projected. */
  const project = async () => {
    const [row] = await pg<{ p: string | null }[]>`
      select xact_id::text || '.' || id::text as p from authz_outbox order by xact_id desc, id desc limit 1`;
    platform.cursor = row?.p ?? '0.0';
    platform.projectedRestricted = new Set((await pg<{ pageId: string }[]>`select page_id as "pageId" from page_access`).map((r) => r.pageId));
  };

  const page = (id: string, opts: { ws?: string; trashed?: boolean } = {}) =>
    pg`insert into pages (id, space_id, workspace_id, deleted_at)
       values (${id}, ${SPACE}, ${opts.ws ?? WS}, ${opts.trashed ? pg`now()` : null})`;
  /** A restrict as the capture trigger records it: `page_access` + an outbox row, in ONE committed transaction. */
  const restrict = (pageId: string, ws = WS) =>
    pg.begin(async (t) => {
      const tx = t as unknown as postgres.Sql; // postgres.js types TransactionSql without its call signature
      await tx`insert into page_access (page_id, workspace_id, space_id, access_level) values (${pageId}, ${ws}, ${SPACE}, 'members')`;
      await tx`insert into authz_outbox (table_name) values ('page_access')`;
    });
  const grantRow = (pageId: string, s: { userId?: string; groupId?: string }, role: string) =>
    pg`insert into page_permissions (page_access_id, user_id, group_id, role)
       select id, ${s.userId ?? null}, ${s.groupId ?? null}, ${role} from page_access where page_id = ${pageId}`;
  const grants = (pageId: string) =>
    pg<{ userId: string | null; groupId: string | null; role: string }[]>`
      select pp.user_id as "userId", pp.group_id as "groupId", pp.role
        from page_permissions pp join page_access pa on pa.id = pp.page_access_id
       where pa.page_id = ${pageId} order by pp.user_id nulls last, pp.group_id`;
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'applied',
      (e) => (e instanceof HttpException ? `${e.getStatus()}:${(e.getResponse() as { code?: string }).code ?? ''}` : `error:${(e as Error).message}`),
    );
  const actor = { id: ACTOR, workspaceId: WS } as never;
  const add = (pageId: string, role: 'reader' | 'writer', b: { userIds?: string[]; groupIds?: string[] } = { userIds: [OTHER] }) =>
    svc.addPermission({ pageId, role, ...b } as never, actor);

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 2);
    appPg = mkReadModelPg(SCHEMA, 4);
    await createReadModelTables(pg);
    await pg`alter table page_access add column space_id uuid, add column access_level varchar,
             add column creator_id uuid, add column created_at timestamptz not null default now(),
             add column updated_at timestamptz not null default now()`;
    await pg`alter table page_permissions add column added_by_id uuid,
             add column updated_at timestamptz not null default now()`;
    await pg`create table group_users (user_id uuid not null, group_id uuid not null, primary key (user_id, group_id))`;
    await pg`create table groups (id uuid primary key, workspace_id uuid not null, name varchar, is_default boolean not null default false)`;
    await pg`create table authz_outbox (xact_id xid8 not null default pg_current_xact_id(), id bigserial not null, table_name varchar)`;
    await pg`insert into groups (id, workspace_id, name, is_default)
             values (${DEFAULT_GROUP}, ${WS}, 'Everyone', true), (${ACTOR_GROUP}, ${WS}, 'Mine', false),
                    (${TEAM_GROUP}, ${WS}, 'Team', false)`;
    await pg`insert into group_users (user_id, group_id) values (${ACTOR}, ${ACTOR_GROUP}), (${OTHER}, ${TEAM_GROUP})`;
    db = mkReadModelDb(appPg);
    svc = new PageRestrictionService(
      db as never,
      {
        findById: async (id: string) =>
          db.selectFrom('pages').select(['id', 'spaceId', 'workspaceId', 'parentPageId']).where('id', '=', id).executeTakeFirst(),
      } as never,
      new PagePermissionRepo(db as never, {} as never, {} as never),
      { createForUser: async () => ({ cannot: () => false }) } as never,
      'remote',
      authz as never,
      undefined,
      { log: (row: { event: string; metadata?: Record<string, unknown> }) => void audits.push(row) } as never,
    );
  });

  afterAll(async () => {
    await appPg?.end({ timeout: 5 });
    await pg?.end({ timeout: 5 });
  });

  let warn: jest.SpyInstance;
  beforeEach(async () => {
    await pg`truncate pages, page_access, page_permissions, authz_outbox`;
    Object.assign(platform, { cursor: '0.0', projectedRestricted: new Set(), settles: [], xidsAtFence: [], pageChecks: [] });
    platform.admins.clear();
    platform.pageBinding.clear();
    audits.length = 0;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  describe('INV-4: a grant racing a just-committed restriction', () => {
    const P = uuid(200);

    it('committed but unprojected → 503 grant_ceiling_unconfirmed (never decided on the stale PDP); projected → 403; nothing written', async () => {
      await page(P);
      await restrict(P); // someone else restricted it a moment ago; the actor holds no grant on it
      // The stale PDP would still say "view" (space->view - locked, with the lock not projected): the fence must stop it.
      expect(await outcome(add(P, 'reader'))).toBe('503:grant_ceiling_unconfirmed');
      expect(platform.pageChecks).toEqual([]);
      const [{ p }] = await pg<{ p: string }[]>`
        select xact_id::text || '.' || id::text as p from authz_outbox order by xact_id desc, id desc limit 1`;
      expect(atOrPast(platform.settles[0], p)).toBe(true); // the fence was read AFTER the restriction committed
      expect(await grants(P)).toEqual([]);

      await project();
      expect(await outcome(add(P, 'reader'))).toBe('403:grant_exceeds_actor');
      expect(await grants(P)).toEqual([]);
      expect(audits.map((a) => a.event)).toEqual(['page.acl_write_refused']);
    });

    it('the fence runs while the write holds no xid — on an add and on an update raise (its row lock comes after)', async () => {
      await page(P);
      await restrict(P);
      await grantRow(P, { userId: OTHER }, 'reader');
      await project();
      platform.pageBinding.set(`${ACTOR}:${P}`, 'edit'); // the remainder the PDP answers: a page binding
      expect(await outcome(add(P, 'reader', { userIds: [THIRD] }))).toBe('applied');
      expect(await outcome(svc.updatePermission({ pageId: P, userId: OTHER, role: 'writer' } as never, actor))).toBe('applied');
      expect(platform.settles).toHaveLength(2);
      expect(platform.xidsAtFence).toEqual([]);
      expect(await grants(P)).toEqual([
        { userId: OTHER, groupId: null, role: 'writer' },
        { userId: THIRD, groupId: null, role: 'reader' },
      ]);
    });

    it('a binding that covers view but not edit: reader applies, writer is refused', async () => {
      await page(P);
      await restrict(P);
      await project();
      platform.pageBinding.set(`${ACTOR}:${P}`, 'view');
      expect(await outcome(add(P, 'reader'))).toBe('applied');
      expect(await outcome(add(P, 'writer', { userIds: [THIRD] }))).toBe('403:grant_exceeds_actor');
      expect(await grants(P)).toEqual([{ userId: OTHER, groupId: null, role: 'reader' }]);
    });
  });

  describe('INV-4: the actor’s own rows decide, with no fence', () => {
    const P = uuid(300);

    it('a direct reader grant: reader applies with no fence; writer needs edit (fenced PDP: none) → 403', async () => {
      await page(P);
      await restrict(P);
      await grantRow(P, { userId: ACTOR }, 'reader');
      expect(await outcome(add(P, 'reader'))).toBe('applied');
      expect(platform.settles).toEqual([]);
      await project();
      expect(await outcome(add(P, 'writer', { userIds: [THIRD] }))).toBe('403:grant_exceeds_actor');
    });

    it('a grandfathered group grant the actor is in (group_users) counts: writer applies with no fence', async () => {
      await page(P);
      await restrict(P);
      await grantRow(P, { groupId: ACTOR_GROUP }, 'writer');
      expect(await outcome(add(P, 'writer'))).toBe('applied');
      expect(platform.settles).toEqual([]);
      expect(await grants(P)).toEqual([
        { userId: OTHER, groupId: null, role: 'writer' },
        { userId: null, groupId: ACTOR_GROUP, role: 'writer' },
      ]);
    });

    it('a group grant the actor is NOT in does not count', async () => {
      await page(P);
      await restrict(P);
      await grantRow(P, { groupId: TEAM_GROUP }, 'writer');
      await project();
      expect(await outcome(add(P, 'reader', { userIds: [THIRD] }))).toBe('403:grant_exceeds_actor');
    });
  });

  describe('INV-4: the admin override audit', () => {
    const P = uuid(400);

    it('a workspace admin with no page access: applied, plus one override row and the log token', async () => {
      await page(P);
      await restrict(P);
      await project();
      platform.admins.add(ACTOR);
      expect(await outcome(add(P, 'writer'))).toBe('applied');
      expect(audits.map((a) => a.event)).toEqual(['page.permission_added', ACL_ADMIN_OVERRIDE_EVENT]);
      expect(audits[1].metadata).toMatchObject({ basis: 'admin_cascade', grantees: [{ userId: OTHER, role: 'writer' }] });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^PAGE_ACL_ADMIN_OVERRIDE action=add /));
    });

    it('a workspace admin who holds their own grant: no override row', async () => {
      await page(P);
      await restrict(P);
      await grantRow(P, { userId: ACTOR }, 'writer');
      platform.admins.add(ACTOR);
      expect(await outcome(add(P, 'writer'))).toBe('applied');
      expect(audits.map((a) => a.event)).toEqual(['page.permission_added']);
    });
  });

  describe('INV-6 / INV-5: per-user grants only; the default group is never grantable', () => {
    const P = uuid(500);

    it('the default group (is_default) is refused on add, raise and preview, with INV-6’s code; nothing written', async () => {
      await page(P);
      await restrict(P);
      platform.admins.add(ACTOR);
      expect(await outcome(add(P, 'reader', { groupIds: [DEFAULT_GROUP] }))).toBe('400:group_grant_not_allowed_on_restricted_page');
      expect(await outcome(add(P, 'reader', { userIds: [OTHER], groupIds: [DEFAULT_GROUP] }))).toBe(
        '400:group_grant_not_allowed_on_restricted_page',
      );
      await expect(
        svc.preview({ pageId: P, action: 'add', role: 'reader', groupIds: [DEFAULT_GROUP] } as never, actor),
      ).resolves.toMatchObject({ outcome: 'refused', code: 'group_grant_not_allowed_on_restricted_page' });
      expect(await grants(P)).toEqual([]);

      await grantRow(P, { groupId: DEFAULT_GROUP }, 'reader'); // a pre-existing (grandfathered) row
      expect(await outcome(svc.updatePermission({ pageId: P, groupId: DEFAULT_GROUP, role: 'writer' } as never, actor))).toBe(
        '400:group_grant_not_allowed_on_restricted_page',
      );
      await expect(
        svc.preview({ pageId: P, action: 'update', role: 'writer', groupId: DEFAULT_GROUP } as never, actor),
      ).resolves.toMatchObject({ outcome: 'refused', code: 'group_grant_not_allowed_on_restricted_page' });
      expect(await grants(P)).toEqual([{ userId: null, groupId: DEFAULT_GROUP, role: 'reader' }]);
    });

    it('a grandfathered group grant keeps resolving, can be lowered (by an actor with no page access) and removed', async () => {
      await page(P);
      await restrict(P);
      await grantRow(P, { groupId: TEAM_GROUP }, 'writer');
      await project();
      // Still resolves: the group's row is part of the page's ACL, untouched by INV-6.
      expect(await grants(P)).toEqual([{ userId: null, groupId: TEAM_GROUP, role: 'writer' }]);
      expect(await outcome(svc.updatePermission({ pageId: P, groupId: TEAM_GROUP, role: 'reader' } as never, actor))).toBe('applied');
      expect(await grants(P)).toEqual([{ userId: null, groupId: TEAM_GROUP, role: 'reader' }]);
      expect(platform.settles).toEqual([]); // a lowering asks nothing
      expect(await outcome(svc.removePermission({ pageId: P, groupIds: [TEAM_GROUP] } as never, actor))).toBe('applied');
      expect(await grants(P)).toEqual([]);
    });
  });

  describe('INV-6 report: grandfathered group grants on restricted pages', () => {
    it('lists every group grant in the workspace (default group and trashed pages flagged), keyset-paged; nothing else', async () => {
      const [A, B, C, X] = [uuid(601), uuid(602), uuid(603), uuid(604)];
      await page(A);
      await page(B, { trashed: true });
      await page(C);
      await page(X, { ws: OTHER_WS });
      for (const id of [A, B, C]) await restrict(id);
      await restrict(X, OTHER_WS);
      await grantRow(A, { groupId: DEFAULT_GROUP }, 'writer');
      await grantRow(A, { groupId: TEAM_GROUP }, 'reader');
      await grantRow(A, { userId: OTHER }, 'writer'); // a user grant: not reported
      await grantRow(B, { groupId: TEAM_GROUP }, 'writer');
      await grantRow(C, { userId: OTHER }, 'reader'); // no group grant: not reported
      await grantRow(X, { groupId: TEAM_GROUP }, 'reader'); // another workspace: not reported

      const first = await svc.listRestrictedPagesWithGroupGrants(WS, { limit: 2 });
      expect(first.items).toEqual([
        { pageId: A, spaceId: SPACE, groupId: DEFAULT_GROUP, role: 'writer', pageTrashed: false, isDefaultGroup: true },
        { pageId: A, spaceId: SPACE, groupId: TEAM_GROUP, role: 'reader', pageTrashed: false, isDefaultGroup: false },
      ]);
      expect(first.next).toEqual({ pageId: A, groupId: TEAM_GROUP });
      const second = await listRestrictedPagesWithGroupGrants(db as never, WS, { limit: 2, after: first.next! });
      expect(second).toEqual({
        items: [{ pageId: B, spaceId: SPACE, groupId: TEAM_GROUP, role: 'writer', pageTrashed: true, isDefaultGroup: false }],
        next: null,
      });
    });
  });
});
