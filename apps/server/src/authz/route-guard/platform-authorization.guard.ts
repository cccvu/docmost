import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { classifyFromContext } from './route-classification';
import { INTENTIONAL_UNGUARDED, ledgerKey } from './intentional-unguarded.ledger';

/**
 * CCC Layer-C fail-closed global guard — NOT upstream Docmost code (GitHub #13).
 *
 * The fork analog of the platform's `authorization.guard.ts`. Registered as an `APP_GUARD` (main app.module.ts),
 * it DENIES any HTTP route that carries no authentication decision — i.e. a route that is neither @Public /
 * @PlatformPublic, nor guarded by an AUTH_GUARD (JwtAuthGuard / CollabServiceSecretGuard), nor an explicit
 * intentional-unguarded ledger entry. This closes the structural gap the fork had: a forgotten single-object
 * GET (the `collab/stats` / `getPublicFile` class of leak) is denied at runtime instead of silently served.
 *
 * It is a fail-closed BACKSTOP, not an authenticator: for a decided route it returns `true` (pass-through) and
 * lets the route's OWN gating run — the controller's `@UseGuards(JwtAuthGuard)` (which runs AFTER this global
 * guard) enforces the session; a ledgered route's own token/throttle/share-row check applies. It shares the
 * exact same decision (classifyFromContext -> classify) as the build-time route-inventory fitness test, whose
 * green build guarantees the ledger is complete — so this guard can never fail-close a legitimate route in a
 * merged (green) tree. It does NOT enforce object-level authorization (Layer A owns that — see
 * route-classification.ts).
 */
@Injectable()
export class PlatformAuthorizationGuard implements CanActivate {
  private readonly ledgerKeys: ReadonlySet<string> = new Set(INTENTIONAL_UNGUARDED.map(ledgerKey));

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Only gate HTTP handlers (the scanned surface). Non-HTTP execution contexts (if any) are left to their
    // own handling — this guard's contract is the controller route table the fitness test enumerates.
    if (context.getType() !== 'http') return true;

    const decision = classifyFromContext(context.getHandler(), context.getClass(), this.reflector, this.ledgerKeys);

    if (decision === 'offender') {
      // Deny-by-default: a route with no @Public/@PlatformPublic, no AUTH_GUARD, and no ledger entry.
      throw new ForbiddenException('route has no authorization decision');
    }

    // 'public' | 'authenticated' | 'ledgered' | 'fork-authz' -> allow the request to proceed to its own gating.
    // NOTE on 'fork-authz': the @PlatformAuthz object-level PDP check is a future hook; no fork route uses the
    // decorator yet. Until it lands, a @PlatformAuthz route MUST also carry @UseGuards(JwtAuthGuard) for authn.
    return true;
  }
}
