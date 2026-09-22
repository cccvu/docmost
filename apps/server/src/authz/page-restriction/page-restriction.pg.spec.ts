import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageRestrictionService } from './page-restriction.service';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
} from '../../service-bridge/read-model-pg.testkit';

/**
 * Real-Postgres proof of the page-restriction self-dealing SQL (#486). The unit spec
 * (`page-restriction.service.spec.ts`) pins these statements through a Kysely spy, which cannot tell a correct
 * correlated subquery from a wrong one — so the queries that decide a refusal run here against real tables:
 *   - A3: an agent-path unrestrict (`requireActorCoverage`) is refused (409) while a DIRECT sub-page has no
 *     `page_access` row of its own — a trashed one included (it can be restored) — and allowed when every direct
 *     child is restricted, whatever lies deeper; without the flag (the native UI) it is unchanged;
 *   - A1: a grant or re-role naming a group the actor belongs to is refused, found through `group_users`;
 *   - A2: restricting under a restricted ancestor keeps the actor nothing (upstream's recursive
 *     `hasRestrictedAncestor`, read-only), and asks the PDP nothing;
 *   - `updatePermission`: a subject with no grant is a 404; a grant is re-roled in place.
 *
 * The upstream `PagePermissionRepo` is the real one (its SQL is part of what is under test); the PDP, the space
 * ability and the page lookup are stubs. Lives in the `docmost-authz-pg` CI lane, which collects
 * `src/(service-bridge|authz)/**.pg.spec.ts`; self-skips without AUTHZ_TEST_PG_URL.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG page-restriction gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'page_restriction_pg_spec';
const WS = uuid(100);
const SPACE = uuid(1);
const ACTOR = uuid(10);
const OTHER = uuid(11);
const MY_GROUP = uuid(60);
const THEIR_GROUP = uuid(61);

d('PageRestrictionService self-dealing SQL on real Postgres (#486)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: PageRestrictionService;
  let pdpAnswer: boolean[] | null;
  const pdpCalls: unknown[] = [];
  const actor = { id: ACTOR, workspaceId: WS } as any;

  const page = (
    id: string,
    parent: string | null,
    opts: { trashed?: boolean } = {},
  ) =>
    pg`insert into pages (id, space_id, parent_page_id, workspace_id, deleted_at)
       values (${id}, ${SPACE}, ${parent}, ${WS}, ${opts.trashed ? pg`now()` : null})`;
  const restrictRow = (pageId: string) =>
    pg`insert into page_access (page_id, workspace_id, space_id, access_level) values (${pageId}, ${WS}, ${SPACE}, 'members')`;
  const isRestricted = async (pageId: string) =>
    (await pg`select 1 from page_access where page_id = ${pageId}`).length > 0;
  const grants = (pageId: string) =>
    pg<{ userId: string | null; groupId: string | null; role: string }[]>`
      select pp.user_id as "userId", pp.group_id as "groupId", pp.role
        from page_permissions pp join page_access pa on pa.id = pp.page_access_id
       where pa.page_id = ${pageId} order by pp.role`;

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 2);
    appPg = mkReadModelPg(SCHEMA, 4);
    await createReadModelTables(pg);
    // Columns the upstream repo writes that the shared read-model kit does not carry, plus group membership.
    await pg`alter table page_access add column space_id uuid, add column access_level varchar,
             add column creator_id uuid, add column created_at timestamptz not null default now(),
             add column updated_at timestamptz not null default now()`;
    await pg`alter table page_permissions add column added_by_id uuid,
             add column updated_at timestamptz not null default now()`;
    await pg`create table group_users (user_id uuid not null, group_id uuid not null, primary key (user_id, group_id))`;
    await pg`insert into group_users (user_id, group_id) values (${ACTOR}, ${MY_GROUP}), (${OTHER}, ${THEIR_GROUP})`;
    db = mkReadModelDb(appPg);

    const permissionRepo = new PagePermissionRepo(
      db as any,
      {} as any,
      {} as any,
    );
    const pageRepo = {
      findById: async (id: string) =>
        db
          .selectFrom('pages')
          .select(['id', 'spaceId', 'workspaceId', 'parentPageId'])
          .where('id', '=', id)
          .executeTakeFirst(),
    };
    const spaceAbility = {
      createForUser: async () => ({ cannot: () => false }),
    };
    const authz = {
      tryCheckBulk: async (subject: unknown, checks: unknown[]) => {
        pdpCalls.push({ subject, checks });
        return pdpAnswer;
      },
    };
    svc = new PageRestrictionService(
      db as any,
      pageRepo as any,
      permissionRepo,
      spaceAbility as any,
      'remote',
      authz as any,
    );
  });

  afterAll(async () => {
    await appPg?.end({ timeout: 5 });
    await pg?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await pg`truncate pages, page_access, page_permissions`;
    pdpAnswer = [true];
    pdpCalls.length = 0;
  });

  describe('A3: unrestrict with requireActorCoverage', () => {
    const P = uuid(200);
    const C1 = uuid(201);
    const C2 = uuid(202);
    const G = uuid(203);

    it('refuses (409) while a direct sub-page is unrestricted, and leaves the restriction in place', async () => {
      await page(P, null);
      await page(C1, P);
      await page(C2, P);
      await restrictRow(P);
      await restrictRow(C1); // C2 is dark: locked only through P
      await expect(
        svc.unrestrict(P, actor, { requireActorCoverage: true }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await isRestricted(P)).toBe(true);
    });

    it('counts a TRASHED unrestricted sub-page (a restore would expose it)', async () => {
      await page(P, null);
      await page(C1, P, { trashed: true });
      await restrictRow(P);
      await expect(
        svc.unrestrict(P, actor, { requireActorCoverage: true }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await isRestricted(P)).toBe(true);
    });

    it('allows it when every direct sub-page is restricted — an unrestricted GRANDchild sits behind its restricted parent', async () => {
      await page(P, null);
      await page(C1, P);
      await page(G, C1); // unrestricted, but still locked through C1 after P is lifted
      await restrictRow(P);
      await restrictRow(C1);
      await svc.unrestrict(P, actor, { requireActorCoverage: true });
      expect(await isRestricted(P)).toBe(false);
      expect(await isRestricted(C1)).toBe(true);
    });

    it('allows a leaf page', async () => {
      await page(P, null);
      await restrictRow(P);
      await svc.unrestrict(P, actor, { requireActorCoverage: true });
      expect(await isRestricted(P)).toBe(false);
    });

    it('ignores other pages’ children (the subquery is correlated to THIS page)', async () => {
      const Q = uuid(210);
      await page(P, null);
      await page(Q, null);
      await page(C1, Q); // an unrestricted child of a DIFFERENT page
      await restrictRow(P);
      await svc.unrestrict(P, actor, { requireActorCoverage: true });
      expect(await isRestricted(P)).toBe(false);
    });

    it('refuses (403) when the actor cannot edit the page, before looking at children', async () => {
      pdpAnswer = [false];
      await page(P, null);
      await restrictRow(P);
      await expect(
        svc.unrestrict(P, actor, { requireActorCoverage: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await isRestricted(P)).toBe(true);
    });

    it('without the flag (the native UI) lifts it even over an unrestricted sub-page — the human break-glass', async () => {
      await page(P, null);
      await page(C1, P);
      await restrictRow(P);
      await svc.unrestrict(P, actor);
      expect(await isRestricted(P)).toBe(false);
    });
  });

  describe('A1: no self-grant through a group', () => {
    const P = uuid(300);

    it('refuses a grant to a group the actor belongs to, and writes nothing', async () => {
      await page(P, null);
      await restrictRow(P);
      await expect(
        svc.addPermission(
          { pageId: P, groupIds: [MY_GROUP], role: 'writer' } as any,
          actor,
        ),
      ).rejects.toMatchObject({ response: { code: 'self_grant' } });
      expect(await grants(P)).toEqual([]);
    });

    it('grants a group the actor is not in', async () => {
      await page(P, null);
      await restrictRow(P);
      await svc.addPermission(
        { pageId: P, groupIds: [THEIR_GROUP], role: 'reader' } as any,
        actor,
      );
      expect(await grants(P)).toEqual([
        { userId: null, groupId: THEIR_GROUP, role: 'reader' },
      ]);
    });

    it('refuses re-roling a group grant the actor belongs to', async () => {
      await page(P, null);
      await restrictRow(P);
      await pg`insert into page_permissions (page_access_id, group_id, role)
               select id, ${MY_GROUP}, 'reader' from page_access where page_id = ${P}`;
      await expect(
        svc.updatePermission(
          { pageId: P, groupId: MY_GROUP, role: 'writer' } as any,
          actor,
        ),
      ).rejects.toMatchObject({ response: { code: 'self_grant' } });
      expect(await grants(P)).toEqual([
        { userId: null, groupId: MY_GROUP, role: 'reader' },
      ]);
    });
  });

  describe('A2: restrict under a restricted ancestor', () => {
    it('keeps the actor nothing and asks the PDP nothing', async () => {
      const A = uuid(400);
      const P = uuid(401);
      await page(A, null);
      await page(P, A);
      await restrictRow(A);
      await svc.restrict(P, actor);
      expect(await isRestricted(P)).toBe(true);
      expect(await grants(P)).toEqual([]);
      expect(pdpCalls).toEqual([]);
    });

    it('keeps reader for an actor who can only view the space', async () => {
      const P = uuid(410);
      await page(P, null);
      pdpAnswer = [true, false];
      await svc.restrict(P, actor);
      expect(await grants(P)).toEqual([
        { userId: ACTOR, groupId: null, role: 'reader' },
      ]);
    });
  });

  describe('updatePermission', () => {
    const P = uuid(500);

    it('is a 404 when the subject holds no grant on the page', async () => {
      await page(P, null);
      await restrictRow(P);
      await expect(
        svc.updatePermission(
          { pageId: P, userId: OTHER, role: 'writer' } as any,
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('re-roles an existing grant in place', async () => {
      await page(P, null);
      await restrictRow(P);
      await pg`insert into page_permissions (page_access_id, user_id, role)
               select id, ${OTHER}, 'reader' from page_access where page_id = ${P}`;
      await svc.updatePermission(
        { pageId: P, userId: OTHER, role: 'writer' } as any,
        actor,
      );
      expect(await grants(P)).toEqual([
        { userId: OTHER, groupId: null, role: 'writer' },
      ]);
    });

    it('is a 400 on an unrestricted page', async () => {
      await page(P, null);
      await expect(
        svc.updatePermission(
          { pageId: P, userId: OTHER, role: 'writer' } as any,
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
