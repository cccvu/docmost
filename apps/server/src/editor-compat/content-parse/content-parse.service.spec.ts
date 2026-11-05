/**
 * #626: the bounds around untrusted-content conversion, tested against a scripted fixture worker (no parsers
 * loaded) so each failure mode is deterministic. The real worker is covered in content-parse.real-worker.spec.ts.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/editor-compat …`).
 */
import * as path from 'node:path';
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
  requestQueue,
  userConversionKey,
  type ContentParseLimits,
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
};

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
    await expect(pool.parse('a', 'html', 'user:1')).resolves.toEqual({ type: 'doc', label: 'a' });
    await expect(pool.parse('b', 'markdown', 'user:1')).resolves.toEqual({ type: 'doc', label: 'b' });
    await expect(pool.toHtml('c', 'user:2')).resolves.toBe('<p>c</p>');
    expect(spawned).toHaveLength(1);
  });

  it('Markdown → HTML: `maxChars` lowers the cap for one call (→ 422), and never raises it past the limit', async () => {
    const { pool } = track(makePool({ maxChars: 100 }));
    const md = (n: number) => 'x'.repeat(n); // the fixture answers `<p>${md}</p>`: n + 7 characters
    await expect(pool.toHtml(md(23), 'user:1', undefined, 30)).resolves.toBe(`<p>${md(23)}</p>`);
    await expect(pool.toHtml(md(24), 'user:1', undefined, 30)).rejects.toBeInstanceOf(ContentTooComplexException);
    await expect(pool.toHtml(md(93), 'user:1')).resolves.toBe(`<p>${md(93)}</p>`); // the limit, by default
    await expect(pool.toHtml(md(94), 'user:1', undefined, 10_000)).rejects.toBeInstanceOf(ContentTooComplexException);
  });

  it('content that does not convert is 400 "Invalid content format" (as before)', async () => {
    const { pool } = track(makePool());
    const err = await pool.parse('invalid', 'html', 'user:1').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Invalid content format');
  });

  it('too many nodes (or nesting too deep) is 422 content_too_complex', async () => {
    const { pool } = track(makePool());
    const err = await pool.parse('too-complex', 'html', 'user:1').catch((e) => e);
    expect(err).toBeInstanceOf(ContentTooComplexException);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({ code: 'content_too_complex' });
  });
});

describe('#626 the bounds', () => {
  it('a conversion past the deadline is stopped (even a synchronous loop) → 422; the event loop never blocks; the next one gets a fresh worker', async () => {
    const { pool, spawned } = track(makePool());
    const started = Date.now();
    const hang = pool.parse('hang', 'html', 'user:1');
    const lag = await maxLoopLag(hang);
    await expect(hang).rejects.toBeInstanceOf(ContentTooComplexException);
    expect(Date.now() - started).toBeLessThan(LIMITS.deadlineMs + 3_000);
    expect(lag).toBeLessThan(200);
    await expect(pool.parse('after', 'html', 'user:1')).resolves.toEqual({ type: 'doc', label: 'after' });
    expect(spawned).toHaveLength(2);
  });

  it('a conversion that exhausts the heap cap kills only the worker → 422; this process carries on', async () => {
    const { pool, spawned } = track(makePool({ deadlineMs: 20_000 }));
    const err = await pool.parse('oom', 'html', 'user:1').catch((e) => e);
    expect(err).toBeInstanceOf(ContentTooComplexException);
    await expect(pool.parse('after', 'html', 'user:1')).resolves.toEqual({ type: 'doc', label: 'after' });
    expect(spawned).toHaveLength(2);
  }, 30_000);

  it('a worker that dies mid-conversion is 503 engine_busy (retryable), and is replaced', async () => {
    const { pool, spawned } = track(makePool());
    const err = await pool.parse('crash', 'html', 'user:1').catch((e) => e);
    expect(err).toBeInstanceOf(ContentParseBusyException);
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse()).toMatchObject({ code: 'engine_busy' });
    await expect(pool.parse('after', 'html', 'user:1')).resolves.toEqual({ type: 'doc', label: 'after' });
    expect(spawned).toHaveLength(2);
  });

  it.each([['never-ready'], ['throw-on-load']])(
    'a worker that cannot start (%s) fails closed with 503 — never a conversion on the main thread',
    async (mode) => {
      const { pool } = track(makePool({ startupMs: 300 }, mode));
      await expect(pool.parse('a', 'html', 'user:1')).rejects.toBeInstanceOf(ContentParseBusyException);
    },
  );
});

describe('#626 the worker is replaced whenever it is lost', () => {
  it('a worker that failed to start is dropped: the next conversion starts a new one and succeeds', async () => {
    const { pool, spawned } = track(makePool({ startupMs: 300 }, ['throw-on-load', 'normal']));
    await expect(pool.parse('a', 'html', 'user:1')).rejects.toBeInstanceOf(ContentParseBusyException);
    await expect(pool.parse('b', 'html', 'user:1')).resolves.toEqual({ type: 'doc', label: 'b' });
    expect(spawned).toHaveLength(2);
  });

  it('a worker that dies while idle is replaced, so the next conversion is not handed to a dead worker', async () => {
    const { pool, spawned } = track(makePool({ deadlineMs: 5_000 }));
    await pool.parse('a', 'html', 'user:1');
    await spawned[0].terminate();
    const started = Date.now();
    // Handed to the dead worker, this would wait out the deadline and answer a wrong 422.
    await expect(pool.parse('b', 'html', 'user:1')).resolves.toEqual({ type: 'doc', label: 'b' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(spawned).toHaveLength(2);
  });

  it('a worker killed by a job is replaced at once, before any next conversion asks for one', async () => {
    const { pool, spawned } = track(makePool());
    await expect(pool.parse('hang', 'html', 'user:1')).rejects.toBeInstanceOf(ContentTooComplexException);
    await until(() => spawned.length === 2);
  });
});

describe('#626 admission and fairness', () => {
  it('no turn within the wait budget → 503 engine_busy; nothing is queued behind it', async () => {
    const { pool } = track(makePool({ waitMs: 150, deadlineMs: 5_000 }));
    const long = pool.parse('sleep:800', 'html', 'user:A');
    const started = Date.now();
    await expect(pool.parse('b', 'html', 'user:B')).rejects.toBeInstanceOf(ContentParseBusyException);
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(long).resolves.toMatchObject({ type: 'doc' });
  });

  it("one principal's concurrent conversions wait for each other, so another principal is served in between", async () => {
    const { pool } = track(makePool({ deadlineMs: 5_000, waitMs: 5_000 }));
    const done: string[] = [];
    const a1 = pool.parse('sleep:200:a1', 'html', 'user:A').then(() => done.push('a1'));
    const a2 = pool.parse('sleep:200:a2', 'html', 'user:A').then(() => done.push('a2'));
    const a3 = pool.parse('sleep:200:a3', 'html', 'user:A').then(() => done.push('a3'));
    await new Promise((r) => setTimeout(r, 20)); // B arrives after all of A's are submitted
    const b = pool.parse('sleep:200:b', 'html', 'user:B').then(() => done.push('b'));
    await Promise.all([a1, a2, a3, b]);
    // Without the per-principal gate, B would wait behind all three of A's (FIFO on the worker).
    expect(done.indexOf('b')).toBeLessThan(done.indexOf('a3'));
    expect(done.indexOf('b')).toBe(1);
  });

  it('a batch queue may wait longer than a request: it is served where a request would get 503', async () => {
    const { pool } = track(makePool({ waitMs: 150, deadlineMs: 5_000 }));
    const long = pool.parse('sleep:800', 'html', 'user:A');
    await expect(pool.parse('b', 'html', 'user:B')).rejects.toBeInstanceOf(ContentParseBusyException);
    await expect(pool.parse('c', 'html', 'batch:file-task:1', 3_000)).resolves.toEqual({ type: 'doc', label: 'c' });
    await long;
  });

  it('forgets a principal once it has nothing queued or running (no per-principal state leaks)', async () => {
    const { pool } = track(makePool());
    await Promise.all([pool.parse('a', 'html', 'user:A'), pool.parse('b', 'html', 'user:B')]);
    await pool.parse('crash', 'html', 'user:C').catch(() => undefined);
    // C's turn is released once the replacement worker is ready (#642), then C is forgotten too.
    const principals = (pool as unknown as { principals: Map<string, unknown> }).principals;
    await until(() => principals.size === 0);
  });
});

describe('#642 one principal never causes another principal\'s 503', () => {
  it('the production limits: wait > deadline, and wait + a worker load (≤3.5 s) + deadline fits the 20 s relay', () => {
    const { waitMs, deadlineMs } = CONTENT_PARSE_LIMITS;
    expect(waitMs).toBeGreaterThan(deadlineMs);
    expect(waitMs + 3_500 + deadlineMs).toBeLessThan(20_000); // the platform's content-write relay timeout
  });

  it("a conversion that killed the worker keeps its principal's turn until the replacement is ready: a newcomer goes first", async () => {
    // The replacement loads for longer than the newcomer may wait.
    const { pool, spawned } = track(makePool({ deadlineMs: 300, waitMs: 500 }, ['normal', 'slow-ready:700']));
    await pool.parse('warm', 'html', 'user:A');
    const order: string[] = [];
    const a1 = pool.parse('hang', 'html', 'user:A').catch((e) => e);
    // A's next conversion is already waiting for A's turn (with a wait long enough to outlast the reload).
    const a2 = pool.parse('sleep:50', 'html', 'user:A', 5_000).then(() => order.push('a2'));
    await until(() => spawned.length === 2); // a1 was killed at the deadline; its replacement is loading
    const b = pool.parse('sleep:50', 'html', 'user:B').then(() => order.push('b'));
    await expect(a1).resolves.toBeInstanceOf(ContentTooComplexException);
    // Without the hold, a2 takes the free slot and waits out the load inside it, and b gets 503 behind it.
    await b;
    await a2;
    expect(order).toEqual(['b', 'a2']);
  });

  it('the killed conversion is answered at once, not after the reload', async () => {
    const { pool } = track(makePool({ deadlineMs: 300 }, ['normal', 'slow-ready:1500']));
    await pool.parse('warm', 'html', 'user:A');
    const started = Date.now();
    await expect(pool.parse('hang', 'html', 'user:A')).rejects.toBeInstanceOf(ContentTooComplexException);
    expect(Date.now() - started).toBeLessThan(1_200);
    // …and the principal is forgotten once the reload releases its turn.
    const principals = (pool as unknown as { principals: Map<string, unknown> }).principals;
    expect(principals.has('user:A')).toBe(true);
    await until(() => !principals.has('user:A'), 5_000);
  });

  it('a principal looping deadline-length conversions, with slow reloads, never gets a newcomer refused', async () => {
    const deadlineMs = 300;
    const { pool, spawned } = track(makePool({ deadlineMs, waitMs: 400 }, ['normal', 'slow-ready:250']));
    await pool.parse('warm', 'html', 'user:A');
    let stop = false;
    // A closed loop, three deep: every conversion runs to the deadline and kills the worker.
    const abuse = async () => {
      while (!stop) await pool.parse('hang', 'html', 'user:A', 5_000).catch(() => undefined);
    };
    const loops = [abuse(), abuse(), abuse()];
    const outcomes: string[] = [];
    const newcomer = (i: number) =>
      pool.parse('sleep:20', 'html', `user:N${i}`).then(
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
    const validation = await convertOnBehalfOf('U', async () => requestQueue());
    const zip = batchConversion('file-task:1', 'U');
    expect([validation.principal, zip.principal]).toEqual([direct, direct]);
    expect(validation.waitMs).toBe(CONTENT_PARSE_LIMITS.waitMs);
    expect(zip.waitMs).toBe(CONTENT_PARSE_LIMITS.batchWaitMs); // the import keeps its long wait

    const { pool } = track(makePool({ deadlineMs: 2_000, waitMs: 500 }));
    const u = [
      pool.parse('sleep:350', 'html', direct, 5_000),
      pool.parse('sleep:350', 'html', validation.principal, 5_000),
      pool.parse('sleep:350', 'html', zip.principal, 5_000),
    ];
    await new Promise((r) => setTimeout(r, 20));
    // Under three keys B would queue behind all three (1050 ms > its 500 ms wait).
    await expect(pool.parse('b', 'html', 'user:B')).resolves.toEqual({ type: 'doc', label: 'b' });
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
    await expect(pool.parse('hang', 'html', 'user:A')).rejects.toBeInstanceOf(
      ContentTooComplexException,
    );
    await until(() => spawned.length === 2);
    await pool.parse('warm', 'html', 'background'); // the replacement is ready, so its reload has been charged
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
    await pool.parse('warm', 'html', 'background');
    const hang = pool.parse('hang', 'html', 'user:A').catch((e) => e);
    await expect(hang).resolves.toBeInstanceOf(ContentTooComplexException);
    const afterRun = pool.budgetLeft('user:A');
    expect(afterRun).toBeLessThanOrEqual(10_000 - deadlineMs); // the conversion, to its kill
    await until(() => pool.budgetLeft('user:A') < afterRun - 100, 5_000); // + the ~150 ms reload
    expect(pool.budgetLeft('user:A')).toBeGreaterThan(
      10_000 - deadlineMs - 1_500,
    );
  });

  it('an ordinary conversion is charged its wall time; exempt keys are never charged', async () => {
    const { pool } = track(
      makePool({ budgetCapacityMs: 10_000, budgetRefillMsPerMinute: 0 }),
    );
    await pool.parse('sleep:120', 'html', 'user:A');
    expect(pool.budgetLeft('user:A')).toBeLessThanOrEqual(10_000 - 120);
    await pool.parse('sleep:120', 'html', 'background');
    await pool.parse('sleep:120', 'html', 'batch:file-task:1');
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
    await pool.parse('warm', 'html', 'background');
    await spend(pool, spawned);
    expect(pool.budgetLeft('user:A')).toBeLessThanOrEqual(0);

    const started = Date.now();
    const err = await pool.parse('sleep:10', 'html', 'user:A').catch((e) => e);
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
    await expect(pool.parse('b', 'html', 'user:B')).resolves.toEqual({
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
    await pool.parse('warm', 'html', 'background');
    await spend(pool, spawned);
    const debt = -pool.budgetLeft('user:A');
    const err = await pool.parse('x', 'html', 'user:A').catch((e) => e);
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
    await pool.parse('warm', 'html', 'background');
    await spend(pool, spawned);
    const err = await pool.parse('x', 'html', 'user:A').catch((e) => e);
    expect(err).toBeInstanceOf(ConversionBudgetExhaustedException);
    offset += err.retryAfterSeconds * 1000; // the time it was told to wait
    await expect(pool.parse('again', 'html', 'user:A')).resolves.toEqual({
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
    await pool.parse('warm', 'html', 'background');
    await spend(pool, spawned);
    expect(pool.budgetLeft('user:A')).toBeLessThanOrEqual(0);
    // Interactive: refused. Batch, same key, a wait longer than the refill: served once the bucket is positive.
    await expect(pool.parse('x', 'html', 'user:A')).rejects.toBeInstanceOf(
      ConversionBudgetExhaustedException,
    );
    await expect(
      pool.toHtml('imported', 'user:A', 5_000, undefined, true),
    ).resolves.toBe('<p>imported</p>');
  });

  it('a batch is gated once: admitted on its first conversion, its later ones are charged but never wait or fail', async () => {
    // The zip import converts inside its open transaction: a budget wait per page would hold it for minutes.
    const { pool, spawned } = track(
      makePool({
        deadlineMs: 200,
        budgetCapacityMs: 100,
        budgetRefillMsPerMinute: 600, // 0.01 worker-ms per ms: no refill fits a 5 s wait
      }),
    );
    await pool.parse('warm', 'html', 'background');
    const turn = batchConversion('file-task:1', 'A').budgetTurn!;
    expect(turn).toEqual({ admitted: false });
    await expect(pool.toHtml('first', 'user:A', 5_000, undefined, true, turn)).resolves.toBe('<p>first</p>');
    expect(turn.admitted).toBe(true);
    await spend(pool, spawned); // the same human's bucket is now empty, far past what a refill could cover
    offset += 5_000; // +50 ms of refill: off the -capacity floor, still empty, so the next charge is visible
    const left = pool.budgetLeft('user:A');
    expect(left).toBeLessThanOrEqual(0);
    // The same batch: converted at once, and charged.
    await expect(pool.toHtml('sleep:60:second', 'user:A', 5_000, undefined, true, turn)).resolves.toEqual({
      type: 'doc',
      label: 'second',
    });
    expect(pool.budgetLeft('user:A')).toBeLessThan(left - 30); // ~60 ms of worker time, less a 0.6 ms refill
    // Controls: a new batch (a second import) by the same human is gated again, and so is an interactive write.
    await expect(
      pool.toHtml('next import', 'user:A', 5_000, undefined, true, batchConversion('file-task:2', 'A').budgetTurn),
    ).rejects.toBeInstanceOf(ConversionBudgetExhaustedException);
    await expect(pool.parse('x', 'html', 'user:A')).rejects.toBeInstanceOf(ConversionBudgetExhaustedException);
  });

  it('debt is floored at -capacity: a large admitted batch locks its human out for at most one full refill', async () => {
    const { pool, spawned } = track(
      makePool({ deadlineMs: 200, budgetCapacityMs: 100, budgetRefillMsPerMinute: 600 }),
    );
    await pool.parse('warm', 'html', 'background');
    const turn = batchConversion('file-task:1', 'A').budgetTurn!;
    await expect(pool.toHtml('first', 'user:A', 5_000, undefined, true, turn)).resolves.toBe('<p>first</p>');
    await spend(pool, spawned); // ≥ 200 ms killed + the reload, charged to a 100 ms bucket
    for (let i = 0; i < 3; i++) {
      await pool.toHtml(`sleep:60:p${i}`, 'user:A', 5_000, undefined, true, turn); // ungated, charged
    }
    // Without the floor the debt would be ≥ 280 ms; with it, never below -capacity (less a sub-ms refill).
    expect(pool.budgetLeft('user:A')).toBeGreaterThanOrEqual(-100);
    expect(pool.budgetLeft('user:A')).toBeLessThan(-90);
  });

  it('a batch caller whose wait cannot cover the refill fails with the same 429', async () => {
    const { pool, spawned } = track(
      makePool({
        deadlineMs: 200,
        budgetCapacityMs: 100,
        budgetRefillMsPerMinute: 600,
      }), // 0.01 worker-ms per ms
    );
    await pool.parse('warm', 'html', 'background');
    await spend(pool, spawned);
    const started = Date.now();
    const err = await pool
      .toHtml('imported', 'user:A', 1_000, undefined, true)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConversionBudgetExhaustedException);
    expect(Date.now() - started).toBeLessThan(200); // decided up front, not after waiting out its batch wait
    expect(batchConversion('file-task:1', 'U').batch).toBe(true); // the zip import is a batch caller
    expect(requestQueue().batch).toBeUndefined(); // a request is not
  });

  it('idle keys do not accumulate: a bucket that has refilled is dropped (on read, and by the periodic sweep)', async () => {
    const { pool } = track(
      makePool({ budgetCapacityMs: 1_000, budgetRefillMsPerMinute: 60_000 }),
    );
    for (let i = 0; i < 20; i++)
      await pool.parse('sleep:5', 'html', `user:P${i}`);
    expect(pool.budgetKeys).toBe(20);
    offset += 61_000; // every bucket is full again, and the sweep is due
    await pool.parse('trigger', 'html', 'background'); // exempt: sweeps, charges nothing
    expect(pool.budgetKeys).toBe(0);
    // A full bucket read directly is dropped too.
    await pool.parse('sleep:5', 'html', 'user:Q');
    expect(pool.budgetKeys).toBe(1);
    offset += 2_000;
    expect(pool.budgetLeft('user:Q')).toBe(1_000);
    expect(pool.budgetKeys).toBe(0);
  });
});
