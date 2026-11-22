import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { CollabQuiescedException } from '../collab-ingress/collab-quiesce';

/** The upstream route whose inline variant is refused while collab is quiesced (`Controller.handler`). */
export const INLINE_COMMENT_CREATE_ROUTE = 'CommentController.create';

/**
 * CCC authorization integration — NOT upstream Docmost code (wiki-v2 #919, F7).
 *
 * While collab is quiesced (authz/collab-ingress/collab-quiesce.ts), a comment create that carries a `yjsSelection`
 * (an inline comment, whose highlight is a mark written into the live document) is refused 503 BEFORE the handler, so
 * before its row insert. Upstream's `CommentService.create` inserts the row first and then writes the mark through
 * the collab document, catching every failure of that write: during a quiesce the mark is refused (no direct write
 * while draining), so the reader would get a 200 with a comment and no highlight, and a 503 after the insert would
 * break "503 = nothing changed" (a retry would duplicate the comment). A page-level comment (no selection) writes no
 * mark and passes; outside a quiesce nothing changes.
 *
 * An APP_INTERCEPTOR registered by CommentResolutionModule (which imports CollaborationModule for the gateway), so the
 * upstream controller and service stay untouched. It runs after the route's guards (a caller that is not signed in
 * still gets its 401) and reads the raw body, so a `yjsSelection` the DTO would reject is refused too (fail closed).
 * Matched by `Controller.handler`; inline-comment-quiesce.interceptor.spec.ts pins that key to the real route.
 */
@Injectable()
export class InlineCommentQuiesceInterceptor implements NestInterceptor {
  constructor(private readonly gateway: CollaborationGateway) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    if (`${context.getClass().name}.${context.getHandler().name}` !== INLINE_COMMENT_CREATE_ROUTE) return next.handle();
    if (!this.gateway.isQuiesced()) return next.handle();
    const body = context.switchToHttp().getRequest<{ body?: { yjsSelection?: unknown } }>().body;
    if (!body?.yjsSelection) return next.handle();
    return throwError(() => new CollabQuiescedException());
  }
}
