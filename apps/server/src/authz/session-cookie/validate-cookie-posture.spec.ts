import {
  CookiePostureEnv,
  cookiePostureProblems,
  validateCookiePosture,
} from './validate-cookie-posture';

/**
 * #310 — the boot validator turns a misconfigured cookie posture from a silent runtime fail-OPEN into a
 * fail-fast (refuse to boot). It asserts (a) NODE_ENV is recognized and (b) isProduction() ⟺ isHttps().
 */

function env(nodeEnv: string, https: boolean): CookiePostureEnv {
  return {
    getNodeEnv: () => nodeEnv,
    isHttps: () => https,
  };
}

describe('validate-cookie-posture (#310 fail-fast boot check)', () => {
  it('passes for coherent production (NODE_ENV=production + https APP_URL)', () => {
    expect(cookiePostureProblems(env('production', true))).toEqual([]);
    expect(() => validateCookiePosture(env('production', true))).not.toThrow();
  });

  it('passes for coherent dev (NODE_ENV=development + http APP_URL)', () => {
    expect(cookiePostureProblems(env('development', false))).toEqual([]);
    expect(() => validateCookiePosture(env('development', false))).not.toThrow();
  });

  it('REFUSES production with a non-https APP_URL (would ship a shadowable, non-Secure cookie)', () => {
    const problems = cookiePostureProblems(env('production', false));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/incoherent session-cookie posture/i);
    expect(() => validateCookiePosture(env('production', false))).toThrow(/refusing to boot/i);
  });

  it('REFUSES an https deployment not marked production (silent dev posture on an https edge)', () => {
    const problems = cookiePostureProblems(env('development', true));
    expect(problems.length).toBeGreaterThan(0);
    expect(() => validateCookiePosture(env('development', true))).toThrow(/refusing to boot/i);
  });

  it('REFUSES an unrecognized NODE_ENV (a typo would silently pick dev posture)', () => {
    // 'Production' (capital P) → isProduction() false, but isHttps() true on the real https edge → also
    // caught by the coherence rule; the allow-list message is the primary tell.
    const problems = cookiePostureProblems(env('Production', true));
    expect(problems.join(' ')).toMatch(/NODE_ENV='Production' is not recognized/);
    expect(() => validateCookiePosture(env('Production', true))).toThrow(/refusing to boot/i);
  });
});
