import * as postgres from 'postgres';
import { JwtService } from '@nestjs/jwt';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { TokenService } from '../core/auth/services/token.service';
import { JwtType } from '../core/auth/dto/jwt-payload';
import { SessionRevokeOthersService } from './session-revoke-others.service';
import { WorkspaceResolver } from './workspace-resolver';
import { shadowEmailFor } from './shadow-user';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  createReadModelTables,
  mkReadModelDb,
} from './read-model-pg.testkit';

/**
 * wiki-v2 #818 — `revoke-others` on a REAL Postgres with the REAL UserRepo + UserSessionRepo + TokenService: the
 * session a valid keep token proves survives, every other live session of the user is revoked (the count is the
 * real `numUpdatedRows`), another user's sessions and `deactivated_at` are untouched, and a token that proves
 * nothing revokes them all.
 *
 * Self-skips without AUTHZ_TEST_PG_URL (the `docmost-authz` lane); the `docmost-authz-pg` lane sets
 * AUTHZ_REQUIRE_PG=1 so the anti-vacuity guard reds if that wiring regresses.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG revoke-others lane (#818)', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'session_revoke_others_pg_spec';
const WS = uuid(100);
const ALICE = uuid(201);
const BOB = uuid(202);
const SECRET = 'fork-app-secret-for-pg-tests-0123456789';

d('SessionRevokeOthersService on real Postgres (#818)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let svc: SessionRevokeOthersService;
  let jwt: JwtService;
  let nextSession = 1000;

  const insertUser = async (id: string, externalId: string): Promise<void> => {
    await pg`insert into users (id, name, email, role, workspace_id)
             values (${id}, ${externalId}, ${shadowEmailFor(externalId)}, 'member', ${WS})`;
  };

  const insertSession = async (
    userId: string,
    opts: { revoked?: boolean; expired?: boolean } = {},
  ): Promise<string> => {
    const id = uuid(nextSession++);
    await pg`insert into user_sessions (id, user_id, workspace_id, expires_at, revoked_at)
             values (${id}, ${userId}, ${WS},
                     ${opts.expired ? pg`now() - interval '1 day'` : pg`now() + interval '30 days'`},
                     ${opts.revoked ? pg`now()` : null})`;
    return id;
  };

  const liveSessions = async (userId: string): Promise<string[]> => {
    const rows = (await pg`select id from user_sessions
                           where user_id = ${userId} and revoked_at is null order by id`) as unknown as Array<{
      id: string;
    }>;
    return rows.map((r) => r.id);
  };

  const accessToken = (sub: string, sessionId: string): string =>
    jwt.sign({
      sub,
      email: 'x',
      workspaceId: WS,
      type: JwtType.ACCESS,
      sessionId,
    });

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 2);
    const db = mkReadModelDb(appPg) as any;
    await createReadModelTables(pg);
    await pg`
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
    await pg`
      create table user_sessions (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null, workspace_id uuid not null, device_name varchar, ip_address varchar,
        expires_at timestamptz not null, revoked_at timestamptz,
        last_active_at timestamptz not null default now(),
        created_at timestamptz not null default now(), geo_location jsonb
      )`;
    jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '1h' } });
    svc = new SessionRevokeOthersService(
      db,
      new UserRepo(db),
      new UserSessionRepo(db),
      new TokenService(jwt, { getAppSecret: () => SECRET } as any),
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
    await pg`insert into workspaces (id, name) values (${WS}, 'default')`;
    await insertUser(ALICE, 'alice');
    await insertUser(BOB, 'bob');
  });

  it('keeps the session the keep token proves, revokes the user’s other live sessions, touches nothing else', async () => {
    const current = await insertSession(ALICE);
    await insertSession(ALICE);
    await insertSession(ALICE);
    await insertSession(ALICE, { revoked: true }); // already revoked: not counted again
    const bobs = await insertSession(BOB);

    await expect(
      svc.revokeOtherSessions('alice', accessToken(ALICE, current)),
    ).resolves.toEqual({
      userId: ALICE,
      revoked: 2,
      kept: true,
    });

    expect(await liveSessions(ALICE)).toEqual([current]);
    expect(await liveSessions(BOB)).toEqual([bobs]);
    const users =
      (await pg`select deactivated_at from users where id = ${ALICE}`) as unknown as Array<any>;
    expect(users[0].deactivated_at).toBeNull(); // never deactivates
    // A repeat is a no-op that still keeps the session.
    await expect(
      svc.revokeOtherSessions('alice', accessToken(ALICE, current)),
    ).resolves.toEqual({
      userId: ALICE,
      revoked: 0,
      kept: true,
    });
  });

  it.each<
    [
      string,
      (s: {
        current: string;
        bobs: string;
        expired: string;
      }) => string | undefined,
    ]
  >([
    ['no keep token', () => undefined],
    [
      'another user’s token for that user’s session',
      (s) => accessToken(BOB, s.bobs),
    ],
    [
      'a token claiming Alice but naming Bob’s session',
      (s) => accessToken(ALICE, s.bobs),
    ],
    [
      'a token naming Alice’s expired session',
      (s) => accessToken(ALICE, s.expired),
    ],
  ])(
    '%s → keeps nothing and revokes every live session of the user',
    async (_label, token) => {
      const current = await insertSession(ALICE);
      await insertSession(ALICE);
      const expired = await insertSession(ALICE, { expired: true });
      const bobs = await insertSession(BOB);

      const res = await svc.revokeOtherSessions(
        'alice',
        token({ current, bobs, expired }),
      );

      expect(res).toEqual({ userId: ALICE, revoked: 3, kept: false }); // the expired row is unrevoked, so it counts
      expect(await liveSessions(ALICE)).toEqual([]);
      expect(await liveSessions(BOB)).toEqual([bobs]);
    },
  );

  it('a never-provisioned identity is a no-op', async () => {
    await insertSession(ALICE);
    await expect(svc.revokeOtherSessions('never-signed-in')).resolves.toEqual({
      userId: null,
      revoked: 0,
      kept: false,
    });
    expect(await liveSessions(ALICE)).toHaveLength(1);
  });
});
