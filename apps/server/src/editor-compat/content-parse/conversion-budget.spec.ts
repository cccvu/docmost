/**
 * #716 M7/I3/I8: the conversion worker-time budget on its own, against an injected clock. Fully deterministic: no
 * worker, no real timers, exact values (the flaky pool case ran real 200 ms deadlines under CI timer stalls).
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/editor-compat …`).
 */
import {
  type BatchBudgetTurn,
  ConversionBudget,
  ConversionBudgetExhaustedException,
  type ConversionBudgetLimits,
  isBudgetExempt,
} from './conversion-budget';

const LIMITS: ConversionBudgetLimits = { budgetCapacityMs: 1_000, budgetRefillMsPerMinute: 60_000, batchOverdraftMs: 500 };

/** A budget on a fake clock; `sleep` advances it (a batch's refill wait completes at once, exactly as long as asked). */
const make = (limits: Partial<ConversionBudgetLimits> = {}) => {
  const clock = { t: 1_000_000 };
  const slept: number[] = [];
  const budget = new ConversionBudget(
    { ...LIMITS, ...limits },
    {
      now: () => clock.t,
      sleep: async (ms) => {
        slept.push(ms);
        clock.t += ms;
      },
    },
  );
  return { budget, clock, slept };
};
const turn = (): BatchBudgetTurn => ({ admitted: false, overdraftMs: 0 });
const ctx = (left = 0) => ({ left: () => left, context: 'format=html bytes=1' });

describe('ConversionBudget (#642, extracted #716)', () => {
  it('a missing key is full; a charge spends it; the refill restores it at the configured rate', () => {
    const { budget, clock } = make();
    expect(budget.left('user:A')).toBe(1_000);
    budget.charge('user:A', 400);
    expect(budget.left('user:A')).toBe(600);
    clock.t += 30_000; // half a minute at 60 s/min = 30 s of refill, capped at capacity
    expect(budget.left('user:A')).toBe(1_000);
    expect(budget.size).toBe(0); // read full ⇒ dropped
    budget.charge('user:A', 400);
    clock.t += 100; // 100 ms at 1 ms/ms
    expect(budget.left('user:A')).toBe(700);
  });

  it('debt is floored at exactly -capacity', () => {
    const { budget } = make({ budgetRefillMsPerMinute: 0 });
    budget.charge('user:A', 5_000);
    expect(budget.left('user:A')).toBe(-1_000);
    budget.charge('user:A', 5_000);
    expect(budget.left('user:A')).toBe(-1_000);
  });

  it('exempt keys are never charged or gated; non-positive charges are ignored', async () => {
    const { budget } = make({ budgetRefillMsPerMinute: 0 });
    for (const key of ['background', 'batch:file-task:1']) {
      expect(isBudgetExempt(key)).toBe(true);
      budget.charge(key, 10_000);
      expect(budget.left(key)).toBe(1_000);
      await expect(budget.admit(key, { batch: false, ...ctx() })).resolves.toBeUndefined();
    }
    expect(isBudgetExempt('user:A')).toBe(false);
    expect(isBudgetExempt('identity:I')).toBe(false);
    budget.charge('user:A', 0);
    budget.charge('user:A', -5);
    budget.charge('user:A', NaN);
    expect(budget.size).toBe(0);
  });

  it('prune sweeps refilled buckets at most once a minute', () => {
    const { budget, clock } = make();
    for (let i = 0; i < 5; i++) budget.charge(`user:${i}`, 10);
    expect(budget.size).toBe(5);
    clock.t += 1_000; // all refilled, but the sweep last ran (lastPrune=0) long ago: due now
    budget.prune();
    expect(budget.size).toBe(0);
    budget.charge('user:x', 10);
    clock.t += 1_000;
    budget.prune(); // within a minute of the last sweep: skipped
    expect(budget.size).toBe(1);
    clock.t += 60_000;
    budget.prune();
    expect(budget.size).toBe(0);
  });

  it('an interactive caller is admitted while positive, and refused 429 with the exact seconds until positive', async () => {
    const { budget } = make({ budgetRefillMsPerMinute: 6_000 }); // 0.1 ms per ms
    await expect(budget.admit('user:A', { batch: false, ...ctx() })).resolves.toBeUndefined();
    budget.charge('user:A', 1_250); // to -250: positive again in 2 501 ms
    const err = await budget.admit('user:A', { batch: false, ...ctx(60_000) }).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionBudgetExhaustedException);
    expect((err as ConversionBudgetExhaustedException).retryAfterSeconds).toBe(3);
    expect((err as ConversionBudgetExhaustedException).getStatus()).toBe(429);
    expect((err as ConversionBudgetExhaustedException).getResponse()).toMatchObject({ code: 'conversion_budget_exhausted' });
  });

  it('with no refill, Retry-After is 60 s and a batch can never wait it out', async () => {
    const { budget, slept } = make({ budgetRefillMsPerMinute: 0 });
    budget.charge('user:A', 1_000);
    const err = await budget.admit('user:A', { batch: true, turn: turn(), ...ctx(1e9) }).catch((e) => e);
    expect((err as ConversionBudgetExhaustedException).retryAfterSeconds).toBe(60);
    expect(slept).toEqual([]);
  });

  it('a batch waits for the refill within what is left of its wait, then is admitted', async () => {
    const { budget, slept } = make({ budgetRefillMsPerMinute: 6_000 });
    budget.charge('user:A', 1_250); // -250 → 2 501 ms to positive
    await expect(budget.admit('user:A', { batch: true, turn: turn(), ...ctx(5_000) })).resolves.toBeUndefined();
    expect(slept).toEqual([2_501]);
    expect(budget.left('user:A')).toBeGreaterThan(0);
  });

  it('a batch whose wait cannot cover the refill is refused at once', async () => {
    const { budget, slept } = make({ budgetRefillMsPerMinute: 6_000 });
    budget.charge('user:A', 1_250);
    await expect(budget.admit('user:A', { batch: true, turn: turn(), ...ctx(2_500) })).rejects.toBeInstanceOf(
      ConversionBudgetExhaustedException,
    );
    expect(slept).toEqual([]);
  });

  it('an admitted batch is charged but not gated, even far below zero', async () => {
    const { budget } = make({ budgetRefillMsPerMinute: 0 });
    const t = turn();
    t.admitted = true;
    budget.charge('user:A', 1_400, t); // -400: below zero, above the floor
    await expect(budget.admit('user:A', { batch: true, turn: t, ...ctx() })).resolves.toBeUndefined();
    expect(t.overdraftMs).toBe(0);
  });

  it('I3: what the floor clamps away accrues to the turn; past batchOverdraftMs the batch is refused 429', async () => {
    const { budget } = make({ budgetRefillMsPerMinute: 0 }); // capacity 1 000, overdraft limit 500
    const t = turn();
    t.admitted = true;
    budget.charge('user:A', 1_800, t); // raw -800: above the floor, nothing clamped
    expect(t.overdraftMs).toBe(0);
    budget.charge('user:A', 300, t); // raw -1 100 → -1 000, 100 clamped
    expect(t.overdraftMs).toBe(100);
    budget.charge('user:A', 400, t); // raw -1 400 → 400 more
    expect(t.overdraftMs).toBe(500);
    await expect(budget.admit('user:A', { batch: true, turn: t, ...ctx() })).resolves.toBeUndefined(); // = limit: ok
    budget.charge('user:A', 1, t);
    expect(t.overdraftMs).toBe(501);
    const err = await budget.admit('user:A', { batch: true, turn: t, ...ctx(1e9) }).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionBudgetExhaustedException);
    expect((err as ConversionBudgetExhaustedException).retryAfterSeconds).toBe(60); // no refill
  });

  it('I3: the reload charge accrues to the turn too; a charge without a turn never touches one', () => {
    const { budget } = make({ budgetRefillMsPerMinute: 0 });
    const t = turn();
    budget.charge('user:A', 2_500, t); // the conversion: raw -1 500 → -1 000 (500 clamped)
    expect(t.overdraftMs).toBe(500);
    budget.charge('user:A', 250, t); // its reload: all 250 below the floor
    expect(t.overdraftMs).toBe(750);
    const other = turn();
    budget.charge('user:B', 5_000);
    expect(other.overdraftMs).toBe(0);
  });

  it('I3: an overdrawn batch whose bucket has since refilled is still refused (Retry-After at least 1 s)', async () => {
    const { budget, clock } = make();
    const t = turn();
    t.admitted = true;
    budget.charge('user:A', 3_000, t); // 1 000 clamped > 500
    clock.t += 120_000; // full again
    const err = await budget.admit('user:A', { batch: true, turn: t, ...ctx() }).catch((e) => e);
    expect((err as ConversionBudgetExhaustedException).retryAfterSeconds).toBe(1);
  });

  it('the default clock reads Date.now at call time (a spy on it steers an un-injected budget)', () => {
    const budget = new ConversionBudget({ ...LIMITS, budgetRefillMsPerMinute: 60_000 });
    let now = 5_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      budget.charge('user:A', 500);
      now += 200;
      expect(budget.left('user:A')).toBe(700);
    } finally {
      spy.mockRestore();
    }
  });
});
