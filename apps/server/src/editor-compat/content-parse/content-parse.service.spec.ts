/**
 * #626: the bounds around untrusted-content conversion, tested against a scripted fixture worker (no parsers
 * loaded) so each failure mode is deterministic. The real worker is covered in content-parse.real-worker.spec.ts.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/editor-compat …`).
 */
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { BadRequestException } from '@nestjs/common';
import {
  batchConversion,
  CONTENT_PARSE_LIMITS,
  ContentParseBusyException,
  ContentParsePool,
  ContentTooComplexException,
  ConversionBudgetExhaustedException,
  convertOnBehalfOf,
  isBudgetExempt,
  isContentParseRefusal,
  humanConversionKey,
  identityConversionKey,
  requestQueue,
  userConversionKey,
  type BatchBudgetTurn,
  type ContentParseLimits,
  type ConversionQueue,
  type SpawnWorker,
} from './content-parse.service';

const FIXTURE = path.join(__dirname, '__fixtures__', 'scripted.worker.cjs');

const LIMITS: ContentParseLimits = {
  deadlineMs: 400,
  waitMs: 2_000,
  memoryMb: 64,
  maxNodes: 100,
  maxChars: 1_000,
  batchWaitMs: 5_000,
  startupMs: 5_000,
  // Out of the way of the #626/#642 admission specs; the budget has its own block below.
  budgetCapacityMs: 1e12,
  budgetRefillMsPerMinute: 1e12,
  batchOverdraftMs: 1e12,
  // #716: the small class is off here (no fixture input is empty); its own block below turns it on.
  smallInputBytes: 0,
  smallAgingMs: 400,
  // #716: no reload credit unless a spec turns it on (then a reload stops the waiters' clocks, capped per waiter).
  reloadCreditMs: 0,
};

/** #716 M9: an interactive queue (`waitMs` absent = the pool's own wait). */
const q = (principal: string, waitMs?: number): ConversionQueue => ({ principal, waitMs });
/** #716 M9: a batch queue always carries its turn; a fresh one when the caller has none. */
const bq = (principal: string, waitMs: number, budgetTurn: BatchBudgetTurn = { admitted: false, overdraftMs: 0 }): ConversionQueue => ({
  principal,
  waitMs,
  batch: true,
  budgetTurn,
});

/**
 * A pool over the fixture that counts how many workers it started. `mode` is the fixture's start-up behavior; a list
 * gives each successive worker its own (the last one repeats).
 */
const makePool = (limits: Partial<ContentParseLimits> = {}, mode: string | string[] = 'normal') => {
  const spawned: Worker[] = [];
  const modes = Array.isArray(mode) ? mode : [mode];
  const spawn: SpawnWorker = (memoryMb) => {
    const workerData = { mode: modes[Math.min(spawned.length, modes.length - 1)] };
    const w = new Worker(FIXTURE, { workerData, resourceLimits: { maxOldGenerationSizeMb: memoryMb } });
    spawned.push(w);
    return w;
  };
  return { pool: new ContentParsePool({ ...LIMITS, ...limits }, spawn), spawned };
};

/** The largest gap between main-thread timer ticks while `work` runs: how long the event loop was blocked. */
const maxLoopLag = async (work: Promise<unknown>): Promise<number> => {
  let last = Date.now();
  let worst = 0;
  const tick = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  try {
    await work.catch(() => undefined);
  } finally {
    clearInterval(tick);
  }
  return worst;
};

/** Resolves once `cond` holds, polling; rejects after `ms`. */
const until = async (cond: () => boolean, ms = 3_000): Promise<void> => {
  const by = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > by) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const pools: ContentParsePool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});
const track = <T extends { pool: ContentParsePool }>(t: T): T => {
  pools.push(t.pool);
  return t;
};

describe('#626 conversion results', () => {
  it('returns the worker result, and reuses one warm worker across conversions', async () => {
    const { pool, spawned } = track(makePool());
    await expect(pool.parse('a', 'html', q('user:1'))).resolves.toEqual({ type: 'doc', label: 'a' });
    await expect(pool.parse('b', 'markdown', q('user:1'))).resolves.toEqual({ type: 'doc', label: 'b' });
    await expect(pool.toHtml('c', q('user:2'))).resolves.toBe('<p>c</p>');
    expect(spawned).toHaveLength(1);
  });

  it('Markdown → HTML: `maxChars` lowers the cap for one call (→ 422), and never raises it past the limit', async () => {
    const { pool } = track(makePool({ maxChars: 100 }));
    const md = (n: number) => 'x'.repeat(n); // the fixture answers `<p>${md}</p>`: n + 7 characters
    await expect(pool.toHtml(md(23), q('user:1'), 30)).resolves.toBe(`<p>${md(23)}</p>`);
    await expect(pool.toHtml(md(24), q('user:1'), 30)).rejects.toBeInstanceOf(ContentTooComplexException);
    await expect(pool.toHtml(md(93), q('user:1'))).resolves.toBe(`<p>${md(93)}</p>`); // the limit, by default
    await expect(pool.toHtml(md(94), q('user:1'), 10_000)).rejects.toBeInstanceOf(ContentTooComplexException);
  });

  it('content that does not convert is 400 "Invalid content format" (as before)', async () => {
    const { pool } = track(makePool());
    const err = await pool.parse('invalid', 'html', q('user:1')).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Invalid content format');
  });

  it('too many nodes (or nesting too deep) is 422 content_too_complex', async () => {
    const { pool } = track(makePool());
    const err = await pool.parse('too-complex', 'html', q('user:1')).catch((e) => e);
    expect(err).toBeInstanceOf(ContentTooComplexException);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({ code: 'content_too_complex' });
  });
});

describe('#626 the bounds', () => {
  it('a conversion past the deadline is stopped (even a synchronous loop) → 422; the event loop never blocks; the next one gets a fresh worker', async () => {
    const { pool, spawned } = track(makePool());
    const started = Date.now();
    const hang = pool.parse('hang', 'html', q('user:1'));
    const lag = await maxLoopLag(hang);
    await expect(hang).rejects.toBeInstanceOf(ContentTooComplexException);
    expect(Date.now() - started).toBeLessThan(LIMITS.deadlineMs + 3_000);
    expect(lag).toBeLessThan(200);
    await expect(pool.parse('after', 'html', q('user:1'))).resolves.toEqual({ type: 'doc', label: 'after' });
    expect(spawned).toHaveLength(2);
  });

  it('a conversion that exhausts the heap cap kills only the worker → 422; this process carries on', async () => {
    const { pool, spawned } = track(makePool({ deadlineMs: 20_000 }));
    const err = await pool.parse('oom', 'html', q('user:1')).catch((e) => e);
    expect(err).toBeInstanceOf(ContentTooComplexException);
    await expect(pool.parse('after', 'html', q('user:1'))).resolves.toEqual({ type: 'doc', label: 'after' });
    expect(spawned).toHaveLength(2);
  }, 30_000);

  it('a worker that dies mid-conversion is 503 engine_busy (retryable), and is replaced', async () => {
    const { pool, spawned } = track(makePool());
    const err = await pool.parse('crash', 'html', q('user:1')).catch((e) => e);
    expect(err).toBeInstanceOf(ContentParseBusyException);
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse()).toMatchObject({ code: 'engine_busy' });
    await expect(pool.parse('after', 'html', q('user:1'))).resolves.toEqual({ type: 'doc', label: 'after' });
    expect(spawned).toHaveLength(2);
  });

  it.each([['never-ready'], ['throw-on-load']])(
    'a worker that cannot start (%s) fails closed with 503 — never a conversion on the main thread',
    async (mode) => {
      const { pool } = track(makePool({ startupMs: 300 }, mode));
      await expect(pool.parse('a', 'html', q('user:1'))).rejects.toBeInstanceOf(ContentParseBusyException);
    },
  );
});

describe('#626 the worker is replaced whenever it is lost', () => {
  it('a worker that failed to start is dropped: the next conversion starts a new one and succeeds', async () => {
    const { pool, spawned } = track(makePool({ startupMs: 300 }, ['throw-on-load', 'normal']));
    await expect(pool.parse('a', 'html', q('user:1'))).rejects.toBeInstanceOf(ContentParseBusyException);
    await expect(pool.parse('b', 'html', q('user:1'))).resolves.toEqual({ type: 'doc', label: 'b' });
    expect(spawned).toHaveLength(2);
  });

  it('a worker that dies while idle is replaced, so the next conversion is not handed to a dead worker', async () => {
    const { pool, spawned } = track(makePool({ deadlineMs: 5_000 }));
    await pool.parse('a', 'html', q('user:1'));
    await spawned[0].terminate();
    const started = Date.now();
    // Handed to the dead worker, this would wait out the deadline and answer a wrong 422.
    await expect(pool.parse('b', 'html', q('user:1'))).resolves.toEqual({ type: 'doc', label: 'b' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(spawned).toHaveLength(2);
  });

  it('a worker killed by a job is replaced at once, before any next conversion asks for one', async () => {
    const { pool, spawned } = track(makePool());
    await expect(pool.parse('hang', 'html', q('user:1'))).rejects.toBeInstanceOf(ContentTooComplexException);
    await until(() => spawned.length === 2);
  });
});

describe('#626 admission and fairness', () => {
  it('no turn within the wait budget → 503 engine_busy; nothing is queued behind it', async () => {
    const { pool } = track(makePool({ waitMs: 150, deadlineMs: 5_000 }));
    const long = pool.parse('sleep:800', 'html', q('user:A'));
    const started = Date.now();
    await expect(pool.parse('b', 'html', q('user:B'))).rejects.toBeInstanceOf(ContentParseBusyException);
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(long).resolves.toMatchObject({ type: 'doc' });
  });

  it("one principal's concurrent conversions wait for each other, so another principal is served in between", async () => {
    const { pool } = track(makePool({ deadlineMs: 5_000, waitMs: 5_000 }));
    const done: string[] = [];
    const a1 = pool.parse('sleep:200:a1', 'html', q('user:A')).then(() => done.push('a1'));
    const a2 = pool.parse('sleep:200:a2', 'html', q('user:A')).then(() => done.push('a2'));
    const a3 = pool.parse('sleep:200:a3', 'html', q('user:A')).then(() => done.push('a3'));
    await new Promise((r) => setTimeout(r, 20)); // B arrives after all of A's are submitted
    const b = pool.parse('sleep:200:b', 'html', q('user:B')).then(() => done.push('b'));
    await Promise.all([a1, a2, a3, b]);
    // Without the per-principal gate, B would wait behind all three of A's (FIFO on the worker).
    expect(done.indexOf('b')).toBeLessThan(done.indexOf('a3'));
    expect(done.indexOf('b')).toBe(1);
  });

  it('a batch queue may wait longer than a request: it is served where a request would get 503', async () => {
    const { pool } = track(makePool({ waitMs: 150, deadlineMs: 5_000 }));
    const long = pool.parse('sleep:800', 'html', q('user:A'));
    await expect(pool.parse('b', 'html', q('user:B'))).rejects.toBeInstanceOf(ContentParseBusyException);
    await expect(pool.parse('c', 'html', q('batch:file-task:1', 3_000))).resolves.toEqual({ type: 'doc', label: 'c' });
    await long;
  });

  it('forgets a principal once it has nothing queued or running (no per-principal state leaks)', async () => {
    const { pool } = track(makePool());
    await Promise.all([pool.parse('a', 'html', q('user:A')), pool.parse('b', 'html', q('user:B'))]);
    await pool.parse('crash', 'html', q('user:C')).catch(() => undefined);
    // C's turn is released once the replacement worker is ready (#642), then C is forgotten too.
    const principals = (pool as unknown as { principals: Map<string, unknown> }).principals;
    await until(() => principals.size === 0);
  });
});

describe('#642 one principal never causes another principal\'s 503', () => {
  it('the production limits: wait > deadline + lag, a reload is credited (≤3.5 s), and all of it fits the 20 s relay', () => {
    const { waitMs, deadlineMs, reloadCreditMs } = CONTENT_PARSE_LIMITS;
    // #716: a killed conversion holds the worker until its replacement is ready, and that reload stops the waiters'
    // clocks (credited up to reloadCreditMs), so the wait itself only has to cover one deadline-length conversion + lag.
    expect(reloadCreditMs).toBe(3_500);
    expect(waitMs).toBeGreaterThanOrEqual(deadlineMs + 1_000);
    expect(waitMs + deadlineMs).toBeLessThanOrEqual(15_000); // no reload: the pre-#716 worst case, not raised
    expect(waitMs + reloadCreditMs + deadlineMs).toBeLessThan(20_000); // with one reload: the relay's 20 s
  });

  it('#716: a reload is credited to the waiters — served, where without the credit the same wait is a 503', async () => {
    // A's conversion is killed at 300 ms and the replacement loads for 600 ms: B waits ~900 ms of wall time with a
    // 500 ms wait. Credited (cap 1 s): its clock stopped for the reload, so it is served.
    const credited = track(makePool({ deadlineMs: 300, waitMs: 500, reloadCreditMs: 1_000 }, ['normal', 'slow-ready:600']));
    await credited.pool.parse('warm', 'html', q('user:A'));
    const a = credited.pool.parse('hang', 'html', q('user:A')).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20)); // A holds the worker
    await expect(credited.pool.parse('sleep:10', 'html', q('user:B'))).resolves.toMatchObject({ type: 'doc' });
    await expect(a).resolves.toBeInstanceOf(ContentTooComplexException);
  });

  it('#716: the credit is capped per waiter (a reload longer than reloadCreditMs still counts the rest)', async () => {
    // Same, with a 100 ms cap: B's clock runs for 500 of the 600 ms reload → 300 + 500 > 500 → 503.
    const capped = track(makePool({ deadlineMs: 300, waitMs: 500, reloadCreditMs: 100 }, ['normal', 'slow-ready:600']));
    await capped.pool.parse('warm', 'html', q('user:A'));
    const a = capped.pool.parse('hang', 'html', q('user:A')).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    await expect(capped.pool.parse('sleep:10', 'html', q('user:B'))).rejects.toBeInstanceOf(ContentParseBusyException);
    await expect(a).resolves.toBeInstanceOf(ContentTooComplexException);
  });

  it("a conversion that killed the worker keeps its principal's turn until the replacement is ready: a newcomer goes first", async () => {
    // The replacement loads for 700 ms. #716: the newcomer now spends that reload inside its wait (the slot is held
    // until the replacement is ready), so its wait is sized to cover it: the bound the production limits pin.
    const { pool, spawned } = track(makePool({ deadlineMs: 300, waitMs: 1_500 }, ['normal', 'slow-ready:700']));
    await pool.parse('warm', 'html', q('user:A'));
    const order: string[] = [];
    const a1 = pool.parse('hang', 'html', q('user:A')).catch((e) => e);
    // A's next conversion is already waiting for A's turn (with a wait long enough to outlast the reload).
    const a2 = pool.parse('sleep:50', 'html', q('user:A', 5_000)).then(() => order.push('a2'));
    await until(() => spawned.length === 2); // a1 was killed at the deadline; its replacement is loading
    const b = pool.parse('sleep:50', 'html', q('user:B')).then(() => order.push('b'));
    await expect(a1).resolves.toBeInstanceOf(ContentTooComplexException);
    // Without the hold, a2 takes the slot ahead of b once the load is done, and b waits a whole extra conversion.
    await b;
    await a2;
    expect(order).toEqual(['b', 'a2']);
  });

  it('the killed conversion is answered at once, not after the reload', async () => {
    const { pool } = track(makePool({ deadlineMs: 300 }, ['normal', 'slow-ready:1500']));
    await pool.parse('warm', 'html', q('user:A'));
    const started = Date.now();
    await expect(pool.parse('hang', 'html', q('user:A'))).rejects.toBeInstanceOf(ContentTooComplexException);
    expect(Date.now() - started).toBeLessThan(1_200);
    // …and the principal is forgotten once the reload releases its turn.
    const principals = (pool as unknown as { principals: Map<string, unknown> }).principals;
    expect(principals.has('user:A')).toBe(true);
    await until(() => !principals.has('user:A'), 5_000);
  });

  it('a principal looping deadline-length conversions, with slow reloads, never gets a newcomer refused', async () => {
    const deadlineMs = 300;
    // #716: the reload is inside the newcomer's wait now, so the wait covers deadline + reload (300 + 250) with margin.
    const { pool, spawned } = track(makePool({ deadlineMs, waitMs: 900 }, ['normal', 'slow-ready:250']));
    await pool.parse('warm', 'html', q('user:A'));
    let stop = false;
    // A closed loop, three deep: every conversion runs to the deadline and kills the worker.
    const abuse = async () => {
      while (!stop) await pool.parse('hang', 'html', q('user:A', 5_000)).catch(() => undefined);
    };
    const loops = [abuse(), abuse(), abuse()];
    const outcomes: string[] = [];
    const newcomer = (i: number) =>
      pool.parse('sleep:20', 'html', q(`user:N${i}`)).then(
        () => 'ok',
        (e: Error) => e.constructor.name,
      );
    try {
      for (let i = 0; i < 5; i++) {
        // The worst moment: just after a kill, while the replacement loads.
        const killed = spawned.length;
        await until(() => spawned.length > killed, 5_000);
        outcomes.push(await newcomer(i));
      }
      for (let i = 5; i < 9; i++) {
        await new Promise((r) => setTimeout(r, 40 + 70 * (i - 5))); // other moments of the cycle
        outcomes.push(await newcomer(i));
      }
    } finally {
      stop = true;
      await Promise.all(loops);
    }
    expect(outcomes).toEqual(Array(9).fill('ok'));
  }, 30_000);

  it("one human's request, zip import and validate-content share ONE key: another principal waits behind one of them", async () => {
    const direct = userConversionKey('U');
    const validation = await convertOnBehalfOf(userConversionKey('U'), async () => requestQueue());
    const zip = batchConversion('file-task:1', 'U');
    expect([validation.principal, zip.principal]).toEqual([direct, direct]);
    expect(validation.waitMs).toBe(CONTENT_PARSE_LIMITS.waitMs);
    expect(zip.waitMs).toBe(CONTENT_PARSE_LIMITS.batchWaitMs); // the import keeps its long wait

    const { pool } = track(makePool({ deadlineMs: 2_000, waitMs: 500 }));
    const u = [
      pool.parse('sleep:350', 'html', q(direct, 5_000)),
      pool.parse('sleep:350', 'html', q(validation.principal, 5_000)),
      pool.parse('sleep:350', 'html', q(zip.principal, 5_000)),
    ];
    await new Promise((r) => setTimeout(r, 20));
    // Under three keys B would queue behind all three (1050 ms > its 500 ms wait).
    await expect(pool.parse('b', 'html', q('user:B'))).resolves.toEqual({ type: 'doc', label: 'b' });
    await Promise.all(u);
  });

  it('work no human started keeps its own key; a request with no actor and no named human is `background`', async () => {
    expect(batchConversion('file-task:1', null).principal).toBe('batch:file-task:1');
    expect(requestQueue().principal).toBe('background');
    expect((await convertOnBehalfOf(undefined, async () => requestQueue())).principal).toBe('background');
  });
});

/**
 * #642 worker-time budget. After the echo fix, one abuser looping deadline-length conversions still kept the single
 * worker busy back to back (7 s + kill + reload > the 8 s wait) and 35% of another person's small writes were refused
 * busy. Each human key now has a bucket of worker time; an empty one is refused at admission with 429 + Retry-After.
 * Real fixture workers; time past a refill is advanced by offsetting `Date.now` (worker threads do not run under fake
 * timers).
 */
describe('#642 the per-principal worker-time budget', () => {
  let offset = 0;
  beforeEach(() => {
    offset = 0;
    const realNow = Date.now.bind(Date);
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  });
  afterEach(() => jest.restoreAllMocks());

  /** Spend `user:A`'s budget with one conversion killed at the deadline; resolves once its reload is charged too. */
  const spend = async (pool: ContentParsePool, spawned: Worker[]) => {
    await expect(pool.parse('hang', 'html', q('user:A'))).rejects.toBeInstanceOf(
      ContentTooComplexException,
    );
    await until(() => spawned.length === 2);
    await pool.parse('warm', 'html', q('background')); // the replacement is ready, so its reload has been charged
  };

  it('the production budget: 30 s burst, 15 s a minute; a 1 MiB page every 20 s at the deadline-length worst case per minute fits', () => {
    expect(CONTENT_PARSE_LIMITS.budgetCapacityMs).toBe(30_000);
    expect(CONTENT_PARSE_LIMITS.budgetRefillMsPerMinute).toBe(15_000);
    // A legit heavy writer: ~1 MiB every 20 s at ≤4 s a conversion in production uses ≤12 s a minute.
    expect(3 * 4_000).toBeLessThan(
      CONTENT_PARSE_LIMITS.budgetRefillMsPerMinute,
    );
    // The burst holds at least four deadline-length conversions with a worst-case 3.5 s reload each.
    expect(CONTENT_PARSE_LIMITS.budgetCapacityMs).toBeLessThanOrEqual(
      4 * (CONTENT_PARSE_LIMITS.deadlineMs + 3_500),
    );
  });

  it('a killed conversion is charged up to its kill, and the reload it caused is charged once the worker is back', async () => {
    const deadlineMs = 200;
    const { pool, spawned } = track(
      makePool(
        { deadlineMs, budgetCapacityMs: 10_000, budgetRefillMsPerMinute: 0 },
        ['normal', 'slow-ready:150'],
      ),
    );
    await pool.parse('warm', 'html', q('background'));
    const hang = pool.parse('hang', 'html', q('user:A')).catch((e) => e);
    await expect(hang).resolves.toBeInstanceOf(ContentTooComplexException);
    const afterRun = pool.budgetLeft('user:A');
    expect(afterRun).toBeLessThanOrEqual(10_000 - deadlineMs); // the conversion, to its kill
    await until(() => pool.budgetLeft('user:A') < afterRun - 100, 5_000); // + the ~150 ms reload
    expect(pool.budgetLeft('user:A')).toBeGreaterThan(
      10_000 - deadlineMs - 1_500,
    );
  });

  /** Every main-thread setTimeout fires 50 ms early while `work` runs (a real one can fire ~1 ms early). */
  const withEarlyTimers = async <T>(work: () => Promise<T>): Promise<T> => {
    const real = global.setTimeout;
    const early = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        real(fn, Math.max(0, (ms ?? 0) - 50), ...args)) as typeof setTimeout);
    try {
      return await work();
    } finally {
      early.mockRestore();
    }
  };

  it('#734 a deadline timer that fires early re-arms: a conversion is never killed before its full deadline', async () => {
    // The kill timer is only honored if it re-checks the elapsed time (without the re-arm: killed and charged at
    // ~150 ms).
    const deadlineMs = 200;
    const { pool } = track(makePool({ deadlineMs, budgetCapacityMs: 10_000, budgetRefillMsPerMinute: 0 }));
    await pool.parse('warm', 'html', q('background'));
    const err = await withEarlyTimers(() => pool.parse('hang', 'html', q('user:A')).catch((e) => e));
    expect(err).toBeInstanceOf(ContentTooComplexException);
    expect(pool.budgetLeft('user:A')).toBeLessThanOrEqual(10_000 - deadlineMs);
  });

  it('#734 a conversion that replies after the kill timer re-armed keeps its worker: the re-armed timer is cleared', async () => {
    // Ordered by the event loop, not by a timing window: the kill timer's FIRST fire is forced to 0 ms (libuv runs
    // expired timers before it polls for the worker's reply), so it re-arms for the ~1 s left long before the 50 ms
    // reply is read, and the reply then lands with that re-armed timer pending.
    const deadlineMs = 1_000;
    const { pool, spawned } = track(makePool({ deadlineMs, budgetCapacityMs: 10_000, budgetRefillMsPerMinute: 0 }));
    await pool.parse('warm', 'html', q('background'));
    const real = global.setTimeout;
    let forced = false;
    const armedAfter: number[] = [];
    const spy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (!forced && ms === deadlineMs) {
          forced = true; // the kill timer's first arm fires at once
          return real(fn, 0, ...args);
        }
        if (forced) armedAfter.push(ms ?? 0);
        return real(fn, ms, ...args);
      }) as typeof setTimeout);
    try {
      await expect(pool.parse('sleep:50', 'html', q('user:A'))).resolves.toEqual({ type: 'doc', label: '' });
    } finally {
      spy.mockRestore();
    }
    expect(forced).toBe(true);
    expect(armedAfter.some((ms) => ms > deadlineMs - 100 && ms <= deadlineMs)).toBe(true); // it did re-arm
    await new Promise((r) => setTimeout(r, deadlineMs + 100)); // a leftover re-armed timer would have fired by now
    expect(spawned.length).toBe(1); // never discarded and replaced
    await expect(pool.parse('after', 'html', q('background'))).resolves.toEqual({ type: 'doc', label: 'after' });
  });

  it('#734 a wall clock that steps backward neither postpones the kill nor undercharges it: the deadline is monotonic', async () => {
    // ADR 0031: the deadline is the one bound on the single worker. Date.now() steps back 3 s just after dispatch
    // (an NTP/chrony step); a kill decided on it would land at ~3.2 s and hold the worker for everyone that long.
    // The step is taken when the kill timer is armed, i.e. after dispatch by construction, never on a timing guess.
    const deadlineMs = 200;
    const { pool } = track(makePool({ deadlineMs, budgetCapacityMs: 10_000, budgetRefillMsPerMinute: 0 }));
    await pool.parse('warm', 'html', q('background'));
    const real = global.setTimeout;
    const spy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (ms === deadlineMs && offset === 0) offset -= 3_000; // `offset` steers this describe's Date.now spy
        return real(fn, ms, ...args);
      }) as typeof setTimeout);
    const started = performance.now();
    let err: unknown;
    try {
      err = await pool.parse('hang', 'html', q('user:A')).catch((e) => e);
    } finally {
      spy.mockRestore();
    }
    const took = performance.now() - started;
    expect(offset).toBe(-3_000); // the step happened, mid-conversion
    expect(err).toBeInstanceOf(ContentTooComplexException);
    expect(took).toBeGreaterThanOrEqual(deadlineMs);
    expect(took).toBeLessThan(deadlineMs + 1_500); // a postponed kill takes ≥ 3.2 s
    expect(pool.budgetLeft('user:A')).toBeLessThanOrEqual(10_000 - deadlineMs); // charged its full deadline
  });

  it('an ordinary conversion is charged its wall time; exempt keys are never charged', async () => {
    const { pool } = track(
      makePool({ budgetCapacityMs: 10_000, budgetRefillMsPerMinute: 0 }),
    );
    await pool.parse('sleep:120', 'html', q('user:A'));
    expect(pool.budgetLeft('user:A')).toBeLessThanOrEqual(10_000 - 120);
    await pool.parse('sleep:120', 'html', q('background'));
    await pool.parse('sleep:120', 'html', q('batch:file-task:1'));
    expect(pool.budgetLeft('background')).toBe(10_000);
    expect(pool.budgetLeft('batch:file-task:1')).toBe(10_000);
    expect(
      isBudgetExempt('background') &&
        isBudgetExempt('batch:x') &&
        !isBudgetExempt('user:1'),
    ).toBe(true);
  });

  it('once over budget the abuser is refused at once with 429 conversion_budget_exhausted + Retry-After; another principal is admitted at once (no 503)', async () => {
    // 60 s a minute = 1 worker-ms per ms, so the debt of one ~200 ms kill + reload is a sub-second refill.
    const { pool, spawned } = track(
      makePool({
        deadlineMs: 200,
        waitMs: 400,
        budgetCapacityMs: 100,
        budgetRefillMsPerMinute: 60_000,
      }),
    );
    await pool.parse('warm', 'html', q('background'));
    await spend(pool, spawned);
    expect(pool.budgetLeft('user:A')).toBeLessThanOrEqual(0);

    const started = Date.now();
    const err = await pool.parse('sleep:10', 'html', q('user:A')).catch((e) => e);
    expect(Date.now() - started).toBeLessThan(100); // refused before it queues, never after a wait
    expect(err).toBeInstanceOf(ConversionBudgetExhaustedException);
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toMatchObject({
      code: 'conversion_budget_exhausted',
    });
    expect(err.getResponse().message).toMatch(
      /^this account is using the content converter heavily; retry in \d+ s$/,
    );
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(isContentParseRefusal(err)).toBe(true); // importers pass it on as is

    // B was never charged for A's use: admitted and served straight away.
    await expect(pool.parse('b', 'html', q('user:B'))).resolves.toEqual({
      type: 'doc',
      label: 'b',
    });
  });

  it('Retry-After is the whole seconds until the bucket is positive again, at least 1', async () => {
    const { pool, spawned } = track(
      makePool({
        deadlineMs: 200,
        budgetCapacityMs: 100,
        budgetRefillMsPerMinute: 6_000,
      }), // 0.1 worker-ms per ms
    );
    await pool.parse('warm', 'html', q('background'));
    await spend(pool, spawned);
    const debt = -pool.budgetLeft('user:A');
    const err = await pool.parse('x', 'html', q('user:A')).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionBudgetExhaustedException);
    // debt / 0.1 per ms → ms, rounded up to seconds (a few ms of real time may have refilled meanwhile).
    const expected = Math.ceil((debt * 10 + 1) / 1000);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(expected);
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(
      Math.max(1, expected - 1),
    );
  });

  it('the refill restores admission', async () => {
    const { pool, spawned } = track(
      makePool({
        deadlineMs: 200,
        budgetCapacityMs: 100,
        budgetRefillMsPerMinute: 6_000,
      }),
    );
    await pool.parse('warm', 'html', q('background'));
    await spend(pool, spawned);
    const err = await pool.parse('x', 'html', q('user:A')).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionBudgetExhaustedException);
    offset += err.retryAfterSeconds * 1000; // the time it was told to wait
    await expect(pool.parse('again', 'html', q('user:A'))).resolves.toEqual({
      type: 'doc',
      label: 'again',
    });
  });

  it('a batch caller (the zip import) waits for the refill within its batch wait instead of failing', async () => {
    const { pool, spawned } = track(
      makePool({
        deadlineMs: 200,
        budgetCapacityMs: 100,
        budgetRefillMsPerMinute: 60_000,
      }),
    );
    await pool.parse('warm', 'html', q('background'));
    await spend(pool, spawned);
    expect(pool.budgetLeft('user:A')).toBeLessThanOrEqual(0);
    // Interactive: refused. Batch, same key, a wait longer than the refill: served once the bucket is positive.
    await expect(pool.parse('x', 'html', q('user:A'))).rejects.toBeInstanceOf(
      ConversionBudgetExhaustedException,
    );
    await expect(
      pool.toHtml('imported', bq('user:A', 5_000)),
    ).resolves.toBe('<p>imported</p>');
  });

  it('a batch is gated once: admitted on its first conversion, its later ones are charged but never wait or fail', async () => {
    // The zip import converts inside its open transaction: a budget wait per page would hold it for minutes.
    // #716 I8: deterministic — no refill (exact charges) and a deadline far past every fixture sleep, so the CI
    // runner's timer stalls can no longer turn a 60 ms sleep into a deadline kill (the observed flake).
    const { pool } = track(makePool({ deadlineMs: 5_000, budgetCapacityMs: 200, budgetRefillMsPerMinute: 0 }));
    await pool.parse('warm', 'html', q('background'));
    const turn = batchConversion('file-task:1', 'A').budgetTurn;
    expect(turn).toEqual({ admitted: false, overdraftMs: 0 });
    await expect(pool.toHtml('first', bq('user:A', 5_000, turn))).resolves.toBe('<p>first</p>');
    expect(turn.admitted).toBe(true);
    // The same batch spends the human's bucket below zero: charged, never gated.
    // #734: 210 ms (was 250): still below zero, and 130 ms of slack before the next charge reaches the floor.
    await pool.toHtml('sleep:210:spend', bq('user:A', 5_000, turn));
    const left = pool.budgetLeft('user:A');
    expect(left).toBeLessThan(0);
    expect(left - 60).toBeGreaterThan(-200); // above the floor even after the next charge, so it is visible in full
    // The same batch: converted at once, and charged (a 60 ms fixture sleep is at least 60 ms of worker time: the
    // fixture's sleep never ends early by the pool's clock, #734).
    await expect(pool.toHtml('sleep:60:second', bq('user:A', 5_000, turn))).resolves.toEqual({
      type: 'doc',
      label: 'second',
    });
    expect(pool.budgetLeft('user:A')).toBeLessThanOrEqual(left - 60);
    // Controls: a new batch (a second import) by the same human is gated again, and so is an interactive write.
    await expect(
      pool.toHtml('next import', bq('user:A', 5_000, batchConversion('file-task:2', 'A').budgetTurn)),
    ).rejects.toBeInstanceOf(ConversionBudgetExhaustedException);
    await expect(pool.parse('x', 'html', q('user:A'))).rejects.toBeInstanceOf(ConversionBudgetExhaustedException);
  });

  it('debt is floored at -capacity: a large admitted batch locks its human out for at most one full refill', async () => {
    // #716 I8 (the flaky case seen in CI): a 200 ms deadline under 60 ms sleeps was killed by a stalled CI
    // timer. Now: a deadline 33× the sleeps, no refill, and an EXACT expectation.
    const { pool } = track(makePool({ deadlineMs: 5_000, budgetCapacityMs: 100, budgetRefillMsPerMinute: 0 }));
    await pool.parse('warm', 'html', q('background'));
    const turn = batchConversion('file-task:1', 'A').budgetTurn;
    await expect(pool.toHtml('first', bq('user:A', 5_000, turn))).resolves.toBe('<p>first</p>');
    for (let i = 0; i < 3; i++) {
      await pool.toHtml(`sleep:150:p${i}`, bq('user:A', 5_000, turn)); // ungated, charged: ≥ 450 ms in all
    }
    // Without the floor the debt would be ≤ -350 ms; with it, exactly -capacity.
    expect(pool.budgetLeft('user:A')).toBe(-100);
  });

  it('#716 I3: an admitted batch overdrawn past batchOverdraftMs is refused 429 before any more work', async () => {
    const { pool } = track(
      makePool({ deadlineMs: 5_000, budgetCapacityMs: 100, budgetRefillMsPerMinute: 0, batchOverdraftMs: 100 }),
    );
    await pool.parse('warm', 'html', q('background'));
    const turn = batchConversion('file-task:1', 'A').budgetTurn;
    await pool.toHtml('first', bq('user:A', 5_000, turn));
    // #734: 100 + 250 ms (was 150 + 150, which put the overdraft exactly on the 100 ms limit when the conversions
    // measured exactly their sleeps). The fixture's sleeps never end early by the pool's clock, so the overdraft is
    // ≥ 150 ms; and `a` leaves ~100 ms of slack before the floor for a late timer.
    await pool.toHtml('sleep:100:a', bq('user:A', 5_000, turn)); // to about 0: on the books, no overdraft yet
    expect(turn.overdraftMs).toBe(0);
    await pool.toHtml('sleep:250:b', bq('user:A', 5_000, turn)); // past the floor by ≥ 150 ms: the overdraft
    expect(turn.overdraftMs).toBeGreaterThan(100);
    const started = Date.now();
    const err = await pool.toHtml('sleep:2000:never', bq('user:A', 5_000, turn)).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionBudgetExhaustedException);
    expect(Date.now() - started).toBeLessThan(1_000); // refused up front: the 2 s conversion never ran
    expect(pool.budgetLeft('user:A')).toBe(-100); // and nothing more was charged
  });

  it('a batch caller whose wait cannot cover the refill fails with the same 429', async () => {
    const { pool, spawned } = track(
      makePool({
        deadlineMs: 200,
        budgetCapacityMs: 100,
        budgetRefillMsPerMinute: 600,
      }), // 0.01 worker-ms per ms
    );
    await pool.parse('warm', 'html', q('background'));
    await spend(pool, spawned);
    const started = Date.now();
    const err = await pool
      .toHtml('imported', bq('user:A', 1_000))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConversionBudgetExhaustedException);
    expect(Date.now() - started).toBeLessThan(200); // decided up front, not after waiting out its batch wait
    expect(batchConversion('file-task:1', 'U').batch).toBe(true); // the zip import is a batch caller
    expect(requestQueue().batch).toBeUndefined(); // a request is not
    // #716 M9: a batch queue without its turn does not compile (it would be gated on every conversion).
    // @ts-expect-error — `budgetTurn` is required on a batch queue
    const bad: ConversionQueue = { principal: 'user:A', waitMs: 1, batch: true };
    expect(bad.batch).toBe(true);
  });

  it('idle keys do not accumulate: a bucket that has refilled is dropped (on read, and by the periodic sweep)', async () => {
    const { pool } = track(
      makePool({ budgetCapacityMs: 1_000, budgetRefillMsPerMinute: 60_000 }),
    );
    for (let i = 0; i < 20; i++)
      await pool.parse('sleep:5', 'html', q(`user:P${i}`));
    expect(pool.budgetKeys).toBe(20);
    offset += 61_000; // every bucket is full again, and the sweep is due
    await pool.parse('trigger', 'html', q('background')); // exempt: sweeps, charges nothing
    expect(pool.budgetKeys).toBe(0);
    // A full bucket read directly is dropped too.
    await pool.parse('sleep:5', 'html', q('user:Q'));
    expect(pool.budgetKeys).toBe(1);
    offset += 2_000;
    expect(pool.budgetLeft('user:Q')).toBe(1_000);
    expect(pool.budgetKeys).toBe(0);
  });
});

describe('#716 M8/I6 the admission keys', () => {
  afterEach(() => jest.restoreAllMocks());

  it('M8: a request actor converts under userConversionKey, whatever its actorType says', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ClsServiceManager } = require('nestjs-cls');
    jest
      .spyOn(ClsServiceManager, 'getClsService')
      .mockReturnValue({ get: () => ({ actorType: 'api_key', actorId: 'U' }) } as never);
    expect(requestQueue().principal).toBe(userConversionKey('U'));
  });

  it('I6: an east-west human converts as their Docmost user, else their platform identity — never `background`', async () => {
    expect(humanConversionKey('U', 'I')).toBe('user:U'); // a provisioned human keeps their one key
    expect(humanConversionKey(undefined, 'I')).toBe(identityConversionKey('I'));
    expect(identityConversionKey('I')).toBe('identity:I');
    expect(humanConversionKey(null, null)).toBeUndefined();
    expect(isBudgetExempt(identityConversionKey('I'))).toBe(false); // their own bucket
    const named = await convertOnBehalfOf(humanConversionKey(undefined, 'I'), async () => requestQueue());
    expect(named.principal).toBe('identity:I');
  });

  it('budgetKey: admitted and charged under its own key, while the turn stays the principal', async () => {
    const { pool } = track(makePool({ budgetCapacityMs: 10_000, budgetRefillMsPerMinute: 0 }));
    await pool.parse('sleep:50', 'html', { principal: 'user:A', budgetKey: 'user:A:export' });
    expect(pool.budgetLeft('user:A')).toBe(10_000);
    expect(pool.budgetLeft('user:A:export')).toBeLessThanOrEqual(10_000 - 50);
  });
});

/**
 * #716 small interactive inputs: one worker (a second breaks the §27 memory budget), so fairness is a priority class.
 * Fixture inputs are classed by their byte length: `smallInputBytes: 12` makes 'sleep:20:s' (10 bytes) small and
 * anything padded past 12 bytes large.
 */
describe('#716 small interactive conversions', () => {
  const LARGE = (ms: number, tag: string) => `sleep:${ms}:${tag}-${'x'.repeat(16)}`;
  const SMALL = (ms: number, tag: string) => `sleep:${ms}:${tag}`;

  it('the production class: ≤ 32 KiB, priority only (no deadline or wait of its own), aging 3 s within a wait', () => {
    const { smallInputBytes, smallAgingMs, deadlineMs, waitMs, reloadCreditMs } = CONTENT_PARSE_LIMITS;
    expect(smallInputBytes).toBe(32 * 1024);
    expect(smallAgingMs).toBe(3_000);
    // #716 load run: a 3 s small deadline answered a 3.3 s 17 KB edit 422. A small input keeps the normal bounds.
    expect(CONTENT_PARSE_LIMITS).not.toHaveProperty('smallDeadlineMs');
    expect(CONTENT_PARSE_LIMITS).not.toHaveProperty('smallWaitMs');
    // Worst case, small or large: wait + a credited reload + the deadline stays inside the 20 s relay.
    expect(waitMs + reloadCreditMs + deadlineMs).toBeLessThan(20_000);
    // An aged large waiter + one small conversion of up to 4 s + lag still fits its own wait (reloads credited).
    expect(smallAgingMs + 4_000 + 1_000).toBeLessThanOrEqual(waitMs);
  });

  it('a small write is served ahead of a large one that queued before it', async () => {
    const { pool } = track(makePool({ smallInputBytes: 12, smallAgingMs: 2_000, deadlineMs: 5_000, waitMs: 5_000 }));
    const order: string[] = [];
    const running = pool.parse(LARGE(200, 'l1'), 'html', q('user:L1')).then(() => order.push('l1'));
    await new Promise((r) => setTimeout(r, 20)); // l1 holds the worker
    const l2 = pool.parse(LARGE(20, 'l2'), 'html', q('user:L2')).then(() => order.push('l2'));
    const s = pool.parse(SMALL(20, 's'), 'html', q('user:S')).then(() => order.push('s'));
    await Promise.all([running, l2, s]);
    expect(order).toEqual(['l1', 's', 'l2']);
  });

  it('aging: a large waiter that has waited smallAgingMs goes before a small one', async () => {
    const { pool } = track(makePool({ smallInputBytes: 12, smallAgingMs: 50, deadlineMs: 5_000, waitMs: 5_000 }));
    const order: string[] = [];
    const running = pool.parse(LARGE(400, 'l1'), 'html', q('user:L1')).then(() => order.push('l1'));
    await new Promise((r) => setTimeout(r, 20));
    const l2 = pool.parse(LARGE(20, 'l2'), 'html', q('user:L2')).then(() => order.push('l2'));
    const s = pool.parse(SMALL(20, 's'), 'html', q('user:S')).then(() => order.push('s'));
    await Promise.all([running, l2, s]);
    expect(order).toEqual(['l1', 'l2', 's']); // l2 waited ~380 ms ≥ 50 ms when l1 finished
  });

  it('a batch conversion is never small, however short its input', async () => {
    const { pool } = track(makePool({ smallInputBytes: 12, smallAgingMs: 2_000, deadlineMs: 5_000, waitMs: 5_000 }));
    const order: string[] = [];
    const running = pool.parse(LARGE(200, 'l1'), 'html', q('user:L1')).then(() => order.push('l1'));
    await new Promise((r) => setTimeout(r, 20));
    const b = pool.toHtml(SMALL(20, 'b'), bq('user:B', 5_000)).then(() => order.push('b'));
    const s = pool.parse(SMALL(20, 's'), 'html', q('user:S')).then(() => order.push('s'));
    await Promise.all([running, b, s]);
    expect(order).toEqual(['l1', 's', 'b']);
  });

  it('a small conversion slower than the aging bound but under the deadline succeeds (no deadline of its own)', async () => {
    const { pool } = track(makePool({ smallInputBytes: 12, smallAgingMs: 100, deadlineMs: 2_000 }));
    await expect(pool.parse(SMALL(400, 's'), 'html', q('user:S'))).resolves.toMatchObject({ type: 'doc' });
    // …and past the shared deadline it is 422 like any other conversion.
    const started = Date.now();
    await expect(pool.parse('hang', 'html', q('user:S'))).rejects.toBeInstanceOf(ContentTooComplexException);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  });

  it('the #716 load case at production bounds: a small input taking 3.3 s converts (it was a 422 at a 3 s deadline)', async () => {
    const { smallInputBytes, smallAgingMs, deadlineMs, waitMs } = CONTENT_PARSE_LIMITS;
    const { pool } = track(makePool({ smallInputBytes, smallAgingMs, deadlineMs, waitMs }));
    await expect(pool.parse(SMALL(3_300, 's17k'), 'html', q('user:S'))).resolves.toMatchObject({ type: 'doc' });
  }, 10_000);

  it('a deadline kill logs how late the main-thread timer fired (lateMs: the event loop\'s lag at that moment)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Logger } = require('@nestjs/common');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { pool } = track(makePool({ deadlineMs: 150 }));
      await expect(pool.parse('hang', 'html', q('user:S'))).rejects.toBeInstanceOf(ContentTooComplexException);
      const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith('CONTENT_PARSE_TOO_COMPLEX'));
      expect(line).toMatch(/^CONTENT_PARSE_TOO_COMPLEX reason=deadline lateMs=-?\d+ principal=user:S format=html bytes=4 /);
    } finally {
      warn.mockRestore();
    }
  });

  it('a small conversion waits no longer than a large one (the same waitMs: past it, 503)', async () => {
    const { pool } = track(makePool({ smallInputBytes: 12, smallAgingMs: 100, deadlineMs: 5_000, waitMs: 150 }));
    const running = pool.parse(LARGE(500, 'l1'), 'html', q('user:L1'));
    await new Promise((r) => setTimeout(r, 20));
    await expect(pool.parse(LARGE(10, 'l2'), 'html', q('user:L2'))).rejects.toBeInstanceOf(ContentParseBusyException);
    await expect(pool.parse(SMALL(10, 's'), 'html', q('user:S'))).rejects.toBeInstanceOf(ContentParseBusyException);
    await running;
  });

  it('the reload is counted inside the wait: the worker is handed on only once the replacement is ready', async () => {
    const { pool, spawned } = track(
      makePool({ smallInputBytes: 12, smallAgingMs: 100, deadlineMs: 100, waitMs: 300 }, ['normal', 'slow-ready:800']),
    );
    await pool.parse('warm', 'html', q('user:A'));
    const killed = pool.parse('hang', 'html', q('user:A')).catch((e) => e); // killed at the 100 ms deadline
    await until(() => spawned.length === 2); // the replacement is loading (800 ms > the 300 ms wait)
    const err = await pool.parse(SMALL(10, 's'), 'html', q('user:S')).catch((e) => e);
    expect(err).toBeInstanceOf(ContentParseBusyException); // the reload was spent inside its wait
    await expect(killed).resolves.toBeInstanceOf(ContentTooComplexException);
  });

  it('two small principals behind a killed conversion are both served within the wait (scaled bound)', async () => {
    // Bound: the running conversion + its reload + one small job per small principal ahead.
    const { pool, spawned } = track(
      makePool({ smallInputBytes: 12, smallAgingMs: 1_000, deadlineMs: 300, waitMs: 1_500 }, ['normal', 'slow-ready:300']),
    );
    await pool.parse('warm', 'html', q('user:A'));
    const killed = pool.parse(`hang:${'x'.repeat(16)}`, 'html', q('user:A')).catch((e) => e); // large: killed at 300 ms
    await new Promise((r) => setTimeout(r, 20));
    const s1 = pool.parse(SMALL(100, 's1'), 'html', q('user:S1'));
    const s2 = pool.parse(SMALL(100, 's2'), 'html', q('user:S2'));
    await expect(Promise.all([s1, s2])).resolves.toHaveLength(2);
    await expect(killed).resolves.toBeInstanceOf(ContentTooComplexException);
    expect(spawned.length).toBe(2);
  });
});
