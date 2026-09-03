import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NativeAuthModeGuard } from './native-auth-mode.guard';
import { NativeCredentialRoute } from './native-auth-mode.decorator';
import { AuthzMode } from './authz-mode';

/**
 * A sample controller whose handlers carry the REAL decorator, so the test exercises the actual
 * decorator → Reflector → guard path (not a mocked reflector). `login` is a native credential route;
 * `logout` is session-scoped and must NEVER be 404'd.
 */
class SampleAuthController {
  @NativeCredentialRoute()
  login() {}

  logout() {}
}

const reflector = new Reflector();

const ctxFor = (handler: unknown): any => ({
  getHandler: () => handler,
  getClass: () => SampleAuthController,
});

const guard = (mode: AuthzMode) => new NativeAuthModeGuard(mode, reflector);

describe('NativeAuthModeGuard', () => {
  it('404s a marked native credential route in remote mode (for ALL callers, no exception)', () => {
    expect(() =>
      guard('remote').canActivate(ctxFor(SampleAuthController.prototype.login)),
    ).toThrow(NotFoundException);
  });

  it('allows the same marked route in native mode (native login stays enabled)', () => {
    expect(
      guard('native').canActivate(ctxFor(SampleAuthController.prototype.login)),
    ).toBe(true);
  });

  it('never 404s an UNMARKED route (collab-token / logout) — in either mode', () => {
    expect(
      guard('remote').canActivate(ctxFor(SampleAuthController.prototype.logout)),
    ).toBe(true);
    expect(
      guard('native').canActivate(ctxFor(SampleAuthController.prototype.logout)),
    ).toBe(true);
  });
});
