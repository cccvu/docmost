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

/** The upstream routes whose permanent branch reaches `PageService.forceDelete` (`Controller.handler`).
 *  `remote-purge.fitness.spec.ts` pins this set to exactly the upstream routes that reach it. */
export const NATIVE_PURGE_ROUTES: ReadonlySet<string> = new Set(['PageController.delete']);

type AuthedRequest = FastifyRequest & {
  user?: { user?: User; workspace?: { id?: string } };
};

/**
 * CCC authorization integration — NOT upstream Docmost code (#636 W6).
 *
 * In `AUTHZ_MODE=remote`, the native `POST /api/pages/delete {permanentlyDelete: true}` runs `RemotePurgeService.purge`
 * — space admin AND `page#edit` on every page removed, decided under locks after a settle fence — INSTEAD of the
 * upstream handler, which is never called (its own check, space `Manage Settings`, runs outside any lock and covers
 * no descendant). The answer is upstream's: the handler's empty 200 in main.ts's response envelope. An APP_INTERCEPTOR
 * runs OUTSIDE that global envelope (main.ts adds it after the app-module enhancers), so an interceptor that never
 * calls the handler never reaches it: the envelope is applied here, by the same `TransformHttpResponseInterceptor`.
 * The service writes the handler's `page.deleted` audit row. A trash (`permanentlyDelete` absent, null or false)
 * and native (standalone) mode pass through to the upstream handler untouched.
 *
 * It runs before the `ValidationPipe` (an interceptor that does not call the handler skips the pipe), so it reads the
 * raw body and fails closed: only a plain object whose `permanentlyDelete` is exactly `true` is a purge; any other
 * value the DTO would refuse (`@IsBoolean`) is a 400 here too, so no body the handler could read as permanent ever
 * reaches it. Registered in app.module.ts (seam #4) after the #467 access audit and per-principal rate limit, so a
 * purge is rate-limited and lands in the access row.
 */
@Injectable()
export class RemotePurgeInterceptor implements NestInterceptor {
  private readonly envelope: TransformHttpResponseInterceptor<unknown>;

  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly purge: RemotePurgeService,
    reflector: Reflector,
  ) {
    this.envelope = new TransformHttpResponseInterceptor(reflector);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode !== 'remote' || context.getType() !== 'http') return next.handle();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    if (!NATIVE_PURGE_ROUTES.has(route)) return next.handle();

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const body = req.body as Record<string, unknown> | null | undefined;
    const flag = body !== null && typeof body === 'object' && !Array.isArray(body) ? body.permanentlyDelete : undefined;
    if (flag === undefined || flag === null || flag === false) return next.handle(); // a trash: upstream's
    if (flag !== true) {
      return throwError(() => new BadRequestException(['permanentlyDelete must be a boolean value']));
    }
    const pageId = body!.pageId;
    if (typeof pageId !== 'string' || pageId.length === 0) {
      return throwError(() => new BadRequestException(['pageId should not be empty']));
    }
    const user = req.user?.user;
    const workspaceId = req.user?.workspace?.id;
    // The class-level JwtAuthGuard always resolves both; without them there is nobody to decide for.
    if (!user?.id || !workspaceId) return throwError(() => new UnauthorizedException());

    const purged = defer(() => this.purge.purge(user, pageId, workspaceId)).pipe(map(() => undefined));
    return this.envelope.intercept(context, { handle: () => purged });
  }
}
