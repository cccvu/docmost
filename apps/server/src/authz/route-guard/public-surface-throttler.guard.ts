import { ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerStorage,
  ThrottlerException,
  ThrottlerGuard,
  ThrottlerRequest,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { isPublicRoute } from './route-classification';
import { CollabClientTrust } from '../collab-ingress/client-trust';

/**
 * CCC authorization integration — NOT upstream Docmost code (GitHub #29).
 *
 * A per-IP rate limiter for the ENTIRE unauthenticated public surface (the anonymous public-content
 * discovery list plus the public share/search/workspace-bootstrap read routes). It is registered ONCE as
 * a global `APP_GUARD` (app.module.ts, seam #4) and covers every current and future anonymously-reachable
 * HTTP route without touching a single controller.
 *
 * Design (uses only supported `@nestjs/throttler` APIs — object-form ctor + `skipIf` + `@InjectThrottlerStorage`):
 *   - It carries its OWN isolated options — a single `default` throttler — so it NEITHER reads NOR affects
 *     the shared `throttle.module.ts` named throttlers (`auth`, `ai-chat`) or `auth.controller`. Named
 *     `default` so the stock un-suffixed `Retry-After` / `X-RateLimit-*` headers are emitted.
 *   - Scoping is the documented per-throttler `skipIf` predicate: it applies ONLY to anonymously-reachable
 *     HTTP routes (`isPublicRoute` = `@Public()` OR `@PlatformPublic()`, the SAME predicate the route
 *     classifier uses — so the two can't drift) and is a no-op for authenticated / collab / WebSocket
 *     traffic. Legitimate signed-in traffic is never throttled by this guard.
 *   - Keying (`getTracker`, #810): the client address the platform's trusted-proxy walk resolves
 *     (`authz/collab-ingress/client-address.ts`, fed the platform's list by the collab bounds' `CollabClientTrust`,
 *     the same key as the collab pre-auth share). `X-Real-IP` is honest only on the nginx path (the front door
 *     OVERWRITES it); the ALB is publicly reachable and passes a client's own `X-Real-IP` through untouched, so a
 *     direct caller could rotate it per request for a fresh bucket, or name a proxied victim's address to spend the
 *     victim's bucket. The walk cannot be forged on either path (a client-written X-Forwarded-For entry always sits
 *     left of the one the ALB appends). An upgrade-style request it cannot key (two X-Forwarded-For lines, a non-IP
 *     address) shares ONE bucket. While the trust is unknown (the platform not answering yet, an older platform,
 *     native mode) it keys as before #810: `X-Real-IP`, else `req.ip` (Fastify `trustProxy:true`: the leftmost
 *     X-Forwarded-For token, the footgun `service-bridge/service-auth.guard.ts` F6 documents).
 *   - Availability (`handleRequest`): the limiter reuses the shared Redis storage, which makes the whole
 *     public surface depend on Redis. So it FAILS OPEN — a throttle-storage error or timeout logs a warning
 *     and admits the request, rather than 500-ing (or hanging) the anonymous read surface that was
 *     Redis-independent before this guard. A genuine over-limit `ThrottlerException` (429) still propagates.
 *
 * Defense-in-depth: the WAF `X-Real-IP` rate rule (unspoofable, coarse) is the hard edge backstop; this
 * app-layer limit is the per-endpoint, Redis-distributed layer #29 asked for.
 *
 * Tunable via env: `PUBLIC_RATE_LIMIT_MAX` (default 60) and `PUBLIC_RATE_LIMIT_TTL_MS` (default 60000) —
 * i.e. 60 requests / 60s per client IP per public route. Non-positive / non-integer values fall back to the
 * default (a negative limit would otherwise 429 the whole surface); the effective values are logged at boot.
 */

// Bound the wait on the throttle-storage round-trip. The shared ioredis client does not set a command
// timeout / disable the offline queue, so a Redis outage could otherwise HANG the increment; racing it keeps
// the fail-open path fast even when the storage never answers.
const STORAGE_TIMEOUT_MS = 1000;
/** The one bucket every request the trusted-proxy walk cannot key shares (no honest client sends one, #810). */
export const UNKEYABLE_TRACKER = 'unkeyable';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * True iff this is an HTTP request to an anonymously-reachable route (`@Public()` or `@PlatformPublic()`).
 * The guard throttles ONLY these; everything else (authenticated HTTP, WebSocket/RPC contexts) is skipped.
 * Exported for direct unit testing.
 */
export function isPublicHttpRoute(
  reflector: Reflector,
  context: ExecutionContext,
): boolean {
  if (context.getType() !== 'http') return false;
  return isPublicRoute(reflector, [context.getHandler(), context.getClass()]);
}

@Injectable()
export class PublicSurfaceThrottlerGuard extends ThrottlerGuard {
  private readonly log = new Logger(PublicSurfaceThrottlerGuard.name);

  constructor(
    // Both params are explicitly self-declared: subclassing ThrottlerGuard (whose base ctor carries
    // @InjectThrottlerOptions()/@InjectThrottlerStorage() param decorators) with a custom constructor
    // would otherwise let the base's inherited param metadata shift injection by index. Declaring the
    // full dependency array here makes resolution unambiguous.
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    // #810: the collab bounds' client trust (exported by CollaborationModule). Required: a graph without it fails to
    // boot instead of silently keying on the forgeable X-Real-IP (socket-bounds.module.spec.ts).
    @Inject(CollabClientTrust) private readonly clientTrust: CollabClientTrust,
  ) {
    // Read at construction (once, at boot for the APP_GUARD singleton) so ops can tune without a code
    // change and tests can pin a small limit before the app boots.
    const ttl = parsePositiveInt(process.env.PUBLIC_RATE_LIMIT_TTL_MS, 60_000);
    const limit = parsePositiveInt(process.env.PUBLIC_RATE_LIMIT_MAX, 60);
    super(
      {
        throttlers: [
          {
            name: 'default',
            ttl,
            limit,
            // Apply ONLY to anonymously-reachable HTTP routes; skip everything else (authenticated HTTP,
            // WS/RPC contexts). `skipIf` is a documented ThrottlerOptions predicate — no internals override.
            skipIf: (context: ExecutionContext) =>
              !isPublicHttpRoute(reflector, context),
          },
        ],
        errorMessage: 'Too many requests',
      },
      storage,
      reflector,
    );
    this.log.log(
      `@Public surface rate limit: ${limit} req / ${ttl}ms per client IP (the trusted-proxy walk once the platform serves its list; X-Real-IP until then)`,
    );
  }

  /**
   * Key on the platform's trusted-proxy walk once its list is known (#810); one shared bucket for a request it cannot
   * key. Until then, today's key: X-Real-IP, else `req.ip`.
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const client = this.clientTrust.keyFor(req?.raw ?? req);
    if (client) return client.status === 'keyed' ? client.key : UNKEYABLE_TRACKER;
    const raw = req?.headers?.['x-real-ip'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const realIp =
      typeof header === 'string' ? header.split(',')[0]?.trim() : undefined;
    return realIp || req.ip;
  }

  /**
   * Fail OPEN: this guard put the whole @Public surface behind Redis, so a storage error/timeout must admit
   * the request (with a warning) rather than take the surface down. A genuine 429 (ThrottlerException) still
   * propagates. The WAF X-Real-IP rate rule remains the hard backstop while the app limiter is degraded.
   */
  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    try {
      return await this.withStorageTimeout(super.handleRequest(requestProps));
    } catch (err) {
      if (err instanceof ThrottlerException) throw err; // real over-limit 429 — propagate
      this.log.warn(
        `@Public rate limiter failing OPEN (throttle storage unavailable): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return true;
    }
  }

  private async withStorageTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('throttle storage timeout')),
        STORAGE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
