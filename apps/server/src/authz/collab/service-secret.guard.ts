import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Verifies the platform's shared service secret (`x-authz-service-secret`) on the inbound
 * force-disconnect signal — the same secret convention the fork's PlatformAuthzClient presents
 * outbound. Fails closed if the secret is unconfigured.
 */
@Injectable()
export class CollabServiceSecretGuard implements CanActivate {
  private readonly secret = process.env.PLATFORM_AUTHZ_SERVICE_SECRET ?? '';

  canActivate(context: ExecutionContext): boolean {
    if (!this.secret) throw new ServiceUnavailableException('service secret not configured');
    const req = context.switchToHttp().getRequest();
    const provided = req.headers?.['x-authz-service-secret'];
    if (typeof provided !== 'string' || !this.equals(provided, this.secret)) {
      throw new UnauthorizedException('invalid service secret');
    }
    return true;
  }

  private equals(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
