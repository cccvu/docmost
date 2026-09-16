import { Injectable, Logger } from '@nestjs/common';

/**
 * CCC audit integration — NOT upstream Docmost code.
 *
 * A fire-and-forget forwarder for Docmost domain audit events to the wiki-v2 platform's central audit
 * sink (`POST /audit/ingest`). Mirrors `HttpAuthzClient` (same base URL + `x-authz-service-secret`)
 * but with the OPPOSITE failure posture: audit must NEVER block or break a user request, so every error
 * is swallowed (logged at warn). Best-effort by design — the high-value authN + authz-decision events
 * are captured on the platform side synchronously; a durable audit-outbox is a documented enhancement.
 */
/**
 * Raw transport evidence for ONE event — data, never an address.
 *
 * The platform resolves this against its own trust predicate rather than believing a value we computed
 * (wiki-v2 #320). Send both fields together or omit the object entirely: the platform treats a supplied
 * `clientEvidence` as AUTHORITATIVE, so `forwardedFor` on its own — no usable `socketPeer` — is recorded
 * as a refusal, which would mislabel a destroyed socket as a forgery attempt.
 *
 * Exactly these two keys and no others. The platform validates with `forbidNonWhitelisted`, and one
 * unknown nested key 400s the WHOLE batch (up to 500 events), which this client swallows as a warn.
 */
export interface AuditClientEvidence {
  /** The peer address of the socket Docmost served the request on — the chain's hop 0. */
  socketPeer?: string;
  /** The raw `X-Forwarded-For` header, comma-separated, exactly as received. Never parsed here. */
  forwardedFor?: string;
}

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
  /**
   * LEGACY. Docmost's own `request.ip`, which at middleware time is the unvalidated leftmost
   * `X-Forwarded-For` token. Still sent so an older platform build keeps working; the platform ignores
   * it whenever `clientEvidence` is present.
   */
  ipAddress?: string;
  clientEvidence?: AuditClientEvidence;
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
        // AUDIT_FORWARD_FAILED opens the line so the drop is greppable and alarmable. Without a token this
        // failure is invisible: the forward is fire-and-forget, so a systematic rejection (a contract
        // mismatch, say) would drop EVERY event while the request path stays perfectly healthy.
        this.logger.warn(`AUDIT_FORWARD_FAILED http status=${res.status} dropped=${events.length}`);
      }
    } catch (e) {
      this.logger.warn(`AUDIT_FORWARD_FAILED transport error=${(e as Error).message} dropped=${events.length}`);
    }
  }
}
