/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * AUTHZ_MODE is a REQUIRED, server-controlled, startup-only security setting selecting how the fork
 * makes authorization decisions:
 *   - native  → Docmost's OWN authorization (CASL + space_members/page_access/page_permissions). The
 *               fork runs fully standalone; no external service is contacted. A legitimate upstream
 *               control — never "allow all".
 *   - remote  → decisions come from an external authorization service (the CCC platform, or any server
 *               implementing the documented contract). Fail-closed on unreachability; it NEVER falls
 *               back to native at runtime (that would be a downgrade attack).
 *
 * The mode is fixed per container start. It is NEVER inferred from service availability, request
 * params, headers, cookies, URLs, or client state. An invalid/ambiguous value refuses the boot.
 */
export type AuthzMode = 'native' | 'remote';

/** DI token for the resolved AuthzMode (provided @Global by AuthzModeModule). */
export const AUTHZ_MODE = Symbol('AUTHZ_MODE');

export function isAuthzMode(value: unknown): value is AuthzMode {
  return value === 'native' || value === 'remote';
}

/**
 * Resolve the mode from the raw env value. Throws (aborting DI/boot) on anything but exactly 'native'
 * or 'remote' — a belt-and-suspenders guard alongside the boot-time env validation, so the mode can
 * never silently default. Trimming + lowercasing tolerates trivial whitespace/case, nothing more.
 */
export function resolveAuthzMode(raw: string | undefined | null): AuthzMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  if (isAuthzMode(value)) return value;
  throw new Error(
    `AUTHZ_MODE must be exactly 'native' or 'remote' (got ${JSON.stringify(raw)}). ` +
      `It is a required, server-controlled security setting and has no default; refusing to boot. ` +
      `See docmost/docs/architecture/standalone.md.`,
  );
}
