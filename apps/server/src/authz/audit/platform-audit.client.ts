import { Injectable, Logger } from '@nestjs/common';

/**
 * CCC audit integration — NOT upstream Docmost code.
 *
 * A fire-and-forget forwarder for Docmost domain audit events to the wiki-v2 platform's central audit
 * sink (`POST /audit/ingest`). Mirrors `PlatformAuthzClient` (same base URL + `x-authz-service-secret`)
 * but with the OPPOSITE failure posture: audit must NEVER block or break a user request, so every error
 * is swallowed (logged at warn). Best-effort by design — the high-value authN + authz-decision events
 * are captured on the platform side synchronously; a durable audit-outbox is a documented enhancement.
 */
export interface AuditIngestEvent {
  event: string;
  resourceType: string;
  resourceId?: string;
  spaceId?: string;
  changes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  actorId?: string;
  actorType?: 'user' | 'system' | 'api_key';
  workspaceId?: string;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class PlatformAuditClient {
  private readonly logger = new Logger(PlatformAuditClient.name);
  private readonly baseUrl = process.env.PLATFORM_AUTHZ_URL ?? 'http://platform:4000';
  private readonly secret = process.env.PLATFORM_AUTHZ_SERVICE_SECRET ?? '';

  /** Forward a batch. Resolves regardless of outcome — callers do not await for correctness. */
  async forward(events: AuditIngestEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      const res = await fetch(`${this.baseUrl}/audit/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-authz-service-secret': this.secret },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) {
        this.logger.warn(`audit ingest -> HTTP ${res.status} (${events.length} event(s) dropped)`);
      }
    } catch (e) {
      this.logger.warn(`audit ingest failed: ${(e as Error).message} (${events.length} event(s) dropped)`);
    }
  }
}
