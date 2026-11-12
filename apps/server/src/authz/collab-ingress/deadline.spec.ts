import { AsyncLocalStorage } from 'node:async_hooks';
import * as Y from 'yjs';
import { ConflictScan, installConflictScanMeter } from './conflict-scan';
import { copyOf, twoClientsShape } from './conflict-scan.testkit';
import {
  DEADLINE_EXCEEDED_CODE,
  NestedDeadlineError,
  deadlineExceeded,
  isDeadlineExceeded,
  overrideDeadlineForTests,
  runWithDeadline,
  vmRunWithDeadline,
} from './deadline';

/**
 * #827 (ADR 0036): what the guard relies on when it puts Yjs work under `runWithDeadline`, proven on the Node running
 * this spec (production: node:22-slim; the #827 sizing bench measures the same on any Node). Wall-clock bounds
 * are loose on the late side (a busy CI runner), tight on the early side: a cut must never land before its deadline.
 */
const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};
const timed = (fn: () => void): { ms: number; err: unknown } => {
  const t0 = performance.now();
  try {
    fn();
    return { ms: performance.now() - t0, err: null };
  } catch (err) {
    return { ms: performance.now() - t0, err };
  }
};
const LATE = 150; // ms a cut may land late on a loaded runner (measured: ≤ 1.7 ms on an idle box)

describe('#827 runWithDeadline interrupts synchronous outer-realm work', () => {
  it('a busy loop is cut at its deadline: an error with the timeout code (not instanceof: the vm realm made it)', () => {
    for (const ms of [50, 120]) {
      const { ms: took, err } = timed(() =>
        runWithDeadline(() => {
          for (;;);
        }, ms),
      );
      expect(isDeadlineExceeded(err)).toBe(true);
      expect((err as { code?: unknown }).code).toBe(DEADLINE_EXCEEDED_CODE);
      expect(took).toBeGreaterThanOrEqual(ms - 2);
      expect(took).toBeLessThan(ms + LATE);
    }
  });

  it('a Yjs apply that would walk ~9M steps is cut; the interrupted doc is left mid-transaction (discard it), others are fine', () => {
    const { base, frame } = twoClientsShape(3000);
    const victim = copyOf(base);
    const { ms: took, err } = timed(() => runWithDeadline(() => Y.applyUpdate(victim, frame), 100));
    expect(isDeadlineExceeded(err)).toBe(true);
    expect(took).toBeGreaterThanOrEqual(98);
    expect(took).toBeLessThan(100 + LATE);
    // Yjs's transact `finally` never ran: the doc is broken for good, which is why a deadline's doc is thrown away
    expect((victim as unknown as { _transaction: unknown })._transaction).not.toBeNull();
    // every other document, and Yjs itself, is untouched
    const other = copyOf(base);
    const seen: Uint8Array[] = [];
    other.on('update', (u: Uint8Array) => seen.push(u));
    other.getText('t').insert(0, 'still fine');
    expect(seen).toHaveLength(1);
    expect(other.getText('t').toString()).toBe('still fine');
  });

  it('innermost inside the meter: the meter scope is cleared after a timeout (its finally runs outside the vm)', () => {
    const meter = installConflictScanMeter(Y);
    const { base, frame } = twoClientsShape(3000);
    const shadow = copyOf(base);
    const scan = new ConflictScan(shadow, false, Infinity);
    let err: unknown;
    try {
      meter.metered(scan, () => runWithDeadline(() => Y.applyUpdate(shadow, frame), 60));
    } catch (e) {
      err = e;
    }
    expect(isDeadlineExceeded(err)).toBe(true);
    expect(meter.isActive()).toBe(false);
    expect(scan.steps).toBeGreaterThan(0); // it was counting when cut
  });

  it('returns what fn returns, and an error thrown inside keeps its identity (no wrapping)', () => {
    expect(runWithDeadline(() => 42, 1000)).toBe(42);
    const mine = new Error('mine');
    let caught: unknown;
    try {
      runWithDeadline(() => {
        throw mine;
      }, 1000);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(mine);
    expect(isDeadlineExceeded(caught)).toBe(false);
    const value = { reason: 'not an error' }; // the shape a load's budget trip throws
    let thrown: unknown;
    try {
      runWithDeadline(() => {
        throw value;
      }, 1000);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(value);
  });

  it('no termination leaks past the boundary: 400 races at a 1 ms deadline, each a return or a timeout, never anything else', () => {
    let returned = 0;
    let timedOut = 0;
    for (let i = 0; i < 400; i++) {
      try {
        runWithDeadline(() => busy(0.9 + (i % 5) * 0.05), 1);
        returned++;
      } catch (e) {
        if (!isDeadlineExceeded(e)) throw e;
        timedOut++;
      }
      // code right after the boundary runs (a leaked termination would kill it, and the process)
      expect([1, 2, 3].map((x) => x * 2)).toEqual([2, 4, 6]);
    }
    expect(returned + timedOut).toBe(400);
    expect(timedOut).toBeGreaterThan(0); // anti-vacuity: the races did reach the boundary
  });

  it('after a timeout, the caller\'s finally, later microtasks and timers all run', async () => {
    const order: string[] = [];
    try {
      try {
        runWithDeadline(() => {
          queueMicrotask(() => order.push('microtask queued inside'));
          for (;;);
        }, 20);
      } finally {
        order.push('outer finally');
      }
    } catch (e) {
      expect(isDeadlineExceeded(e)).toBe(true);
    }
    queueMicrotask(() => order.push('microtask after'));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    order.push('timer after');
    expect(order).toEqual(['outer finally', 'microtask queued inside', 'microtask after', 'timer after']);
  });

  it('restores the caller\'s AsyncLocalStorage store even when the work entered another and was cut', async () => {
    const als = new AsyncLocalStorage<{ who: string }>();
    await als.run({ who: 'caller' }, async () => {
      expect(() =>
        runWithDeadline(() => {
          als.enterWith({ who: 'inside' });
          for (;;);
        }, 20),
      ).toThrow();
      expect(als.getStore()).toEqual({ who: 'caller' });
      await Promise.resolve();
      expect(als.getStore()).toEqual({ who: 'caller' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(als.getStore()).toEqual({ who: 'caller' });
    });
  });

  it('refuses a nested deadline before running anything (a cut inside an inner async scope aborts node)', () => {
    let innerRan = false;
    let inner: unknown;
    const r = runWithDeadline(() => {
      try {
        runWithDeadline(() => {
          innerRan = true;
        }, 1000);
      } catch (e) {
        inner = e;
      }
      return 'outer done';
    }, 1000);
    expect(r).toBe('outer done');
    expect(innerRan).toBe(false);
    expect(inner).toBeInstanceOf(NestedDeadlineError);
    // and the refusal left nothing behind: the next call runs
    expect(runWithDeadline(() => 'next', 1000)).toBe('next');
  });

  it('refuses a deadline that is not a positive finite number, and a non-function', () => {
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => runWithDeadline(() => 1, ms)).toThrow(RangeError);
    expect(() => runWithDeadline(undefined as unknown as () => number, 10)).toThrow(TypeError);
    // Rounded up to the vm's 1 ms minimum (a vm `timeout` of 0 is Node's own RangeError). A loaded worker can let 1 ms
    // pass before `run()` starts, so a timeout is accepted too: the point is that the fraction is not refused.
    let fraction: unknown;
    try {
      fraction = runWithDeadline(() => 'fraction', 0.4);
    } catch (e) {
      fraction = e;
    }
    if (fraction !== 'fraction') expect(isDeadlineExceeded(fraction)).toBe(true);
  });
});

describe('#827 the runner is overridable in tests, and a simulated timeout reads as one', () => {
  it('overrideDeadlineForTests swaps the runner and its restore puts the vm one back', () => {
    const restore = overrideDeadlineForTests(() => {
      throw deadlineExceeded(5);
    });
    try {
      let err: unknown;
      try {
        runWithDeadline(() => 1, 5);
      } catch (e) {
        err = e;
      }
      expect(isDeadlineExceeded(err)).toBe(true);
    } finally {
      restore();
    }
    expect(runWithDeadline(() => 7, 100)).toBe(7);
    expect(vmRunWithDeadline(() => 8, 100)).toBe(8);
  });

  it('refuses to override outside jest', () => {
    const id = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;
    try {
      expect(() => overrideDeadlineForTests(() => undefined as never)).toThrow(/jest only/);
    } finally {
      process.env.JEST_WORKER_ID = id;
    }
  });

  it('isDeadlineExceeded reads only the code', () => {
    expect(isDeadlineExceeded(deadlineExceeded(1))).toBe(true);
    expect(isDeadlineExceeded(Object.assign(new Error('x'), { code: 'ERR_OTHER' }))).toBe(false);
    for (const v of [null, undefined, 'ERR_SCRIPT_EXECUTION_TIMEOUT', 1]) expect(isDeadlineExceeded(v)).toBe(false);
  });
});
