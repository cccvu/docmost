import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import { AuditContext, AUDIT_CONTEXT_KEY } from '../../common/middlewares/audit-context.middleware';
import { AuditLogContext, IAuditService } from '../../integrations/audit/audit.service';
import { ActorType, AuditLogPayload } from '../../common/events/audit-events';
import { AuditClientEvidence, AuditIngestEvent, PlatformAuditClient } from './platform-audit.client';
import { buildClientEvidenceFromReq } from './request-evidence';

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

  /**
   * Evidence rides ONLY with the CLS-derived context, never with a caller-supplied one.
   *
   * `logWithContext` / `logBatchWithContext` exist so a caller can state the context explicitly — today
   * that is the import worker, which runs on a queue with no request in scope. If those paths also read
   * ambient CLS, an event's actor would come from the caller while its network origin came from whatever
   * request happened to be on the stack: two halves of one provenance claim from different sources,
   * written into a hash-chained log. Benign now, but `IAuditService` is an upstream-owned interface, so a
   * future upstream caller could invoke it mid-request and silently attribute the wrong socket peer.
   */
  log(payload: AuditLogPayload): void {
    void this.client.forward([this.toEvent(payload, this.currentContext(), this.clientEvidence())]);
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
    // Read the UNTOUCHED node request from CLS and delegate to the shared builder, so the domain-event
    // forwarder and the /api access interceptor produce identical, #320-clean evidence (see request-evidence.ts).
    // No request in scope (a background job, or a route outside the CLS middleware) yields `undefined`.
    return buildClientEvidenceFromReq(this.cls.get<IncomingMessage | undefined>(CLS_REQ));
  }

  private toEvent(
    payload: AuditLogPayload,
    context?: ForwardContext,
    clientEvidence?: AuditClientEvidence,
  ): AuditIngestEvent {
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
      clientEvidence,
      userAgent: context?.userAgent,
    };
  }
}
