import {
  AUTH_COOKIE_BASENAME,
  AUTH_COOKIE_HOST_PREFIXED,
  AuthCookieEnv,
  clearDocmostAuthCookie,
  docmostAuthCookieClearOptions,
  docmostAuthCookieName,
  docmostAuthCookieSetOptions,
  readDocmostAuthCookie,
  setDocmostAuthCookie,
} from './docmost-auth-cookie';

/**
 * #310 — the session cookie must be `__Host-authToken` + Secure in production so a sibling
 * sibling same-site origin cannot shadow it, and the reader must NEVER fall back to the un-prefixed name.
 * These assertions are only meaningful at PRODUCTION posture (isProduction:true) — a dev-only assertion is
 * vacuous (#313), so both postures are pinned explicitly.
 */

const EXPIRES = new Date('2030-01-01T00:00:00.000Z');
const prodEnv: AuthCookieEnv = {
  getNodeEnv: () => 'production',
  getCookieExpiresIn: () => EXPIRES,
};
const devEnv: AuthCookieEnv = {
  getNodeEnv: () => 'development',
  getCookieExpiresIn: () => EXPIRES,
};

// Minimal FastifyReply stub capturing the (name, value?, options) of each set/clear call.
function replyStub() {
  const set: Array<{ name: string; value: string; options: any }> = [];
  const clear: Array<{ name: string; options: any }> = [];
  const reply: any = {
    setCookie: (name: string, value: string, options: any) => {
      set.push({ name, value, options });
      return reply;
    },
    clearCookie: (name: string, options: any) => {
      clear.push({ name, options });
      return reply;
    },
  };
  return { reply, set, clear };
}

describe('docmost-auth-cookie — production posture (__Host- + Secure)', () => {
  it('resolves the __Host- prefixed name', () => {
    expect(docmostAuthCookieName(prodEnv)).toBe('__Host-authToken');
    expect(AUTH_COOKIE_HOST_PREFIXED).toBe('__Host-authToken');
  });

  it('set options are Secure + host-only (no domain) + Path=/ (the __Host- requirements)', () => {
    const opts = docmostAuthCookieSetOptions(prodEnv);
    expect(opts).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
      expires: EXPIRES,
    });
    expect('domain' in opts).toBe(false);
  });

  it('clear options repeat the set attributes minus the lifetime (accepted __Host- removal, #313)', () => {
    const set = docmostAuthCookieSetOptions(prodEnv);
    const clear = docmostAuthCookieClearOptions(prodEnv);
    expect(clear).toEqual({ httpOnly: true, sameSite: 'lax', path: '/', secure: true });
    expect('expires' in clear).toBe(false);
    expect('domain' in clear).toBe(false);
    // parity: clear === set minus expires
    const { expires: _e, ...setMinusExpires } = set;
    expect(clear).toEqual(setMinusExpires);
  });

  it('setDocmostAuthCookie writes the prefixed cookie with the correct attributes', () => {
    const { reply, set } = replyStub();
    setDocmostAuthCookie(reply, 'jwt-value', prodEnv);
    expect(set).toHaveLength(1);
    expect(set[0].name).toBe('__Host-authToken');
    expect(set[0].value).toBe('jwt-value');
    expect(set[0].options.secure).toBe(true);
    expect('domain' in set[0].options).toBe(false);
  });

  it('clearDocmostAuthCookie evicts BOTH the prefixed cookie and the legacy un-prefixed authToken', () => {
    const { reply, clear } = replyStub();
    clearDocmostAuthCookie(reply, prodEnv);
    expect(clear.map((c) => c.name).sort()).toEqual(['__Host-authToken', 'authToken']);
    // both removals repeat Secure/Path=/ so the __Host- removal is accepted and identities match
    for (const c of clear) {
      expect(c.options.secure).toBe(true);
      expect(c.options.path).toBe('/');
      expect('expires' in c.options).toBe(false);
    }
  });

  it('reads ONLY the prefixed name and IGNORES a shadow un-prefixed authToken (vuln closed)', () => {
    // A sibling origin plants a plain authToken; the legitimate value is under __Host-.
    const jar = { '__Host-authToken': 'legit', authToken: 'attacker' };
    expect(readDocmostAuthCookie(jar, prodEnv)).toBe('legit');
    // With ONLY the planted plain authToken present, the reader returns nothing — it is never honored.
    expect(readDocmostAuthCookie({ authToken: 'attacker' }, prodEnv)).toBeUndefined();
    expect(readDocmostAuthCookie(undefined, prodEnv)).toBeUndefined();
  });
});

describe('docmost-auth-cookie — dev/test posture (un-prefixed, non-Secure)', () => {
  it('resolves the un-prefixed name and secure:false', () => {
    expect(docmostAuthCookieName(devEnv)).toBe('authToken');
    expect(AUTH_COOKIE_BASENAME).toBe('authToken');
    expect(docmostAuthCookieSetOptions(devEnv).secure).toBe(false);
  });

  it('clear does NOT emit a second (legacy) removal — the resolved name IS authToken', () => {
    const { reply, clear } = replyStub();
    clearDocmostAuthCookie(reply, devEnv);
    expect(clear).toHaveLength(1);
    expect(clear[0].name).toBe('authToken');
  });

  it('reads the un-prefixed name in dev', () => {
    expect(readDocmostAuthCookie({ authToken: 'legit' }, devEnv)).toBe('legit');
  });
});
