import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { ServiceSpaceService } from './service-space.service';
import { ServiceBridgeService } from './service-bridge.service';
import { shadowEmailFor } from './shadow-user';
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
 * Real-Postgres proof of the space control-plane MUTATION invariants (#486). The unit spec
 * (`service-space.service.spec.ts`) pins the statement shapes through a Kysely spy; only a real engine can
 * prove the row lock actually serializes two transactions, that the admin count sees the other transaction's
 * commit, and that the partial/unique indexes fire. Cases:
 *   - last-admin: a sole live admin cannot be demoted, removed or upsert-demoted; a group admin row counts; a
 *     soft-deleted admin does not; the guard holds on an archived space; a foreign-space memberId is a 404;
 *   - the space lock: FOR NO KEY UPDATE makes a second mutation WAIT (observed in pg_stat_activity, not by
 *     wall-clock) without blocking an FK insert, and a concurrent demote pair leaves exactly one admin;
 *   - rule M: no self-add, no raising a row that covers the actor (own row or a group they are in), case
 *     variants of either id included; narrowing and removal stay allowed. (A re-role WITHOUT its actor is a
 *     400 at the ValidationPipe — pinned in dto-validation.spec.ts and the wire spec, not reachable here.)
 *
 * Shadow users go through the REAL `ServiceBridgeService.provisionShadowUser` (the lower-cased shadow-email
 * upsert), so id canonicalization is the production code path. The testkit is reused unedited; the DDL it lacks
 * (the users table, the space_members unique key the upsert's ON CONFLICT names) is added here.
 *
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG space mutation gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'service_space_mutations_pg_spec';
const WS = uuid(100);
const S = uuid(1); // the space under test
const S_OTHER = uuid(2); // another space (cross-space memberId)
const GROUP = uuid(60);
const ACTOR = 'ops-admin'; // the acting identity where rule M is not under test (never covered by a row)

d('ServiceSpaceService member mutations on real Postgres (#486)', () => {
  jest.setTimeout(30_000); // provisioning bcrypt-hashes an unusable password per new shadow user

  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let bridge: ServiceBridgeService;
  let svc: ServiceSpaceService;

  /** A shadow user exactly as provisioning would create it (same lower-cased email key), without bcrypt. */
  const shadow = async (externalId: string): Promise<string> => {
    const rows = await pg<{ id: string }[]>`
      insert into users (email, name, role, workspace_id) values (${shadowEmailFor(externalId)}, ${externalId}, 'member', ${WS})
      on conflict (email, workspace_id) do update set deleted_at = null
      returning id`;
    return rows[0].id;
  };
  const space = (id: string, opts: { archived?: boolean } = {}) =>
    pg`insert into spaces (id, name, slug, workspace_id, deleted_at)
       values (${id}, ${'s-' + id.slice(-3)}, ${'s-' + id.slice(-3)}, ${WS}, ${opts.archived ? pg`now()` : null})`;
  const member = async (
    spaceId: string,
    subject: { userId?: string; groupId?: string },
    role: string,
    opts: { deleted?: boolean } = {},
  ): Promise<string> => {
    const rows = await pg<{ id: string }[]>`
      insert into space_members (user_id, group_id, space_id, role, added_by_id, deleted_at)
      values (${subject.userId ?? null}, ${subject.groupId ?? null}, ${spaceId}, ${role}, ${subject.userId ?? null},
              ${opts.deleted ? pg`now()` : null})
      returning id`;
    return rows[0].id;
  };
  const roleOf = async (memberId: string): Promise<string | undefined> =>
    ((await pg<{ role: string }[]>`select role from space_members where id = ${memberId}`)[0] ?? {}).role;
  const liveAdmins = async (spaceId: string): Promise<number> =>
    (await pg<{ n: number }[]>`
      select count(*)::int as n from space_members where space_id = ${spaceId} and role = 'admin' and deleted_at is null`)[0].n;

  /** Poll (no wall-clock assertion) until `n` backends are blocked on a heavyweight lock in our statement. */
  const waitForLockWaiters = async (n: number): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      const rows = await pg<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query ilike '%for no key update%'`;
      if (rows[0].n >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`never observed ${n} backend(s) waiting on the space lock`);
  };
  /** Hold the space row lock on a separate connection until the returned `release` is called. */
  const holdSpaceLock = async (spaceId: string) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const acquired = new Promise<void>((r) => (locked = r));
    const done = pg.begin(async (tx) => {
      // `unsafe` (bound param): postgres.js's TransactionSql type loses the tagged-template call signature.
      await tx.unsafe('select 1 from spaces where id = $1 for no key update', [spaceId]);
      locked();
      await gate;
    });
    await acquired;
    return { release, done };
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
    // What the read-model testkit omits: the upsert's ON CONFLICT target and the provisioning users table
    // (faithful to 20240324T085900-spaces.ts / 20240324T085600-users.ts for the columns touched).
    await pg`alter table space_members add constraint space_members_space_id_user_id_unique unique (space_id, user_id)`;
    await pg`
      create table users (
        id uuid primary key default gen_random_uuid(), name varchar, email varchar not null,
        email_verified_at timestamptz, password varchar, avatar_url varchar, role varchar, workspace_id uuid,
        locale varchar, timezone varchar, settings jsonb, last_login_at timestamptz, deactivated_at timestamptz,
        has_generated_password boolean default false,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint users_email_workspace_id_unique unique (email, workspace_id)
      )`;
    // Rule M's group coverage reads group_users (faithful to 20240324T085700-groups.ts minus the FKs).
    await pg`
      create table group_users (
        id uuid primary key default gen_random_uuid(), user_id uuid not null, group_id uuid not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint group_users_group_id_user_id_unique unique (group_id, user_id)
      )`;
    // A child table with an FK to spaces: proves the space lock does not block FK KEY SHARE.
    await pg`create table fk_probe (id serial primary key, space_id uuid not null references spaces(id))`;

    const resolver = fakeWorkspaceResolver(WS);
    bridge = new ServiceBridgeService(db as any, new UserRepo(db as any), {} as any, {} as any, resolver, {} as any);
    svc = new ServiceSpaceService(db as any, resolver, bridge);
  });

  afterAll(async () => {
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
    await appPg?.end?.({ timeout: 5 });
  });

  beforeEach(async () => {
    await pg`delete from fk_probe`;
    await pg`delete from group_users`;
    await pg`delete from space_members`;
    await pg`delete from spaces`;
    await pg`delete from users`;
    await space(S);
    await space(S_OTHER);
  });

  describe('last-admin invariant', () => {
    it('a sole live admin cannot be demoted, removed or upsert-demoted (row unchanged)', async () => {
      const alice = await shadow('alice');
      const m = await member(S, { userId: alice }, 'admin');
      await member(S, { userId: await shadow('bob') }, 'writer');

      await expect(svc.changeMemberRole(S, m, 'writer', ACTOR)).rejects.toBeInstanceOf(ConflictException);
      await expect(svc.removeMember(S, m)).rejects.toBeInstanceOf(ConflictException);
      await expect(
        svc.addMember(S, { externalId: 'alice', role: 'reader', addedByExternalId: 'bob' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await roleOf(m)).toBe('admin');
    });

    it('a GROUP admin row counts as another admin (upstream parity): the user admin can go', async () => {
      const alice = await shadow('alice');
      const m = await member(S, { userId: alice }, 'admin');
      await member(S, { groupId: GROUP }, 'admin');
      await expect(svc.changeMemberRole(S, m, 'reader', ACTOR)).resolves.toBeUndefined();
      expect(await roleOf(m)).toBe('reader');
      await expect(svc.removeMember(S, m)).resolves.toBeUndefined();
      expect(await roleOf(m)).toBeUndefined();
    });

    it('a SOFT-DELETED admin row does not count as another admin', async () => {
      const m = await member(S, { userId: await shadow('alice') }, 'admin');
      await member(S, { userId: await shadow('bob') }, 'admin', { deleted: true });
      await expect(svc.changeMemberRole(S, m, 'writer', ACTOR)).rejects.toBeInstanceOf(ConflictException);
      await expect(svc.removeMember(S, m)).rejects.toBeInstanceOf(ConflictException);
    });

    it('removing the last direct admin of an ARCHIVED space is still refused (remove stays allowed there)', async () => {
      await pg`update spaces set deleted_at = now() where id = ${S}`;
      const admin = await member(S, { userId: await shadow('alice') }, 'admin');
      const writer = await member(S, { userId: await shadow('bob') }, 'writer');
      await expect(svc.removeMember(S, admin)).rejects.toBeInstanceOf(ConflictException);
      await expect(svc.removeMember(S, writer)).resolves.toBeUndefined(); // non-admin removal still works
    });

    it('a memberId from ANOTHER space is a 404 for change and remove (never a cross-space write)', async () => {
      const foreign = await member(S_OTHER, { userId: await shadow('alice') }, 'writer');
      await expect(svc.changeMemberRole(S, foreign, 'admin', ACTOR)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.removeMember(S, foreign)).rejects.toBeInstanceOf(NotFoundException);
      expect(await roleOf(foreign)).toBe('writer');
    });
  });

  describe('the space row lock', () => {
    it('makes a member mutation WAIT on a held FOR NO KEY UPDATE, without blocking an FK insert', async () => {
      await member(S, { userId: await shadow('alice') }, 'admin');
      const m = await member(S, { userId: await shadow('bob') }, 'writer');
      const holder = await holdSpaceLock(S);

      let settled = false;
      const change = svc.changeMemberRole(S, m, 'reader', ACTOR).finally(() => (settled = true));
      await waitForLockWaiters(1); // the bridge transaction is blocked on the space row, observed in the engine
      expect(settled).toBe(false);
      // NO KEY UPDATE is compatible with the FOR KEY SHARE an FK check takes: content writes are not held up.
      await pg`insert into fk_probe (space_id) values (${S})`;

      holder.release();
      await holder.done;
      await expect(change).resolves.toBeUndefined();
      expect(await roleOf(m)).toBe('reader');
    });

    it('serializes a concurrent demote pair: exactly one wins, one 409s, one live admin remains', async () => {
      const a = await member(S, { userId: await shadow('alice') }, 'admin');
      const b = await member(S, { userId: await shadow('bob') }, 'admin');
      const holder = await holdSpaceLock(S);
      const both = Promise.allSettled([svc.changeMemberRole(S, a, 'writer', ACTOR), svc.changeMemberRole(S, b, 'writer', ACTOR)]);
      await waitForLockWaiters(2); // both are genuinely in flight at once, queued behind the holder
      holder.release();
      await holder.done;

      const results = await both;
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect(await liveAdmins(S)).toBe(1);
    });
  });
  describe('rule M — no self-raising membership writes', () => {
    const selfGrant = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'self_grant' });
    };
    const memberCount = async (): Promise<number> =>
      (await pg<{ n: number }[]>`select count(*)::int as n from space_members where space_id = ${S}`)[0].n;

    it.each(['reader', 'writer', 'admin'] as const)('refuses adding yourself as %s (nothing written)', async (role) => {
      await member(S, { userId: await shadow('boss') }, 'admin');
      await selfGrant(svc.addMember(S, { externalId: 'alice', role, addedByExternalId: 'alice' }));
      expect(await memberCount()).toBe(1);
    });

    it('refuses a case variant of your own externalId (both resolve to ONE shadow user)', async () => {
      await selfGrant(svc.addMember(S, { externalId: 'ALICE', role: 'reader', addedByExternalId: 'alice' }));
      expect(await memberCount()).toBe(0);
    });

    it('refuses an upsert raising your own row; allows the upsert that demotes it', async () => {
      const alice = await shadow('alice');
      const own = await member(S, { userId: alice }, 'reader');
      await member(S, { userId: await shadow('boss') }, 'admin');
      await selfGrant(svc.addMember(S, { externalId: 'alice', role: 'admin', addedByExternalId: 'alice' }));
      expect(await roleOf(own)).toBe('reader');

      await pg`update space_members set role = 'admin' where id = ${own}`;
      await expect(
        svc.addMember(S, { externalId: 'alice', role: 'reader', addedByExternalId: 'alice' }),
      ).resolves.toMatchObject({ memberId: own });
      expect(await roleOf(own)).toBe('reader');
    });

    it('refuses reviving your own SOFT-DELETED row (it ranks as no membership)', async () => {
      const own = await member(S, { userId: await shadow('alice') }, 'admin', { deleted: true });
      await selfGrant(svc.addMember(S, { externalId: 'alice', role: 'reader', addedByExternalId: 'alice' }));
      const rows = await pg<{ deletedAt: Date | null }[]>`select deleted_at from space_members where id = ${own}`;
      expect(rows[0].deletedAt).not.toBeNull();
    });

    it('PATCH: refuses raising your own row (also via an upper-cased memberId or actor id); allows demoting it', async () => {
      const own = await member(S, { userId: await shadow('alice') }, 'writer');
      await member(S, { userId: await shadow('boss') }, 'admin');
      await selfGrant(svc.changeMemberRole(S, own, 'admin', 'alice'));
      await selfGrant(svc.changeMemberRole(S, own.toUpperCase(), 'admin', 'alice'));
      await selfGrant(svc.changeMemberRole(S, own, 'admin', 'ALICE'));
      expect(await roleOf(own)).toBe('writer');

      await expect(svc.changeMemberRole(S, own, 'reader', 'alice')).resolves.toBeUndefined();
      expect(await roleOf(own)).toBe('reader');
    });

    it('PATCH: a group row the actor belongs to cannot be raised, but can be demoted', async () => {
      const alice = await shadow('alice');
      await pg`insert into group_users (user_id, group_id) values (${alice}, ${GROUP})`;
      const grp = await member(S, { groupId: GROUP }, 'reader');
      await member(S, { userId: await shadow('boss') }, 'admin');
      await selfGrant(svc.changeMemberRole(S, grp, 'writer', 'alice'));
      expect(await roleOf(grp)).toBe('reader');

      await pg`update space_members set role = 'admin' where id = ${grp}`;
      await expect(svc.changeMemberRole(S, grp, 'reader', 'alice')).resolves.toBeUndefined();
      expect(await roleOf(grp)).toBe('reader');
    });

    it("PATCH: raising a group row the actor is NOT in (or another user's row) is allowed", async () => {
      await shadow('alice');
      await pg`insert into group_users (user_id, group_id) values (${await shadow('carol')}, ${GROUP})`;
      const grp = await member(S, { groupId: GROUP }, 'reader');
      const bob = await member(S, { userId: await shadow('bob') }, 'reader');
      await expect(svc.changeMemberRole(S, grp, 'admin', 'alice')).resolves.toBeUndefined();
      await expect(svc.changeMemberRole(S, bob, 'writer', 'alice')).resolves.toBeUndefined();
      expect([await roleOf(grp), await roleOf(bob)]).toEqual(['admin', 'writer']);
    });

    it('PATCH: an actor that was never provisioned is covered by nothing, and is not created', async () => {
      const grp = await member(S, { groupId: GROUP }, 'reader');
      await expect(svc.changeMemberRole(S, grp, 'writer', 'nobody')).resolves.toBeUndefined();
      const rows = await pg`select 1 from users where email = ${shadowEmailFor('nobody')}`;
      expect(rows).toHaveLength(0);
    });

    it('removing yourself, or a group you belong to, stays allowed', async () => {
      const alice = await shadow('alice');
      await pg`insert into group_users (user_id, group_id) values (${alice}, ${GROUP})`;
      await member(S, { userId: await shadow('boss') }, 'admin');
      const own = await member(S, { userId: alice }, 'admin');
      const grp = await member(S, { groupId: GROUP }, 'writer');
      await expect(svc.removeMember(S, own)).resolves.toBeUndefined();
      await expect(svc.removeMember(S, grp)).resolves.toBeUndefined();
      expect(await memberCount()).toBe(1);
    });
  });
});
