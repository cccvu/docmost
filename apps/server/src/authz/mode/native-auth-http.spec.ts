import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';

// The ONLY `.tsx` blocker in the real AuthController import graph is auth.service.ts's two email-template
// imports (verified: signup/token/session/mail/auth.util/setup.guard/jwt-auth.guard are all `.tsx`-clean).
// A FACTORY mock (not automock — automock loads the real module to introspect it, hitting the `.tsx`) stubs
// the whole auth.service subtree so importing the controller never drags the `.tsx` through jest's transform
// (moduleNameMapper/moduleFileExtensions omit `.tsx`). The credential routes 404 at the guard before any
// handler runs, so no real AuthService behavior is exercised anyway; we inject a stub below.
jest.mock('../../core/auth/services/auth.service', () => ({
  __esModule: true,
  AuthService: class AuthService {},
}));

import { AuthController } from '../../core/auth/auth.controller';
import { AuthService } from '../../core/auth/services/auth.service';
import { SessionService } from '../../core/session/session.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SetupGuard } from '../../core/auth/guards/setup.guard';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import { NativeAuthModeGuard } from './native-auth-mode.guard';
import { AUTHZ_MODE, AuthzMode } from './authz-mode';

/**
 * HTTP-boundary proof of the native-auth disable (#139) — NOT upstream Docmost code.
 *
 * Boots the REAL AuthController behind the REAL NativeAuthModeGuard on a Fastify adapter (same harness shape
 * as authz/route-guard/platform-authorization.guard.spec.ts) and asserts that in `AUTHZ_MODE=remote` the
 * credential routes (login / setup / change-password / forgot-password / password-reset / verify-token) return
 * 404 at the HTTP boundary — independent of any ALB/WAF rule, for all callers — while the session-scoped
 * allowlist (collab-token / logout) is NOT 404'd. This is the behavioral complement to the static fitness
 * scan (native-credential-routes.spec.ts): it proves the wiring actually denies, not merely that decorators
 * are present. A second block proves native mode leaves the credential surface reachable (standalone).
 *
 * The peripheral guards (ThrottlerGuard / JwtAuthGuard / SetupGuard) are overridden to pass-through so the
 * module compiles without throttler / passport / setup infrastructure; only the REAL NativeAuthModeGuard runs
 * the mode under test.
 */
const stubEnv = {
  getCookieExpiresIn: () => new Date(Date.now() + 3_600_000),
  isHttps: () => false,
  isCloud: () => false,
  getAppSecret: () => 'test-secret',
};

async function bootApp(mode: AuthzMode): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      Reflector,
      NativeAuthModeGuard,
      { provide: AUTHZ_MODE, useValue: mode },
      { provide: AuthService, useValue: {} },
      { provide: SessionService, useValue: { revokeSession: async () => undefined } },
      { provide: EnvironmentService, useValue: stubEnv },
      { provide: AUDIT_SERVICE, useValue: { log: () => undefined } },
    ],
  })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(SetupGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

// Every credential-establishing route on AuthController (none is @SessionScopedRoute()).
const CREDENTIAL_ROUTES = [
  'login',
  'setup',
  'change-password',
  'forgot-password',
  'password-reset',
  'verify-token',
];

describe('native-auth HTTP boundary (#139) — AUTHZ_MODE=remote', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await bootApp('remote');
  });
  afterAll(async () => {
    await app?.close();
  });

  const post = (path: string) => app.inject({ method: 'POST', url: `/auth/${path}`, payload: {} });

  it.each(CREDENTIAL_ROUTES)(
    '404s POST /auth/%s — native auth disabled server-side (no ALB/WAF needed)',
    async (path) => {
      const res = await post(path);
      expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
    },
  );

  it('does NOT 404 the session-scoped allowlist (collab-token passes the native-auth guard)', async () => {
    // The native-auth guard allows it through to the (overridden) JwtAuthGuard + handler; the exact non-404
    // status depends on handler execution without a session fixture. The point: it is not denied at the guard.
    const res = await post('collab-token');
    expect(res.statusCode).not.toBe(HttpStatus.NOT_FOUND);
  });
});

describe('native-auth HTTP boundary — AUTHZ_MODE=native (standalone preserved)', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await bootApp('native');
  });
  afterAll(async () => {
    await app?.close();
  });

  it('does NOT 404 POST /auth/forgot-password in native mode (native login lifecycle stays reachable)', async () => {
    // In native mode the guard is inert, so the route reaches the handler. Without a workspace fixture the
    // handler typically errors (non-404) — which is exactly the proof: the native-auth guard did not deny it.
    const res = await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: {} });
    expect(res.statusCode).not.toBe(HttpStatus.NOT_FOUND);
  });
});
