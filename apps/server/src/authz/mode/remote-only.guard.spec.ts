import { NotFoundException } from '@nestjs/common';
import { RemoteOnlyGuard } from './remote-only.guard';
import { AuthzMode } from './authz-mode';

const guard = (mode: AuthzMode) => new RemoteOnlyGuard(mode);

describe('RemoteOnlyGuard', () => {
  it('allows the privileged service surface in remote mode', () => {
    expect(guard('remote').canActivate()).toBe(true);
  });

  it('404s the service surface in native mode (for ALL callers, no exception)', () => {
    // The core hardening: native mode must 404 the surface REGARDLESS of the service secret. This guard
    // does not read the secret at all, so a native deployment that happens to have
    // PLATFORM_AUTHZ_SERVICE_SECRET set is still 404'd — the surface is off by ENFORCEMENT, not by the
    // configuration accident of a missing secret.
    expect(() => guard('native').canActivate()).toThrow(NotFoundException);
  });

  it('returns 404 (not 401/403) so the route is indistinguishable from "does not exist"', () => {
    let thrown: unknown;
    try {
      guard('native').canActivate();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).getStatus()).toBe(404);
  });
});
