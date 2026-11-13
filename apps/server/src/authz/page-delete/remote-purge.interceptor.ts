import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { defer, map, Observable, throwError } from 'rxjs';
import { User } from '@docmost/db/types/entity.types';
import { TransformHttpResponseInterceptor } from '../../common/interceptors/http-response.interceptor';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { RemotePurgeService } from './remote-purge.service';
import { RemoteTrashService } from './remote-trash.service';
import { RemoteRestoreService } from './remote-restore.service';
import { ACTING_SERVICE_HEADER, parseActingService } from './acting-service';

/** The upstream routes whose permanent branch reaches `PageService.forceDelete` and whose trash branch reaches
 *  `PageService.removePage` (`Controller.handler`). `remote-purge.fitness.spec.ts` pins this set to exactly the
 *  upstream routes that reach either. */
export const NATIVE_PURGE_ROUTES: ReadonlySet<string> = new Set(['PageController.delete']);

/** The upstream routes that reach `PageRepo.restorePage` (#556). `remote-purge.fitness.spec.ts` pins this set to
 *  exactly the upstream routes that reach it. */
export const NATIVE_RESTORE_ROUTES: ReadonlySet<string> = new Set(['PageController.restore']);

type AuthedRequest = FastifyRequest & {
  user?: { user?: User; workspace?: { id?: string } };
};

/**
 * CCC authorization integration — NOT upstream Docmost code (#636 W6, #661, #670, #556).
 *
 * In `AUTHZ_MODE=remote`, the native `POST /api/pages/delete` and `POST /api/pages/restore` never reach the upstream
 * handlers (the class keeps its first name, so app.module.ts's registration is unchanged):
 *  - `{permanentlyDelete: true}` runs `RemotePurgeService.purge` — space admin on every space AND `page#edit` on every
 *    page removed, decided under locks after a settle fence;
 *  - a trash (`permanentlyDelete` absent, null or false) runs `RemoteTrashService.trash` — `page#edit` on every page
 *    it trashes, under locks, and it trashes exactly those (#661);
 *  - a restore runs `RemoteRestoreService.restore` — atomic, only the pages trashed with the root, `page#edit` on each
 *    of them, under locks; a live page is a no-op (#556).
 * Upstream's handlers check the ROOT only, outside any lock, and cover no descendant. The answer is upstream's: the
 * delete handler's empty 200, or the restore handler's page, in main.ts's response envelope. An APP_INTERCEPTOR runs
 * OUTSIDE that global envelope (main.ts adds it after the app-module enhancers), so an interceptor that never calls
 * the handler never reaches it: the envelope is applied here, by the same `TransformHttpResponseInterceptor`. The services write the handlers'
 * `page.deleted` / `page.trashed` / `page.restored` audit rows. Native (standalone) mode passes through to the
 * upstream handlers untouched, and ignores the acting-service header.
 *
 * The platform's `x-ccc-acting-service` header (`acting-service.ts`, #670) names a delegated service account; it is
 * parsed strictly here, before any branch (malformed → 400, on a restore too), and only ever adds that account's
 * checks.
 *
 * It runs before the `ValidationPipe` (an interceptor that does not call the handler skips the pipe), so it reads the
 * raw body and fails closed: only a plain object whose `permanentlyDelete` is exactly `true` is a purge, and only one
 * whose flag is absent, null or false is a trash; any other value the DTO would refuse (`@IsBoolean`) is a 400 here
 * too, as is a missing or non-string `pageId` (on a restore, `PageIdDto`'s only field). Registered in app.module.ts
 * (seam #4) after the #467 access audit and per-principal rate limit, so a removal or restore is rate-limited and
 * lands in the access row.
 */
@Injectable()
export class RemotePurgeInterceptor implements NestInterceptor {
  private readonly envelope: TransformHttpResponseInterceptor<unknown>;

  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly purge: RemotePurgeService,
    private readonly trash: RemoteTrashService,
    private readonly restore: RemoteRestoreService,
    reflector: Reflector,
  ) {
    this.envelope = new TransformHttpResponseInterceptor(reflector);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode !== 'remote' || context.getType() !== 'http') return next.handle();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    const restoring = NATIVE_RESTORE_ROUTES.has(route);
    if (!restoring && !NATIVE_PURGE_ROUTES.has(route)) return next.handle();

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    let actingServiceId: string | undefined;
    try {
      actingServiceId = parseActingService(req.headers?.[ACTING_SERVICE_HEADER]);
    } catch (err) {
      return throwError(() => err);
    }
    const body = req.body as Record<string, unknown> | null | undefined;
    const flag =
      !restoring && body !== null && typeof body === 'object' && !Array.isArray(body) ? body.permanentlyDelete : undefined;
    const permanent = flag === true;
    if (!permanent && flag !== undefined && flag !== null && flag !== false) {
      return throwError(() => new BadRequestException(['permanentlyDelete must be a boolean value']));
    }
    const pageId = body !== null && typeof body === 'object' && !Array.isArray(body) ? body.pageId : undefined;
    if (typeof pageId !== 'string' || pageId.length === 0) {
      return throwError(() => new BadRequestException(['pageId should not be empty']));
    }
    const user = req.user?.user;
    const workspaceId = req.user?.workspace?.id;
    // The class-level JwtAuthGuard always resolves both; without them there is nobody to decide for.
    if (!user?.id || !workspaceId) return throwError(() => new UnauthorizedException());

    if (restoring) {
      // The restore handler answers the page (read after the commit), in the same envelope.
      const restored = defer(() => this.restore.restore(user, pageId, workspaceId, actingServiceId));
      return this.envelope.intercept(context, { handle: () => restored.pipe(map((r) => r.page)) });
    }
    const removed: Observable<unknown> = permanent
      ? defer(() => this.purge.purge(user, pageId, workspaceId, undefined, actingServiceId))
      : defer(() => this.trash.trash(user, pageId, workspaceId, undefined, actingServiceId));
    return this.envelope.intercept(context, { handle: () => removed.pipe(map(() => undefined)) });
  }
}
