import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuditContext, AUDIT_CONTEXT_KEY } from '../../common/middlewares/audit-context.middleware';
import { AuditLogContext, IAuditService } from '../../integrations/audit/audit.service';
import { ActorType, AuditLogPayload } from '../../common/events/audit-events';
import { AuditIngestEvent, PlatformAuditClient } from './platform-audit.client';

/**
 * CCC audit integration — NOT upstream Docmost code.
 *
 * The `AUDIT_SERVICE` implementation that replaces `NoopAuditService`: instead of persisting to
 * Docmost's DB, it FORWARDS each domain audit event to the wiki-v2 platform's central sink (the single
 * tamper-evident source of truth). All policy/persistence lives in the platform; this only maps the
 * upstream payload + the CLS actor context onto the ingest contract and hands it to the fire-and-forget
 * client. It never persists locally and never throws into a request path.
 */
type ForwardContext = {
  workspaceId?: string;
  actorId?: string;
  actorType?: ActorType;
  ipAddress?: string;
  userAgent?: string;
};

@Injectable()
export class PlatformAuditService implements IAuditService {
  constructor(
    private readonly cls: ClsService,
    private readonly client: PlatformAuditClient,
  ) {}

  log(payload: AuditLogPayload): void {
    void this.client.forward([this.toEvent(payload, this.currentContext())]);
  }

  logWithContext(payload: AuditLogPayload, context: AuditLogContext): void {
    void this.client.forward([this.toEvent(payload, context)]);
  }

  logBatchWithContext(payloads: AuditLogPayload[], context: AuditLogContext): void {
    void this.client.forward(payloads.map((p) => this.toEvent(p, context)));
  }

  /** The auth/import flows call setActorId then log — persist it into the CLS context the log reads. */
  setActorId(actorId: string): void {
    const ctx = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (ctx) {
      ctx.actorId = actorId;
      this.cls.set(AUDIT_CONTEXT_KEY, ctx);
    }
  }

  setActorType(actorType: ActorType): void {
    const ctx = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (ctx) {
      ctx.actorType = actorType;
      this.cls.set(AUDIT_CONTEXT_KEY, ctx);
    }
  }

  updateRetention(workspaceId: string, retentionDays: number): void {
    const ctx = this.currentContext();
    void this.client.forward([
      {
        event: 'workspace.retention_updated',
        resourceType: 'workspace',
        resourceId: workspaceId,
        workspaceId,
        actorId: ctx?.actorId,
        actorType: ctx?.actorType,
        metadata: { retentionDays },
      },
    ]);
  }

  private currentContext(): ForwardContext | undefined {
    const ctx = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (!ctx) return undefined;
    return {
      workspaceId: ctx.workspaceId ?? undefined,
      actorId: ctx.actorId ?? undefined,
      actorType: ctx.actorType,
      ipAddress: ctx.ipAddress ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    };
  }

  private toEvent(payload: AuditLogPayload, context?: ForwardContext): AuditIngestEvent {
    return {
      event: payload.event,
      resourceType: payload.resourceType,
      resourceId: payload.resourceId,
      spaceId: payload.spaceId,
      changes: payload.changes as Record<string, unknown> | undefined,
      metadata: payload.metadata,
      actorId: context?.actorId,
      actorType: context?.actorType,
      workspaceId: context?.workspaceId,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    };
  }
}
