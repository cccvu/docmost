import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import {
  findUnstorableText,
  InvalidCharactersException,
  isJsonContentType,
  RequestTooComplexException,
  UnstorableFinding,
} from './storable-text';

/**
 * CCC request control — NOT upstream Docmost code (#781, ADR 0036).
 *
 * Refuses a request carrying a NUL or a lone UTF-16 surrogate in its JSON body, its query string or its path
 * parameters with 400 `invalid_characters` BEFORE the handler runs, so nothing of it is applied. Without it the string
 * reached Postgres and failed there as a 500 — on the `/v1` conditional update after the content had already been
 * written to the live document (the title is written second), which the platform renders "may have been applied".
 * `PgInputErrorFilter` is the backstop for what this cannot see (a string the handler decodes itself, such as a
 * comment's JSON-string `content`).
 *
 * An INTERCEPTOR, registered from AuthzModule (StorableTextModule) like NativeFormatModule: global, so it runs on every
 * controller route (native, `/api/service/*`, conditional and keyed routes alike), after the guards (an unauthenticated
 * caller still gets its 401/403 first and this walks nothing for it) and inside AppModule's access audit and
 * per-principal rate limit, which therefore record and count the 400. It runs before the global ValidationPipe, on the
 * raw parsed body, so a field the whitelist would strip is checked too (harmless: nothing legitimate sends a NUL).
 *
 * Only a JSON body (`application/json`, `…+json`) is walked; a multipart upload carries no parsed body here (its parts
 * are read from the stream by the handler) and its file bytes are binary, and no route takes text bodies. Not HTTP
 * (socket.io gateways): passed through untouched — the collab WebSocket is Hocuspocus on the raw server and never
 * reaches Nest at all.
 */
type Req = {
  body?: unknown;
  query?: unknown;
  params?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  routeOptions?: { url?: string };
  user?: { user?: { id?: string } };
};

const ownKeys = (v: unknown): unknown => (v !== null && typeof v === 'object' ? { ...v } : v);

const joinPath = (prefix: string, path: string) =>
  path === '' ? prefix : path.startsWith('[') ? `${prefix}${path}` : `${prefix}.${path}`;

@Injectable()
export class StorableTextInterceptor implements NestInterceptor {
  private readonly log = new Logger('StorableText');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Req>();
    const contentType = req.headers?.['content-type'];
    // Fastify's query and params objects are not plain (fast-querystring's prototype is an empty null-prototype
    // object), so their own keys are copied into plain ones: their values are strings and arrays of strings.
    const sources: Array<[string, unknown]> = [
      ['params', ownKeys(req.params)],
      ['query', ownKeys(req.query)],
      ...(isJsonContentType(Array.isArray(contentType) ? contentType[0] : contentType)
        ? ([['body', req.body]] as Array<[string, unknown]>)
        : []),
    ];
    for (const [name, value] of sources) {
      const finding: UnstorableFinding | null = findUnstorableText(value);
      if (!finding) continue;
      const route = req.routeOptions?.url ?? '-';
      const principal = req.user?.user?.id ?? '-';
      if (finding.kind === 'too_complex') {
        this.log.warn(`STORABLE_TEXT_REFUSED route=${route} principal=${principal} source=${name}: 413 request_too_complex`);
        return throwError(() => new RequestTooComplexException());
      }
      const field = joinPath(name, finding.path);
      // The field path only: never the value.
      this.log.warn(`STORABLE_TEXT_REFUSED route=${route} principal=${principal} field=${JSON.stringify(field)}: 400 invalid_characters`);
      return throwError(() => new InvalidCharactersException(field));
    }
    return next.handle();
  }
}
