import type { FastifyReply } from 'fastify';

/**
 * CCC session-cookie helper — NOT upstream Docmost code (wiki-v2 issue #310).
 *
 * Single source of truth for the Docmost session cookie's NAME and attributes, so every set/clear/read
 * agrees. It closes the cookie-shadowing / login-CSRF vector: the wiki now shares a registrable parent
 * domain with sibling institutional sites, so any same-site sibling origin could plant
 * `authToken=<its JWT>; Domain=<shared-parent-domain>; Path=/api`, which the browser sends first (longer
 * Path) and `@fastify/cookie` keeps — the server cannot tell the two apart because the `Cookie:` header
 * carries no Path/Domain. The only robust defense is the browser-enforced `__Host-` prefix: a browser
 * refuses a `__Host-`-named cookie unless it is Secure, host-only (no Domain) and Path=/, so a sibling
 * origin can never set one that lands on the wiki host.
 *
 * SECURITY POSTURE IS GATED ON `isHttps()` (the APP_URL scheme), matching upstream Docmost's own
 * `secure: isHttps()` choice — because the `__Host-` prefix REQUIRES a Secure/https context to work at all:
 * a browser silently drops a `__Host-`/Secure cookie sent over http, so deriving the prefix from anything
 * other than the actual https edge would break login on every legitimate http deployment (the documented
 * standalone self-host runs `NODE_ENV=production` over `http://localhost:3000`; the fork CI smokes boot over
 * http). The name and the `secure` flag share this ONE authority, so `prefix ⟺ Secure` holds by
 * construction (no `__Host-`-without-Secure lockout, #313; no name-override env var, #379).
 *
 * FAIL-CLOSED FOR THE CCC PRODUCTION DEPLOYMENT IS ENFORCED AT THE PLATFORM, not here. A fork boot check
 * cannot tell the real CCC https deployment apart from a legitimate http deployment — both run
 * `NODE_ENV=production`, and the AUTHZ_MODE=remote contract smoke legitimately boots a remote fork over http
 * — so any fork-side "must be https" guard would refuse to boot valid configs. Instead the platform
 * (services/platform), which authoritatively knows it is production and observes the fork's real Set-Cookie
 * when it mints a Docmost session, REJECTS a non-`__Host-` fork session cookie in production posture
 * (bff/docmost.client.ts). So a fork misconfigured to an http APP_URL in the CCC deployment fails login
 * closed at the platform rather than silently shipping a shadowable cookie (wiki-v2 #310).
 *
 * Over http (`isHttps()` false) the name is the un-prefixed `authToken` and `secure` is false, because a
 * Secure `__Host-` cookie would be dropped by the browser — this is the legitimate self-host / dev posture,
 * and safe because an http deployment on a private host/LAN is not the shared-parent-domain threat model.
 */

/** The un-prefixed cookie name used over http AND the legacy name evicted on logout after migration. */
export const AUTH_COOKIE_BASENAME = 'authToken';
/** The https cookie name: the `__Host-` prefix is browser-enforced host-only + Secure + Path=/. */
export const AUTH_COOKIE_HOST_PREFIXED = '__Host-authToken';

/** The subset of EnvironmentService the auth-cookie helpers need (keeps them unit-testable). */
export interface AuthCookieEnv {
  isHttps(): boolean;
  getCookieExpiresIn(): Date;
}

/**
 * The single canonical "use the `__Host-` prefixed, Secure cookie" predicate (wiki-v2 #310). Derived from
 * `isHttps()` (the APP_URL scheme) — the ONLY signal under which a `__Host-`/Secure cookie actually works,
 * and the same authority upstream uses for `secure`. Both the name and the `secure` flag read it, so
 * `prefix ⟺ Secure` holds by construction. Kept as a free function (not a method on EnvironmentService) so
 * the fork's upstream files stay unmodified. Fail-closed enforcement that the CCC production deployment
 * actually resolves to `__Host-` lives at the platform (see the file header), never at fork boot.
 */
export function useHostPrefixedCookie(env: { isHttps(): boolean }): boolean {
  return env.isHttps();
}

/**
 * Cookie attributes for the session cookie. Literal types make any divergence between the set and clear
 * paths (or from the `__Host-` requirements) a COMPILE error. `secure` shares the `isHttps()` authority
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
  return useHostPrefixedCookie(env) ? AUTH_COOKIE_HOST_PREFIXED : AUTH_COOKIE_BASENAME;
}

/** Attributes for SETTING the session cookie. */
export function docmostAuthCookieSetOptions(
  env: AuthCookieEnv,
): DocmostAuthCookieSetOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: useHostPrefixedCookie(env),
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
 * Clear the session cookie, and (over https only) evict the legacy un-prefixed `authToken` that a browser
 * may still hold from before the `__Host-` migration. The legacy eviction is COSMETIC — the reader ignores
 * the un-prefixed name over https, so a stale/attacker `authToken` is never read — but it keeps browser jars
 * clean. It is skipped over http, where the resolved name IS `authToken` and clearing it again would be
 * redundant. Emitted on LOGOUT only (never on the mint path, so the east-west relay never caches an
 * empty-value pair).
 */
export function clearDocmostAuthCookie(res: FastifyReply, env: AuthCookieEnv): void {
  res.clearCookie(docmostAuthCookieName(env), docmostAuthCookieClearOptions(env));
  if (docmostAuthCookieName(env) !== AUTH_COOKIE_BASENAME) {
    res.clearCookie(AUTH_COOKIE_BASENAME, docmostAuthCookieClearOptions(env));
  }
}

/**
 * Read the session token from parsed cookies under the RESOLVED name ONLY. There is deliberately no
 * fallback to the un-prefixed `authToken` over https: a fallback would let a sibling-planted plain
 * `authToken` be read, reopening the exact vector this fix closes.
 */
export function readDocmostAuthCookie(
  cookies: Record<string, string | undefined> | undefined,
  env: AuthCookieEnv,
): string | undefined {
  return cookies?.[docmostAuthCookieName(env)];
}
