import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import { ServiceScope } from './service-scope';
import { FixedWindowRateLimiter } from './service-rate-limit';

export const SERVICE_SCOPE_KEY = 'ccc:service-scope';

/** Declare the single ServiceScope a `/api/service/*` route requires. */
export const RequireServiceScope = (scope: ServiceScope) =>
  SetMetadata(SERVICE_SCOPE_KEY, scope);

/**
 * #616: the id of the credential that authenticated the request, set on the request by the guard. A Symbol key, so
 * nothing a caller sends (headers, body, query) can set or shadow it. A handler reads it with
 * {@link serviceCredentialIdOf} to bind state to WHICH service called (the create-idempotency ledger).
 */
const SERVICE_CREDENTIAL_ID = Symbol('ccc.serviceCredentialId');

/** The authenticated service credential's id, or undefined when no ServiceAuthGuard admitted the request. */
export function serviceCredentialIdOf(req: unknown): string | undefined {
  const id = (req as Record<symbol, unknown> | null | undefined)?.[SERVICE_CREDENTIAL_ID];
  return typeof id === 'string' ? id : undefined;
}

/** Record the credential that authenticated `req` (the guard, once it admitted it; a test's stand-in guard). */
export function attachServiceCredential(req: unknown, credentialId: string): void {
  if (req && typeof req === 'object') (req as Record<symbol, unknown>)[SERVICE_CREDENTIAL_ID] = credentialId;
}

interface ServiceCredential {
  id: string;
  secret: string;
  scopes: ReadonlySet<ServiceScope>;
}

const envLimit = (name: string, def: number): number => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const RATE_LIMIT = envLimit('SERVICE_BRIDGE_RATE_LIMIT', 600);
/**
 * Scopes on the platform's per-request hot path get their own, larger window (each scope is already its own bucket;
 * this sets its size). They are cheap indexed reads, and every caller behind them is already rate-limited per
 * principal at the platform edge, so a shared 600/min would throttle every user because of one:
 * - `pages:authz:read` (#545): the page projector reads it once per page event, plus fan-out and reconcile chunks.
 * - `pages:read` (#493): `/v1` page-content routes resolve "is this page live" through `resolve-space` on EVERY
 *   request; the platform answers a throttled resolve as a retriable 503, but it should not happen under normal load.
 * The import helpers go the other way (#616): `pages:import:read` gets a SMALLER window, because a validate-content call
 * parses up to 1 MiB of HTML/Markdown on the fork's single event loop (two calls per import submit or preview).
 */
const SCOPE_RATE_LIMITS: Partial<Record<ServiceScope, number>> = {
  [ServiceScope.PagesAuthzRead]: envLimit('SERVICE_BRIDGE_PAGES_AUTHZ_RATE_LIMIT', 6000),
  [ServiceScope.PagesRead]: envLimit('SERVICE_BRIDGE_PAGES_READ_RATE_LIMIT', 6000),
  [ServiceScope.PagesImportRead]: envLimit('SERVICE_BRIDGE_PAGES_IMPORT_RATE_LIMIT', 120),
};

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Scoped, fail-closed auth for the highly-privileged east-west `/api/service/*` endpoints. It is
 * deliberately NOT "anyone holding the shared secret can do anything":
 *  - Least privilege: each route declares its scope; the guard authorizes THAT scope, not mere secret
 *    possession. Today one shared secret is a TRANSITIONAL credential granted the full scope set; adding
 *    distinct per-scope credentials later is a registry change here — no redesign.
 *  - Fail-closed: unconfigured credential → 503; a route missing its scope declaration → 403 (a bug is
 *    not an open door); missing/wrong secret → 401; a valid credential lacking the route's scope → 403.
 *  - Constant-time secret comparison.
 *  - Rate limiting (429) as a DoS backstop — per-credential for authenticated calls AND per-client-IP for
 *    the unauthenticated (missing/wrong-secret) path, so a bad-secret flood is bounded too.
 */
@Injectable()
export class ServiceAuthGuard implements CanActivate {
  private readonly credentials: ServiceCredential[];
  private readonly limiter = new FixedWindowRateLimiter(RATE_LIMIT, 60_000);
  private readonly scopeLimiters = new Map(
    Object.entries(SCOPE_RATE_LIMITS).map(([scope, n]) => [scope, new FixedWindowRateLimiter(n, 60_000)]),
  );

  constructor(private readonly reflector: Reflector) {
    const raw = process.env.PLATFORM_AUTHZ_SERVICE_SECRET ?? '';
    // F6 (companion #272): a whitespace-only value is NOT a configured credential — it would otherwise pass
    // the truthy check and be accepted as a real secret. Treat blank/whitespace as unconfigured → 503.
    const shared = raw.trim().length > 0 ? raw : '';
    this.credentials = shared
      ? [
          {
            id: 'shared',
            secret: shared,
            scopes: new Set(Object.values(ServiceScope)),
          },
        ]
      : [];
  }

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<ServiceScope>(
      SERVICE_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) {
      throw new ForbiddenException('service route missing scope declaration');
    }
    if (this.credentials.length === 0) {
      throw new ServiceUnavailableException('service credential not configured');
    }

    const req = context.switchToHttp().getRequest();
    const provided = req.headers?.['x-authz-service-secret'];
    if (typeof provided !== 'string' || provided.length === 0) {
      this.enforceAnonLimit();
      throw new UnauthorizedException('missing service credential');
    }

    const cred = this.credentials.find((c) => this.equals(provided, c.secret));
    if (!cred) {
      this.enforceAnonLimit();
      throw new UnauthorizedException('invalid service credential');
    }
    if (!cred.scopes.has(required)) {
      throw new ForbiddenException(`service credential lacks scope ${required}`);
    }

    const limiter = this.scopeLimiters.get(required) ?? this.limiter;
    if (!limiter.allow(`${cred.id}:${required}`)) {
      throw new HttpException(
        'service rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    attachServiceCredential(req, cred.id);
    return true;
  }

  /**
   * F6 (companion #272): rate-limit the UNAUTHENTICATED path too. The per-credential limiter below only runs
   * AFTER a valid credential matches, so a missing/wrong-secret flood was previously unbounded — the "DoS
   * backstop" the class docstring promises did not cover the anonymous path.
   *
   * A SINGLE coarse `anon` bucket — deliberately NOT keyed on `req.ip`. `main.ts` sets `trustProxy: true`, so
   * `req.ip` is derived from a client-supplied `X-Forwarded-For`; keying on it would let an attacker (a) mint
   * a fresh 600/min budget per spoofed header (bypassing the very backstop this adds) and (b) grow the
   * limiter's in-memory window Map without bound (a memory-exhaustion vector). Every legitimate caller holds
   * the secret and uses the separate per-credential bucket, so all traffic that reaches this path is already
   * illegitimate; capping it collectively is exactly the intent, and the key space stays bounded and
   * unspoofable. (`/api/service/*` is east-west/internal, so this is a backstop, not the primary control.)
   */
  private enforceAnonLimit(): void {
    if (!this.limiter.allow('anon')) {
      throw new HttpException(
        'service rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private equals(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
