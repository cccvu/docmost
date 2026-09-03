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
