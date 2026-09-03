import { FixedWindowRateLimiter } from './service-rate-limit';

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit within a window, then denies', () => {
    const rl = new FixedWindowRateLimiter(3, 1000);
    expect(rl.allow('k', 0)).toBe(true);
    expect(rl.allow('k', 100)).toBe(true);
    expect(rl.allow('k', 200)).toBe(true);
    expect(rl.allow('k', 300)).toBe(false); // over the limit
  });

  it('resets after the window elapses', () => {
    const rl = new FixedWindowRateLimiter(1, 1000);
    expect(rl.allow('k', 0)).toBe(true);
    expect(rl.allow('k', 500)).toBe(false);
    expect(rl.allow('k', 1000)).toBe(true); // window reset at now >= resetAt
  });

  it('tracks keys (credentials) independently', () => {
    const rl = new FixedWindowRateLimiter(1, 1000);
    expect(rl.allow('a', 0)).toBe(true);
    expect(rl.allow('b', 0)).toBe(true); // different key unaffected
    expect(rl.allow('a', 0)).toBe(false);
  });
});
