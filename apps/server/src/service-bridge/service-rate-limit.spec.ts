import { TokenBucketRateLimiter } from './service-rate-limit';

/** A limiter on a hand-driven monotonic clock (ms). */
function clocked(sweepEveryMs?: number) {
  const clock = { t: 1_000 };
  const rl = new TokenBucketRateLimiter(() => clock.t, sweepEveryMs);
  return { rl, clock };
}

const drain = (rl: TokenBucketRateLimiter, key: string, limit: number): number => {
  let n = 0;
  while (rl.take([{ key, limit }]).ok) n++;
  return n;
};

describe('TokenBucketRateLimiter (#780)', () => {
  it('admits a burst up to the capacity, then refuses', () => {
    const { rl } = clocked();
    expect(drain(rl, 'k', 120)).toBe(120);
    expect(rl.take([{ key: 'k', limit: 120 }])).toEqual({ ok: false, retryAfterSec: 1, short: ['k'] });
  });

  it('refills gradually — one token every 60/limit s, never a 60 s cliff', () => {
    const { rl, clock } = clocked();
    drain(rl, 'k', 120); // 120/min = one token per 500 ms
    clock.t += 499;
    expect(rl.take([{ key: 'k', limit: 120 }]).ok).toBe(false);
    clock.t += 1;
    expect(rl.take([{ key: 'k', limit: 120 }]).ok).toBe(true); // exactly one token back after 500 ms
    expect(rl.take([{ key: 'k', limit: 120 }]).ok).toBe(false);
    clock.t += 5_000;
    expect(drain(rl, 'k', 120)).toBe(10); // 5 s = 10 tokens, not the whole bucket
    clock.t += 10 * 60_000;
    expect(drain(rl, 'k', 120)).toBe(120); // never above capacity, however long it idles
  });

  it('retryAfterSec is the ceiling of the wait for one token, at least 1', () => {
    const { rl, clock } = clocked();
    drain(rl, 'slow', 6); // one token per 10 s
    expect(rl.take([{ key: 'slow', limit: 6 }]).retryAfterSec).toBe(10);
    clock.t += 2_500;
    expect(rl.take([{ key: 'slow', limit: 6 }]).retryAfterSec).toBe(8); // 7.5 s left → 8
    drain(rl, 'fast', 6000); // one token per 10 ms
    expect(rl.take([{ key: 'fast', limit: 6000 }]).retryAfterSec).toBe(1);
    // Several short buckets: the longest wait.
    expect(rl.take([{ key: 'fast', limit: 6000 }, { key: 'slow', limit: 6 }])).toEqual({
      ok: false,
      retryAfterSec: 8,
      short: ['fast', 'slow'],
    });
  });

  it('is all-or-nothing: a refused take leaves every bucket unchanged', () => {
    const { rl } = clocked();
    drain(rl, 'own', 2);
    // `shared` has tokens, `own` has none: refused, and `shared` must not be charged.
    for (let i = 0; i < 50; i++) {
      expect(rl.take([{ key: 'own', limit: 2 }, { key: 'shared', limit: 3 }]).ok).toBe(false);
    }
    expect(rl.size).toBe(1); // `shared` was never even stored
    expect(drain(rl, 'shared', 3)).toBe(3);
    // And the other way round: `own2` must keep its tokens while `shared` is empty.
    expect(rl.take([{ key: 'own2', limit: 2 }, { key: 'shared', limit: 3 }]).ok).toBe(false);
    expect(drain(rl, 'own2', 2)).toBe(2);
  });

  it('debits every named bucket when admitted', () => {
    const { rl } = clocked();
    expect(rl.take([{ key: 'a', limit: 5 }, { key: 'g', limit: 5 }]).ok).toBe(true);
    expect(drain(rl, 'a', 5)).toBe(4);
    expect(drain(rl, 'g', 5)).toBe(4);
  });

  it('tracks keys independently', () => {
    const { rl } = clocked();
    drain(rl, 'a', 1);
    expect(rl.take([{ key: 'b', limit: 1 }]).ok).toBe(true);
    expect(rl.take([{ key: 'a', limit: 1 }]).ok).toBe(false);
  });

  it('prunes buckets that refilled to full, at most once per sweep interval (no timers)', () => {
    const { rl, clock } = clocked(1_000);
    for (let i = 0; i < 100; i++) rl.take([{ key: `p${i}`, limit: 60 }]); // one token each, back in 1 s
    drain(rl, 'busy', 60);
    expect(rl.size).toBe(101);
    clock.t += 999; // not yet a sweep interval
    rl.take([{ key: 'other', limit: 600_000 }]);
    expect(rl.size).toBe(102);
    clock.t += 1; // a sweep runs: the p* buckets are full again; `busy` is not; `other` refilled too
    rl.take([{ key: 'busy2', limit: 60 }]);
    expect(rl.size).toBe(2); // busy + busy2
    expect(rl.take([{ key: 'busy', limit: 60 }]).ok).toBe(true); // `busy` kept its state: 1 token refilled, now spent
    expect(rl.take([{ key: 'busy', limit: 60 }]).ok).toBe(false);
  });

  it('runs on the injected monotonic clock only (wall-clock jumps do not refill)', () => {
    const { rl } = clocked();
    drain(rl, 'k', 1);
    const realNow = Date.now;
    Date.now = () => realNow() + 3_600_000; // a wall-clock jump of an hour
    try {
      expect(rl.take([{ key: 'k', limit: 1 }]).ok).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it('defaults to a monotonic clock (performance.now)', () => {
    const rl = new TokenBucketRateLimiter();
    const a = rl.now();
    expect(typeof a).toBe('number');
    expect(rl.now()).toBeGreaterThanOrEqual(a);
  });
});
