import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, tap } from 'rxjs';
import { isPublicRoute } from '../route-guard/route-classification';
import { buildClientEvidenceFromReq } from '../audit/request-evidence';
import { ApiAccessAuditService, ApiAccessFacts } from './api-access-audit.service';

/**
 * CCC authorization integration — NOT upstream Docmost code (wiki-v2 #467).
 *
 * Emits exactly ONE uniform per-request `access` audit row for every AUTHENTICATED Docmost `/api` request
 * (invariant #3, D8). Registered as a global `APP_INTERCEPTOR` (app.module.ts seam #4), OUTER to the
 * per-principal rate-limit interceptor, so it also records a 429 the limiter raises (delivered as an
 * observable error). Mirrors the platform's own `/v1` `V1AuditInterceptor`: it captures only non-secret
 * request FACTS (actor, method, route with the query stripped, status, outcome, duration) and NEVER the
 * body or the `Authorization`/cookie headers.
 *
 * Scope: authenticated HTTP requests with a resolved `req.user.user.id`. Skipped for non-HTTP (collab WS),
 * `@Public`/anonymous routes, east-west service/collab callers (no `{user,workspace}` principal), and an
 * env-tunable noise set. This is the HTTP-layer access envelope; it coexists with (does not duplicate) the
 * variable-cardinality `domain` events the same request may also emit.
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseCsvSet(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function pathOnly(url: string): string {
  return url.split('?')[0];
}

@Injectable()
export class ApiAccessAuditInterceptor implements NestInterceptor {
  // High-frequency / non-security routes an operator can mute (health/version are anonymous and already
  // filtered by the principal gate, but kept explicit). Read once at construction.
  private readonly excludePrefixes = [
    '/api/health',
    '/api/version',
    ...parseCsvSet(process.env.API_AUDIT_EXCLUDE_ROUTES),
  ];
  // Extreme-load relief valve: when true, only mutations (non-GET/HEAD/OPTIONS) are audited.
  private readonly mutationsOnly = process.env.API_AUDIT_MUTATIONS_ONLY === 'true';

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: ApiAccessAuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.audit.enabled || context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<
      FastifyRequest & { user?: { user?: { id?: string }; workspace?: { id?: string } } }
    >();
    const actorId = req.user?.user?.id;
    // No human principal ⇒ anonymous, or an east-west service/collab caller (those authenticate via a
    // different guard and never populate the {user,workspace} JWT shape). Nothing to attribute.
    if (!actorId) return next.handle();
    if (isPublicRoute(this.reflector, [context.getHandler(), context.getClass()])) return next.handle();

    const method = (req.method ?? 'GET').toUpperCase();
    const route = pathOnly(req.url ?? '');
    const isRead = READ_METHODS.has(method);
    if (this.mutationsOnly && isRead) return next.handle();
    if (this.excludePrefixes.some((p) => route === p || route.startsWith(`${p}/`))) return next.handle();

    // Capture facts synchronously inside the request scope so the deferred tap callbacks don't depend on
    // async-context propagation through the RxJS pipe (the pattern V1AuditInterceptor uses).
    const ua = req.headers?.['user-agent'];
    const facts: ApiAccessFacts = {
      method,
      route,
      actorId,
      workspaceId: req.user?.workspace?.id,
      priority: isRead ? 'low' : 'normal',
      clientEvidence: buildClientEvidenceFromReq(req.raw),
      userAgent: typeof ua === 'string' ? ua : undefined,
    };
    const res = context.switchToHttp().getResponse<FastifyReply>();
    const startedAt = Date.now();
    const emit = (outcome: 'success' | 'error', status: number): void =>
      this.audit.record(facts, status, outcome, Date.now() - startedAt);

    return next.handle().pipe(
      tap({
        next: () => emit('success', typeof res?.statusCode === 'number' ? res.statusCode : 200),
        // A 429 from the inner rate-limit interceptor, or any downstream throw, lands here and is audited.
        error: (err) => emit('error', err instanceof HttpException ? err.getStatus() : 500),
      }),
    );
  }
}
