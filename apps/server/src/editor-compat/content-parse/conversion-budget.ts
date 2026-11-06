/**
 * #642 / #716 — each human's token bucket of conversion-WORKER time. Fork-owned.
 *
 * Extracted from `ContentParsePool` (#716 M7) so it can be tested on its own, against an injected clock, and so every
 * caller of the one worker shares one budget. The pool decides WHEN to admit and charge; this decides WHETHER:
 *   - a key's bucket holds `budgetCapacityMs` and regains `budgetRefillMsPerMinute`; a missing key is full;
 *   - it is charged on settle with the worker time a conversion took (and the reload it caused), floored at
 *     -capacity, so an ungated charge never locks its human out for longer than one full refill;
 *   - an interactive caller is admitted only while its bucket is positive (429 with the seconds until it is), a batch
 *     caller waits for the refill within what is left of its wait;
 *   - a batch (the zip import) is admitted ONCE, then charged but not gated — except (#716 I3) once the debt the floor
 *     clamped away (`BatchBudgetTurn.overdraftMs`) passes `batchOverdraftMs`: then it is refused 429 before any more
 *     work, and the import rolls back. That bounds the worker time one import can take to about
 *     2 × capacity + `batchOverdraftMs` + the refill over its run.
 *   - keys with no human behind them (`background`, `batch:<id>`) are exempt.
 */
import { HttpException, HttpStatus, Logger } from '@nestjs/common';

export interface ConversionBudgetLimits {
  /** A key's bucket of worker time, in ms: how much it may use in a burst. */
  budgetCapacityMs: number;
  /** Worker ms a key's bucket regains per minute: its sustained share of the one worker. */
  budgetRefillMsPerMinute: number;
  /** #716 I3: worker ms an admitted batch may be charged past the floor before it is refused. */
  batchOverdraftMs: number;
}

/**
 * 429 (#642): this key has used its share of the converter's time. Refused at admission (nothing queued, nothing
 * applied); `retryAfterSeconds` is when its bucket is positive again. RetryAfterFilter turns it into `Retry-After`.
 */
export class ConversionBudgetExhaustedException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      {
        message: `this account is using the content converter heavily; retry in ${retryAfterSeconds} s`,
        code: 'conversion_budget_exhausted',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * #642: a batch is admitted against its human's budget once, on its first conversion; after that its conversions are
 * charged but never gated. The zip import converts every page inside one open transaction, so a budget wait on each
 * conversion would hold that connection and the inserted rows' locks for minutes. It still takes one turn at a time,
 * so it can never hold more than one conversion's share of the worker.
 */
export interface BatchBudgetTurn {
  admitted: boolean;
  /**
   * #716 I3: worker ms this batch was charged that the -capacity floor clamped away. Past `batchOverdraftMs` the batch
   * is refused (429) before its next conversion.
   */
  overdraftMs: number;
}

/** #642: keys with no human behind them share no budget — actorless requests and imports nobody started. */
export function isBudgetExempt(key: string): boolean {
  return key === 'background' || key.startsWith('batch:');
}

/** How often idle (full) buckets are swept, at most. Buckets are also dropped whenever they are read full. */
const BUDGET_PRUNE_EVERY_MS = 60_000;

export interface ConversionBudgetClock {
  now?: () => number;
  /** How a batch waits for its refill (tests advance a fake clock instead). */
  sleep?: (ms: number) => Promise<void>;
}

export interface AdmitOptions {
  /** Work nobody waits on a response for: an empty bucket is waited out within `left()`, not refused. */
  batch: boolean;
  /** The batch's shared admission (`batchConversion`). */
  turn?: BatchBudgetTurn;
  /** Ms left of the caller's wait. */
  left: () => number;
  /** For the log line only: sizes and the operation, never content. */
  context: string;
}

export class ConversionBudget {
  private readonly logger = new Logger('ContentParse');
  /** Buckets of the keys that are below capacity. A missing key is full. */
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private lastPrune = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly limits: Readonly<ConversionBudgetLimits>,
    clock: ConversionBudgetClock = {},
  ) {
    // Read through at call time (not `Date.now` captured), so a spy on Date.now still steers the default clock.
    this.now = clock.now ?? (() => Date.now());
    this.sleep = clock.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** The key's worker time left, in ms, refilled to now (may be negative). Drops a bucket that is full again. */
  left(key: string, now = this.now()): number {
    const { budgetCapacityMs: cap, budgetRefillMsPerMinute: perMin } = this.limits;
    const b = this.buckets.get(key);
    if (!b) return cap;
    const tokens = Math.min(cap, b.tokens + ((now - b.at) * perMin) / 60_000);
    if (tokens >= cap) {
      this.buckets.delete(key);
      return cap;
    }
    b.tokens = tokens;
    b.at = now;
    return tokens;
  }

  /** How many keys hold a bucket below capacity (tests, diagnostics). */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Charge `ms` of worker time to the key (on settle). Exempt keys are never charged. Floored at -capacity; what the
   * floor clamps away is added to the batch's `turn.overdraftMs` (#716 I3), so an admitted batch cannot run unbounded.
   */
  charge(key: string, ms: number, turn?: BatchBudgetTurn): void {
    if (isBudgetExempt(key) || !(ms > 0)) return;
    const now = this.now();
    const floor = -this.limits.budgetCapacityMs;
    const raw = this.left(key, now) - ms;
    if (turn && raw < floor) turn.overdraftMs += floor - raw;
    this.buckets.set(key, { tokens: Math.max(floor, raw), at: now });
  }

  /** Sweep the buckets that have refilled, at most once a `BUDGET_PRUNE_EVERY_MS`, so idle keys do not accumulate. */
  prune(now = this.now()): void {
    if (now - this.lastPrune < BUDGET_PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    for (const key of [...this.buckets.keys()]) this.left(key, now);
  }

  /** Ms until the key's bucket is strictly positive again (∞ with no refill). */
  private msUntilPositive(tokens: number): number {
    const perMin = this.limits.budgetRefillMsPerMinute;
    if (tokens > 0) return 0;
    return perMin > 0 ? Math.floor((-tokens * 60_000) / perMin) + 1 : Number.POSITIVE_INFINITY;
  }

  private refuse(key: string, tokens: number, context: string, why: string): never {
    const needMs = this.msUntilPositive(tokens);
    const retryAfter = Number.isFinite(needMs) ? Math.max(1, Math.ceil(needMs / 1000)) : 60;
    this.logger.warn(
      `CONTENT_PARSE_BUDGET principal=${key} ${context} budgetMs=${Math.round(tokens)}${why}: worker-time budget spent; answered 429 conversion_budget_exhausted retryAfter=${retryAfter}`,
    );
    throw new ConversionBudgetExhaustedException(retryAfter);
  }

  /**
   * Admit the key only while its bucket is positive. Empty: an interactive caller is refused at once (429 with the
   * seconds until it is positive again); a batch caller waits for the refill if that fits in what is left of its
   * wait, else is refused the same way. A batch whose `turn` was already admitted is not gated (charged only), unless
   * its overdraft has passed `batchOverdraftMs` (#716 I3): then it is refused before any more work.
   */
  async admit(key: string, { batch, turn, left, context }: AdmitOptions): Promise<void> {
    if (isBudgetExempt(key)) return;
    if (batch && turn?.admitted) {
      if (turn.overdraftMs > this.limits.batchOverdraftMs) {
        this.refuse(key, this.left(key), context, ` overdraftMs=${Math.round(turn.overdraftMs)} limitMs=${this.limits.batchOverdraftMs}`);
      }
      return;
    }
    for (;;) {
      const tokens = this.left(key);
      if (tokens > 0) return;
      const needMs = this.msUntilPositive(tokens);
      if (batch && needMs <= left()) {
        await this.sleep(needMs);
        continue;
      }
      this.refuse(key, tokens, context, '');
    }
  }
}
