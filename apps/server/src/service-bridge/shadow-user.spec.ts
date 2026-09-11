import { isShadowEmail, SHADOW_EMAIL_DOMAIN, shadowEmailFor } from './shadow-user';

describe('shadow-user namespace (no-impersonation boundary)', () => {
  it('derives and recognizes the reserved domain (case-insensitive)', () => {
    expect(shadowEmailFor('abc')).toBe(`abc@${SHADOW_EMAIL_DOMAIN}`);
    expect(isShadowEmail(shadowEmailFor('abc'))).toBe(true);
    expect(isShadowEmail(`ABC@${SHADOW_EMAIL_DOMAIN.toUpperCase()}`)).toBe(true);
  });

  it('rejects real users, docmost-native anchors, and empty/null — the impersonation guard', () => {
    expect(isShadowEmail('real.person@vanderbilt.edu')).toBe(false);
    expect(isShadowEmail('docmost-native+x@users.invalid')).toBe(false);
    expect(isShadowEmail('')).toBe(false);
    expect(isShadowEmail(null)).toBe(false);
    expect(isShadowEmail(undefined)).toBe(false);
  });

  /**
   * T-034 (issue #50): the recognizer is the last line of defense when a resolved row's email is tampered
   * or mis-provisioned (mintSession refuses anything else). A suffix check is easy to get subtly wrong, so
   * pin the lookalike table explicitly: only an exact `@shadow.wiki-v2.internal` suffix qualifies.
   */
  it('T-034: lookalike-domain table — only the exact reserved suffix is a shadow user', () => {
    const accepted = [
      `abc@${SHADOW_EMAIL_DOMAIN}`,
      `abc@${SHADOW_EMAIL_DOMAIN.toUpperCase()}`,
      `ABC.XYZ+1@${SHADOW_EMAIL_DOMAIN}`,
    ];
    const rejected = [
      `abc@${SHADOW_EMAIL_DOMAIN}.attacker.com`, // suffix attack: our domain as a prefix
      `abc@not-${SHADOW_EMAIL_DOMAIN}`, // no @ before the domain
      `abc@sub.${SHADOW_EMAIL_DOMAIN}`, // subdomain of the reserved name is still a different domain
      `abc@${SHADOW_EMAIL_DOMAIN} `, // trailing whitespace is not the suffix
      `abc@${SHADOW_EMAIL_DOMAIN}\n`,
      `abc@x${SHADOW_EMAIL_DOMAIN}`, // missing dot boundary
      'real.person@vanderbilt.edu',
    ];
    for (const email of accepted) expect(isShadowEmail(email)).toBe(true);
    for (const email of rejected) expect(isShadowEmail(email)).toBe(false);
  });

  // T-034b: the derived address always lives in the reserved domain, whatever the externalId's shape. The
  // wire DTO pins externalId's charset (`[A-Za-z0-9._+-]`), so even a hostile id cannot break out of the
  // local part into a domain — but the derivation itself must remain a pure suffix.
  it('T-034b: derived addresses stay in the namespace for id-like inputs (no breakout)', () => {
    for (const id of ['a', 'AbC-123_x.y+z', '0'.repeat(128)]) {
      const email = shadowEmailFor(id);
      expect(isShadowEmail(email)).toBe(true);
      expect(email.split('@')).toHaveLength(2); // exactly one @ — no domain injection
    }
  });
});
