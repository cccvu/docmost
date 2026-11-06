import * as postgres from 'postgres';
import { CallHandler, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { decode } from 'jsonwebtoken';
import { lastValueFrom, of } from 'rxjs';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { TokenService } from '../../core/auth/services/token.service';
import { SessionService } from '../../core/session/session.service';
import { ServiceBridgeService } from '../../service-bridge/service-bridge.service';
import { WorkspaceResolver } from '../../service-bridge/workspace-resolver';
import {
  PG_URL,
  bootstrapSchema,
  createReadModelTables,
  mkReadModelDb,
  mkReadModelPg,
  uuid,
} from '../../service-bridge/read-model-pg.testkit';
import { RemoteStepUpInterceptor } from './remote-step-up.interceptor';

/**
 * Step-up freshness on a REAL Postgres (wiki-v2 #713) — NOT upstream Docmost code.
 *
 * The whole fork path with the REAL upstream `SessionService.createSessionAndToken`, `TokenService`, `UserRepo` and
 * `UserSessionRepo`, the real jsonb column and the production plugin set: `ServiceBridgeService.mintSession` stamps
 * the row its token names, and `RemoteStepUpInterceptor` reads that row back through the same repo `jwt.strategy`
 * uses. The property: freshness is per session ROW. An older session of the same user stays refused after a fresh
 * re-mint; the re-mint never touches it.
 *
 * Self-skips without AUTHZ_TEST_PG_URL (the `docmost-authz` lane); the `docmost-authz-pg` lane sets
 * AUTHZ_REQUIRE_PG=1 so the anti-vacuity guard reds if that wiring regresses.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG step-up freshness lane (#713)', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'step_up_freshness_pg_spec';
const DEFAULT_WS = uuid(100);
const now = () => Math.floor(Date.now() / 1000);

d('session freshness is per user_sessions row on real Postgres (#713)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: any;
  let svc: ServiceBridgeService;
  let interceptor: RemoteStepUpInterceptor;

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
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
    // Faithful to the user_sessions migration (20260326T121350), metadata jsonb included.
    await pg`
      create table user_sessions (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null, workspace_id uuid not null, device_name varchar, user_agent varchar,
        ip_address inet, geo_location varchar, metadata jsonb,
        last_active_at timestamptz not null default now(), expires_at timestamptz not null,
        revoked_at timestamptz, created_at timestamptz not null default now()
      )`;
    await pg`insert into workspaces (id, name) values (${DEFAULT_WS}, 'default')`;

    const userSessionRepo = new UserSessionRepo(db);
    const env = { getCookieExpiresIn: () => new Date(Date.now() + 30 * 86_400_000) } as any;
    const tokens = new TokenService(new JwtService({ secret: 'step-up-pg-spec' }), env);
    const cls = { get: () => undefined, set: () => undefined } as any;
    const sessions = new SessionService(tokens, userSessionRepo, env, cls);
    svc = new ServiceBridgeService(db, new UserRepo(db), userSessionRepo, sessions, new WorkspaceResolver(db), cls);
    interceptor = new RemoteStepUpInterceptor('remote', userSessionRepo);
  });

  afterAll(async () => {
    await appPg?.end({ timeout: 5 }).catch(() => undefined);
    await pg?.end({ timeout: 5 }).catch(() => undefined);
  });

  const sessionIdOf = (token: string): string => (decode(token, { json: true }) as { sessionId: string }).sessionId;

  /** Run the interceptor for a permanent purge as the session `sessionId` of `userId`. */
  const purgeAs = (userId: string, sessionId: string): Promise<unknown> => {
    const req = {
      body: { pageId: 'p1', permanentlyDelete: true },
      user: { user: { id: userId }, workspace: { id: DEFAULT_WS } },
      raw: { sessionId },
    };
    const ctx = {
      getType: () => 'http',
      getClass: () => ({ PageController: class {} }).PageController,
      getHandler: () => ({ delete: () => undefined }).delete,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of('handled') };
    return lastValueFrom(interceptor.intercept(ctx, next));
  };

  it('stores {authTime, freshUntil} on the minted row as jsonb, and nothing on a mint without it', async () => {
    const { userId } = await svc.provisionShadowUser({ externalId: 'fresh-alice' } as any);
    const authTime = now() - 30;
    const freshToken = await svc.mintSession('fresh-alice', undefined, { authTime, freshUntil: authTime + 7200 });
    const bareToken = await svc.mintSession('fresh-alice');
    const rows = (await pg`select id, metadata::text as m from user_sessions where user_id = ${userId}`) as unknown as Array<{
      id: string;
      m: string | null;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r.m]));
    expect(JSON.parse(byId.get(sessionIdOf(freshToken))!)).toEqual({ authTime, freshUntil: authTime + 7200 });
    expect(byId.get(sessionIdOf(bareToken))).toBeNull();
  });

  it('an OLD session stays refused after a NEW fresh session is minted for the same user', async () => {
    const { userId } = await svc.provisionShadowUser({ externalId: 'fresh-bob' } as any);
    // The old token: minted when the human authenticated long ago, its window long lapsed.
    const oldAuth = now() - 3 * 86_400;
    const oldToken = await svc.mintSession('fresh-bob', undefined, { authTime: oldAuth, freshUntil: oldAuth + 7200 });
    // A token minted with no freshness at all.
    const bareToken = await svc.mintSession('fresh-bob');
    // The step-up re-mint.
    const authTime = now() - 5;
    const newToken = await svc.mintSession('fresh-bob', undefined, { authTime, freshUntil: authTime + 7200 });

    await expect(purgeAs(userId, sessionIdOf(newToken))).resolves.toBe('handled');
    await expect(purgeAs(userId, sessionIdOf(oldToken))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(purgeAs(userId, sessionIdOf(bareToken))).rejects.toBeInstanceOf(ForbiddenException);

    // The re-mint wrote only its own row: the old row still carries its own lapsed window.
    const old = (await pg`select metadata::text as m from user_sessions where id = ${sessionIdOf(oldToken)}`) as unknown as Array<{
      m: string;
    }>;
    expect(JSON.parse(old[0].m)).toEqual({ authTime: oldAuth, freshUntil: oldAuth + 7200 });
  });

  it('a fresh row of ANOTHER user, or a revoked fresh row, never passes', async () => {
    const { userId: carol } = await svc.provisionShadowUser({ externalId: 'fresh-carol' } as any);
    const { userId: dave } = await svc.provisionShadowUser({ externalId: 'fresh-dave' } as any);
    const authTime = now() - 5;
    const carolToken = await svc.mintSession('fresh-carol', undefined, { authTime, freshUntil: authTime + 7200 });
    await expect(purgeAs(dave, sessionIdOf(carolToken))).rejects.toBeInstanceOf(ForbiddenException);
    await pg`update user_sessions set revoked_at = now() where id = ${sessionIdOf(carolToken)}`;
    await expect(purgeAs(carol, sessionIdOf(carolToken))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
