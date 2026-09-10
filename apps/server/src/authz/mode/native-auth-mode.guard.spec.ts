import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NativeAuthModeGuard } from './native-auth-mode.guard';
import { SessionScopedRoute } from './native-auth-mode.decorator';
import { AuthzMode } from './authz-mode';

/**
 * NativeAuthModeGuard — fail-closed ALLOWLIST (seams #87/#88), NOT upstream Docmost code.
 *
 * In `AUTHZ_MODE=remote` the guard 404s every route it runs on EXCEPT handlers marked `@SessionScopedRoute()`
 * (the collab-token / logout allowlist). The marker is read HANDLER-ONLY, so a marker mistakenly placed on a
 * controller CLASS is ignored and the routes stay DENIED — the safe failure direction for an allowlist. In
 * `native` mode the guard is fully inert (standalone native login stays enabled).
 */
class SampleController {
  @SessionScopedRoute()
  sessionRoute() {} // allowlisted (collab-token / logout analog)

  credentialRoute() {} // unmarked (login / forgot-password / password-reset analog)
}

// A controller whose CLASS carries the marker — under the handler-only read this must NOT open its methods.
@SessionScopedRoute()
class ClassMarkedController {
  credentialRoute() {}
}

const reflector = new Reflector();

const ctxFor = (target: object, handler: unknown): any => ({
  getHandler: () => handler,
  getClass: () => target,
});

const guard = (mode: AuthzMode) => new NativeAuthModeGuard(mode, reflector);

describe('NativeAuthModeGuard (fail-closed allowlist)', () => {
  it('404s an UNMARKED route in remote mode (default-deny, for ALL callers)', () => {
    expect(() =>
      guard('remote').canActivate(
        ctxFor(SampleController, SampleController.prototype.credentialRoute),
      ),
    ).toThrow(NotFoundException);
  });

  it('allows a @SessionScopedRoute() handler in remote mode (collab-token / logout stay reachable)', () => {
    expect(
      guard('remote').canActivate(
        ctxFor(SampleController, SampleController.prototype.sessionRoute),
      ),
    ).toBe(true);
  });

  it('is INERT in native mode — allows both marked and unmarked routes (standalone native login stays on)', () => {
    expect(
      guard('native').canActivate(
        ctxFor(SampleController, SampleController.prototype.credentialRoute),
      ),
    ).toBe(true);
    expect(
      guard('native').canActivate(
        ctxFor(SampleController, SampleController.prototype.sessionRoute),
      ),
    ).toBe(true);
  });

  it('IGNORES a class-level marker (handler-only read) — a class allow must NOT open methods in remote', () => {
    // Fail-open defense: even with the CLASS marked @SessionScopedRoute(), an unmarked handler stays denied.
    expect(() =>
      guard('remote').canActivate(
        ctxFor(ClassMarkedController, ClassMarkedController.prototype.credentialRoute),
      ),
    ).toThrow(NotFoundException);
  });
});
