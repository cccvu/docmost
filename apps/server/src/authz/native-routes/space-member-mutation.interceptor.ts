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

/** The upstream routes that change space membership natively (`Controller.handler` → the route, for the audit row).
 *  `native-route-authz.fitness.spec.ts` pins the keys to exactly the routes whose handler reaches a member-service
 *  mutation, so a new or renamed one reds the build. */
export const NATIVE_SPACE_MEMBER_MUTATION_ROUTES: ReadonlyMap<string, string> = new Map([
  ['SpaceController.addSpaceMember', 'POST /api/spaces/members/add'],
  ['SpaceController.removeSpaceMember', 'POST /api/spaces/members/remove'],
  ['SpaceController.updateSpaceMemberRole', 'POST /api/spaces/members/change-role'],
]);

export const SPACE_NATIVE_MEMBER_MUTATION_REFUSED_EVENT = 'space.native_member_mutation_refused';

type AuthedRequest = FastifyRequest & {
  user?: { user?: { id?: string }; workspace?: { id?: string } };
};

/**
 * CCC authorization integration — NOT upstream Docmost code (#542).
 *
 * In `AUTHZ_MODE=remote` the engine's native space-member routes (`POST /api/spaces/members/add`, `…/remove`,
 * `…/change-role`) are refused with a 404 for every caller. Upstream gates them only by CASL `Manage Member`, which
 * remote mode derives from PDP `space#administer` — held by a delegated `manage_members` admin with no content
 * access. The native write skips everything the governed path enforces: the service bridge's self-grant rule M
 * (`service-space.service.ts`), the acting-human check and the platform audit. And the `space_members` row it writes
 * is projected into SpiceDB by the outbox relay. So a `manage_members`-only admin could add themselves (or a group
 * they are in) as a writer and gain the content access their binding withholds (#542).
 *
 * Membership in remote mode changes only through the platform (`/api/service/spaces` behind the console, `/v1` and
 * MCP). The client already hides these controls in remote mode (UPSTREAM_MODIFICATIONS.md §140), and no platform
 * caller, script or e2e test uses these routes. Native (standalone) mode keeps the upstream routes.
 *
 * Mirrors `SpaceHardDeleteInterceptor` (#502) and `SpaceNativeCreateInterceptor` (#598), but is registered by the
 * fork-owned `NativeRouteAuthzModule` (no upstream seam). APP_INTERCEPTORs of imported modules run inside AppModule's
 * own, so the #467 access audit and the per-principal rate limit still wrap the refusal. It runs before the handler,
 * so before CASL and the write, and before `ValidationPipe`, so the body is raw and read defensively: the attempted
 * space id is recorded only when it is a UUID, and never in the `spaceId` column (the caller may have no access to
 * it). `targetsActor` flags an attempt that names the caller's own user id, the #542 self-grant shape. The refusal
 * writes one domain row through `PlatformAuditClient` directly, so the `API_AUDIT_ENABLED` kill switch cannot drop it.
 *
 * `narrowing-routes.ts` still lists remove/change-role (its spec pins the native member family). The settle is
 * remote-only and a refused request commits nothing and never succeeds, so those entries are inert while this
 * refusal stands; they keep the settle in place should it ever be lifted.
 */
@Injectable()
export class SpaceMemberMutationInterceptor implements NestInterceptor {
  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly audit: PlatformAuditClient,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode !== 'remote' || context.getType() !== 'http') return next.handle();
    const route = NATIVE_SPACE_MEMBER_MUTATION_ROUTES.get(`${context.getClass().name}.${context.getHandler().name}`);
    if (!route) return next.handle();

    try {
      this.recordRefusal(context.switchToHttp().getRequest<AuthedRequest>(), route);
    } catch {
      // Audit is best-effort and must never turn the refusal into anything but a 404.
    }
    return throwError(() => new NotFoundException());
  }

  private recordRefusal(req: AuthedRequest, route: string): void {
    const actorId = req.user?.user?.id;
    // The class-level JwtAuthGuard always resolves a user here; without one there is nobody to attribute.
    if (!actorId) return;
    const body: unknown = req.body;
    const fields = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const attempted = fields.spaceId;
    const spaceId = typeof attempted === 'string' && isUUID(attempted) ? attempted : undefined;
    // add takes `userIds: string[]`, remove/change-role take `userId: string`; a comparison only, nothing is echoed.
    const userIds = Array.isArray(fields.userIds) ? fields.userIds : [fields.userId];
    const targetsActor = userIds.some((id) => id === actorId);
    const ua = req.headers?.['user-agent'];
    const row: AuditIngestEvent = {
      event: SPACE_NATIVE_MEMBER_MUTATION_REFUSED_EVENT,
      resourceType: 'space',
      resourceId: spaceId,
      actorId,
      actorType: 'user',
      workspaceId: req.user?.workspace?.id,
      clientEvidence: buildClientEvidenceFromReq(req.raw),
      userAgent: typeof ua === 'string' ? ua : undefined,
      metadata: {
        outcome: 'denied',
        reason: 'platform_only',
        route,
        ...(spaceId ? {} : { invalidSpaceId: true }),
        ...(targetsActor ? { targetsActor: true } : {}),
      },
    };
    void this.audit.forward([row]).catch(() => undefined);
  }
}
