/**
 * CCC session-cookie boot validator — NOT upstream Docmost code (wiki-v2 issue #310).
 *
 * Turns a misconfigured session-cookie posture from "boots green, serves a shadowable cookie" (fail-OPEN)
 * into "refuses to boot" (fail-fast), mirroring services/platform's validate-production-config.ts. The
 * session cookie's security posture is gated on `NODE_ENV === 'production'` (docmost-auth-cookie.ts); this
 * check guarantees that authority is coherent with the actual edge before any request is served:
 *
 *   - NODE_ENV must be a recognized value — a typo like `Production` would otherwise make `isProduction()`
 *     false and silently run the dev (un-prefixed, non-Secure) cookie posture in production.
 *   - `isProduction()` and `isHttps()` (the APP_URL scheme) must AGREE. Production requires an https APP_URL
 *     (the `__Host-` + Secure cookie needs the https edge), and an https deployment must be marked
 *     production (an https edge silently running the dev posture is the fail-open). Either mismatch is a
 *     misconfiguration that would ship an insecure or broken session cookie — refuse to boot instead.
 *
 * `APP_URL` participates ONLY here (a coherence assertion), never in the per-request cookie decision, so the
 * security property does not depend on a config string being right at request time.
 */

import { isProductionPosture } from './docmost-auth-cookie';

/** The subset of EnvironmentService this validator needs (keeps it unit-testable without a full service). */
export interface CookiePostureEnv {
  getNodeEnv(): string;
  isHttps(): boolean;
}

const VALID_NODE_ENVS = ['development', 'test', 'production'];

/** Pure check — returns the list of problems (empty = OK). Exported so a unit test exercises the classifier. */
export function cookiePostureProblems(env: CookiePostureEnv): string[] {
  const problems: string[] = [];

  const nodeEnv = env.getNodeEnv();
  if (!VALID_NODE_ENVS.includes(nodeEnv)) {
    problems.push(
      `NODE_ENV='${nodeEnv}' is not recognized (expected one of ${VALID_NODE_ENVS.join(', ')}) — ` +
        'an unrecognized value silently runs the session cookie in development (non-Secure, shadowable) posture',
    );
  }

  const prod = isProductionPosture(env);
  const https = env.isHttps();
  if (prod !== https) {
    problems.push(
      `incoherent session-cookie posture: NODE_ENV production=${prod} but APP_URL https=${https}. ` +
        'In production the session cookie is __Host- + Secure and requires an https APP_URL; an https ' +
        'deployment must be marked production (else it runs the dev, shadowable posture). Fix APP_URL/NODE_ENV.',
    );
  }

  return problems;
}

/** Throw (refuse to boot) if the session-cookie posture is misconfigured. */
export function validateCookiePosture(env: CookiePostureEnv): void {
  const problems = cookiePostureProblems(env);
  if (problems.length === 0) return;
  throw new Error(
    `refusing to boot: invalid Docmost session-cookie posture (wiki-v2 #310), ${problems.length} problem(s):\n` +
      problems.map((p) => `  - ${p}`).join('\n'),
  );
}
