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
 *   - Keying (`getTracker`): the nginx-stamped **`X-Real-IP`** (the real client socket address; the
 *     front-door OVERWRITES any client-supplied value — `infra/front-door/.../wiki-proxy.conf` — and it is
 *     the same basis the ALB WAF rate rule uses). It deliberately does NOT key on `req.ip`, which under
 *     Fastify `trustProxy:true` is the client-controlled leftmost `X-Forwarded-For` token — an attacker
 *     could rotate that header to mint a fresh bucket per request and bypass the limit (the footgun the
 *     sibling `service-bridge/service-auth.guard.ts` F6 documents). Falls back to `req.ip` only when the
 *     header is absent (standalone / dev, no front-door — not an internet threat surface).
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
      `@Public surface rate limit: ${limit} req / ${ttl}ms per client IP (X-Real-IP)`,
    );
  }

  /**
   * Key on the unspoofable, nginx-stamped X-Real-IP rather than the stock `req.ip` (leftmost XFF under
   * trustProxy:true). Falls back to `req.ip` only when the header is absent (dev/standalone, no front-door).
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
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
