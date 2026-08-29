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

@Injectable()
export class PlatformAuthzClient {
  private readonly logger = new Logger(PlatformAuthzClient.name);
  private readonly baseUrl = process.env.PLATFORM_AUTHZ_URL ?? 'http://platform:4000';
  private readonly secret = process.env.PLATFORM_AUTHZ_SERVICE_SECRET ?? '';

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-authz-service-secret': this.secret },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.logger.error(`authz ${path} -> HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (e) {
      this.logger.error(`authz ${path} failed: ${(e as Error).message}`);
      return null;
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
    const r = await this.post<{ ids: string[] }>('/authz/filter-resources', { subject, permission, resourceType, candidateIds });
    return r?.ids ?? [];
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
    const candidates = candidateUserIds.map((externalId) => ({ provider: 'docmost', externalId }));
    const r = await this.post<{ subjects: Array<{ externalId?: string }> }>('/authz/filter-subjects', {
      permission,
      resourceType,
      resourceId,
      candidates,
    });
    if (!r) return [];
    return r.subjects.map((s) => s.externalId).filter((id): id is string => !!id);
  }
}
