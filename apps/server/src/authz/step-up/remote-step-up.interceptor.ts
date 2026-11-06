import { CallHandler, ExecutionContext, ForbiddenException, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { defer, Observable, switchMap } from 'rxjs';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { REMOTE_STEP_UP_ROUTES, StepUpRoute } from './remote-step-up.table';
import { isFreshAt, nowEpochSeconds, parseSessionFreshness } from './session-freshness';

/** The machine code the SPA (and the platform relay) recognize. */
export const STEP_UP_REQUIRED_CODE = 'step_up_required';

export const stepUpRequired = (): ForbiddenException =>
  new ForbiddenException({ message: 'Recent sign-in required', code: STEP_UP_REQUIRED_CODE });

type AuthedRequest = FastifyRequest & {
  user?: { user?: { id?: string }; workspace?: { id?: string } };
  raw: FastifyRequest['raw'] & { sessionId?: unknown };
};

/**
 * CCC authorization integration — NOT upstream Docmost code (wiki-v2 #713).
 *
 * In `AUTHZ_MODE=remote` every route in `remote-step-up.table.ts` (permanent purge, page ACL writes, space settings)
 * is answered only for a session that is freshly authenticated: the request's OWN `user_sessions` row
 * (`req.raw.sessionId`, which `jwt.strategy` sets after checking the row is active and the caller's) must carry a
 * platform freshness with `now < freshUntil`. Anything else is `403 {code: 'step_up_required'}`: no session id, a row
 * that is gone, revoked or someone else's, no or garbled metadata, a future `authTime`, or a lapsed window. It reads
 * that one row by id and never another session of the same user, so a fresh re-mint never refreshes an older token.
 *
 * Registered in app.module.ts (seam #4) after the #467 access audit and per-principal rate limit (so a refusal is
 * rate-limited and lands in the access row), after `RemoteNativeRefusalInterceptor` (a refused route stays a 404),
 * and BEFORE `RemotePurgeInterceptor`, which never calls the handler: registered after it, the purge would skip this
 * check. App-module interceptors also run before every module-registered one (export admission, the narrowing settle).
 * It runs before the handler, so before CASL and any write, and before the `ValidationPipe`, so a `when` predicate
 * reads the raw body (a throw gates). Native (standalone) mode, and every route not in the table, pass through.
 *
 * Not in AuthzModeModule/AuthzModule: an interceptor from an imported module would run after `RemotePurgeInterceptor`.
 */
@Injectable()
export class RemoteStepUpInterceptor implements NestInterceptor {
  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly sessions: UserSessionRepo,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode !== 'remote' || context.getType() !== 'http') return next.handle();
    const entry = REMOTE_STEP_UP_ROUTES.get(`${context.getClass().name}.${context.getHandler().name}`);
    if (!entry) return next.handle();
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (entry.when && !gates(entry.when, req.body)) return next.handle();
    return defer(() => this.requireFresh(req)).pipe(switchMap(() => next.handle()));
  }

  private async requireFresh(req: AuthedRequest): Promise<void> {
    const sessionId = req.raw?.sessionId;
    const userId = req.user?.user?.id;
    const workspaceId = req.user?.workspace?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0 || !userId || !workspaceId) throw stepUpRequired();
    const row = await this.sessions.findActiveById(sessionId);
    if (!row || row.userId !== userId || row.workspaceId !== workspaceId) throw stepUpRequired();
    if (!isFreshAt(parseSessionFreshness(row.metadata), nowEpochSeconds())) throw stepUpRequired();
  }
}

function gates(when: NonNullable<StepUpRoute['when']>, body: unknown): boolean {
  try {
    return when(body) !== false;
  } catch {
    return true;
  }
}
