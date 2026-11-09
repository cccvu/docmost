/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * In-memory token-bucket rate limiter for the east-west `/api/service/*` endpoints (#780). Each key is a bucket
 * holding up to `limit` tokens (its per-minute rate) that refills continuously at `limit` per 60 s, so a throttled
 * caller gets tokens back one at a time — there is no fixed window whose reset lets everyone back in at once (the
 * 60 s lockout cliff of the fixed-window limiter it replaces). One fork container per task, so in-memory suffices.
 *
 * `take` is all-or-nothing: it debits one token from EVERY bucket named, or from none. A refused request charges
 * nothing, so a principal throttled on its own bucket never drains a shared (global) bucket it is also charged to.
 * Memory is bounded without timers: at most once per `sweepEveryMs`, a call drops every bucket that has refilled
 * to full (indistinguishable from a bucket that does not exist). The clock is monotonic and injectable for tests.
 */
export const RATE_WINDOW_MS = 60_000;

export interface BucketDebit {
  key: string;
  /** The bucket's capacity and per-minute refill rate. */
  limit: number;
}

export interface TakeResult {
  ok: boolean;
  /** Seconds until every short bucket holds a token again (≥ 1 when refused, 0 when admitted). */
  retryAfterSec: number;
  /** The keys that lacked a token (empty when admitted). */
  short: string[];
}

interface Bucket {
  tokens: number;
  at: number;
  limit: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep: number;

  constructor(
    readonly now: () => number = () => performance.now(),
    private readonly sweepEveryMs = RATE_WINDOW_MS,
  ) {
    this.lastSweep = now();
  }

  /** The number of stored (not yet full) buckets — the memory bound, for tests. */
  get size(): number {
    return this.buckets.size;
  }

  take(debits: readonly BucketDebit[]): TakeResult {
    const now = this.now();
    this.sweep(now);
    // Refill first (a pure function of elapsed time), decide, and only then debit: all-or-nothing.
    const states = debits.map(({ key, limit }) => ({ key, b: this.refilled(key, limit, now) }));
    const short = states.filter(({ b }) => b.tokens < 1);
    if (short.length > 0) {
      const waitMs = Math.max(...short.map(({ b }) => ((1 - b.tokens) * RATE_WINDOW_MS) / b.limit));
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)), short: short.map((s) => s.key) };
    }
    for (const { key, b } of states) {
      b.tokens -= 1;
      this.buckets.set(key, b); // a new bucket is stored only once it is debited
    }
    return { ok: true, retryAfterSec: 0, short: [] };
  }

  private refilled(key: string, limit: number, now: number): Bucket {
    const b = this.buckets.get(key);
    if (!b) return { tokens: limit, at: now, limit };
    b.tokens = Math.min(limit, b.tokens + ((now - b.at) * limit) / RATE_WINDOW_MS);
    b.at = now;
    b.limit = limit;
    return b;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.sweepEveryMs) return;
    this.lastSweep = now;
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((now - b.at) * b.limit) / RATE_WINDOW_MS >= b.limit) this.buckets.delete(key);
    }
  }
}
