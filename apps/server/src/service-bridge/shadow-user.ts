/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * The shadow-user namespace the platform's session brokerage operates on. A "shadow user" is a
 * non-privileged Docmost `member` the platform provisions to represent a platform identity; its email is
 * synthetic and lives in this reserved domain, so it can never collide with a real Docmost user (the
 * same boundary the platform's BFF relied on). Session minting (`POST /api/service/session`) refuses any
 * user NOT in this namespace — that is the no-impersonation boundary: no minting for real users,
 * docmost-native anchors (`@users.invalid`), or privileged accounts.
 */
export const SHADOW_EMAIL_DOMAIN = 'shadow.wiki-v2.internal';

/**
 * Derive the synthetic shadow email for a platform identity. The local part is LOWER-CASED (companion F2):
 * the derivation is the single chokepoint both provisioning (the `(email, workspace_id)` upsert, which is
 * case-SENSITIVE) and minting (`UserRepo.findByEmail`, which matches case-INSENSITIVELY via `LOWER(email)`)
 * flow through. Without normalization, case-variant `externalId`s (`Alice` vs `alice`) would insert TWO
 * rows the case-insensitive lookup then resolves ambiguously — a duplicate-account / cross-identity hazard.
 * Platform ids are canonical lowercase UUIDs today, so this is a no-op for existing data and closes the gap
 * for any future non-UUID caller.
 */
export function shadowEmailFor(externalId: string): string {
  return `${externalId.toLowerCase()}@${SHADOW_EMAIL_DOMAIN}`;
}

/**
 * True only for a well-formed address whose domain is EXACTLY the reserved shadow domain. Companion F7: a
 * bare `endsWith('@' + DOMAIN)` accepted an embedded-`@` lookalike (`attacker@evil.com@shadow.wiki-v2.internal`
 * ends with the suffix). Require exactly one `@`, a non-empty local part, and an exact domain match, so the
 * recognizer can never be fooled by a tampered/mis-provisioned row that merely CONTAINS the reserved domain.
 */
export function isShadowEmail(email: string | null | undefined): boolean {
  if (typeof email !== 'string') return false;
  const lower = email.toLowerCase();
  const at = lower.indexOf('@');
  return (
    at > 0 && // a non-empty local part
    lower.indexOf('@', at + 1) === -1 && // exactly one '@' (no embedded-@ breakout)
    lower.slice(at + 1) === SHADOW_EMAIL_DOMAIN // the domain is EXACTLY the reserved name
  );
}
