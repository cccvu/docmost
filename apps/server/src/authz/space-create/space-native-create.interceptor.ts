import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable, throwError } from 'rxjs';
import { UserRole } from '../../common/helpers/types/permission';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { AuditIngestEvent, PlatformAuditClient } from '../audit/platform-audit.client';
import { buildClientEvidenceFromReq } from '../audit/request-evidence';

/** The upstream routes that create a space natively (`Controller.handler`). `space-native-create.fitness.spec.ts`
 *  pins this set to exactly the routes whose handler reaches the native create, so a new or renamed one reds the build. */
export const NATIVE_SPACE_CREATE_ROUTES: ReadonlySet<string> = new Set(['SpaceController.createSpace']);

export const SPACE_NATIVE_CREATE_REFUSED_EVENT = 'space.native_create_refused';

const ROUTE = 'POST /api/spaces/create';

const USER_ROLES: ReadonlySet<string> = new Set(Object.values(UserRole));

type AuthedRequest = FastifyRequest & {
  user?: { user?: { id?: string; role?: unknown }; workspace?: { id?: string } };
};

/**
 * CCC authorization integration — NOT upstream Docmost code (#598).
 *
 * In `AUTHZ_MODE=remote` the engine's native space create (`POST /api/spaces/create`) is refused with a 404 for every
 * authenticated caller. Upstream gates it only by workspace CASL on `users.role` (owner/admin), which is not
 * PDP-backed, and the space it writes — plus the creator's `space_members` admin row — is projected into SpiceDB by
 * the outbox relay. So a native create would bypass the governed path: the platform's `POST /api/service/spaces`
 * (acting human, audited, idempotent) and the connector-posture bind (ADR 0028). Before this, remote mode relied on
 * no owner/admin fork session existing, and a native-phase session (first-run setup, the contract smoke) survives the
 * switch to remote.
 *
 * Creation in remote mode is the platform's (`/v1`, the console, MCP). Native (standalone) mode keeps the upstream
 * route.
 *
 * Mirrors `SpaceHardDeleteInterceptor` (#502): an interceptor registered in app.module.ts (seam #4) after the #467
 * access audit and per-principal rate limit, so the controller stays untouched, the refusal is rate-limited and the
 * access row records the 404. It runs before the handler, so before CASL and the insert, and before `ValidationPipe`.
 * The refusal writes one domain row through `PlatformAuditClient` directly, so the `API_AUDIT_ENABLED` kill switch
 * cannot drop it. The body is never read: the name and slug are free text and are not evidence. The actor's engine
 * role is recorded only as one of the known enum values, so an attempt by a leftover privileged session stands out.
 */
@Injectable()
export class SpaceNativeCreateInterceptor implements NestInterceptor {
  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly audit: PlatformAuditClient,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode !== 'remote' || context.getType() !== 'http') return next.handle();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    if (!NATIVE_SPACE_CREATE_ROUTES.has(route)) return next.handle();

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
    const role = req.user?.user?.role;
    const ua = req.headers?.['user-agent'];
    const row: AuditIngestEvent = {
      event: SPACE_NATIVE_CREATE_REFUSED_EVENT,
      resourceType: 'space',
      actorId,
      actorType: 'user',
      workspaceId: req.user?.workspace?.id,
      clientEvidence: buildClientEvidenceFromReq(req.raw),
      userAgent: typeof ua === 'string' ? ua : undefined,
      metadata: {
        outcome: 'denied',
        reason: 'platform_only',
        route: ROUTE,
        ...(typeof role === 'string' && USER_ROLES.has(role) ? { actorRole: role } : {}),
      },
    };
    void this.audit.forward([row]).catch(() => undefined);
  }
}
