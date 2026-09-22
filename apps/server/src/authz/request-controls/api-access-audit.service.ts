import { Inject, Injectable } from '@nestjs/common';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { AuditClientEvidence, PlatformAuditClient } from '../audit/platform-audit.client';

/**
 * CCC authorization integration — NOT upstream Docmost code (wiki-v2 #467).
 *
 * The request facts an access-audit row is built from. Captured synchronously by the interceptor at request
 * start (the outcome/status arrive later, on completion).
 */
export interface ApiAccessFacts {
  /** HTTP method, upper-cased. */
  method: string;
  /** Request path with the query string stripped (never the query — it can carry secrets). */
  route: string;
  /** The authenticated Docmost user id (`req.user.user.id`); translated to a platform id on ingest. */
  actorId: string;
  workspaceId?: string;
  /** 'low' for READ requests (shed first under overload), 'normal' for mutations/denials. */
  priority: 'low' | 'normal';
  /** #320-clean transport evidence; the platform resolves the address itself. */
  clientEvidence?: AuditClientEvidence;
  userAgent?: string;
}

/**
 * Forwards ONE uniform per-request `access` audit row for an authenticated Docmost `/api` request to the
 * platform's hash-chained sink (`POST /audit/ingest`), reusing the existing `AUDIT_SERVICE` seam's
 * fire-and-forget `PlatformAuditClient`. This is the in-process delivery of D8's "gateway audits every API
 * call" hook (architecture.md §D8), re-homed per ADR 0022 — no proxy, no new AGPL surface.
 *
 * It NEVER blocks or throws into a request (the client swallows every error). The row is an arbitrary
 * `event` string, so it does NOT touch the fixed upstream `AuditLogPayload` union. Only reachable in
 * `remote` mode (native/standalone has no central sink); `API_AUDIT_ENABLED=false` opts a remote deploy out.
 */
@Injectable()
export class ApiAccessAuditService {
  /** Read once at construction: central audit exists only in remote mode, and the toggle is a kill-switch. */
  readonly enabled: boolean;

  constructor(
    @Inject(AUTHZ_MODE) mode: AuthzMode,
    private readonly client: PlatformAuditClient,
  ) {
    this.enabled = mode === 'remote' && process.env.API_AUDIT_ENABLED !== 'false';
  }

  /** Fire-and-forget: emit the row. `status`/`outcome`/`durationMs` are the completed request's result. */
  record(
    facts: ApiAccessFacts,
    status: number,
    outcome: 'success' | 'error',
    durationMs: number,
  ): void {
    if (!this.enabled) return;
    // The client already swallows every error, but `.catch` here makes the fire-and-forget guarantee hold
    // even if that contract ever changed — a rejected forward must never become an unhandled rejection.
    void this.client
      .forward([
        {
          event: `api.${facts.method.toLowerCase()}`,
          resourceType: 'http_request',
          eventCategory: 'access',
          priority: facts.priority,
          actorId: facts.actorId,
          actorType: 'user',
          workspaceId: facts.workspaceId,
          clientEvidence: facts.clientEvidence,
          userAgent: facts.userAgent,
          // Non-secret request FACTS only — never the body or the Authorization/cookie headers. The platform
          // also runs redactSecrets over metadata as a backstop.
          metadata: { route: facts.route, method: facts.method, status, outcome, durationMs },
        },
      ])
      .catch(() => undefined);
  }
}
