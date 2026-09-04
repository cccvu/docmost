import { CanActivate, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AUTHZ_MODE, AuthzMode } from './authz-mode';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The mirror of NativeAuthModeGuard: a server-side disable of the privileged east-west service surface
 * (`/api/service/*`, `/api/collab/force-disconnect`) whenever `AUTHZ_MODE` is not `remote`. Applied
 * class-level on every service-bridge / collab-disconnect controller, it throws 404 for ALL callers,
 * INCLUDING one presenting the service secret.
 *
 * Why this exists: the service surface used to be merely "inert" in native mode because a standalone
 * deployment does not set PLATFORM_AUTHZ_SERVICE_SECRET (so ServiceAuthGuard fails closed with 503). That
 * is a configuration accident, not an invariant: a native deployment that DID set the secret (a
 * misconfiguration, or a third party wiring the reference stub) would have activated the full privileged
 * CCC integration surface. This guard makes "the service surface is off in native" an ENFORCED property.
 * It returns 404 (not 401/403) so the route is indistinguishable from "does not exist" in a standalone
 * deployment.
 *
 * The mode is the @Global AUTHZ_MODE token (validated once at boot; never inferred from the request), so
 * it cannot be flipped at runtime or by any caller-controlled input. Order this guard BEFORE the auth
 * guard (`@UseGuards(RemoteOnlyGuard, ServiceAuthGuard)`) so native returns 404 without consulting the
 * secret at all.
 */
@Injectable()
export class RemoteOnlyGuard implements CanActivate {
  constructor(@Inject(AUTHZ_MODE) private readonly mode: AuthzMode) {}

  canActivate(): boolean {
    if (this.mode !== 'remote') {
      throw new NotFoundException();
    }
    return true;
  }
}
