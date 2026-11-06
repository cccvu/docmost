import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, defer, finalize, throwError } from 'rxjs';

/**
 * CCC request control — NOT upstream Docmost code (#699).
 *
 * Admission for the heavy native exports: `ExportController.exportSpace`, and `ExportController.exportPage` when it
 * builds a zip (`includeChildren` or `includeAttachments`). At most ONE such export per principal and EIGHT per process
 * run at once; any more answer 503 `engine_busy` with `Retry-After` before the handler runs. Each export holds its
 * pages' content and their serialized output on the main heap until the archive has streamed, and while it streams
 * holds one storage socket (the S3 pool has 50, shared with every download and upload), so eight leaves the pool to
 * everyone else and keeps the heap the exports can hold together bounded (export-limits.ts). Since #716 the pages are
 * serialized in the conversion worker, not on the main thread: one export page at a time across ALL exports (the
 * worker's serialize lane), under the human's own `:export` budget, inside a 45 s build deadline
 * (editor-compat/export/export-conversion.ts). That also bounds the single-page export without attachments, which the
 * platform's `/v1` export job uses (`includeChildren:false, includeAttachments:false`): it stays unadmitted here, but
 * its one serialization takes the human's turn and the lane like any other.
 *
 * A slot is released only when BOTH the handler has finished AND the response has closed. The handler uses `@Res()`
 * and returns as soon as it has handed the archive stream to fastify, so releasing on the handler alone would free the
 * slot while the archive is still streaming; releasing on the close alone would free it while a refused export is
 * still being worked on. The export's own wall-clock cap (EXPORT_MAX_DURATION_MS) destroys a stalled response, so a
 * client that stops reading cannot hold a slot forever. Release is idempotent.
 *
 * Keyed on the VERIFIED principal (`req.user`, set by the route's JwtAuthGuard; interceptors run after guards), like
 * the per-principal rate limit. Applies in both AUTHZ_MODEs: it bounds resources, not access. Registered from
 * AuthzModule (ExportAdmissionModule), so it runs inside AppModule's access-audit interceptor, which records the 503.
 */
export const EXPORT_ADMISSION = Object.freeze({ perPrincipal: 1, global: 8, retryAfterSeconds: 30 });

export const GOVERNED_EXPORT_ROUTES = Object.freeze(['ExportController.exportSpace', 'ExportController.exportPage']);

type ExportBody = { includeChildren?: unknown; includeAttachments?: unknown } | undefined;

/** Whether this request is a heavy export the admission governs. */
export function isGovernedExport(route: string, body: ExportBody): boolean {
  if (route === 'ExportController.exportSpace') return true;
  if (route === 'ExportController.exportPage') return Boolean(body?.includeChildren) || Boolean(body?.includeAttachments);
  return false;
}

export class ExportBusyException extends ServiceUnavailableException {
  constructor() {
    super({
      message: 'An export is already running (yours, or too many on the server); retry shortly.',
      code: 'engine_busy',
    });
  }
}

@Injectable()
export class ExportAdmissionInterceptor implements NestInterceptor {
  private readonly log = new Logger('ExportAdmission');
  private active = 0;
  private readonly principals = new Map<string, number>();

  /** Exports currently admitted (for tests and diagnostics). */
  get inFlight(): number {
    return this.active;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    const req = context
      .switchToHttp()
      .getRequest<FastifyRequest & { body?: ExportBody; user?: { user?: { id?: string } } }>();
    if (!isGovernedExport(route, req.body)) return next.handle();

    const res = context.switchToHttp().getResponse<FastifyReply>();
    // The governed routes sit behind JwtAuthGuard, so a principal is always set here; if one ever is not, all such
    // callers share one key (fail closed: they never bypass the per-principal limit).
    const principal = req.user?.user?.id ?? 'anonymous';

    const scope =
      (this.principals.get(principal) ?? 0) >= EXPORT_ADMISSION.perPrincipal
        ? 'principal'
        : this.active >= EXPORT_ADMISSION.global
          ? 'global'
          : null;
    if (scope) {
      this.log.warn(
        `EXPORT_BUSY scope=${scope} route=${route} principal=${principal} inFlight=${this.active}: answered 503 engine_busy`,
      );
      if (typeof res?.header === 'function') res.header('Retry-After', String(EXPORT_ADMISSION.retryAfterSeconds));
      // Through the pipe, so the outer access-audit interceptor records the 503 (reject before the handler).
      return throwError(() => new ExportBusyException());
    }

    const release = this.admit(principal);
    let handlerDone = false;
    let responseClosed = false;
    const settle = () => {
      if (handlerDone && responseClosed) release();
    };
    const raw = res?.raw;
    if (!raw || raw.destroyed) {
      responseClosed = true;
    } else {
      raw.once('close', () => {
        responseClosed = true;
        settle();
      });
    }
    return defer(() => next.handle()).pipe(
      finalize(() => {
        handlerDone = true;
        settle();
      }),
    );
  }

  private admit(principal: string): () => void {
    this.active++;
    this.principals.set(principal, (this.principals.get(principal) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; // idempotent: a double release must never free a slot someone else holds
      released = true;
      this.active--;
      const n = (this.principals.get(principal) ?? 1) - 1;
      if (n <= 0) this.principals.delete(principal);
      else this.principals.set(principal, n);
    };
  }
}
