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
 *  - Per-credential rate limiting (429) as a DoS backstop.
 */
@Injectable()
export class ServiceAuthGuard implements CanActivate {
  private readonly credentials: ServiceCredential[];
  private readonly limiter = new FixedWindowRateLimiter(RATE_LIMIT, 60_000);

  constructor(private readonly reflector: Reflector) {
    const shared = process.env.PLATFORM_AUTHZ_SERVICE_SECRET ?? '';
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
      throw new UnauthorizedException('missing service credential');
    }

    const cred = this.credentials.find((c) => this.equals(provided, c.secret));
    if (!cred) throw new UnauthorizedException('invalid service credential');
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

  private equals(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
