import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import { AuditContext, AUDIT_CONTEXT_KEY } from '../../common/middlewares/audit-context.middleware';
import { AuditLogContext, IAuditService } from '../../integrations/audit/audit.service';
import { ActorType, AuditLogPayload } from '../../common/events/audit-events';
import { AuditClientEvidence, AuditIngestEvent, PlatformAuditClient } from './platform-audit.client';
import { buildClientEvidenceFromReq } from './request-evidence';
import { ActivityAuditContext, ActivityAuditWriter } from './activity-audit.writer';

/**
 * CCC audit integration — NOT upstream Docmost code.
 *
 * The remote-mode `AUDIT_SERVICE` implementation that replaces `NoopAuditService`. It FORWARDS every domain
 * audit event to the wiki-v2 platform's central sink — the single tamper-evident source of truth, and the only
 * audit record that carries each event's client address — by mapping the upstream payload + the CLS actor
 * context onto the ingest contract and handing it to the fire-and-forget client.
 *
 * It ALSO persists a small allowlist locally (#615): page trash / restore / move-to-space and comment delete /
 * resolve / reopen go into Docmost's own `audit` table through `ActivityAuditWriter`, because the service-bridge
 * activity feed reads them there and those lifecycle facts leave no other trace in the fork. That copy is a
 * product feed, not audit: it holds the actor, the resource and (for comments) the page id — never the IP, user
 * agent, `changes` or other metadata — and is pruned by workspace retention. Every other event is forward-only.
 * See activity-audit.writer.ts for the exact row shape and skip rules.
 *
 * Neither path ever throws into a request, and persistence never delays or alters the forward: the forward is
 * issued first, with exactly the events it carried before the local copy existed.
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
  /**
   * `activity` is optional only so the forwarding-focused specs can build the service without a database; the
   * module factory (`createAuditService`) always passes it, and platform-audit.service.spec.ts pins that.
   */
  constructor(
    private readonly cls: ClsService,
    private readonly client: PlatformAuditClient,
    private readonly activity?: ActivityAuditWriter,
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
    const context = this.currentContext();
    void this.client.forward([this.toEvent(payload, context, this.clientEvidence())]);
    this.recordActivity([payload], context);
  }

  logWithContext(payload: AuditLogPayload, context: AuditLogContext): void {
    void this.client.forward([this.toEvent(payload, context)]);
    this.recordActivity([payload], context);
  }

  logBatchWithContext(payloads: AuditLogPayload[], context: AuditLogContext): void {
    void this.client.forward(payloads.map((p) => this.toEvent(p, context)));
    this.recordActivity(payloads, context);
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

  /**
   * The local activity copy (#615), AFTER the forward was issued. The writer drops non-allowlisted events itself
   * and never rejects; the try/catch only keeps a broken writer off the request path.
   */
  private recordActivity(payloads: readonly AuditLogPayload[], context: ActivityAuditContext | undefined): void {
    if (!this.activity) return;
    try {
      void this.activity.record(payloads, context).catch(() => undefined);
    } catch {
      // record() never throws by contract.
    }
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
