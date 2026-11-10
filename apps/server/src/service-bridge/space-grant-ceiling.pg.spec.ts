import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { ServiceSpaceService } from './service-space.service';
import { SpaceGrantCeiling } from './space-grant-ceiling';
import { shadowEmailFor } from './shadow-user';
import { PG_URL, uuid, fakeWorkspaceResolver, mkReadModelPg, bootstrapSchema, mkReadModelDb } from './read-model-pg.testkit';
import { createGroupTables, truncateGroupTables } from './groups-pg.testkit';

/**
 * Real-Postgres proof of wiki-v2 #797's space-member invariants, through the REAL ServiceSpaceService and the REAL
 * SpaceGrantCeiling (only the authorization service is a stub):
 *  - INV-2, the full matrix: actor holding (PDP view / edit+share / edit only / a manage_members-only binding / the
 *    workspace cascade; local reader / writer / direct admin / admin through a group; nothing) × requested role ×
 *    user or group subject × the real write or its preview. Local rows decide without the PDP and without a fence;
 *    the PDP is asked only after the settle fence; a demotion is never checked;
 *  - a grant racing a just-committed narrowing is refused: the actor's local row is gone and the PDP is stale until
 *    the fence, so only fence-then-decide refuses it; an unconfirmed fence or an unanswering PDP is a 503;
 *  - the group branch: rule M (adding or raising a group you are in), last admin, `atLeast`, the workspace check,
 *    a deleted group, and INV-5 (the default group is never added or re-roled; removing it stays allowed).
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

describe('real-PG space grant ceiling gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'space_grant_ceiling_pg_spec';
const WS = uuid(100);
const WS_OTHER = uuid(101);
const S = uuid(1);

type Role = 'reader' | 'writer' | 'admin';

/** What the stub PDP answers: `${principalId}|${permission}|${resourceType}|${resourceId}` → allowed. */
class StubPdp {
  granted = new Set<string>();
  /** Applied by a confirmed settle: what the PDP knows once the relay caught up. */
  pendingRevoke = new Set<string>();
  settleStatus: 'confirmed' | 'pending' = 'confirmed';
  unavailable = false;
  calls: string[] = [];

  grant(principal: string, ...perms: string[]) {
    for (const p of perms) {
      const [permission, resourceType, resourceId] =
        p === 'admin_cascade' ? ['admin_cascade', 'workspace', WS] : [p, 'space', S];
      this.granted.add(`${principal}|${permission}|${resourceType}|${resourceId}`);
    }
  }

  readonly client = {
    tryCheckBulk: jest.fn(async (subject: any, checks: any[]) => {
      this.calls.push('check');
      if (this.unavailable) return null;
      return checks.map((c) => this.granted.has(`${subject.principalId}|${c.permission}|${c.resourceType}|${c.resourceId}`));
    }),
    settleProjection: jest.fn(async () => {
      this.calls.push('settle');
      if (this.settleStatus !== 'confirmed') return { status: 'pending' as const, reason: 'timeout' };
      for (const k of this.pendingRevoke) this.granted.delete(k);
      this.pendingRevoke.clear();
      return { status: 'confirmed' as const };
    }),
  };
}

const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    const r: any = await p;
    if (r && r.outcome === 'refused') return r.code;
    return 'ok';
  } catch (e: any) {
    return e?.getResponse?.()?.code ?? `status:${e?.getStatus?.() ?? e?.message}`;
  }
};

d('ServiceSpaceService INV-2 / INV-5 / group branch on real Postgres (#797)', () => {
  jest.setTimeout(120_000);

  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let pdp: StubPdp;
  let svc: ServiceSpaceService;
  let target: string; // the group the actor adds (the actor is not in it)
  let adminGroup: string; // a group holding a direct admin row on S

  const roleOf = async (memberId: string) =>
    ((await pg<{ role: string }[]>`select role from space_members where id = ${memberId}`)[0] ?? {}).role;
  const liveRow = async (subject: { userId?: string; groupId?: string }) =>
    (
      await pg<{ id: string; role: string }[]>`
        select id, role from space_members where space_id = ${S} and deleted_at is null
          and ${subject.userId ? pg`user_id = ${subject.userId}` : pg`group_id = ${subject.groupId!}`}`
    )[0];

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(appPg);
    await createGroupTables(pg);
    // The settle fence reads the max committed outbox position.
    await pg`create table authz_outbox (id bigserial primary key, xact_id xid8 not null default pg_current_xact_id())`;
    await pg`insert into authz_outbox default values`;
  });

  afterAll(async () => {
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
    await appPg?.end?.({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateGroupTables(pg);
    await insertSpace(pg, WS, S);
    await insertMember(pg, S, { userId: await insertShadow(pg, WS, 'boss') }, 'admin'); // keeps last-admin out of the way
    target = await insertGroup(pg, WS, 'target');
    adminGroup = await insertGroup(pg, WS, 'admins');
    await insertMember(pg, S, { groupId: adminGroup }, 'admin');
    pdp = new StubPdp();
    const resolver = fakeWorkspaceResolver(WS);
    // A bridge backed by the same rows (the real provisioning upsert is proven in service-space-mutations.pg.spec.ts).
    const bridge = {
      provisionShadowUser: async ({ externalId }: { externalId: string }) => ({
        userId: await insertShadow(pg, WS, externalId),
        workspaceId: WS,
      }),
      findShadowUserId: async (externalId: string) =>
        (await pg<{ id: string }[]>`select id from users where email = ${shadowEmailFor(externalId)}`)[0]?.id ?? null,
    };
    svc = new ServiceSpaceService(
      db as any,
      resolver,
      bridge as any,
      undefined,
      new SpaceGrantCeiling(db as any, pdp.client as any),
    );
  });

  /** Actor fixtures: the actor's externalId is its PDP principal id. */
  const ACTORS: Record<string, { setup: (id: string) => Promise<void>; covers: Role[]; local: boolean }> = {
    pdpView: { setup: async (a) => pdp.grant(a, 'view'), covers: ['reader'], local: false },
    pdpEditShare: { setup: async (a) => pdp.grant(a, 'view', 'edit', 'share'), covers: ['reader', 'writer'], local: false },
    pdpEditNoShare: { setup: async (a) => pdp.grant(a, 'view', 'edit'), covers: ['reader'], local: false },
    manageMembersOnly: { setup: async (a) => pdp.grant(a, 'administer'), covers: [], local: false },
    workspaceCascade: {
      setup: async (a) => pdp.grant(a, 'view', 'edit', 'share', 'administer', 'admin_cascade'),
      covers: ['reader', 'writer', 'admin'],
      local: false,
    },
    localReader: {
      setup: async (a) => void (await insertMember(pg, S, { userId: await insertShadow(pg, WS, a) }, 'reader')),
      covers: ['reader'],
      local: true,
    },
    localWriter: {
      setup: async (a) => void (await insertMember(pg, S, { userId: await insertShadow(pg, WS, a) }, 'writer')),
      covers: ['reader', 'writer'],
      local: true,
    },
    directAdmin: {
      setup: async (a) => void (await insertMember(pg, S, { userId: await insertShadow(pg, WS, a) }, 'admin')),
      covers: ['reader', 'writer', 'admin'],
      local: true,
    },
    groupAdmin: {
      setup: async (a) => joinGroup(pg, adminGroup, await insertShadow(pg, WS, a)),
      covers: ['reader', 'writer', 'admin'],
      local: true,
    },
    softDeletedAdminRow: {
      setup: async (a) =>
        void (await insertMember(pg, S, { userId: await insertShadow(pg, WS, a) }, 'admin', { deleted: true })),
      covers: [],
      local: false,
    },
    nothing: { setup: async () => undefined, covers: [], local: false },
  };

  const ROLES: Role[] = ['reader', 'writer', 'admin'];
  const MATRIX = Object.entries(ACTORS).flatMap(([name, a]) =>
    ROLES.flatMap((role) =>
      (['user', 'group'] as const).flatMap((kind) =>
        (['write', 'preview'] as const).map((how) => ({ name, a, role, kind, how, allowed: a.covers.includes(role) })),
      ),
    ),
  );

  it.each(MATRIX.map((m) => [`${m.name} grants ${m.role} to a ${m.kind} (${m.how}) → ${m.allowed ? 'allowed' : 'refused'}`, m]))(
    'INV-2: %s',
    async (_label, m) => {
      const actor = `actor-${m.name.toLowerCase()}`;
      await m.a.setup(actor);
      const subject = m.kind === 'user' ? { externalId: 'grantee' } : { groupId: target };
      const call =
        m.how === 'write'
          ? svc.addMember(S, { ...subject, role: m.role, addedByExternalId: actor })
          : svc.previewMember(S, { action: 'add', ...subject, role: m.role, addedByExternalId: actor });
      expect(await outcome(call)).toBe(m.allowed ? 'ok' : 'grant_exceeds_actor');

      const granteeId =
        m.kind === 'user'
          ? (await pg<{ id: string }[]>`select id from users where email = ${shadowEmailFor('grantee')}`)[0]?.id
          : undefined;
      const row = m.kind === 'user' ? (granteeId ? await liveRow({ userId: granteeId }) : undefined) : await liveRow({ groupId: target });
      expect(row?.role).toBe(m.how === 'write' && m.allowed ? m.role : undefined);

      // Decided locally ⇒ no fence and no PDP call; otherwise the fence strictly before the PDP.
      const localDecides = m.a.local && m.allowed;
      expect(pdp.calls).toEqual(localDecides ? [] : ['settle', 'check']);
    },
  );

  it('INV-2 holds on a role change too (write and preview), and a demotion is never checked', async () => {
    const reader = await insertMember(pg, S, { userId: await insertShadow(pg, WS, 'someone') }, 'reader');
    const writerGroup = await insertMember(pg, S, { groupId: target }, 'writer');
    pdp.grant('actor-v', 'view');
    expect(await outcome(svc.changeMemberRole(S, reader, 'writer', 'actor-v'))).toBe('grant_exceeds_actor');
    expect(await outcome(svc.previewMember(S, { action: 'update', memberId: reader, role: 'writer', actorExternalId: 'actor-v' }))).toBe(
      'grant_exceeds_actor',
    );
    expect(await roleOf(reader)).toBe('reader');
    pdp.calls = [];
    // A demotion by an actor holding nothing at all: not a grant, so not checked (no fence, no PDP).
    expect(await outcome(svc.changeMemberRole(S, writerGroup, 'reader', 'nobody-at-all'))).toBe('ok');
    expect(await roleOf(writerGroup)).toBe('reader');
    expect(pdp.calls).toEqual([]);
    // Removal stays open.
    await expect(svc.removeMember(S, writerGroup)).resolves.toBeUndefined();
  });

  it('a demotion through the add upsert (mode set) is not a grant: no ceiling, no fence, no PDP', async () => {
    const someone = await insertMember(pg, S, { userId: await insertShadow(pg, WS, 'someone') }, 'writer');
    const group = await insertMember(pg, S, { groupId: target }, 'writer');
    await insertShadow(pg, WS, 'holds-nothing');
    expect(await outcome(svc.addMember(S, { externalId: 'someone', role: 'reader', addedByExternalId: 'holds-nothing' }))).toBe('ok');
    expect(await outcome(svc.addMember(S, { groupId: target, role: 'reader', addedByExternalId: 'holds-nothing' }))).toBe('ok');
    expect([await roleOf(someone), await roleOf(group)]).toEqual(['reader', 'reader']);
    expect(pdp.calls).toEqual([]);
  });

  it('a grant racing a just-committed narrowing is refused: local row gone, PDP stale until the fence', async () => {
    const actor = 'actor-race';
    const actorId = await insertShadow(pg, WS, actor);
    const own = await insertMember(pg, S, { userId: actorId }, 'writer');
    // The actor's writer row is removed and COMMITTED; the PDP has not projected it yet (it still allows) — the
    // relay catches up only when the fence is settled.
    await pg`delete from space_members where id = ${own}`;
    pdp.grant(actor, 'view', 'edit', 'share');
    for (const p of ['view', 'edit', 'share']) pdp.pendingRevoke.add(`${actor}|${p}|space|${S}`);

    expect(await outcome(svc.addMember(S, { externalId: 'grantee', role: 'writer', addedByExternalId: actor }))).toBe(
      'grant_exceeds_actor',
    );
    expect(pdp.calls).toEqual(['settle', 'check']);
    expect(await pg`select 1 from users u join space_members m on m.user_id = u.id where u.email = ${shadowEmailFor('grantee')}`).toHaveLength(0);
  });

  it('an unconfirmed fence is a 503 grant_unconfirmed and a PDP that cannot answer a 503; nothing is written', async () => {
    pdp.grant('actor-c', 'admin_cascade');
    pdp.settleStatus = 'pending';
    jest.spyOn((svc as any).ceiling.logger, 'warn').mockImplementation();
    expect(await outcome(svc.addMember(S, { groupId: target, role: 'admin', addedByExternalId: 'actor-c' }))).toBe('grant_unconfirmed');
    expect(pdp.calls).toEqual(['settle']); // never decided on an unfenced PDP
    pdp.settleStatus = 'confirmed';
    pdp.unavailable = true;
    expect(await outcome(svc.addMember(S, { groupId: target, role: 'admin', addedByExternalId: 'actor-c' }))).toBe('status:503');
    expect(await liveRow({ groupId: target })).toBeUndefined();
  });

  describe('the group branch', () => {
    it('rule M: adding (or raising) a group the actor is in is self_grant, even for a space admin', async () => {
      const actorId = await insertShadow(pg, WS, 'actor-m');
      await insertMember(pg, S, { userId: actorId }, 'admin');
      await joinGroup(pg, target, actorId);
      expect(await outcome(svc.addMember(S, { groupId: target, role: 'reader', addedByExternalId: 'actor-m' }))).toBe('self_grant');
      expect(await outcome(svc.previewMember(S, { action: 'add', groupId: target, role: 'reader', addedByExternalId: 'actor-m' }))).toBe(
        'self_grant',
      );
      const row = await insertMember(pg, S, { groupId: target }, 'reader');
      expect(await outcome(svc.changeMemberRole(S, row, 'writer', 'actor-m'))).toBe('self_grant');
      expect(await outcome(svc.addMember(S, { groupId: target, role: 'reader', addedByExternalId: 'actor-m' }))).toBe('ok'); // same role
    });

    it('last admin: an upsert demoting the only live admin (a group row) is 409', async () => {
      await pg`delete from space_members where space_id = ${S}`;
      await insertMember(pg, S, { groupId: target }, 'admin');
      await insertShadow(pg, WS, 'actor-l');
      expect(await outcome(svc.addMember(S, { groupId: target, role: 'writer', addedByExternalId: 'actor-l' }))).toBe('status:409');
    });

    it("mode atLeast never lowers (applied: false, row unchanged) but still raises (checked)", async () => {
      const row = await insertMember(pg, S, { groupId: target }, 'writer');
      pdp.grant('actor-a', 'admin_cascade');
      const kept = await svc.addMember(S, { groupId: target, role: 'reader', mode: 'atLeast', addedByExternalId: 'actor-a' });
      expect(kept).toMatchObject({ memberId: row, groupId: target, userId: null, applied: false });
      expect(await roleOf(row)).toBe('writer');
      expect(pdp.calls).toEqual([]); // nothing granted, nothing checked
      const raised = await svc.addMember(S, { groupId: target, role: 'admin', mode: 'atLeast', addedByExternalId: 'actor-a' });
      expect(raised).toMatchObject({ memberId: row, applied: true });
      expect(await roleOf(row)).toBe('admin');
      // The default mode still sets exactly the role (it may demote).
      await svc.addMember(S, { groupId: target, role: 'reader', addedByExternalId: 'boss' });
      expect(await roleOf(row)).toBe('reader');
    });

    it('a group of another workspace, a soft-deleted group and an unknown id are 404 group_not_found', async () => {
      const foreign = await insertGroup(pg, WS_OTHER, 'foreign');
      const gone = await insertGroup(pg, WS, 'gone');
      await pg`update groups set deleted_at = now() where id = ${gone}`;
      for (const groupId of [foreign, gone, uuid(999)]) {
        expect(await outcome(svc.addMember(S, { groupId, role: 'reader', addedByExternalId: 'boss' }))).toBe('group_not_found');
      }
    });

    it('INV-5: the default group is never added or re-roled (400 basic_group_not_grantable); removing it stays allowed', async () => {
      const basic = await insertGroup(pg, WS, 'Everyone', { isDefault: true });
      pdp.grant('actor-w', 'admin_cascade');
      for (const role of ['reader', 'writer', 'admin'] as const) {
        expect(await outcome(svc.addMember(S, { groupId: basic, role, addedByExternalId: 'actor-w' }))).toBe('basic_group_not_grantable');
        expect(await outcome(svc.previewMember(S, { action: 'add', groupId: basic, role, addedByExternalId: 'actor-w' }))).toBe(
          'basic_group_not_grantable',
        );
      }
      const legacy = await insertMember(pg, S, { groupId: basic }, 'writer');
      for (const role of ['reader', 'admin'] as const) {
        expect(await outcome(svc.changeMemberRole(S, legacy, role, 'actor-w'))).toBe('basic_group_not_grantable');
      }
      expect(await outcome(svc.previewMember(S, { action: 'update', memberId: legacy, role: 'reader', actorExternalId: 'actor-w' }))).toBe(
        'basic_group_not_grantable',
      );
      expect(await roleOf(legacy)).toBe('writer');
      await expect(svc.removeMember(S, legacy)).resolves.toBeUndefined();
      expect(await roleOf(legacy)).toBeUndefined();
    });

    it('exactly one subject: both or neither is a 400', async () => {
      expect(await outcome(svc.addMember(S, { role: 'reader', addedByExternalId: 'boss' } as any))).toBe('status:400');
      expect(await outcome(svc.addMember(S, { externalId: 'x', groupId: target, role: 'reader', addedByExternalId: 'boss' }))).toBe(
        'status:400',
      );
    });
  });
});
