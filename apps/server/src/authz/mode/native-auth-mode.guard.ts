import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTHZ_MODE, AuthzMode } from './authz-mode';
import { SESSION_SCOPED_ROUTE_KEY } from './native-auth-mode.decorator';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Server-side disable of native authentication in `AUTHZ_MODE=remote`, wired class-level onto the upstream
 * `AuthController` (seam #87) and method-level onto `WorkspaceController.acceptInvite` (seam #88).
 *
 * FAIL-CLOSED ALLOWLIST: in `remote` mode every route the guard runs on is 404'd UNLESS its handler is
 * marked `@SessionScopedRoute()` — so a new, unmarked credential route added under the guard is denied by
 * default (not exposed). The only allowlisted routes are the two session-scoped ones (collab-token / logout,
 * which carry no native credential). The 404 is for ALL callers, including a service caller presenting the
 * service secret — there is deliberately NO exception (sessions in remote mode are brokered only via
 * `POST /api/service/session`). It returns 404 (not 401/403) so a credential route is indistinguishable from
 * "does not exist". In `native` mode the guard is inert (returns true) — standalone native login stays on.
 *
 * The marker is read HANDLER-ONLY (`reflector.get(KEY, getHandler())`, NOT getAllAndOverride): a
 * `@SessionScopedRoute()` mistakenly placed on a controller CLASS is ignored, so the routes stay denied
 * rather than the whole controller re-opening — the safe failure direction for an allowlist.
 *
 * The mode is the `@Global` `AUTHZ_MODE` token (validated once at boot; never inferred from the request),
 * so this cannot be flipped at runtime or by any caller-controlled input.
 *
 * NOTE: the class-level `@UseGuards(ThrottlerGuard, NativeAuthModeGuard)` runs ThrottlerGuard first, so a
 * denied route may surface a 429 instead of 404 under sustained load. That is deliberate (rate-limiting a
 * dead route is harmless) and pre-existing; the order is intentionally unchanged.
 */
@Injectable()
export class NativeAuthModeGuard implements CanActivate {
  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Handler-only read (see class doc): a class-level marker is intentionally NOT honored.
    const isSessionScoped = this.reflector.get<boolean>(
      SESSION_SCOPED_ROUTE_KEY,
      context.getHandler(),
    );
    if (this.mode === 'remote' && !isSessionScoped) {
      throw new NotFoundException();
    }
    return true;
  }
}
