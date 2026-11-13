import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { ORIGIN_CHECK_REFUSED_MESSAGE, originCheckAllows, signalsFromHeaders } from './origin-check';
import { logOriginCheckRefused } from './origin-check-log';

/** The methods that never change state. Every other method is decided (fail closed on an unknown verb). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * In-process CSRF check for the engine's HTTP routes — NOT upstream Docmost code (wiki-v2 #655).
 *
 * Before #655 the only thing between a same-site page and a cookie-authenticated `/api` write was the edge WAF
 * (`SameSite=lax` is no backstop: on a public suffix such as `.edu`, every sibling host is same-SITE and its form
 * POSTs carry the cookie). This guard applies the platform's #510 decision ({@link originCheckAllows}) inside the
 * engine, so a request the WAF misses, or a deployment with no WAF (local, compose, standalone), is still refused.
 *
 * Gated set: every HTTP request whose method is not GET/HEAD/OPTIONS. Unlike the platform guard, it does NOT skip a
 * request without the session cookie, a bearer request, or a `@Public` route:
 *   - the engine's `jwt.strategy` reads the cookie FIRST and a bearer only as a fallback, so "has a bearer" never
 *     means "not cookie-authenticated" here;
 *   - deciding cookie-less requests too closes login CSRF on the native credential routes (standalone mode);
 *   - every legitimate non-browser caller (the platform relay and service bridge, smokes, load and Playwright API
 *     clients) sends no Origin, Referer or Sec-Fetch-Site, which the table allows ("no signal").
 *
 * Inputs: the raw `Host` header (never Fastify's `request.host`/`hostname`: with `trustProxy: true` those honour
 * `X-Forwarded-Host`, which any client can send), and the trusted list `[APP_URL]` alone. A host that preserves
 * `Host` (an alias behind the front door) passes by the Host match; a genuinely cross-origin frontend would need an
 * explicit allowlist, and none exists. The socket.io handshake gets the same decision from `ws-origin-check.ts`.
 *
 * Registered as an `APP_GUARD` from `OriginCheckModule` (imported by AuthzModule, so no upstream file), it runs before
 * every controller guard; a refusal is a 403 with the platform's message and one rate-limited
 * `FORK_ORIGIN_CHECK_REFUSED` line (origin-check-log.ts: signal shapes only, never a header value).
 */
@Injectable()
export class ForkOriginCheckGuard implements CanActivate {
  constructor(private readonly environmentService: EnvironmentService) {}

  canActivate(ctx: ExecutionContext): boolean {
    // A global guard also wraps socket.io message handlers; their handshake is checked by the socket middleware.
    if (ctx.getType() !== 'http') return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has((req.method ?? 'GET').toUpperCase())) return true;

    if (originCheckAllows(signalsFromHeaders(req.headers), [this.environmentService.getAppUrl()])) return true;
    logOriginCheckRefused('http', req.headers, req.method);
    throw new ForbiddenException(ORIGIN_CHECK_REFUSED_MESSAGE);
  }
}
