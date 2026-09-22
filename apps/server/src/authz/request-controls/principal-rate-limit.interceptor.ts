import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerStorage,
  ThrottlerException,
  ThrottlerStorage,
} from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, from, mergeMap, throwError } from 'rxjs';
import { isPublicRoute } from '../route-guard/route-classification';

/**
 * CCC authorization integration — NOT upstream Docmost code (wiki-v2 #467).
 *
 * A per-PRINCIPAL rate limit for authenticated Docmost `/api` traffic (invariant #3), independent of the
 * edge per-IP WAF limit. It is an INTERCEPTOR, not a guard, on purpose: the only two global `APP_GUARD`s
 * run BEFORE the controller-scoped `JwtAuthGuard`, so `req.user` is unset at global-guard time — a guard
 * could only key on the unverified raw cookie, the documented bypass (platform `gateway/rate-limit.ts` F3:
 * per-principal quotas belong AFTER authentication). Interceptors run after all guards, so `req.user` is the
 * VERIFIED principal here.
 *
 * Keying: a SINGLE per-principal bucket (`principal:<userId>`) built by hand — NOT the stock
 * per-(class,handler) `generateKey`, which a scraper spreading across endpoints would evade. The limit is a
 * safety-net against one abusive/compromised session (a scraped token walking every page, a runaway
 * script), not a quota — the default (`200/10s`, block `10s`) is sized from the measured worst-case editor
 * burst (~150 `/api` req/10s) with headroom and a short, self-healing window.
 *
 * Availability: it puts every authenticated `/api` request behind Redis, so it FAILS OPEN — a storage
 * error/timeout admits (with a warning) rather than 500-ing the app. A genuine over-limit is a resolved
 * `false`, never an error, so it is never swallowed by the fail-open path. `count` mode logs a
 * `PRINCIPAL_RATE_LIMIT_WOULD_BLOCK` line instead of throwing (tune the limit against real traffic before
 * enforcing); `off` disables it.
 */
const STORAGE_TIMEOUT_MS = 1000;
type Mode = 'enforce' | 'count' | 'off';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseMode(raw: string | undefined): Mode {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'count' || v === 'off' ? v : 'enforce';
}

@Injectable()
export class PrincipalRateLimitInterceptor implements NestInterceptor {
  private readonly log = new Logger(PrincipalRateLimitInterceptor.name);
  // Read at construction (once) so ops can tune without a code change and a test can pin a small limit.
  private readonly limit = parsePositiveInt(process.env.PRINCIPAL_RATE_LIMIT_MAX, 200);
  private readonly ttl = parsePositiveInt(process.env.PRINCIPAL_RATE_LIMIT_TTL_MS, 10_000);
  private readonly blockMs = parsePositiveInt(process.env.PRINCIPAL_RATE_LIMIT_BLOCK_MS, 10_000);
  private readonly mode = parseMode(process.env.PRINCIPAL_RATE_LIMIT_MODE);
  // Its own throttler name so its Redis keys never collide with the shared auth/ai-chat throttlers.
  private readonly throttlerName = 'api-principal';

  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {
    this.log.log(
      `Per-principal /api rate limit: mode=${this.mode} ${this.limit} req / ${this.ttl}ms per user (block ${this.blockMs}ms)`,
    );
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode === 'off' || context.getType() !== 'http') return next.handle();

    const req = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: { user?: { id?: string } } }>();
    const userId = req.user?.user?.id;
    // No human principal ⇒ anonymous, or an east-west service/collab caller — exempt (like the platform
    // edge limiter exempts the service secret). @Public routes have no principal anyway; belt-and-suspenders.
    if (!userId) return next.handle();
    if (isPublicRoute(this.reflector, [context.getHandler(), context.getClass()])) return next.handle();

    const res = context.switchToHttp().getResponse<FastifyReply>();
    // Deliver the decision THROUGH the pipe so an over-limit is an OBSERVABLE ERROR (the outer access-audit
    // interceptor records the 429), never a synchronous throw. `next.handle()` is only subscribed when
    // admitted, so the controller never runs on a 429 (reject-before-handler).
    return from(this.decide(userId, res)).pipe(
      mergeMap((allowed) =>
        allowed ? next.handle() : throwError(() => new ThrottlerException('Too many requests')),
      ),
    );
  }

  /** true = admit, false = block (429 headers already set). Fails OPEN on storage error/timeout. */
  private async decide(userId: string, res: FastifyReply): Promise<boolean> {
    const key = `principal:${userId}`;
    try {
      const record = await this.withTimeout(
        this.storage.increment(key, this.ttl, this.limit, this.blockMs, this.throttlerName),
      );
      const over = record.isBlocked || record.totalHits > this.limit;
      if (!over) return true;
      if (this.mode === 'count') {
        this.log.warn(
          `PRINCIPAL_RATE_LIMIT_WOULD_BLOCK principal=${userId} hits=${record.totalHits} limit=${this.limit} ttlMs=${this.ttl}`,
        );
        return true;
      }
      // timeToBlockExpire / timeToExpire are already in SECONDS (the storage ceil-converts from ms).
      this.setHeaders(res, record.timeToBlockExpire, record.timeToExpire);
      return false;
    } catch (err) {
      this.log.warn(
        `Per-principal rate limiter failing OPEN (throttle storage unavailable): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return true;
    }
  }

  private setHeaders(res: FastifyReply, retryAfterS: number, resetS: number): void {
    if (typeof res?.header !== 'function') return;
    res.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterS) || 1)));
    res.header('X-RateLimit-Limit', String(this.limit));
    res.header('X-RateLimit-Remaining', '0');
    res.header('X-RateLimit-Reset', String(Math.max(0, Math.ceil(resetS))));
  }

  // Bound the wait on the throttle-storage round-trip: the shared ioredis client sets no command timeout,
  // so a Redis outage could otherwise HANG the increment. Racing it keeps the fail-open path fast.
  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('throttle storage timeout')), STORAGE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
