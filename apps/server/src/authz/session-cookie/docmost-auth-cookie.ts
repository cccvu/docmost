import type { FastifyReply } from 'fastify';

/**
 * CCC session-cookie helper — NOT upstream Docmost code (wiki-v2 issue #310).
 *
 * Single source of truth for the Docmost session cookie's NAME and attributes, so every set/clear/read
 * agrees. It closes the cookie-shadowing / login-CSRF vector: the wiki now shares a registrable parent
 * domain with sibling institutional sites, so any same-site sibling origin could plant
 * `authToken=<its JWT>; Domain=<shared-parent-domain>; Path=/api`, which the browser sends first (longer
 * Path) and `@fastify/cookie` keeps — the server cannot
 * tell the two apart because the `Cookie:` header carries no Path/Domain. The only robust defense is the
 * browser-enforced `__Host-` prefix: a browser refuses a `__Host-`-named cookie unless it is Secure,
 * host-only (no Domain) and Path=/, so a sibling origin can never set one that lands on the wiki host.
 *
 * SECURITY POSTURE IS GATED ON `NODE_ENV === 'production'`, the repo's canonical security-posture authority
 * (mirrors services/platform's `__Host-wiki_session` + validate-production-config.ts) — deliberately NOT on
 * `isHttps()`/`APP_URL`. Deriving the prefix from a config string means a prod deploy with `APP_URL=http`
 * misconfigured would SILENTLY fall back to the shadowable, non-Secure `authToken` (fail-open, unnoticed
 * because login still works). By reading `isProduction()`, the prefix and the `Secure` flag share ONE
 * authority so `prefix ⟺ Secure` holds by construction (no `__Host-`-without-Secure lockout, #313; no
 * name-override env var, #379), and any APP_URL/NODE_ENV incoherence is caught at boot by
 * validate-cookie-posture.ts (fail-fast) rather than downgrading protection at runtime.
 *
 * In dev/test (`NODE_ENV !== 'production'`) the name is the un-prefixed `authToken` and `secure` is false,
 * because over `http://localhost` a Secure `__Host-` cookie would be dropped — matching the platform's dev
 * posture, and safe because localhost has no sibling origin to shadow it.
 */

/** The un-prefixed cookie name used in dev/test AND the legacy name evicted on logout after migration. */
export const AUTH_COOKIE_BASENAME = 'authToken';
/** The production cookie name: the `__Host-` prefix is browser-enforced host-only + Secure + Path=/. */
export const AUTH_COOKIE_HOST_PREFIXED = '__Host-authToken';

/** The subset of EnvironmentService the auth-cookie helpers need (keeps them unit-testable). */
export interface AuthCookieEnv {
  getNodeEnv(): string;
  getCookieExpiresIn(): Date;
}

/**
 * The single canonical "secure cookie posture required" predicate (wiki-v2 #310). Derived from
 * `NODE_ENV === 'production'` (the repo's security-posture authority) — deliberately NOT from
 * `isHttps()`/`APP_URL`, so a misconfigured APP_URL cannot silently downgrade the cookie. Reused by
 * validate-cookie-posture.ts, which asserts this stays coherent with the edge at boot. Kept as a free
 * function (not a method on EnvironmentService) so the fork's upstream files stay unmodified.
 */
export function isProductionPosture(env: { getNodeEnv(): string }): boolean {
  return env.getNodeEnv() === 'production';
}

/**
 * Cookie attributes for the session cookie. Literal types make any divergence between the set and clear
 * paths (or from the `__Host-` requirements) a COMPILE error. `secure` shares the `isProduction()` authority
 * with the name, and there is deliberately NO `domain` (host-only is a `__Host-` requirement).
 */
export interface DocmostAuthCookieSetOptions {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  expires: Date;
}
/** A removal is another Set-Cookie; it must repeat every attribute EXCEPT the lifetime, or a browser aborts
 * a `__Host-` removal that lacks Secure/host-only/Path=/ (RFC 6265bis §5.7 step 21, wiki-v2 #313). */
export type DocmostAuthCookieClearOptions = Omit<DocmostAuthCookieSetOptions, 'expires'>;

/** The resolved cookie name for the current environment. */
export function docmostAuthCookieName(env: AuthCookieEnv): string {
  return isProductionPosture(env) ? AUTH_COOKIE_HOST_PREFIXED : AUTH_COOKIE_BASENAME;
}

/** Attributes for SETTING the session cookie. */
export function docmostAuthCookieSetOptions(
  env: AuthCookieEnv,
): DocmostAuthCookieSetOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isProductionPosture(env),
    expires: env.getCookieExpiresIn(),
  };
}

/** Attributes for CLEARING the session cookie — the set attributes minus the lifetime (#313). */
export function docmostAuthCookieClearOptions(
  env: AuthCookieEnv,
): DocmostAuthCookieClearOptions {
  // Destructure so a new set attribute is carried into the clear automatically (divergence = type error).
  const { expires: _expires, ...clear } = docmostAuthCookieSetOptions(env);
  return clear;
}

/** Set the session cookie under the resolved name with the correct attributes. */
export function setDocmostAuthCookie(
  res: FastifyReply,
  token: string,
  env: AuthCookieEnv,
): void {
  res.setCookie(docmostAuthCookieName(env), token, docmostAuthCookieSetOptions(env));
}

/**
 * Clear the session cookie, and (in production only) evict the legacy un-prefixed `authToken` that a
 * browser may still hold from before the `__Host-` migration. The legacy eviction is COSMETIC — the reader
 * ignores the un-prefixed name in production, so a stale/attacker `authToken` is never read — but it keeps
 * browser jars clean. It is skipped in dev, where the resolved name IS `authToken` and clearing it again
 * would be redundant. Emitted on LOGOUT only (never on the mint path, so the east-west relay never caches
 * an empty-value pair).
 */
export function clearDocmostAuthCookie(res: FastifyReply, env: AuthCookieEnv): void {
  res.clearCookie(docmostAuthCookieName(env), docmostAuthCookieClearOptions(env));
  if (docmostAuthCookieName(env) !== AUTH_COOKIE_BASENAME) {
    res.clearCookie(AUTH_COOKIE_BASENAME, docmostAuthCookieClearOptions(env));
  }
}

/**
 * Read the session token from parsed cookies under the RESOLVED name ONLY. There is deliberately no
 * fallback to the un-prefixed `authToken` in production: a fallback would let a sibling-planted plain
 * `authToken` be read, reopening the exact vector this fix closes.
 */
export function readDocmostAuthCookie(
  cookies: Record<string, string | undefined> | undefined,
  env: AuthCookieEnv,
): string | undefined {
  return cookies?.[docmostAuthCookieName(env)];
}
