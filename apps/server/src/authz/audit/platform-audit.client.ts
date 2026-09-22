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
 * (wiki-v2 #320). `socketPeer` is what makes the object usable, so send it whenever you send the object
 * at all and omit the object entirely when there is no peer — never send a peerless one. The sink treats
 * a supplied `clientEvidence` as AUTHORITATIVE, so `forwardedFor` on its own is recorded as a refusal,
 * which would mislabel a torn-down socket as a forgery attempt. `forwardedFor` itself is optional: a
 * request that carried no `X-Forwarded-For` legitimately yields `{ socketPeer }` alone.
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
  /**
   * Audit stream (#467). Omit (⇒ 'domain' on the sink) for the ~70 Docmost domain events; the per-request
   * `/api` access interceptor sends 'access'. Kept a distinct, higher-volume, lower-value-per-row stream.
   */
  eventCategory?: 'domain' | 'access';
  /**
   * Sink shedding class (#467). Omit (⇒ 'normal') for everything security-relevant. The access interceptor
   * sends 'low' for READ requests so, under overload, reads are dropped before mutations/denials.
   */
  priority?: 'low' | 'normal';
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
