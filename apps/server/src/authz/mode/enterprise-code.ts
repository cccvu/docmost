import { readdirSync } from 'fs';
import * as path from 'path';

/**
 * CCC authorization integration — NOT upstream Docmost code (wiki-v2 #133, ADR 0035
 * `docs/adr/0035-docmost-ee-authentication-unsupported.md` in the super-repo).
 *
 * Docmost's enterprise (EE) authentication — LDAP, SSO, MFA, API keys, SCIM — is unsupported in this fork, in
 * every AUTHZ_MODE. Upstream wires it in by `require`: `app.module.ts` try-requires `./ee/ee.module`, and
 * `jwt.strategy`, `auth.controller`, the licence check and others each try-require their own `ee/` file. EE
 * `@Public` login routes (`/api/sso`, `/api/mfa`) would mint Docmost session cookies that bypass the platform.
 * The only thing keeping them out is that the private `src/ee` gitlink is never initialized, and nothing
 * checks that: `check-upstream-boundary.sh` cannot see a local init (the gitlink commit is unchanged).
 *
 * So the engine refuses to boot when the EE directory holds anything. Called from the AUTHZ_MODE factory
 * (`authz-mode.module.ts`), which always runs at boot, before the mode is used — no mode parameter and no env
 * override: re-enabling EE is a deliberate code change, with the re-enable checklist in ADR 0035.
 */

/**
 * The directory every upstream EE `require` resolves into: `src/ee` under ts-node/jest, `dist/ee` in the
 * built image (this file sits at `<root>/authz/mode/`, `app.module` at `<root>/`, which requires `./ee/…`).
 */
export const ENTERPRISE_CODE_DIR = path.resolve(__dirname, '../../ee');

/**
 * True when `dir` holds any non-dotfile entry. Absent (ENOENT) or dotfile-only counts as absent. Any other
 * fs error (ENOTDIR, EACCES, …) counts as PRESENT: we cannot prove the directory is empty, so fail closed.
 */
export function enterpriseCodePresent(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    return true;
  }
  return entries.some((name) => !name.startsWith('.'));
}

/** Throws (Nest aborts boot) when any EE code is present. */
export function assertNoEnterpriseCode(
  dir: string = ENTERPRISE_CODE_DIR,
): void {
  if (enterpriseCodePresent(dir)) {
    throw new Error(
      `Docmost enterprise (EE) code found at ${dir}. EE authentication (LDAP, SSO, MFA, API keys, SCIM) is ` +
        'unsupported in this fork in every AUTHZ_MODE (ADR 0035, wiki-v2 #133); refusing to boot. The ' +
        'apps/server/src/ee gitlink must stay uninitialized.',
    );
  }
}
