import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import { ServiceScope } from './service-scope';
import { BucketDebit, RATE_WINDOW_MS, TokenBucketRateLimiter } from './service-rate-limit';
import { PRINCIPAL_ID_PATTERN } from './dto/content-search.dto';

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

/**
 * #780: the platform names the principal each call is made for, so one principal's load is throttled on its own
 * bucket instead of on one bucket shared by every caller of a scope. `user:<id>` (the acting human) or `service:<id>`
 * (a service account acting for nobody), the id in the service bridge's `PRINCIPAL_ID_PATTERN`.
 *
 * A RATE-LIMIT KEY ONLY — never identity or authority: nothing reads it but the limiter, and it is read only after the
 * secret and scope checks (only the platform, which holds the secret, sets it). Absent = an unattributed call (the
 * page projector, the outbox relay, the reconcilers, a session mint), which has its own bucket per scope.
 */
export const RATE_PRINCIPAL_HEADER = 'x-ccc-rate-principal';
export const RATE_PRINCIPAL_PATTERN = new RegExp(`^(user|service):${PRINCIPAL_ID_PATTERN.source.replace(/^\^|\$$/g, '')}$`);

/** The 400 every malformed value gets. Fixed text: it never echoes the value. */
function invalidRatePrincipal(): BadRequestException {
  return new BadRequestException({
    message: `${RATE_PRINCIPAL_HEADER} must be a single user:<id> or service:<id>`,
    code: 'rate_principal_invalid',
  });
}

/**
 * The header's raw value → the rate key, or `undefined` when absent. Strict, fail closed (as `parseActingService`):
 * an array, a non-string, an empty value, a comma-joined repeat or anything not matching the pattern is a 400 —
 * never "unattributed", which would move the caller into the background callers' bucket.
 */
export function parseRatePrincipal(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes(',')) throw invalidRatePrincipal();
  if (!RATE_PRINCIPAL_PATTERN.test(raw)) throw invalidRatePrincipal();
  return raw;
}

/** One scope's three bucket sizes, per minute (#780). */
interface ScopeRateLimits {
  /** Each attributed principal's own bucket. */
  principal: number;
  /** All attributed calls together — the backstop that bounds the engine when many principals are busy at once. */
  global: number;
  /** All unattributed (background) calls together; attributed load never debits it. */
  unattributed: number;
}

/** `<prefix>_RATE_LIMIT` (per principal), `<prefix>_GLOBAL_RATE_LIMIT`, `<prefix>_UNATTRIBUTED_RATE_LIMIT`. */
const scopeLimits = (prefix: string, principal: number, global: number, unattributed: number): ScopeRateLimits => ({
  principal: envLimit(`${prefix}_RATE_LIMIT`, principal),
  global: envLimit(`${prefix}_GLOBAL_RATE_LIMIT`, global),
  unattributed: envLimit(`${prefix}_UNATTRIBUTED_RATE_LIMIT`, unattributed),
});

/**
 * Sizes per scope. The bridge is a backstop that protects the engine; the platform's own per-principal limits are the
 * primary control, so a principal's bucket here sits above what the platform lets one principal send:
 * - `pages:authz:read` (#545): the page projector reads it once per page event, plus fan-out and reconcile chunks.
 * - `pages:read` (#493): `/v1` page routes resolve "is this page live" through `resolve-space` on EVERY request,
 *   before the platform's per-key limiter is charged.
 * - `pages:import:read` (#616) is smaller: a validate-content call parses up to 1 MiB of HTML/Markdown (two calls per
 *   import submit or preview).
 * - every other scope: 2x the platform's per-owner limit per principal.
 */
const SCOPE_RATE_LIMITS: Partial<Record<ServiceScope, ScopeRateLimits>> = {
  [ServiceScope.PagesAuthzRead]: scopeLimits('SERVICE_BRIDGE_PAGES_AUTHZ', 6000, 60000, 6000),
  [ServiceScope.PagesRead]: scopeLimits('SERVICE_BRIDGE_PAGES_READ', 6000, 60000, 6000),
  [ServiceScope.PagesImportRead]: scopeLimits('SERVICE_BRIDGE_PAGES_IMPORT', 120, 1200, 120),
};
const DEFAULT_RATE_LIMITS = scopeLimits('SERVICE_BRIDGE', 1200, 6000, 600);
/** The single bucket every missing/wrong-secret request shares (F6). */
const ANON_RATE_LIMIT = envLimit('SERVICE_BRIDGE_ANON_RATE_LIMIT', 600);

export function rateLimitsFor(scope: ServiceScope): ScopeRateLimits {
  return SCOPE_RATE_LIMITS[scope] ?? DEFAULT_RATE_LIMITS;
}

type RateBucket = 'principal' | 'global' | 'unattributed' | 'anon';

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
 *  - Rate limiting (429 `rate_limited` + `Retry-After`) as a DoS backstop (#780): per scope, an attributed call is
 *    charged to its principal's own bucket AND the scope's global bucket, an unattributed call to the scope's
 *    unattributed bucket only, and the missing/wrong-secret path to one coarse `anon` bucket (429
 *    `service_auth_throttled`), so a bad-secret flood is bounded too. Token buckets: a throttled caller recovers
 *    gradually, never after a shared 60 s cliff.
 */
@Injectable()
export class ServiceAuthGuard implements CanActivate {
  private readonly credentials: ServiceCredential[];
  private readonly logger = new Logger(ServiceAuthGuard.name);
  private readonly limiter = new TokenBucketRateLimiter();
  /** When each `<scope> <bucket>` last logged a refusal: one warn line per bucket kind per minute, bounded. */
  private readonly lastLogged = new Map<string, number>();

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
      this.enforceAnonLimit(context, required);
      throw new UnauthorizedException('missing service credential');
    }

    const cred = this.credentials.find((c) => this.equals(provided, c.secret));
    if (!cred) {
      this.enforceAnonLimit(context, required);
      throw new UnauthorizedException('invalid service credential');
    }
    if (!cred.scopes.has(required)) {
      throw new ForbiddenException(`service credential lacks scope ${required}`);
    }

    // #780: only now (the caller holds the secret and the scope) is the rate key read; a malformed one is a 400.
    const principal = parseRatePrincipal(req.headers?.[RATE_PRINCIPAL_HEADER]);
    const limits = rateLimitsFor(required);
    const base = `${cred.id}:${required}`;
    const debits: Array<BucketDebit & { bucket: RateBucket }> = principal
      ? [
          { key: `${base}:${principal}`, limit: limits.principal, bucket: 'principal' },
          { key: `${base}:*`, limit: limits.global, bucket: 'global' },
        ]
      : [{ key: `${base}:-`, limit: limits.unattributed, bucket: 'unattributed' }];
    this.enforce(context, required, debits);
    attachServiceCredential(req, cred.id);
    return true;
  }

  /**
   * F6 (companion #272): rate-limit the UNAUTHENTICATED path too. The credential's buckets are only charged
   * AFTER a valid credential matches, so a missing/wrong-secret flood was previously unbounded — the "DoS
   * backstop" the class docstring promises did not cover the anonymous path.
   *
   * A SINGLE coarse `anon` bucket — deliberately NOT keyed on `req.ip`. `main.ts` sets `trustProxy: true`, so
   * `req.ip` is derived from a client-supplied `X-Forwarded-For`; keying on it would let an attacker (a) mint
   * a fresh 600/min budget per spoofed header (bypassing the very backstop this adds) and (b) grow the
   * limiter's in-memory window Map without bound (a memory-exhaustion vector). Every legitimate caller holds
   * the secret and uses the separate credential buckets, so all traffic that reaches this path is already
   * illegitimate; capping it collectively is exactly the intent, and the key space stays bounded and
   * unspoofable. (`/api/service/*` is east-west/internal, so this is a backstop, not the primary control.)
   */
  private enforceAnonLimit(context: ExecutionContext, scope: ServiceScope): void {
    // #780: its own code — a refusal here is a credential fault (the caller's secret is missing or wrong), never the
    // caller's own load, so an integrator must not read it as a per-principal `rate_limited`.
    this.enforce(context, scope, [{ key: 'anon', limit: ANON_RATE_LIMIT, bucket: 'anon' }], 'service_auth_throttled');
  }

  /**
   * Debit every bucket or none; refused → `429 <code>` with `Retry-After` set on the reply here (the CCC
   * `RetryAfterFilter` handles 503s and the conversion budget only, so nothing else would set it). The log line names
   * the scope and the bucket kind, never the principal.
   */
  private enforce(
    context: ExecutionContext,
    scope: ServiceScope,
    debits: Array<BucketDebit & { bucket: RateBucket }>,
    code: 'rate_limited' | 'service_auth_throttled' = 'rate_limited',
  ): void {
    const res = this.limiter.take(debits);
    if (res.ok) return;
    const now = this.limiter.now();
    for (const { key, bucket } of debits) {
      if (!res.short.includes(key)) continue;
      const tag = `${scope} ${bucket}`;
      const last = this.lastLogged.get(tag);
      if (last !== undefined && now - last < RATE_WINDOW_MS) continue;
      this.lastLogged.set(tag, now);
      this.logger.warn(`SERVICE_BRIDGE_RATE_LIMITED scope=${scope} bucket=${bucket}`);
    }
    const reply = context.switchToHttp().getResponse?.();
    if (typeof reply?.header === 'function') reply.header('Retry-After', String(res.retryAfterSec));
    throw new HttpException(
      { message: 'service rate limit exceeded', code },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private equals(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
