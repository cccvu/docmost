/**
 * The origin-check decision — NOT upstream Docmost code (wiki-v2 #655).
 *
 * A line-for-line port of the platform's `originCheckAllows` (wiki-v2 `services/platform/src/authz/origin-check.guard.ts`,
 * #510). The fork cannot import platform code (the AGPL boundary, ADR 0014), so the two copies are bound by a shared
 * golden-vector table instead: `origin-check-vectors.json` here is byte-identical to the platform's
 * `services/platform/test/fixtures/origin-check-vectors.json`, and both trees run every vector through their own copy
 * (the super repo's `origin-check-vectors.spec.ts` asserts the identity under `PLATFORM_REQUIRE_FORK=1`).
 *
 * Change the table only in both trees at once.
 */

/** Every value of `Sec-Fetch-Site` the Fetch Metadata spec defines, exactly as browsers send them. */
const FETCH_SITES = new Set(['same-origin', 'same-site', 'cross-site', 'none']);

/** The browser-set request headers the decision reads. Raw: each may be absent, a string, or a string[]. */
export interface OriginSignals {
  secFetchSite: unknown;
  origin: unknown;
  referer: unknown;
  host: unknown;
}

/**
 * The origin-check decision for an unsafe request: true = allow, false = refuse. Pure.
 *
 *   1. Shape. A present `Sec-Fetch-Site` must be exactly one of the four spec values; a present `Origin` must be
 *      literal `null` or a canonical serialized origin. A non-string (array), unparseable, path-bearing or
 *      comma-joined duplicate value is refused — it is never "no signal".
 *   2. A real Origin must be ours: its host equals `Host`, or it is exactly in `trustedOrigins`. If Origin is
 *      absent, a present Referer is held to the same rule (it must parse, and its origin must be ours).
 *   3. `same-site` / `cross-site` → allow only with a real Origin in `trustedOrigins` (a trusted frontend).
 *      `same-origin` / `none` → allow (rule 2 already held). `Origin: null` passes ONLY here.
 *   4. No `Sec-Fetch-Site`: `Origin: null` → refuse; otherwise allow (a non-browser client sends nothing).
 */
export function originCheckAllows(signals: OriginSignals, trustedOrigins: readonly string[]): boolean {
  const host = typeof signals.host === 'string' ? signals.host : undefined;
  const ours = (origin: string) => (host !== undefined && hostOf(origin) === host) || trustedOrigins.includes(origin);

  let site: string | undefined;
  if (signals.secFetchSite !== undefined) {
    if (typeof signals.secFetchSite !== 'string' || !FETCH_SITES.has(signals.secFetchSite)) return false;
    site = signals.secFetchSite;
  }

  // undefined = absent, null = the literal `null` (opaque / privacy-tainted origin), string = a real origin.
  let origin: string | null | undefined;
  if (signals.origin !== undefined) {
    if (signals.origin === 'null') origin = null;
    else {
      const canonical = canonicalOrigin(signals.origin);
      if (canonical === null) return false;
      origin = canonical;
    }
  }

  if (typeof origin === 'string' && !ours(origin)) return false;
  if (origin === undefined && signals.referer !== undefined) {
    const fromReferer = refererOrigin(signals.referer);
    if (fromReferer === null || !ours(fromReferer)) return false;
  }

  if (site === 'same-site' || site === 'cross-site')
    return typeof origin === 'string' && trustedOrigins.includes(origin);
  if (site === 'same-origin' || site === 'none') return true;
  return origin !== null;
}

/** `value` if it is already a canonical serialized origin (`scheme://host[:port]`, nothing else), else null. */
function canonicalOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).origin === value ? value : null;
  } catch {
    return null;
  }
}

/** The origin of a Referer URL, or null if it is not a string, does not parse, or has an opaque origin. */
function refererOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** The host[:port] of a canonical origin — compared against the target `Host` header. */
function hostOf(origin: string): string {
  return new URL(origin).host;
}

/** The refusal message — the platform's, so a 403 reads the same on either side of the relay. */
export const ORIGIN_CHECK_REFUSED_MESSAGE = 'cross-origin state-changing request refused (origin check)';

/** The four signals from raw Node request headers (never Fastify's `request.host`, which honours X-Forwarded-Host). */
export function signalsFromHeaders(headers: Record<string, unknown>): OriginSignals {
  return {
    secFetchSite: headers['sec-fetch-site'],
    origin: headers['origin'],
    referer: headers['referer'],
    host: headers['host'],
  };
}
