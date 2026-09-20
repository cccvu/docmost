import { ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

/**
 * CCC authorization integration — NOT upstream Docmost code (GitHub #29).
 *
 * A per-IP rate limiter for the ENTIRE unauthenticated `@Public()` surface (the anonymous
 * public-content discovery list plus the public share/search/workspace-bootstrap read routes). It is
 * registered ONCE as a global `APP_GUARD` (app.module.ts, seam #4) and covers every current and future
 * `@Public()` HTTP route without touching a single controller.
 *
 * Why a dedicated guard rather than the shared throttler / config:
 *   - It carries its OWN isolated options — a single unnamed-but-named `public` throttler — passed to
 *     the stock `ThrottlerGuard` constructor. It therefore NEITHER reads NOR affects the shared
 *     `throttle.module.ts` named throttlers (`auth`, `ai-chat`) or `auth.controller`.
 *   - Scoping is done with the documented per-throttler `skipIf` predicate (evaluated by the stock
 *     `canActivate`), not by overriding internals: it applies ONLY to `@Public()` HTTP routes and is a
 *     no-op for authenticated / collab / WebSocket traffic — so legitimate signed-in traffic is never
 *     throttled by this guard.
 *   - It reuses the shared Redis `ThrottlerStorage` (via `@InjectThrottlerStorage()`), so the limit is
 *     distributed across ECS tasks, and the stock per-route+per-IP key
 *     (`sha256(Class-Handler-name-tracker)`, tracker = `req.ip` under Fastify `trustProxy:true`) gives
 *     each `@Public` route its own bucket — protecting the DB-amplifying discovery query without one
 *     shared bucket starving normal share browsing.
 *
 * This is defense-in-depth: the WAF's `X-Real-IP` rate rule (unspoofable, coarse) is the hard edge
 * backstop; this app-layer limit is the per-endpoint, Redis-distributed layer the issue asked for.
 *
 * Tunable via env (no redeploy of code needed): `PUBLIC_RATE_LIMIT_MAX` (default 60) and
 * `PUBLIC_RATE_LIMIT_TTL_MS` (default 60000) — i.e. 60 requests / 60s per client IP per public route.
 */
/**
 * True iff this is an HTTP request to an `@Public()` route. The guard throttles ONLY these; everything
 * else (authenticated HTTP, WebSocket/RPC contexts) is skipped. Exported for direct unit testing.
 */
export function isPublicHttpRoute(
  reflector: Reflector,
  context: ExecutionContext,
): boolean {
  if (context.getType() !== 'http') return false;
  return (
    reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

@Injectable()
export class PublicSurfaceThrottlerGuard extends ThrottlerGuard {
  constructor(
    // Both params are explicitly self-declared: subclassing ThrottlerGuard (whose base ctor carries
    // @InjectThrottlerOptions()/@InjectThrottlerStorage() param decorators) with a custom constructor
    // would otherwise let the base's inherited param metadata shift injection by index. Declaring the
    // full dependency array here makes resolution unambiguous.
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
  ) {
    super(
      {
        throttlers: [
          {
            // 'default' (not a custom name) so the stock un-suffixed `Retry-After` / `X-RateLimit-*`
            // response headers are emitted — a named throttler would suffix them (`Retry-After-public`),
            // which HTTP clients don't read. Isolated from the shared module's auth/ai-chat throttlers
            // because this guard passes its OWN options object.
            name: 'default',
            // Read at construction (once, at boot for the APP_GUARD singleton) so ops can tune without a
            // code change and tests can pin a small limit before the app boots.
            ttl: Number(process.env.PUBLIC_RATE_LIMIT_TTL_MS) || 60_000,
            limit: Number(process.env.PUBLIC_RATE_LIMIT_MAX) || 60,
            // Apply ONLY to @Public() HTTP routes; skip everything else (authenticated HTTP, WS/RPC
            // contexts). `skipIf` is a documented ThrottlerOptions predicate — no internals override.
            skipIf: (context: ExecutionContext) =>
              !isPublicHttpRoute(reflector, context),
          },
        ],
        errorMessage: 'Too many requests',
      },
      storage,
      reflector,
    );
  }
}
