import 'reflect-metadata';
import { JwtService } from '@nestjs/jwt';
import {
  CamelCasePlugin,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { TokenService } from '../core/auth/services/token.service';
import { JwtType } from '../core/auth/dto/jwt-payload';
import { SessionRevokeOthersService } from './session-revoke-others.service';
import { RevokeOtherSessionsDto } from './dto/revoke-other-sessions.dto';
import { shadowEmailFor } from './shadow-user';
import { ServiceBridgeController } from './service-bridge.controller';
import { ServiceAuthGuard, SERVICE_SCOPE_KEY } from './service-auth.guard';
import { Reflector } from '@nestjs/core';
import { ServiceScope } from './service-scope';

/**
 * wiki-v2 #818 — `POST /api/service/session/revoke-others`: every live wiki session of the shadow user is revoked
 * except the one the caller PROVES with `keepToken`, verified by the fork's own TokenService. The decision runs on
 * real JWTs (a real JwtService + TokenService) and the revoke on the real compiled SQL, applied to an in-memory
 * `user_sessions` table, so the predicate itself is under test. The real-Postgres twin is
 * `session-revoke-others.pg.spec.ts`; the scope and guard wiring are pinned by `service-scope-coverage.spec.ts`
 * (route → exactly `session:revoke-others`) and `service-auth.guard.spec.ts` (secret + scope enforcement).
 */

const SECRET = 'fork-app-secret-for-tests-0123456789';
const OTHER_SECRET = 'some-other-secret-9876543210-abcdef';
const WS = '00000000-0000-4000-8000-000000000001';
const OTHER_WS = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-0000000000a1';
const OTHER_USER = '00000000-0000-4000-8000-0000000000b2';
const EXT = 'ext-alice';

interface Row {
  id: string;
  userId: string;
  workspaceId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

const UPDATE_ALL =
  'update "user_sessions" set "revoked_at" = $1 where "user_id" = $2 and "workspace_id" = $3 and "revoked_at" is null';
const UPDATE_EXCEPT = `${UPDATE_ALL} and "id" != $4`;

/** A Kysely over a fake driver that applies the ONE update this service may issue to `rows`. */
function memoryDb(rows: Row[]) {
  const sqls: string[] = [];
  const connection = {
    async executeQuery(compiled: {
      sql: string;
      parameters: readonly unknown[];
    }) {
      sqls.push(compiled.sql);
      const [at, userId, workspaceId, keep] = compiled.parameters as [
        Date,
        string,
        string,
        string?,
      ];
      if (compiled.sql !== UPDATE_ALL && compiled.sql !== UPDATE_EXCEPT) {
        throw new Error(`unexpected query: ${compiled.sql}`);
      }
      let n = 0;
      for (const r of rows) {
        if (
          r.userId !== userId ||
          r.workspaceId !== workspaceId ||
          r.revokedAt !== null
        )
          continue;
        if (compiled.sql === UPDATE_EXCEPT && r.id === keep) continue;
        r.revokedAt = at;
        n++;
      }
      return { rows: [], numAffectedRows: BigInt(n) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not supported');
    },
  };
  const driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver as any,
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createIntrospector: (d: Kysely<any>) => new PostgresIntrospector(d),
    },
    plugins: [new CamelCasePlugin()],
  });
  return { db: db as unknown as KyselyDB, sqls };
}

const future = () => new Date(Date.now() + 86_400_000);

function setup(opts: { shadow?: boolean } = {}) {
  const rows: Row[] = [
    {
      id: 's-current',
      userId: USER,
      workspaceId: WS,
      expiresAt: future(),
      revokedAt: null,
    },
    {
      id: 's-laptop',
      userId: USER,
      workspaceId: WS,
      expiresAt: future(),
      revokedAt: null,
    },
    {
      id: 's-thief',
      userId: USER,
      workspaceId: WS,
      expiresAt: future(),
      revokedAt: null,
    },
    {
      id: 's-old',
      userId: USER,
      workspaceId: WS,
      expiresAt: future(),
      revokedAt: new Date(0),
    },
    {
      id: 's-bob',
      userId: OTHER_USER,
      workspaceId: WS,
      expiresAt: future(),
      revokedAt: null,
    },
  ];
  const { db, sqls } = memoryDb(rows);
  const userRepo = {
    findByEmail: jest.fn(async (email: string, ws: string) =>
      opts.shadow !== false && email === shadowEmailFor(EXT) && ws === WS
        ? ({ id: USER, workspaceId: WS, deactivatedAt: null } as any)
        : undefined,
    ),
  };
  // Mirrors UserSessionRepo.findActiveById: unrevoked and unexpired.
  const userSessionRepo = {
    findActiveById: jest.fn(async (id: string) =>
      rows.find(
        (r) => r.id === id && r.revokedAt === null && r.expiresAt > new Date(),
      ),
    ),
  };
  const jwt = new JwtService({
    secret: SECRET,
    signOptions: { expiresIn: '1h', issuer: 'Docmost' },
  });
  const tokenService = new TokenService(jwt, {
    getAppSecret: () => SECRET,
  } as any);
  const workspaces = { resolveDefaultWorkspaceId: async () => WS };
  const svc = new SessionRevokeOthersService(
    db,
    userRepo as any,
    userSessionRepo as any,
    tokenService,
    workspaces as any,
  );
  const sign = (
    payload: Record<string, unknown>,
    o: { secret?: string; expiresIn?: number } = {},
  ) =>
    jwt.sign(payload, {
      secret: o.secret ?? SECRET,
      ...(o.expiresIn !== undefined ? { expiresIn: o.expiresIn } : {}),
    });
  const access = (over: Record<string, unknown> = {}) =>
    sign({
      sub: USER,
      email: shadowEmailFor(EXT),
      workspaceId: WS,
      type: JwtType.ACCESS,
      sessionId: 's-current',
      ...over,
    });
  const live = () =>
    rows
      .filter((r) => r.revokedAt === null)
      .map((r) => r.id)
      .sort();
  return { svc, rows, sqls, userRepo, userSessionRepo, sign, access, live };
}

describe('SessionRevokeOthersService.revokeOtherSessions (#818)', () => {
  it('keeps exactly the session a valid keep token proves and revokes the user’s others', async () => {
    const t = setup();
    await expect(t.svc.revokeOtherSessions(EXT, t.access())).resolves.toEqual({
      userId: USER,
      revoked: 2,
      kept: true,
    });
    expect(t.live()).toEqual(['s-bob', 's-current']); // another user's session is never touched
    expect(t.sqls).toEqual([UPDATE_EXCEPT]); // one UPDATE, no users write (never deactivates)
  });

  it('is idempotent: a repeat revokes nothing more and still keeps the session', async () => {
    const t = setup();
    await t.svc.revokeOtherSessions(EXT, t.access());
    await expect(t.svc.revokeOtherSessions(EXT, t.access())).resolves.toEqual({
      userId: USER,
      revoked: 0,
      kept: true,
    });
    expect(t.live()).toEqual(['s-bob', 's-current']);
  });

  it('no keep token → every live session of the user is revoked', async () => {
    const t = setup();
    await expect(t.svc.revokeOtherSessions(EXT)).resolves.toEqual({
      userId: USER,
      revoked: 3,
      kept: false,
    });
    expect(t.live()).toEqual(['s-bob']);
    expect(t.sqls).toEqual([UPDATE_ALL]);
    expect(t.userSessionRepo.findActiveById).not.toHaveBeenCalled();
  });

  // Each of these must keep NOTHING: the fork only keeps a session it can prove belongs to this user.
  it.each<[string, (t: ReturnType<typeof setup>) => string]>([
    [
      'another user’s token (wrong sub)',
      (t) => t.access({ sub: OTHER_USER, sessionId: 's-bob' }),
    ],
    [
      'a token whose sub is not the shadow user, naming this user’s session',
      (t) => t.access({ sub: OTHER_USER }),
    ],
    [
      'a token for another workspace',
      (t) => t.access({ workspaceId: OTHER_WS }),
    ],
    [
      'a token signed with another secret',
      (t) =>
        t.sign(
          {
            sub: USER,
            workspaceId: WS,
            type: 'access',
            sessionId: 's-current',
          },
          { secret: OTHER_SECRET },
        ),
    ],
    [
      'an expired token',
      (t) =>
        t.sign(
          {
            sub: USER,
            workspaceId: WS,
            type: 'access',
            sessionId: 's-current',
          },
          { expiresIn: -10 },
        ),
    ],
    ['a collab token (wrong type)', (t) => t.access({ type: JwtType.COLLAB })],
    ['a token naming no session', (t) => t.access({ sessionId: undefined })],
    ['a token naming a non-string session', (t) => t.access({ sessionId: 42 })],
    ['a token for a revoked session', (t) => t.access({ sessionId: 's-old' })],
    [
      'a token for an unknown session',
      (t) => t.access({ sessionId: 's-nope' }),
    ],
    [
      'a token naming ANOTHER user’s live session',
      (t) => t.access({ sessionId: 's-bob' }),
    ],
    [
      'a token with a tampered payload',
      (t) => {
        const [h, , s] = t.access().split('.');
        const p = Buffer.from(
          JSON.stringify({
            sub: USER,
            workspaceId: WS,
            type: 'access',
            sessionId: 's-laptop',
          }),
        ).toString('base64url');
        return `${h}.${p}.${s}`;
      },
    ],
  ])(
    '%s → keeps nothing, revokes all of the user’s sessions',
    async (_label, token) => {
      const t = setup();
      await expect(t.svc.revokeOtherSessions(EXT, token(t))).resolves.toEqual({
        userId: USER,
        revoked: 3,
        kept: false,
      });
      expect(t.live()).toEqual(['s-bob']);
      expect(t.sqls).toEqual([UPDATE_ALL]);
    },
  );

  it('a session row of the right id but another user is never kept (the row check, not just the token)', async () => {
    const t = setup();
    // A valid token for USER whose session id happens to be a row now owned by someone else.
    t.rows.find((r) => r.id === 's-current')!.userId = OTHER_USER;
    await expect(t.svc.revokeOtherSessions(EXT, t.access())).resolves.toEqual({
      userId: USER,
      revoked: 2,
      kept: false,
    });
  });

  it('no shadow user → a no-op that touches nothing', async () => {
    const t = setup({ shadow: false });
    await expect(t.svc.revokeOtherSessions(EXT, t.access())).resolves.toEqual({
      userId: null,
      revoked: 0,
      kept: false,
    });
    expect(t.sqls).toEqual([]);
    expect(t.live()).toHaveLength(4);
  });

  it('a database failure while checking the keep session propagates and revokes nothing', async () => {
    const t = setup();
    t.userSessionRepo.findActiveById.mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(t.svc.revokeOtherSessions(EXT, t.access())).rejects.toThrow(
      'db down',
    );
    expect(t.sqls).toEqual([]);
    expect(t.live()).toHaveLength(4);
  });

  it('derives the shadow email from externalId (lower-cased) and never takes a user id from the caller', async () => {
    const t = setup();
    await t.svc.revokeOtherSessions('EXT-ALICE', t.access());
    expect(t.userRepo.findByEmail).toHaveBeenCalledWith(
      shadowEmailFor(EXT),
      WS,
    );
  });
});

describe('RevokeOtherSessionsDto (#818)', () => {
  const check = async (body: Record<string, unknown>) =>
    validate(plainToInstance(RevokeOtherSessionsDto, body), {
      whitelist: true,
    });

  it('declares keepToken, so the whitelist ValidationPipe keeps it', async () => {
    const dto = plainToInstance(RevokeOtherSessionsDto, {
      externalId: EXT,
      keepToken: 'a.b.c',
      extra: 1,
    });
    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect(dto.keepToken).toBe('a.b.c');
    expect((dto as any).extra).toBeUndefined();
  });

  it('accepts a missing keepToken', async () => {
    expect(await check({ externalId: EXT })).toEqual([]);
  });

  it.each([
    ['an externalId with an @', { externalId: 'a@evil.com' }],
    ['a missing externalId', {}],
    [
      'a keepToken that is not a JWS',
      { externalId: EXT, keepToken: 'not a token' },
    ],
    ['a keepToken of two segments', { externalId: EXT, keepToken: 'a.b' }],
    [
      'an over-long keepToken',
      { externalId: EXT, keepToken: `${'a'.repeat(4096)}.b.c` },
    ],
    ['a non-string keepToken', { externalId: EXT, keepToken: 5 }],
  ])('refuses %s', async (_label, body) => {
    expect((await check(body)).length).toBeGreaterThan(0);
  });
});

describe('ServiceBridgeController.revokeOtherSessions (#818)', () => {
  it('forwards externalId and keepToken to the service and answers its result', async () => {
    const result = { userId: USER, revoked: 1, kept: true };
    const revokeOthers = { revokeOtherSessions: jest.fn(async () => result) };
    const ctl = new ServiceBridgeController(
      {} as any,
      {} as any,
      {} as any,
      revokeOthers as any,
    );
    await expect(
      ctl.revokeOtherSessions({ externalId: EXT, keepToken: 'a.b.c' }),
    ).resolves.toBe(result);
    expect(revokeOthers.revokeOtherSessions).toHaveBeenCalledWith(EXT, 'a.b.c');
  });

  it('requires its own scope, session:revoke-others (not session:revoke)', () => {
    expect(
      Reflect.getMetadata(
        SERVICE_SCOPE_KEY,
        ServiceBridgeController.prototype.revokeOtherSessions,
      ),
    ).toBe(ServiceScope.SessionRevokeOthers);
    expect(ServiceScope.SessionRevokeOthers).toBe('session:revoke-others');
  });
});

/** The real guard, the real Reflector, the real handler: the route needs the secret AND its own scope. */
describe('ServiceAuthGuard on POST /api/service/session/revoke-others (#818)', () => {
  const BRIDGE_SECRET = 'bridge-secret-for-revoke-others-0123';
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = BRIDGE_SECRET;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
    else process.env.PLATFORM_AUTHZ_SERVICE_SECRET = prev;
  });

  const ctx = (secret?: string) => {
    const headers: Record<string, string> =
      secret === undefined ? {} : { 'x-authz-service-secret': secret };
    const reply = { header: () => reply };
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
        getResponse: () => reply,
      }),
      getHandler: () => ServiceBridgeController.prototype.revokeOtherSessions,
      getClass: () => ServiceBridgeController,
    } as any;
  };

  it('admits the platform secret (granted every scope, this one included)', () => {
    expect(
      new ServiceAuthGuard(new Reflector()).canActivate(ctx(BRIDGE_SECRET)),
    ).toBe(true);
  });

  it.each([
    ['no secret', undefined],
    ['a wrong secret', 'not-the-bridge-secret-0000000000'],
  ])('refuses %s with 401', (_label, secret) => {
    expect(() =>
      new ServiceAuthGuard(new Reflector()).canActivate(ctx(secret)),
    ).toThrow(expect.objectContaining({ status: 401 }));
  });

  it('refuses a credential that holds session:revoke but not session:revoke-others with 403', () => {
    const guard = new ServiceAuthGuard(new Reflector());
    (guard as any).credentials = [
      {
        id: 'shared',
        secret: BRIDGE_SECRET,
        scopes: new Set([ServiceScope.SessionRevoke]),
      },
    ];
    expect(() => guard.canActivate(ctx(BRIDGE_SECRET))).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});
