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
import { UserRole } from '../../common/helpers/types/permission';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { AuditIngestEvent, PlatformAuditClient } from '../audit/platform-audit.client';
import { buildClientEvidenceFromReq } from '../audit/request-evidence';
import { REMOTE_REFUSED_ROUTES, RefusalHit, RefusedRoute } from './remote-refusal.table';

const USER_ROLES: ReadonlySet<string> = new Set(Object.values(UserRole));

const INVALID_ID_FLAG: Record<NonNullable<RefusedRoute['resourceIdField']>, string> = {
  spaceId: 'invalidSpaceId',
  groupId: 'invalidGroupId',
};

type AuthedRequest = FastifyRequest & {
  user?: { user?: { id?: string; role?: unknown }; workspace?: { id?: string } };
};

/**
 * CCC authorization integration — NOT upstream Docmost code (#502, #542, #598, #636).
 *
 * In `AUTHZ_MODE=remote` every route in `remote-refusal.table.ts` is refused with a 404 for every authenticated
 * caller, whatever its engine role. The table says why per family. In short: each of these routes is either gated by
 * workspace CASL on `users.role`, which is not PDP-backed, or writes state that SpiceDB projects (space and group
 * membership, spaces) with no self-dealing check, or destroys what the platform's archive keeps. Before this, remote
 * mode relied on no privileged fork session existing, and a native-phase session survives the switch to remote. The
 * governed path for each is the platform's (`/v1`, the console, MCP, through `/api/service/*`). Native (standalone)
 * mode keeps every upstream route.
 *
 * An interceptor rather than a guard, registered in app.module.ts (seam #4) after the #467 access audit and the
 * per-principal rate limit: the controllers stay untouched, `req.user` is resolved, a flood of attempts is
 * rate-limited, and the access row records the 404. It runs before the handler, so before CASL and any write, and
 * before `ValidationPipe`, so the body is raw. It is read only where the table asks: a `when` predicate (a throw
 * counts as refuse, fail closed) and a UUID-only `resourceIdField`; everything else in it is free text and is not
 * evidence. The refusal writes one domain row through `PlatformAuditClient` directly, so the `API_AUDIT_ENABLED` kill
 * switch cannot drop it, and best-effort, so a failing sink still gives the 404. The actor's engine role is recorded
 * only as one of the known enum values, so an attempt by a leftover privileged session stands out, and a member write
 * that names the caller's own user id is flagged `targetsActor` (the #542 self-grant shape).
 *
 * Not in AuthzModeModule: the collab app has no PlatformAuditModule, and it serves none of these routes.
 */
@Injectable()
export class RemoteNativeRefusalInterceptor implements NestInterceptor {
  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly audit: PlatformAuditClient,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode !== 'remote' || context.getType() !== 'http') return next.handle();
    const hit = REMOTE_REFUSED_ROUTES.get(`${context.getClass().name}.${context.getHandler().name}`);
    if (!hit) return next.handle();
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (hit.entry.when && !refuses(hit.entry.when, req)) return next.handle();

    try {
      this.recordRefusal(req, hit);
    } catch {
      // Audit is best-effort and must never turn the refusal into anything but a 404.
    }
    return throwError(() => new NotFoundException());
  }

  private recordRefusal(req: AuthedRequest, { family, entry }: RefusalHit): void {
    const actorId = req.user?.user?.id;
    // The class-level JwtAuthGuard always resolves a user here; without one there is nobody to attribute.
    if (!actorId) return;
    const field = entry.resourceIdField;
    const resourceId = field ? attemptedId(req, field) : undefined;
    const targetsActor = entry.targetUserField ? namesUser(req, entry.targetUserField, actorId) : false;
    const role = req.user?.user?.role;
    const ua = req.headers?.['user-agent'];
    const row: AuditIngestEvent = {
      event: family.event,
      resourceType: family.resourceType,
      ...(resourceId ? { resourceId } : {}),
      actorId,
      actorType: 'user',
      workspaceId: req.user?.workspace?.id,
      clientEvidence: buildClientEvidenceFromReq(req.raw),
      userAgent: typeof ua === 'string' ? ua : undefined,
      metadata: {
        outcome: 'denied',
        reason: family.reason,
        route: entry.route,
        ...(field && !resourceId ? { [INVALID_ID_FLAG[field]]: true } : {}),
        ...(targetsActor ? { targetsActor: true } : {}),
        ...(typeof role === 'string' && USER_ROLES.has(role) ? { actorRole: role } : {}),
      },
    };
    void this.audit.forward([row]).catch(() => undefined);
  }
}

function refuses(when: (body: unknown) => boolean, req: AuthedRequest): boolean {
  try {
    return when(req.body) !== false;
  } catch {
    return true;
  }
}

/** Whether the raw body's `field` (one id or an array of ids) names `userId`. A comparison only. Never throws. */
function namesUser(req: AuthedRequest, field: string, userId: string): boolean {
  try {
    const body: unknown = req.body;
    const value =
      body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)[field] : undefined;
    return (Array.isArray(value) ? value : [value]).some((id) => id === userId);
  } catch {
    return false;
  }
}

/** The attempted id, only when the raw body is an object whose `field` is a UUID string. Never throws. */
function attemptedId(req: AuthedRequest, field: string): string | undefined {
  try {
    const body: unknown = req.body;
    const value =
      body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)[field] : undefined;
    return typeof value === 'string' && isUUID(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
