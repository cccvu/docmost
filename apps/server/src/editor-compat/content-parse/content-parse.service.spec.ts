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
  ContentParseBusyException,
  ContentParsePool,
  ContentTooComplexException,
  type ContentParseLimits,
  type SpawnWorker,
} from './content-parse.service';

const FIXTURE = path.join(__dirname, '__fixtures__', 'scripted.worker.cjs');

const LIMITS: ContentParseLimits = { deadlineMs: 400, waitMs: 2_000, memoryMb: 64, maxNodes: 100, startupMs: 5_000 };

/** A pool over the fixture that counts how many workers it started. */
const makePool = (limits: Partial<ContentParseLimits> = {}, mode = 'normal') => {
  const spawned: Worker[] = [];
  const spawn: SpawnWorker = (memoryMb) => {
    const w = new Worker(FIXTURE, { workerData: { mode }, resourceLimits: { maxOldGenerationSizeMb: memoryMb } });
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

  it('forgets a principal once it has nothing queued or running (no per-principal state leaks)', async () => {
    const { pool } = track(makePool());
    await Promise.all([pool.parse('a', 'html', 'user:A'), pool.parse('b', 'html', 'user:B')]);
    await pool.parse('crash', 'html', 'user:C').catch(() => undefined);
    expect((pool as unknown as { principals: Map<string, unknown> }).principals.size).toBe(0);
  });
});
