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

export function shadowEmailFor(externalId: string): string {
  return `${externalId}@${SHADOW_EMAIL_DOMAIN}`;
}

export function isShadowEmail(email: string | null | undefined): boolean {
  return (
    typeof email === 'string' &&
    email.toLowerCase().endsWith(`@${SHADOW_EMAIL_DOMAIN}`)
  );
}
