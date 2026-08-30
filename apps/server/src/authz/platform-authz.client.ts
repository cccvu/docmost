import { Injectable, Logger } from '@nestjs/common';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * A typed client for the wiki-v2 platform's Authorization API (the external PDP). All policy —
 * SpiceDB semantics, identity translation, the schema — lives in the platform; this is only a
 * client. FAIL-CLOSED: any transport error or non-200 resolves to "denied" (false / empty), so a
 * platform outage cannot silently grant access.
 */
export type AuthzSubject = { principalId: string } | { provider: string; externalId: string };

export interface AuthzCheckItem {
  permission: string;
  resourceType: string;
  resourceId: string;
}

/** The platform's Authorization API caps `filter-*` candidate arrays at @ArrayMaxSize(1000). Sending
 *  more in one request is 400'd → the fail-closed client turns that into an empty result, silently
 *  DROPPING authorized objects. So over-cap arrays are chunked to this size and the results unioned. */
const FILTER_CHUNK = 1000;
/** Bounded per-request timeout (ms) so a slow/hung platform cannot hang the wiki request; on timeout the
 *  call aborts and resolves fail-closed. Overridable via PLATFORM_AUTHZ_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 1500;

@Injectable()
export class PlatformAuthzClient {
  private readonly logger = new Logger(PlatformAuthzClient.name);
  private readonly baseUrl = process.env.PLATFORM_AUTHZ_URL ?? 'http://platform:4000';
  private readonly secret = process.env.PLATFORM_AUTHZ_SERVICE_SECRET ?? '';
  private readonly timeoutMs = Number(process.env.PLATFORM_AUTHZ_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    // Bound the call: abort after `timeoutMs` so a hung platform can't hang the wiki request. The
    // AbortError lands in the catch below → returns null → the caller fails closed (deny / empty).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-authz-service-secret': this.secret },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.error(`authz ${path} -> HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (e) {
      this.logger.error(`authz ${path} failed: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async check(subject: AuthzSubject, permission: string, resourceType: string, resourceId: string): Promise<boolean> {
    const r = await this.post<{ allowed: boolean }>('/authz/check', { subject, permission, resourceType, resourceId });
    return r?.allowed === true;
  }

  async checkBulk(subject: AuthzSubject, checks: AuthzCheckItem[]): Promise<boolean[]> {
    if (checks.length === 0) return [];
    const r = await this.post<{ results: boolean[] }>('/authz/check-bulk', { subject, checks });
    return r?.results ?? checks.map(() => false);
  }

  async filterResources(
    subject: AuthzSubject,
    permission: string,
    resourceType: string,
    candidateIds: string[],
  ): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    // Chunk to the platform's 1000-cap and union the allowed ids; a single over-cap request would be
    // 400'd and silently dropped. Each chunk is independently fail-closed (a null result adds nothing).
    const allowed = new Set<string>();
    for (let i = 0; i < candidateIds.length; i += FILTER_CHUNK) {
      const batch = candidateIds.slice(i, i + FILTER_CHUNK);
      const r = await this.post<{ ids: string[] }>('/authz/filter-resources', { subject, permission, resourceType, candidateIds: batch });
      for (const id of r?.ids ?? []) allowed.add(id);
    }
    return [...allowed];
  }

  async lookupResources(subject: AuthzSubject, permission: string, resourceType: string): Promise<string[]> {
    const r = await this.post<{ ids: string[] }>('/authz/lookup-resources', { subject, permission, resourceType });
    return r?.ids ?? [];
  }

  /**
   * The subject-side filter: of these Docmost user ids, which hold `permission` on the resource?
   * Backs the reverse-index recipient filters (`getUserIdsWith*Access`). The platform echoes the
   * passing subject refs back, so we recover Docmost user ids directly. FAIL-CLOSED → empty on error.
   */
  async filterSubjects(
    permission: string,
    resourceType: string,
    resourceId: string,
    candidateUserIds: string[],
  ): Promise<string[]> {
    if (candidateUserIds.length === 0) return [];
    // Chunk to the platform's 1000-cap and union the recovered user ids (see filterResources).
    const allowed = new Set<string>();
    for (let i = 0; i < candidateUserIds.length; i += FILTER_CHUNK) {
      const batch = candidateUserIds.slice(i, i + FILTER_CHUNK);
      const candidates = batch.map((externalId) => ({ provider: 'docmost', externalId }));
      const r = await this.post<{ subjects: Array<{ externalId?: string }> }>('/authz/filter-subjects', {
        permission,
        resourceType,
        resourceId,
        candidates,
      });
      if (!r) continue;
      for (const s of r.subjects) if (s.externalId) allowed.add(s.externalId);
    }
    return [...allowed];
  }
}
