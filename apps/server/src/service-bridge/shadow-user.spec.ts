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
});
