import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import { AuditContext, AUDIT_CONTEXT_KEY } from '../../common/middlewares/audit-context.middleware';
import { AuditLogContext, IAuditService } from '../../integrations/audit/audit.service';
import { ActorType, AuditLogPayload } from '../../common/events/audit-events';
import { AuditClientEvidence, AuditIngestEvent, PlatformAuditClient } from './platform-audit.client';

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
        clientEvidence: this.clientEvidence(),
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

  /**
   * Raw transport evidence for the request in scope, for the platform to resolve itself (#320).
   *
   * Why this is read HERE and not taken from the audit context: `AuditContext.ipAddress` is Docmost's
   * `request.ip`, and at middleware time — where that context is captured — Nest's middie hook runs
   * BEFORE `fastify-ip`'s, so the value is Fastify's `trustProxy: true` result: the LEFTMOST
   * `X-Forwarded-For` token, never parsed as an address. A client picks it. `platform-audit.wiring.spec.ts`
   * pins that ordering, because it is the whole reason this method exists.
   *
   * `CLS_REQ` is nestjs-cls's own key (`saveReq` defaults to true, and `ClsModule.forRoot` is mounted
   * globally in `app.module.ts`), and Nest runs every middleware through middie with the RAW node
   * request — so the untouched socket peer and header are reachable from this CCC-owned service without
   * modifying a single upstream file.
   */
  private clientEvidence(): AuditClientEvidence | undefined {
    const req = this.cls.get<IncomingMessage | undefined>(CLS_REQ);
    // No request in scope (a background job, or a route outside the CLS middleware) — nothing to claim.
    const socketPeer = req?.socket?.remoteAddress;
    // Together-or-neither: the platform treats supplied evidence as authoritative and records a refusal
    // when it cannot resolve a peer, so sending `forwardedFor` alone would mislabel a torn-down socket as
    // a forgery attempt. With no peer we send nothing and let the platform fall back to the legacy field.
    if (!socketPeer) return undefined;
    const raw = req?.headers?.['x-forwarded-for'];
    // Typed `string | string[]` because IncomingHttpHeaders has no declared key for it. Node comma-joins
    // repeated header lines, so the array branch is unreachable in practice — narrowed, not cast away.
    const forwardedFor = Array.isArray(raw) ? raw.join(', ') : raw;
    return forwardedFor ? { socketPeer, forwardedFor } : { socketPeer };
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
      clientEvidence: this.clientEvidence(),
      userAgent: context?.userAgent,
    };
  }
}
