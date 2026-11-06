import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';

/**
 * CCC request control — NOT upstream Docmost code (#716).
 *
 * The native page routes answer a non-json `format` by converting the WHOLE page back to HTML or Markdown on the
 * engine's event loop (`jsonToHtml`, and for Markdown Turndown on a jsdom window: ~1 s per MiB on a laptop, ~2.5 s
 * on Graviton, a DOM per call), after the read or the write. That is unthrottled and reachable by any session that
 * can view a page (`/api/pages/info`), so in remote mode it is refused before the handler: 400, "use /v1". Nothing
 * legitimate sends it there: the SPA never does, and the platform reads and writes HTML/Markdown through its own
 * routes (the conversion worker, `conditional-update`, the keyed create, which answers canonical JSON). Native
 * (standalone) mode keeps upstream's behaviour.
 *
 * Refused, per route:
 *   - `PageController.getPage` (`/api/pages/info`) and `PageController.update` (`/api/pages/update`): any `format`
 *     other than `json` (absent is json). The update's echo converts the updated page whatever the body changed.
 *   - `PageController.create` (`/api/pages/create`): a non-json `format` WITH content. A create with no content makes
 *     an empty page, whose echo costs nothing, and the platform may still send `format` on one.
 * The body is raw here (interceptors run before `ValidationPipe`); a `format` that is not a string is refused too
 * (fail closed: the pipe would refuse it anyway).
 *
 * Registered from AuthzModule (NativeFormatModule), like ExportAdmissionModule, so no upstream file changes; its
 * interceptors run inside AppModule's access audit, which records the 400.
 */
export const NATIVE_FORMAT_ROUTES = Object.freeze({
  'PageController.getPage': 'always',
  'PageController.update': 'always',
  'PageController.create': 'with-content',
} as const);

type Body = { format?: unknown; content?: unknown } | undefined;

/** Whether this native route's body asks the engine to convert a page on its event loop. */
export function refusesNativeFormat(route: string, body: Body): boolean {
  const rule = (NATIVE_FORMAT_ROUTES as Record<string, 'always' | 'with-content'>)[route];
  if (!rule) return false;
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  const format = b?.format;
  if (format === undefined || format === null || format === 'json') return false;
  if (rule === 'with-content') return Boolean(b?.content);
  return true;
}

export class NativeFormatRefusedException extends BadRequestException {
  constructor() {
    super({
      message:
        'This engine answers page content as JSON only. Read or write HTML and Markdown through /v1 (the platform API).',
      code: 'use_v1',
    });
  }
}

@Injectable()
export class NativeFormatInterceptor implements NestInterceptor {
  private readonly log = new Logger('NativeFormat');

  constructor(@Inject(AUTHZ_MODE) private readonly mode: AuthzMode) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode !== 'remote' || context.getType() !== 'http') return next.handle();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    if (!(route in NATIVE_FORMAT_ROUTES)) return next.handle();
    const req = context.switchToHttp().getRequest<{ body?: Body; user?: { user?: { id?: string } } }>();
    let refuse: boolean;
    try {
      refuse = refusesNativeFormat(route, req.body);
    } catch {
      refuse = true; // fail closed
    }
    if (!refuse) return next.handle();
    this.log.warn(`NATIVE_FORMAT_REFUSED route=${route} principal=${req.user?.user?.id ?? '-'}: answered 400 use_v1`);
    return throwError(() => new NativeFormatRefusedException());
  }
}
