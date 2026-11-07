/**
 * CCC — NOT upstream Docmost code. Issue #133, ADR 0035
 * (super-repo `docs/adr/0035-docmost-ee-authentication-unsupported.md`).
 *
 * Docmost EE login (SSO, LDAP, MFA) is unsupported in every mode, and the server refuses to boot when EE
 * code is present (`apps/server/src/authz/mode/enterprise-code.ts`). This constant keeps the EE login UI
 * (the invite page's `<SsoLogin/>`, the `/login/mfa` routes) unreachable; the EE code stays untouched.
 *
 * RE-ENABLE CHECKLIST (all required):
 * 1. Reverse ADR 0035 and remove the server boot guard.
 * 2. Every EE login success path calls `openDocmostSession()` before navigating, and on failure calls
 *    `logout()` and surfaces an error, as `features/public/hooks/use-passwordless.ts` does. The #133 gap:
 *    `ee/components/ldap-login-modal.tsx` navigates without exchanging the session.
 * 3. Add ALB/edge routing for the EE route families and update the route-families SSOT.
 */
export function isEnterpriseLoginEnabled(): boolean {
  return false;
}
