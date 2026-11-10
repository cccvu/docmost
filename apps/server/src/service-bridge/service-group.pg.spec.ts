import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { BadRequestException } from '@nestjs/common';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { ServiceBridgeService } from './service-bridge.service';
import { ServiceGroupService } from './service-group.service';
import { shadowEmailFor } from './shadow-user';
import { PG_URL, uuid, fakeWorkspaceResolver, mkReadModelPg, bootstrapSchema, mkReadModelDb } from './read-model-pg.testkit';
import { createGroupTables, truncateGroupTables } from './groups-pg.testkit';

/**
 * Real-Postgres proof of the governed group control plane (wiki-v2 #797): CRUD, case-insensitive name uniqueness,
 * the default group's immutability outside the ensure, `group_in_use` (a delete never takes access away), the ensure's
 * INV-5 precondition, members by externalId only (provisioned like a space add; ON CONFLICT DO NOTHING), the
 * membership lookup and the usage read. Shadow users go through the REAL provisioning upsert where a write provisions.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
// ---- row fixtures (kept in the spec: the fitness scans read every non-spec file) ----
/** A shadow user exactly as provisioning would key it (the lower-cased shadow email), without the bcrypt cost. */
const insertShadow = async (pg: postgres.Sql, workspaceId: string, externalId: string): Promise<string> => {
  const rows = await pg<{ id: string }[]>`
    insert into users (email, name, role, workspace_id) values (${shadowEmailFor(externalId)}, ${externalId}, 'member', ${workspaceId})
    on conflict (email, workspace_id) do update set deleted_at = null
    returning id`;
  return rows[0].id;
};

const insertGroup = async (
  pg: postgres.Sql,
  workspaceId: string,
  name: string,
  opts: { isDefault?: boolean } = {},
): Promise<string> => {
  const rows = await pg<{ id: string }[]>`
    insert into groups (name, is_default, workspace_id) values (${name}, ${opts.isDefault ?? false}, ${workspaceId})
    returning id`;
  return rows[0].id;
};

const joinGroup = async (pg: postgres.Sql, groupId: string, userId: string): Promise<void> => {
  await pg`insert into group_users (user_id, group_id) values (${userId}, ${groupId})`;
};

const insertSpace = async (
  pg: postgres.Sql,
  workspaceId: string,
  id: string,
  opts: { archived?: boolean } = {},
): Promise<void> => {
  await pg`insert into spaces (id, name, slug, workspace_id, deleted_at)
           values (${id}, ${'s-' + id.slice(-4)}, ${'s-' + id.slice(-4)}, ${workspaceId}, ${opts.archived ? pg`now()` : null})`;
};

const insertMember = async (
  pg: postgres.Sql,
  spaceId: string,
  subject: { userId?: string; groupId?: string },
  role: string,
  opts: { deleted?: boolean } = {},
): Promise<string> => {
  const rows = await pg<{ id: string }[]>`
    insert into space_members (user_id, group_id, space_id, role, deleted_at)
    values (${subject.userId ?? null}, ${subject.groupId ?? null}, ${spaceId}, ${role}, ${opts.deleted ? pg`now()` : null})
    returning id`;
  return rows[0].id;
};

/** A page grant naming a group (a page_access row + a page_permissions row). */
const insertGroupPageGrant = async (
  pg: postgres.Sql,
  workspaceId: string,
  pageId: string,
  groupId: string,
  role = 'reader',
): Promise<string> => {
  const access = await pg<{ id: string }[]>`
    insert into page_access (page_id, workspace_id) values (${pageId}, ${workspaceId}) returning id`;
  const rows = await pg<{ id: string }[]>`
    insert into page_permissions (page_access_id, group_id, role) values (${access[0].id}, ${groupId}, ${role}) returning id`;
  return rows[0].id;
};


const d = PG_URL ? describe : describe.skip;

describe('real-PG group control plane gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'service_group_pg_spec';
const WS = uuid(100);
const WS_OTHER = uuid(101);
const S = uuid(1);
const PAGE = uuid(500);

const codeOf = async (p: Promise<unknown>): Promise<{ status?: number; code?: string; body?: any }> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!err) return {};
  const body = (err as any).getResponse?.();
  return { status: (err as any).getStatus?.(), code: body?.code, body };
};

d('ServiceGroupService on real Postgres (#797)', () => {
  jest.setTimeout(60_000); // provisioning bcrypt-hashes an unusable password per new shadow user

  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: ServiceGroupService;

  const membersOf = async (groupId: string): Promise<string[]> =>
    (
      await pg<{ email: string }[]>`
        select u.email from group_users gu join users u on u.id = gu.user_id where gu.group_id = ${groupId} order by u.email`
    ).map((r) => r.email);
  const groupRow = async (id: string) =>
    (await pg<{ name: string; description: string | null }[]>`select name, description from groups where id = ${id}`)[0];

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(appPg);
    await createGroupTables(pg);
    const resolver = fakeWorkspaceResolver(WS);
    const bridge = new ServiceBridgeService(db as any, new UserRepo(db as any), {} as any, {} as any, resolver, {} as any);
    svc = new ServiceGroupService(db as any, resolver, bridge);
  });

  afterAll(async () => {
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
    await appPg?.end?.({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateGroupTables(pg);
    await insertSpace(pg, WS, S);
  });

  describe('reads', () => {
    it('lists live groups of THIS workspace, the default first, filters by q (LIKE characters literal) and limit', async () => {
      const basic = await insertGroup(pg, WS, 'Everyone', { isDefault: true });
      const eng = await insertGroup(pg, WS, 'engineering');
      await insertGroup(pg, WS, 'Alpha_1');
      await insertGroup(pg, WS_OTHER, 'Foreign');
      await pg`insert into groups (name, is_default, workspace_id, deleted_at) values ('Gone', false, ${WS}, now())`;
      await joinGroup(pg, eng, await insertShadow(pg, WS, 'alice'));

      const all = await svc.list();
      expect(all.map((g) => g.name)).toEqual(['Everyone', 'Alpha_1', 'engineering']);
      expect(all[0]).toMatchObject({ id: basic, isDefault: true, memberCount: 0 });
      expect(all.find((g) => g.id === eng)).toMatchObject({ memberCount: 1, isDefault: false, description: null });
      expect((await svc.list({ q: 'ENG' })).map((g) => g.name)).toEqual(['engineering']);
      expect((await svc.list({ q: 'a_' })).map((g) => g.name)).toEqual(['Alpha_1']); // `_` is not a wildcard
      expect((await svc.list({ q: '%' })).map((g) => g.name)).toEqual([]);
      expect(await svc.list({ limit: 1 })).toHaveLength(1);
    });

    it('get / listMembers / usage are 404 for a group of another workspace', async () => {
      const foreign = await insertGroup(pg, WS_OTHER, 'Foreign');
      for (const p of [svc.get(foreign), svc.listMembers(foreign), svc.usage(foreign)]) {
        expect(await codeOf(p)).toMatchObject({ status: 404, code: 'group_not_found' });
      }
    });

    it('lists members with their externalId (null outside the shadow namespace), keyset-paged', async () => {
      const g = await insertGroup(pg, WS, 'team');
      const ids: string[] = [];
      for (const ext of ['m1', 'm2', 'm3']) {
        const id = await insertShadow(pg, WS, ext);
        ids.push(id);
        await joinGroup(pg, g, id);
      }
      const anchor = (await pg<{ id: string }[]>`
        insert into users (email, role, workspace_id) values ('native@users.invalid', 'member', ${WS}) returning id`)[0].id;
      await joinGroup(pg, g, anchor);

      const all = await svc.listMembers(g);
      expect(all.map((m) => m.externalId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['m1', 'm2', 'm3', null]);
      const first = await svc.listMembers(g, { limit: 2 });
      expect(first).toHaveLength(3); // limit + 1: the platform detects hasMore
      const last = first[1];
      const next = await svc.listMembers(g, { limit: 2, before: { createdAt: last.addedAt, id: last.memberId } });
      expect([...first.slice(0, 2), ...next].map((m) => m.memberId)).toEqual(all.map((m) => m.memberId));
    });

    it('looks up the live groups one identity is in, without provisioning it', async () => {
      const basic = await insertGroup(pg, WS, 'Everyone', { isDefault: true });
      const g = await insertGroup(pg, WS, 'team');
      const alice = await insertShadow(pg, WS, 'alice');
      await joinGroup(pg, basic, alice);
      await joinGroup(pg, g, alice);
      expect(await svc.lookupMemberships('ALICE')).toEqual({
        groups: [
          { id: basic, name: 'Everyone', isDefault: true },
          { id: g, name: 'team', isDefault: false },
        ],
      });
      expect(await svc.lookupMemberships('nobody')).toEqual({ groups: [] });
      expect(await pg`select 1 from users where email = ${shadowEmailFor('nobody')}`).toHaveLength(0);
    });

    it('usage lists the live space memberships and the page grants naming the group', async () => {
      const g = await insertGroup(pg, WS, 'team');
      const m = await insertMember(pg, S, { groupId: g }, 'writer');
      await insertSpace(pg, WS, uuid(2));
      await insertMember(pg, uuid(2), { groupId: g }, 'reader', { deleted: true }); // grants nothing
      const perm = await insertGroupPageGrant(pg, WS, PAGE, g, 'writer');
      expect(await svc.usage(g)).toEqual({
        spaces: [{ spaceId: S, memberId: m, role: 'writer' }],
        pages: [{ pageId: PAGE, permissionId: perm, role: 'writer' }],
      });
    });
  });

  describe('create / update', () => {
    it('creates a non-default group with the actor as creator; a case-insensitive clash is 409 group_name_taken', async () => {
      const created = await svc.create({ name: 'Research', description: 'R&D', actorExternalId: 'boss' });
      expect(created).toMatchObject({ name: 'Research', description: 'R&D', isDefault: false, memberCount: 0 });
      const row = (await pg<{ creatorId: string; isDefault: boolean }[]>`
        select creator_id as "creatorId", is_default as "isDefault" from groups where id = ${created.id}`)[0];
      expect(row.isDefault).toBe(false);
      expect(row.creatorId).toBe((await pg<{ id: string }[]>`select id from users where email = ${shadowEmailFor('boss')}`)[0].id);
      expect(await codeOf(svc.create({ name: 'research', actorExternalId: 'boss' }))).toMatchObject({
        status: 409,
        code: 'group_name_taken',
      });
    });

    it('concurrent creates of case variants: exactly one wins', async () => {
      await insertShadow(pg, WS, 'boss');
      const results = await Promise.allSettled([
        svc.create({ name: 'Ops', actorExternalId: 'boss' }),
        svc.create({ name: 'OPS', actorExternalId: 'boss' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await pg`select 1 from groups where lower(name) = 'ops'`).length).toBe(1);
    });

    it('renames and re-describes (empty string clears); a clash with another group is 409, its own name is fine', async () => {
      const g = await insertGroup(pg, WS, 'team');
      await insertGroup(pg, WS, 'Other');
      await expect(svc.update(g, { name: 'Team', description: 'x', actorExternalId: 'boss' })).resolves.toMatchObject({
        name: 'Team',
        description: 'x',
      });
      await svc.update(g, { description: '', actorExternalId: 'boss' });
      expect(await groupRow(g)).toEqual({ name: 'Team', description: null });
      expect(await codeOf(svc.update(g, { name: 'other', actorExternalId: 'boss' }))).toMatchObject({ code: 'group_name_taken' });
      await expect(svc.update(g, { actorExternalId: 'boss' } as any)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('the default group is changed only by the ensure', () => {
    it('refuses rename, member add, member remove and delete (409 default_group_immutable, nothing changed)', async () => {
      const basic = await insertGroup(pg, WS, 'Everyone', { isDefault: true });
      const alice = await insertShadow(pg, WS, 'alice');
      await joinGroup(pg, basic, alice);
      for (const p of [
        svc.update(basic, { name: 'x', actorExternalId: 'boss' }),
        svc.addMembers(basic, { externalIds: ['bob'], actorExternalId: 'boss' }),
        svc.removeMember(basic, 'alice'),
        svc.delete(basic),
      ]) {
        expect(await codeOf(p)).toMatchObject({ status: 409, code: 'default_group_immutable' });
      }
      expect(await groupRow(basic)).toEqual({ name: 'Everyone', description: null });
      expect(await membersOf(basic)).toEqual([shadowEmailFor('alice')]);
      expect(await pg`select 1 from users where email = ${shadowEmailFor('bob')}`).toHaveLength(0); // nobody provisioned
    });
  });

  describe('members (users by externalId only)', () => {
    it('adds identities (provisioning the new ones), reports already-members, and writes nothing twice', async () => {
      const g = await insertGroup(pg, WS, 'team');
      await joinGroup(pg, g, await insertShadow(pg, WS, 'alice'));
      const res = await svc.addMembers(g, { externalIds: ['alice', 'bob', 'bob'], actorExternalId: 'boss' });
      expect(res).toEqual({ added: ['bob'], alreadyMember: ['alice'] });
      expect(await membersOf(g)).toEqual([shadowEmailFor('alice'), shadowEmailFor('bob')].sort());
      const again = await svc.addMembers(g, { externalIds: ['bob'], actorExternalId: 'boss' });
      expect(again).toEqual({ added: [], alreadyMember: ['bob'] });
      // Only user ids are ever written: every group_users row names a users row.
      const orphans = await pg`select 1 from group_users gu left join users u on u.id = gu.user_id where u.id is null`;
      expect(orphans).toHaveLength(0);
    });

    it('removes a member idempotently (removed: false when absent or never provisioned, nothing created)', async () => {
      const g = await insertGroup(pg, WS, 'team');
      await joinGroup(pg, g, await insertShadow(pg, WS, 'alice'));
      await expect(svc.removeMember(g, 'ALICE')).resolves.toEqual({ removed: true });
      await expect(svc.removeMember(g, 'alice')).resolves.toEqual({ removed: false });
      await expect(svc.removeMember(g, 'ghost')).resolves.toEqual({ removed: false });
      expect(await pg`select 1 from users where email = ${shadowEmailFor('ghost')}`).toHaveLength(0);
      await expect(svc.removeMember(g, 'bad id!')).rejects.toBeInstanceOf(BadRequestException);
      expect(await codeOf(svc.removeMember(uuid(999), 'alice'))).toMatchObject({ status: 404, code: 'group_not_found' });
    });
  });

  describe('delete never narrows: 409 group_in_use while the group grants anything', () => {
    it('refuses while a live space membership or a page grant names it, with counts; allows once both are gone', async () => {
      const g = await insertGroup(pg, WS, 'team');
      await joinGroup(pg, g, await insertShadow(pg, WS, 'alice'));
      const m = await insertMember(pg, S, { groupId: g }, 'reader');
      const perm = await insertGroupPageGrant(pg, WS, PAGE, g);
      expect(await codeOf(svc.delete(g))).toMatchObject({
        status: 409,
        code: 'group_in_use',
        body: expect.objectContaining({ spaceCount: 1, pageCount: 1 }),
      });
      await pg`delete from space_members where id = ${m}`;
      expect(await codeOf(svc.delete(g))).toMatchObject({ code: 'group_in_use', body: expect.objectContaining({ spaceCount: 0, pageCount: 1 }) });
      await pg`delete from page_permissions where id = ${perm}`;
      await insertMember(pg, S, { groupId: g }, 'reader', { deleted: true }); // a soft-deleted row grants nothing
      await expect(svc.delete(g)).resolves.toBeUndefined();
      expect(await pg`select 1 from groups where id = ${g}`).toHaveLength(0);
      expect(await pg`select 1 from group_users where group_id = ${g}`).toHaveLength(0);
    });
  });

  describe('ensureDefault (INV-5)', () => {
    it('names the default group with the integrator text and adds identities idempotently', async () => {
      const basic = await insertGroup(pg, WS, 'Everyone', { isDefault: true });
      const first = await svc.ensureDefault({ name: 'Basic access', description: 'No content', externalIds: ['alice', 'bob'] });
      expect(first).toEqual({ groupId: basic, renamed: true, added: ['alice', 'bob'] });
      expect(await groupRow(basic)).toEqual({ name: 'Basic access', description: 'No content' });
      const again = await svc.ensureDefault({ name: 'Basic access', description: 'No content', externalIds: ['alice'] });
      expect(again).toEqual({ groupId: basic, renamed: false, added: [] });
      expect(await membersOf(basic)).toEqual([shadowEmailFor('alice'), shadowEmailFor('bob')].sort());
    });

    it.each([
      ['a live space membership', async (g: string) => void (await insertMember(pg, S, { groupId: g }, 'writer'))],
      ['a page grant', async (g: string) => void (await insertGroupPageGrant(pg, WS, PAGE, g))],
    ])('refuses (409 basic_group_has_grants, logged, nothing written) while %s names it', async (_l, grant) => {
      const basic = await insertGroup(pg, WS, 'Everyone', { isDefault: true });
      await grant(basic);
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation();
      expect(await codeOf(svc.ensureDefault({ name: 'Basic access', externalIds: ['alice'] }))).toMatchObject({
        status: 409,
        code: 'basic_group_has_grants',
      });
      expect(warn.mock.calls.some(([m]) => String(m).startsWith('BASIC_GROUP_HAS_GRANTS'))).toBe(true);
      warn.mockRestore();
      expect(await groupRow(basic)).toEqual({ name: 'Everyone', description: null });
      expect(await membersOf(basic)).toEqual([]);
      expect(await pg`select 1 from users where email = ${shadowEmailFor('alice')}`).toHaveLength(0); // nobody provisioned
    });

    it('a soft-deleted space membership does not block it', async () => {
      const basic = await insertGroup(pg, WS, 'Everyone', { isDefault: true });
      await insertMember(pg, S, { groupId: basic }, 'writer', { deleted: true });
      await expect(svc.ensureDefault({ name: 'Basic access', externalIds: [] })).resolves.toMatchObject({ renamed: true });
    });

    it('409 group_name_taken when another group already has the name; 404 without a default group', async () => {
      await insertGroup(pg, WS, 'Basic Access');
      expect(await codeOf(svc.ensureDefault({ name: 'basic access', externalIds: [] }))).toMatchObject({
        status: 404,
        code: 'default_group_missing',
      });
      await insertGroup(pg, WS, 'Everyone', { isDefault: true });
      expect(await codeOf(svc.ensureDefault({ name: 'basic access', externalIds: [] }))).toMatchObject({
        status: 409,
        code: 'group_name_taken',
      });
    });
  });
});
