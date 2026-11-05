import type { AuthzSubject, AuthzCheckItem } from '../http-authz.client';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Implementation-neutral transport port for the external authorization service (the Policy Decision
 * Point a `remote`-mode deployment calls). The fork is the CLIENT of this contract; a third party
 * implements the SERVER against the published, canonical OpenAPI contract at
 * `docs/integrations/authorization/authorization-service.openapi.json` (with a zero-dependency reference
 * implementation under `examples/integrations/authorization-stub/`). The concrete `HttpAuthzClient`
 * satisfies this interface structurally (renamed from `PlatformAuthzClient` in Phase C, issue #157, since
 * it is a transport, not platform-specific). Every method is FAIL-CLOSED: any transport error, non-2xx,
 * timeout, or malformed body resolves to deny/empty (or, for the `try*` methods, to `null`, which the caller
 * must treat as "unknown", never as an allow) — and, per the security model, MUST NOT fall back to native
 * decisions.
 */
export interface RemoteAuthzClient {
  check(
    subject: AuthzSubject,
    permission: string,
    resourceType: string,
    resourceId: string,
  ): Promise<boolean>;
  checkBulk(subject: AuthzSubject, checks: AuthzCheckItem[]): Promise<boolean[]>;
  /** `checkBulk` with failure reported as `null` (not all-false) — for checks where `false` relaxes access
   *  (e.g. `locked`), so a failure can be treated as the most restrictive answer instead (#492). */
  tryCheckBulk(subject: AuthzSubject, checks: AuthzCheckItem[]): Promise<boolean[] | null>;
  filterResources(
    subject: AuthzSubject,
    permission: string,
    resourceType: string,
    candidateIds: string[],
  ): Promise<string[]>;
  /** `filterResources` with failure reported as `null` (not "none of these") — for a caller that must not read
   *  "could not answer" as "nothing is authorized" (#696). On success: the allowed candidates, in candidate order. */
  tryFilterResources(
    subject: AuthzSubject,
    permission: string,
    resourceType: string,
    candidateIds: string[],
  ): Promise<string[] | null>;
  lookupResources(
    subject: AuthzSubject,
    permission: string,
    resourceType: string,
  ): Promise<string[]>;
  filterSubjects(
    permission: string,
    resourceType: string,
    resourceId: string,
    candidateUserIds: string[],
  ): Promise<string[]>;
}

export type { AuthzSubject, AuthzCheckItem };
