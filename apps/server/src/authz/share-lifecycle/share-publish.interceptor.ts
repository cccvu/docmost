import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { defer, mergeMap, Observable } from 'rxjs';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { SharePublishGate } from './share-publish.gate';

/** The upstream routes that change a page's publish state (`Controller.handler`), with the body field each one
 *  names its target by. `share-publish.fitness.spec.ts` pins this set, plus the fork-owned `ShareExpiryController.set`
 *  (which calls the gate itself), to exactly the routes whose handler reaches a share-widening sink. */
export const SHARE_PUBLISH_ROUTES: ReadonlyMap<string, 'pageId' | 'shareId'> = new Map([
  ['ShareController.create', 'pageId'],
  ['ShareController.update', 'shareId'],
]);

/** The parts of the Fastify request this reads: the raw body, the DomainMiddleware workspace, the JwtAuthGuard user. */
type AuthedRequest = {
  body?: unknown;
  raw?: { workspace?: { id?: unknown } };
  user?: { user?: { id?: unknown }; workspace?: { id?: unknown } };
};

/**
 * CCC share lifecycle — NOT upstream Docmost code (wiki-v2 #704).
 *
 * In `AUTHZ_MODE=remote`, puts `SharePublishGate` (`page#share`, see there) in front of the upstream
 * `POST /api/shares/create` and `POST /api/shares/update`, whose controller we may not edit. Native mode, other
 * routes and non-HTTP contexts pass through untouched.
 *
 * It runs before the `ValidationPipe`, so it reads the RAW body and fails closed: a body that is not a plain object,
 * or a missing, non-string or empty `pageId` (create) / `shareId` (update), is a 400 with no PDP call. The target is
 * resolved exactly as the handler resolves it, and anything unresolved is the handler's own 404, thrown here — never
 * "pass through to the handler", which would be fail-open the day a DTO transform made the two resolutions differ:
 *  - create: `PageRepo.findById(pageId)` (a uuid or a slug) in the caller's workspace, else `Page not found`;
 *  - update: the injected `ShareRepo` token (remote = `PdpShareRepo`, so an expired share does not resolve)
 *    `findById(shareId)` in the caller's workspace, else `Share not found`, then ITS page. The body's optional
 *    `pageId` is never read: deciding on it would let a caller authorize on one page and update another's share.
 * The workspace is read as `@AuthWorkspace` reads it (`req.raw.workspace ?? req.user.workspace`). The PDP is asked
 * about the resolved `page.id`, never the raw input. Only after the gate allows does the handler run, with all of
 * its own checks.
 *
 * An APP_INTERCEPTOR of the fork-owned `ShareLifecycleModule` (mounted from AuthzModule, no upstream seam). It runs
 * after `JwtAuthGuard` (so `req.user` is set) and inside AppModule's own interceptors (access audit, rate limit). A
 * PDP-decided 403 is not a remote-refusal table row: those are unconditional synchronous 404s
 * (`native-route-authz.module.ts`).
 */
@Injectable()
export class SharePublishInterceptor implements NestInterceptor {
  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly gate: SharePublishGate,
    private readonly pageRepo: PageRepo,
    private readonly shareRepo: ShareRepo,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode !== 'remote' || context.getType() !== 'http') return next.handle();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    const field = SHARE_PUBLISH_ROUTES.get(route);
    if (!field) return next.handle();
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    return defer(() => this.authorize(req, field)).pipe(mergeMap(() => next.handle()));
  }

  private async authorize(req: AuthedRequest, field: 'pageId' | 'shareId'): Promise<void> {
    const body: unknown = req.body;
    const raw = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)[field] : undefined;
    if (typeof raw !== 'string' || raw.length === 0) throw new BadRequestException([`${field} should not be empty`]);

    const userId = req.user?.user?.id;
    const workspaceId = (req.raw?.workspace ?? req.user?.workspace)?.id;
    // The class-level JwtAuthGuard always resolves both; without them there is nobody to decide for.
    if (typeof userId !== 'string' || !userId || typeof workspaceId !== 'string' || !workspaceId) {
      throw new UnauthorizedException();
    }

    const pageId = field === 'pageId' ? await this.pageOf(raw, workspaceId) : await this.pageOfShare(raw, workspaceId);
    await this.gate.requirePublish(userId, pageId);
  }

  /** create: the page the handler would share, as its id. */
  private async pageOf(pageIdOrSlug: string, workspaceId: string): Promise<string> {
    const page = await this.pageRepo.findById(pageIdOrSlug);
    if (!page || page.workspaceId !== workspaceId) throw new NotFoundException('Page not found');
    return page.id;
  }

  /** update: the page of the share the handler would update (never the body's `pageId`). */
  private async pageOfShare(shareId: string, workspaceId: string): Promise<string> {
    const share = await this.shareRepo.findById(shareId);
    if (!share || share.workspaceId !== workspaceId || !share.pageId) throw new NotFoundException('Share not found');
    const page = await this.pageRepo.findById(share.pageId);
    if (!page || page.workspaceId !== workspaceId) throw new NotFoundException('Page not found');
    return page.id;
  }
}
