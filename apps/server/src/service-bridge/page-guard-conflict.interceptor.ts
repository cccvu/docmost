import { CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { RESTRICTED_SPACE_MOVE, RESTRICTION_STRIP } from './page-restriction-guard.installer';

/** The database page guards' refusals (SQLSTATE 23514) and what a person is told. A closed set: nothing else maps. */
export const PAGE_GUARD_CONFLICTS: Readonly<Record<string, string>> = {
  ccc_page_no_cycle: 'A page cannot be moved under itself or one of its sub-pages.',
  [RESTRICTED_SPACE_MOVE]:
    'A restricted page, or a page in a restricted section, cannot be moved to another space. Remove the restriction first.',
  [RESTRICTION_STRIP]:
    'This move would take the page out of its restricted section. Restrict the page itself first, or move it within the section.',
};

/**
 * The 409 for a page-guard refusal, or null for any other error. Keyed on the constraint postgres.js reports
 * (`constraint_name`), never on the message, and the body is a fixed text: no page id or tree detail reaches the
 * client.
 */
export function toPageGuardConflict(err: unknown): ConflictException | null {
  const e = err as { code?: unknown; constraint_name?: unknown } | null;
  if (!e || e.code !== '23514' || typeof e.constraint_name !== 'string') return null;
  const message = PAGE_GUARD_CONFLICTS[e.constraint_name];
  return message ? new ConflictException({ message, code: e.constraint_name }) : null;
}

/**
 * CCC service-bridge — NOT upstream Docmost code (#493, #545).
 *
 * The page guards (`ccc_page_cycle_guard`, `ccc_page_space_guard`, `ccc_page_restriction_guard`) refuse inside the database, so the engine's
 * own move/restore paths surface a raw driver error — a 500 today. This maps exactly those refusals to
 * `409 { message, code }` (the `code` is the constraint, which the platform forwards as its own problem code) and
 * passes every other error through untouched.
 *
 * Registered as an APP_INTERCEPTOR by ServiceBridgeModule (no upstream seam). It must stay INNER to the #467
 * `ApiAccessAuditInterceptor` (app.module.ts) so the access audit records the 409, not a 500: interceptors from
 * AppModule's own providers wrap those of the modules it imports — pinned by `page-guard-conflict.interceptor.spec.ts`.
 */
@Injectable()
export class PageGuardConflictInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    return next.handle().pipe(catchError((err) => throwError(() => toPageGuardConflict(err) ?? err)));
  }
}
