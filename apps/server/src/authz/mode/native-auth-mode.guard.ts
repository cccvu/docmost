import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTHZ_MODE, AuthzMode } from './authz-mode';
import { NATIVE_CREDENTIAL_ROUTE_KEY } from './native-auth-mode.decorator';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Server-side disable of native authentication in `AUTHZ_MODE=remote`. Wired class-level onto the upstream
 * `AuthController` (a documented seam); for every route marked `@NativeCredentialRoute()` it throws 404
 * when the mode is `remote` — for ALL callers, including a service caller presenting the service secret
 * (there is deliberately NO exception; sessions in remote mode are brokered only via
 * `POST /api/service/session`). It returns 404 (not 401/403) so a credential route is indistinguishable
 * from "does not exist" in this deployment. Unmarked routes (collab-token / logout, and every other
 * controller) are untouched — the guard falls through to `true`. In `native` mode it is inert.
 *
 * The mode is the `@Global` `AUTHZ_MODE` token (validated once at boot; never inferred from the request),
 * so this cannot be flipped at runtime or by any caller-controlled input.
 */
@Injectable()
export class NativeAuthModeGuard implements CanActivate {
  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isNativeCredentialRoute = this.reflector.getAllAndOverride<boolean>(
      NATIVE_CREDENTIAL_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isNativeCredentialRoute && this.mode === 'remote') {
      throw new NotFoundException();
    }
    return true;
  }
}
