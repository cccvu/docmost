import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { isUUID } from 'class-validator';
import { Observable, throwError } from 'rxjs';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { AuditIngestEvent, PlatformAuditClient } from '../audit/platform-audit.client';
import { buildClientEvidenceFromReq } from '../audit/request-evidence';

/** The upstream routes that hard-delete a space (`Controller.handler`). `space-hard-delete.fitness.spec.ts` pins
 *  this set to exactly the routes whose handler reaches the space delete, so a new or renamed one reds the build. */
export const SPACE_HARD_DELETE_ROUTES: ReadonlySet<string> = new Set(['SpaceController.deleteSpace']);

export const SPACE_HARD_DELETE_REFUSED_EVENT = 'space.hard_delete_refused';

const ROUTE = 'POST /api/spaces/delete';

type AuthedRequest = FastifyRequest & {
  user?: { user?: { id?: string }; workspace?: { id?: string } };
};

/**
 * CCC authorization integration — NOT upstream Docmost code (#502).
 *
 * In `AUTHZ_MODE=remote` the engine's native space delete (`POST /api/spaces/delete`) is refused with a 404 for
 * every caller. Upstream runs an unconditional `DELETE FROM spaces` there: it cascades to every page, version,
 * comment and page grant and queues the S3 purge of every attachment, and its only gate is CASL `Manage Settings`,
 * which remote mode derives from PDP `space#administer`. That includes a delegated `manage_members` holder and the
 * direct admin of an ARCHIVED space, so it bypassed the governed model: removal is archive (acting human, audited,
 * settled) and only a workspace admin restores (#193). After a hard delete there is nothing left to restore.
 *
 * Removal in remote mode is the platform's archive (`/v1`, the console, MCP). There is no remote purge path.
 * Native (standalone) mode keeps the upstream route.
 *
 * An interceptor rather than a guard, registered in app.module.ts (seam #4) after the #467 per-request
 * access audit and per-principal rate limit: the controller stays untouched, `req.user` is resolved, a flood of
 * attempts is rate-limited, and the access row records the 404. It runs before the handler, so before CASL and the
 * delete, and before `ValidationPipe`, so the body is raw and is read defensively. The refusal writes one domain
 * row through `PlatformAuditClient` directly, so the `API_AUDIT_ENABLED` kill switch cannot drop it. The attempted
 * id is recorded only when it is a UUID, and never in the `spaceId` column: the caller may have no access to it.
 */
@Injectable()
export class SpaceHardDeleteInterceptor implements NestInterceptor {
  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly audit: PlatformAuditClient,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode !== 'remote' || context.getType() !== 'http') return next.handle();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    if (!SPACE_HARD_DELETE_ROUTES.has(route)) return next.handle();

    try {
      this.recordRefusal(context.switchToHttp().getRequest<AuthedRequest>());
    } catch {
      // Audit is best-effort and must never turn the refusal into anything but a 404.
    }
    return throwError(() => new NotFoundException());
  }

  private recordRefusal(req: AuthedRequest): void {
    const actorId = req.user?.user?.id;
    // The class-level JwtAuthGuard always resolves a user here; without one there is nobody to attribute.
    if (!actorId) return;
    const body: unknown = req.body;
    const attempted =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { spaceId?: unknown }).spaceId
        : undefined;
    const spaceId = typeof attempted === 'string' && isUUID(attempted) ? attempted : undefined;
    const ua = req.headers?.['user-agent'];
    const row: AuditIngestEvent = {
      event: SPACE_HARD_DELETE_REFUSED_EVENT,
      resourceType: 'space',
      resourceId: spaceId,
      actorId,
      actorType: 'user',
      workspaceId: req.user?.workspace?.id,
      clientEvidence: buildClientEvidenceFromReq(req.raw),
      userAgent: typeof ua === 'string' ? ua : undefined,
      metadata: {
        outcome: 'denied',
        reason: 'archive_only',
        route: ROUTE,
        ...(spaceId ? {} : { invalidSpaceId: true }),
      },
    };
    void this.audit.forward([row]).catch(() => undefined);
  }
}
