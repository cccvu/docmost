import * as postgres from 'postgres';
import { ForbiddenException } from '@nestjs/common';
import { ServiceBridgeService } from './service-bridge.service';
import { WorkspaceResolver } from './workspace-resolver';
import { shadowEmailFor } from './shadow-user';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  createReadModelTables,
  mkReadModelDb,
} from './read-model-pg.testkit';

/**
 * #455 — fork-side instant revocation against a REAL Postgres, with the REAL UserRepo + UserSessionRepo (so
 * the actual `deactivatedAt` write, the `revokeByUserId` sweep, and — decisively — the isUserDisabled
 * ROUND-TRIP through mintSession are proven, not just the orchestration the unit spec mocks). The security
 * claim: once a shadow user is deactivated, it can no longer read/write wiki content through the fork —
 * mintSession refuses it (disqualify → isUserDisabled), which is the same predicate jwt.strategy /
 * onAuthenticate enforce on `/api/*` and collab. reactivate reverses it.
 *
 * Self-skips without AUTHZ_TEST_PG_URL (the `docmost-authz` lane); the `docmost-authz-pg` lane sets
 * AUTHZ_REQUIRE_PG=1 so the anti-vacuity guard reds if that wiring regresses.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG revoke lane (#455)', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'service_bridge_revoke_pg_spec';
const DEFAULT_WS = uuid(100);

d('ServiceBridgeService.deactivateShadowUser / reactivateShadowUser on real Postgres (#455)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: any;
  let svc: ServiceBridgeService;

  // Faithful to the users migration for the columns UserRepo.baseFields SELECTs + provisioning writes, plus
  // deactivated_at (the #455 lever) and the (email, workspace_id) unique key the upsert targets.
  const createUsersTable = async (p: postgres.Sql): Promise<void> => {
    await p`
      create table users (
        id uuid primary key default gen_random_uuid(),
        name varchar, email varchar not null, email_verified_at timestamptz, avatar_url varchar,
        password varchar, role varchar, workspace_id uuid references workspaces(id) on delete cascade,
        locale varchar, timezone varchar, settings jsonb, last_login_at timestamptz,
        deactivated_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz, has_generated_password boolean not null default false,
        constraint users_email_workspace_id_unique unique (email, workspace_id)
      )`;
  };

  // The columns UserSessionRepo.findActiveByUser / revokeByUserId touch.
  const createUserSessionsTable = async (p: postgres.Sql): Promise<void> => {
    await p`
      create table user_sessions (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null, workspace_id uuid not null, device_name varchar, ip_address varchar,
        expires_at timestamptz not null, revoked_at timestamptz,
        last_active_at timestamptz not null default now(),
        created_at timestamptz not null default now(), geo_location jsonb
      )`;
  };

  const insertSession = async (userId: string, revoked = false): Promise<string> => {
    const id = uuid(Math.floor(Math.random() * 1e6) + 1000);
    await pg`insert into user_sessions (id, user_id, workspace_id, expires_at, revoked_at)
             values (${id}, ${userId}, ${DEFAULT_WS}, now() + interval '30 days', ${revoked ? pg`now()` : null})`;
    return id;
  };

  const activeSessionCount = async (userId: string): Promise<number> => {
    const rows = (await pg`select count(*)::int as c from user_sessions
                           where user_id = ${userId} and revoked_at is null and expires_at > now()`) as unknown as Array<{ c: number }>;
    return rows[0].c;
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
    await createUsersTable(pg);
    await createUserSessionsTable(pg);

    const userRepo = new UserRepo(db);
    const userSessionRepo = new UserSessionRepo(db);
    // mintSession refuses BEFORE createSessionAndToken for a deactivated user, so a token stub suffices; the
    // reactivate→mint-succeeds case only needs it to return a value.
    const sessionService = { createSessionAndToken: async () => 'minted-token' } as any;
    svc = new ServiceBridgeService(
      db,
      userRepo,
      userSessionRepo,
      sessionService,
      new WorkspaceResolver(db),
    );
  });

  afterAll(async () => {
    await appPg?.end({ timeout: 5 }).catch(() => undefined);
    await pg?.end({ timeout: 5 }).catch(() => undefined);
  });

  beforeEach(async () => {
    await pg`delete from user_sessions`;
    await pg`delete from users`;
    await pg`delete from workspaces`;
    await pg`insert into workspaces (id, name) values (${DEFAULT_WS}, 'default')`;
  });

  it('deactivate sets deactivated_at (never deleted_at) and revokes every live session', async () => {
    const { userId } = await svc.provisionShadowUser({ externalId: 'alice' } as any);
    await insertSession(userId);
    await insertSession(userId);
    expect(await activeSessionCount(userId)).toBe(2);

    const res = await svc.deactivateShadowUser('alice');

    expect(res).toEqual({ userId, deactivated: true, sessionsRevoked: 2 });
    const rows = (await pg`select deactivated_at, deleted_at from users where id = ${userId}`) as unknown as Array<any>;
    expect(rows[0].deactivated_at).not.toBeNull(); // the lever every fork auth entrypoint enforces
    expect(rows[0].deleted_at).toBeNull(); // disable is reversible — soft-delete is a different lifecycle
    expect(await activeSessionCount(userId)).toBe(0); // /api/* is cut on the next request
  });

  // THE security proof: a deactivated shadow user cannot obtain a fork session — mintSession refuses it via
  // disqualify → isUserDisabled, the same predicate that guards /api/* (jwt.strategy) and collab
  // (onAuthenticate). So the disabled identity cannot read/write wiki content through the fork.
  it('after deactivate, mintSession REFUSES the shadow user (cannot read/write wiki content)', async () => {
    await svc.provisionShadowUser({ externalId: 'alice' } as any);
    await expect(svc.mintSession('alice')).resolves.toBe('minted-token'); // live before

    await svc.deactivateShadowUser('alice');

    await expect(svc.mintSession('alice')).rejects.toBeInstanceOf(ForbiddenException); // refused after
  });

  it('reactivate clears deactivated_at and restores minting (re-enable)', async () => {
    const { userId } = await svc.provisionShadowUser({ externalId: 'alice' } as any);
    await svc.deactivateShadowUser('alice');
    await expect(svc.mintSession('alice')).rejects.toBeInstanceOf(ForbiddenException);

    const res = await svc.reactivateShadowUser('alice');

    expect(res).toEqual({ userId, reactivated: true });
    const rows = (await pg`select deactivated_at from users where id = ${userId}`) as unknown as Array<any>;
    expect(rows[0].deactivated_at).toBeNull();
    await expect(svc.mintSession('alice')).resolves.toBe('minted-token'); // usable again
  });

  it('deactivate is idempotent (retry-before-enable) — a second call still succeeds, no throw', async () => {
    await svc.provisionShadowUser({ externalId: 'alice' } as any);
    const first = await svc.deactivateShadowUser('alice');
    const second = await svc.deactivateShadowUser('alice');
    expect(first.deactivated).toBe(true);
    expect(second.deactivated).toBe(true); // no "already deactivated" throw (unlike native deactivateUser)
  });

  it('deactivate is a benign no-op for a never-provisioned identity', async () => {
    const res = await svc.deactivateShadowUser('never-logged-in');
    expect(res).toEqual({ userId: null, deactivated: false, sessionsRevoked: 0 });
  });

  it('reactivate is a no-op for an already-active user', async () => {
    const { userId } = await svc.provisionShadowUser({ externalId: 'alice' } as any);
    const res = await svc.reactivateShadowUser('alice');
    expect(res).toEqual({ userId, reactivated: false });
  });
});
