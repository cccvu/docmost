import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { PLATFORM_AUTHZ_KEY, PLATFORM_PUBLIC_KEY } from './platform-authz.decorator';

/**
 * CCC Layer-C route classifier — NOT upstream Docmost code (GitHub #13).
 *
 * ONE pure decision function, `classify(facts)`, used by BOTH the build-time route-inventory fitness test
 * (which builds `facts` from a static AST scan) AND the runtime PlatformAuthorizationGuard (which builds
 * `facts` from live reflection). The two can never disagree about a route's class because they funnel through
 * the same function on the same four facts. It answers: does this route carry an AUTHENTICATION decision?
 *
 * IMPORTANT (the honest boundary): a `'authenticated'` classification proves the route requires a logged-in
 * principal — it does NOT prove an authenticated single-object read is object-AUTHORIZED. A handler that does
 * `repo.findById(id)` and returns it without `PageAccessService.validateCanView` still classifies as
 * `'authenticated'`. That residual of Top Risk #3 is owned by Layer A (the PDP repo rebind) and per-object
 * `validateCan…` checks — deliberately OUT of scope for this fitness function.
 */

/**
 * The security-sensitive allow-list of guard NAMES that constitute an AUTHENTICATION decision. Only two:
 *  - JwtAuthGuard: the standard human-session authentication (honors @Public).
 *  - CollabServiceSecretGuard: service-to-service auth for the fork-owned collab force-disconnect route.
 * NOT ThrottlerGuard / SetupGuard (rate-limit / one-time-bootstrap gates — those routes are pre-auth public
 * and are classified via @Public or the ledger, never via this list). Matched by NAME so the static scan and
 * the runtime guard agree exactly; in the fork's codebase these names are unique. Adding to this list is a
 * security-sensitive change — a weakly-authenticating guard here would flip a real leak to a false-GREEN.
 */
export const AUTH_GUARD_NAMES: ReadonlySet<string> = new Set(['JwtAuthGuard', 'CollabServiceSecretGuard']);

export type RouteClass = 'public' | 'authenticated' | 'fork-authz' | 'ledgered' | 'offender';

/** The four facts a route's authentication decision is derived from. */
export interface RouteFacts {
  /** @Public() (Docmost) or fork @PlatformPublic() on the class or handler — anonymous access intended. */
  isPublic: boolean;
  /** fork @PlatformAuthz(...) on the class or handler. */
  isForkAuthz: boolean;
  /** an AUTH_GUARD_NAMES guard (@UseGuards) on the class or handler. */
  hasAuthGuard: boolean;
  /** an explicit intentional-unguarded ledger entry for this Controller.handler. */
  isLedgered: boolean;
}

/** The single source of truth for the decision. Precedence: public > fork-authz > authenticated > ledgered. */
export function classify(f: RouteFacts): RouteClass {
  if (f.isPublic) return 'public';
  if (f.isForkAuthz) return 'fork-authz';
  if (f.hasAuthGuard) return 'authenticated';
  if (f.isLedgered) return 'ledgered';
  return 'offender'; // fail-closed default
}

/** Does a set of guard names include an authentication guard? Shared by the static scan and the guard. */
export function guardsAuthenticate(guardNames: readonly string[]): boolean {
  return guardNames.some((n) => AUTH_GUARD_NAMES.has(n));
}

/** The guard identity as stored by `@UseGuards(...)`: a class (constructor) or an instance. */
function guardName(g: unknown): string | undefined {
  if (typeof g === 'function') return (g as { name?: string }).name;
  if (g && typeof g === 'object') return (g as { constructor?: { name?: string } }).constructor?.name;
  return undefined;
}

function readGuardNames(target: object): string[] {
  const g = Reflect.getMetadata(GUARDS_METADATA, target);
  return (Array.isArray(g) ? g : []).map(guardName).filter((n): n is string => !!n);
}

/**
 * Runtime adapter (used by PlatformAuthorizationGuard): build RouteFacts from live metadata via reflection,
 * then classify. `ledgerKeys` is the set of `Controller.handler` keys from the intentional-unguarded ledger.
 */
export function classifyFromContext(
  handler: Function,
  controllerClass: NewableFunction,
  reflector: Reflector,
  ledgerKeys: ReadonlySet<string>,
): RouteClass {
  const targets: (Function | NewableFunction)[] = [handler, controllerClass];
  const facts: RouteFacts = {
    isPublic:
      !!reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ||
      !!reflector.getAllAndOverride<boolean>(PLATFORM_PUBLIC_KEY, targets),
    isForkAuthz: !!reflector.getAllAndOverride(PLATFORM_AUTHZ_KEY, targets),
    hasAuthGuard: guardsAuthenticate([...readGuardNames(controllerClass), ...readGuardNames(handler)]),
    isLedgered: ledgerKeys.has(`${controllerClass.name}.${handler.name}`),
  };
  return classify(facts);
}
