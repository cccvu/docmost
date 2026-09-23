import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ServiceAuthGuard } from './service-auth.guard';
import { ServiceScope } from './service-scope';

const SECRET = 'test-service-secret-0123456789ab';

function ctx(header?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: header === undefined ? {} : { 'x-authz-service-secret': header },
      }),
    }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as any;
}

// Reflector stub returning a fixed required scope (or undefined for "no scope declared").
function reflectorReturning(scope: ServiceScope | undefined): Reflector {
  return { getAllAndOverride: () => scope } as unknown as Reflector;
}

/**
 * Negative-authorization suite for the east-west service guard (least privilege, fail-closed). These are
 * exactly the "service endpoints as an omnipotent-secret backdoor" defenses the plan calls out.
 */
describe('ServiceAuthGuard', () => {
  const orig = process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
  afterAll(() => {
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = orig;
  });

  describe('with a configured service secret', () => {
    beforeEach(() => {
      process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SECRET;
    });

    it('allows a matching secret that carries the route scope', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      expect(g.canActivate(ctx(SECRET))).toBe(true);
    });

    it('401 on a missing secret header', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      expect(() => g.canActivate(ctx(undefined))).toThrow(UnauthorizedException);
    });

    it('401 on a wrong secret', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      expect(() => g.canActivate(ctx('not-the-secret'))).toThrow(UnauthorizedException);
    });

    it('403 (fail-closed) when the route declares NO scope — a bug is not an open door', () => {
      const g = new ServiceAuthGuard(reflectorReturning(undefined));
      expect(() => g.canActivate(ctx(SECRET))).toThrow(ForbiddenException);
    });

    it('403 when the credential lacks the route scope (least privilege, not mere secret possession)', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      // The shared transitional secret carries ALL scopes, so this branch is otherwise unreachable. Simulate
      // a future per-scope credential that holds ONLY users:provision, and require session:mint — the guard
      // must 403 (a valid secret is not a pass to a scope it doesn't hold). Pins the branch for when distinct
      // per-scope credentials are introduced (no guard redesign needed).
      (g as any).credentials = [
        { id: 'scoped', secret: SECRET, scopes: new Set([ServiceScope.UsersProvision]) },
      ];
      expect(() => g.canActivate(ctx(SECRET))).toThrow(ForbiddenException);
    });

    it('rejects a wrong secret of EQUAL length (exercises the constant-time compare, not the length guard)', () => {
      // The 'wrong secret' test above differs in length, so it short-circuits before timingSafeEqual. A
      // same-length wrong secret forces the constant-time comparison path itself to reject → 401.
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      const sameLenWrong = 'x'.repeat(SECRET.length);
      expect(sameLenWrong.length).toBe(SECRET.length);
      expect(() => g.canActivate(ctx(sameLenWrong))).toThrow(UnauthorizedException);
    });

    // F6 (companion #272): the UNAUTHENTICATED path is rate-limited too. Once the single coarse anon bucket
    // is exhausted, a wrong/missing-secret flood gets 429 (not an unbounded stream of cheap 401s) — the DoS
    // backstop now actually covers the pre-auth path.
    it('F6: rate-limits the unauthenticated (wrong-secret) path with 429 once the anon bucket is exhausted', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      const limiter = (g as any).limiter;
      while (limiter.allow('anon')) {
        /* fill the single coarse anon window to its limit */
      }
      let status: number | undefined;
      try {
        g.canActivate(ctx('wrong-secret'));
      } catch (e: any) {
        status = e.getStatus?.();
      }
      expect(status).toBe(429);
    });

    // F6 hardening: the anon bucket is a SINGLE constant key, NOT keyed on req.ip. Under `trustProxy: true`
    // req.ip is X-Forwarded-For-derived (attacker-controlled), so a per-IP key would let a spoofed XFF mint a
    // fresh budget per request (bypassing the backstop) AND grow the limiter Map without bound. A varying
    // req.ip must therefore NOT create new buckets — once 'anon' is exhausted, spoofed-IP requests still 429.
    it('F6: a spoofed/varying X-Forwarded-For (req.ip) cannot bypass the anon limit', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      const limiter = (g as any).limiter;
      while (limiter.allow('anon')) {
        /* exhaust the single coarse bucket */
      }
      const ctxWithIp = (ip: string) =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({ headers: { 'x-authz-service-secret': 'wrong' }, ip }),
          }),
          getHandler: () => () => undefined,
          getClass: () => class {},
        }) as any;
      for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
        let status: number | undefined;
        try {
          g.canActivate(ctxWithIp(ip));
        } catch (e: any) {
          status = e.getStatus?.();
        }
        expect(status).toBe(429); // still throttled — no per-IP bucket to escape into
      }
    });

    // #545: the page projector's per-event reads have their OWN, larger window — a burst of them can neither
    // starve the other scopes nor be throttled at the shared 600/min.
    it('#545: pages:authz:read is limited by its own larger window, independent of the shared one', () => {
      const pages = new ServiceAuthGuard(reflectorReturning(ServiceScope.PagesAuthzRead));
      const other = new ServiceAuthGuard(reflectorReturning(ServiceScope.ChangesRead));
      (pages as any).limiter = (other as any).limiter; // one shared window, as in one process
      let passed = 0;
      for (let i = 0; i < 700; i++) if (pages.canActivate(ctx(SECRET))) passed++;
      expect(passed).toBe(700); // beyond the shared 600/min
      expect(other.canActivate(ctx(SECRET))).toBe(true); // and the shared window was never touched
      const window = (pages as any).pagesAuthzLimiter;
      while (window.allow(`shared:${ServiceScope.PagesAuthzRead}`)) {
        /* exhaust the pages:authz:read window */
      }
      expect(() => pages.canActivate(ctx(SECRET))).toThrow(expect.objectContaining({ status: 429 }));
    });

    // F6: a valid credential is NOT starved by a flood of bad requests — the anon bucket and the
    // per-credential bucket are separate keys.
    it('F6: a valid credential still passes even after the anon bucket is exhausted', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      const limiter = (g as any).limiter;
      while (limiter.allow('anon')) {
        /* exhaust the anonymous bucket */
      }
      expect(g.canActivate(ctx(SECRET))).toBe(true); // separate per-credential bucket
    });
  });

  describe('with a whitespace-only service secret (fail-closed, F6)', () => {
    beforeEach(() => {
      process.env.PLATFORM_AUTHZ_SERVICE_SECRET = '   ';
    });

    it('503 — a blank/whitespace secret is NOT a configured credential', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      expect(() => g.canActivate(ctx('   '))).toThrow(ServiceUnavailableException);
    });
  });

  describe('with NO service secret configured (fail-closed)', () => {
    beforeEach(() => {
      delete process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
    });

    it('503 — never "allow"', () => {
      const g = new ServiceAuthGuard(reflectorReturning(ServiceScope.SessionMint));
      expect(() => g.canActivate(ctx(SECRET))).toThrow(ServiceUnavailableException);
    });
  });
});
