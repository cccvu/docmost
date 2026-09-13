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

interface ServiceCredential {
  id: string;
  secret: string;
  scopes: ReadonlySet<ServiceScope>;
}

const RATE_LIMIT = (() => {
  const n = Number.parseInt(process.env.SERVICE_BRIDGE_RATE_LIMIT ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 600;
})();

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

    if (!this.limiter.allow(`${cred.id}:${required}`)) {
      throw new HttpException(
        'service rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
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
