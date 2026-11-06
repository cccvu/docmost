/**
 * #716 — export serialization in the conversion worker: the pool's `serialize` op, its lane of one, its class (never
 * small/urgent) and its budget key. Against the scripted fixture worker (`__fixtures__/scripted.worker.cjs`), so the
 * order of completions is the worker's own (one job at a time); the real worker's output is pinned in
 * content-parse.real-worker.spec.ts. Gated (src/editor-compat).
 */
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { InternalServerErrorException, Logger } from '@nestjs/common';
import {
  ContentParsePool,
  ContentTooComplexException,
  type ContentParseLimits,
  type ConversionQueue,
  type SpawnWorker,
} from './content-parse.service';

const FIXTURE = path.join(__dirname, '__fixtures__', 'scripted.worker.cjs');

const LIMITS: ContentParseLimits = {
  deadlineMs: 2_000,
  waitMs: 5_000,
  memoryMb: 64,
  maxNodes: 100,
  maxChars: 1_000,
  batchWaitMs: 5_000,
  startupMs: 5_000,
  budgetCapacityMs: 1e9,
  budgetRefillMsPerMinute: 1,
  batchOverdraftMs: 1e9,
  smallInputBytes: 0, // per test
  smallAgingMs: 2_000,
  reloadCreditMs: 0,
};

const pools: ContentParsePool[] = [];
const makePool = (limits: Partial<ContentParseLimits> = {}) => {
  const spawn: SpawnWorker = (memoryMb) =>
    new Worker(FIXTURE, { workerData: { mode: 'normal' }, resourceLimits: { maxOldGenerationSizeMb: memoryMb } });
  const pool = new ContentParsePool({ ...LIMITS, ...limits }, spawn);
  pools.push(pool);
  return pool;
};
afterAll(() => Promise.all(pools.map((p) => p.close())));
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const q = (principal: string, budgetKey?: string): ConversionQueue => ({ principal, budgetKey });
/** A large write's content: long enough never to be small (the fixture reads only the `sleep:<ms>:<label>` prefix). */
const large = (ms: number, label: string) => `sleep:${ms}:${label}`.padEnd(2_048, ' ');

/** Run the jobs (started in this order, each after the previous has queued) and return their labels by completion. */
async function completionOrder(pool: ContentParsePool, jobs: Array<[string, () => Promise<unknown>]>): Promise<string[]> {
  const done: string[] = [];
  const all: Promise<unknown>[] = [];
  for (const [label, start] of jobs) {
    all.push(start().then(() => done.push(label)));
    // Let it reach its queue (admission, its own turn, the lane) before the next one starts.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  }
  await Promise.all(all);
  return done;
}

describe('ContentParsePool.serialize (#716)', () => {
  it('returns the worker’s serialization', async () => {
    const pool = makePool();
    await expect(pool.serialize({ script: 'sleep:1:p' }, 'markdown', q('user:a'))).resolves.toBe('serialized:p');
  });

  it('stored content that does not serialize is 500 (the server’s fault), never the 400 "Invalid content format"', async () => {
    const pool = makePool();
    await expect(pool.serialize({ script: 'invalid' }, 'html', q('user:a'))).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(pool.serialize({ script: 'too-complex' }, 'html', q('user:a'))).rejects.toBeInstanceOf(ContentTooComplexException);
    // A failure releases the lane: the next serialization runs.
    await expect(pool.serialize({ script: 'sleep:1:next' }, 'html', q('user:a'))).resolves.toBe('serialized:next');
  });

  it('a write waits behind at most ONE serialization, however many are queued (the lane of one)', async () => {
    const pool = makePool();
    await pool.parse('sleep:1:warm', 'html', q('user:warm')); // a loaded worker, so the order is the queue's alone
    const order = await completionOrder(pool, [
      ['A write', () => pool.parse(large(150, 'a'), 'html', q('user:a'))],
      ['B export', () => pool.serialize({ script: 'sleep:50:b' }, 'markdown', q('user:b', 'user:b:export'))],
      ['C export', () => pool.serialize({ script: 'sleep:50:c' }, 'markdown', q('user:c', 'user:c:export'))],
      ['D write', () => pool.parse(large(10, 'd'), 'html', q('user:d'))],
    ]);
    // Without the lane the worker's queue is B, C, D: the write would wait out both exports.
    expect(order).toEqual(['A write', 'B export', 'D write', 'C export']);
  });

  it('is never small/urgent, however tiny: a small write queued after it goes first', async () => {
    const pool = makePool({ smallInputBytes: 64 });
    await pool.parse('sleep:1:warm', 'html', q('user:warm'));
    const order = await completionOrder(pool, [
      ['A write', () => pool.parse(large(150, 'a'), 'html', q('user:a'))],
      ['B export', () => pool.serialize({ script: 'sleep:10:b' }, 'markdown', q('user:b', 'user:b:export'))],
      ['C small', () => pool.parse('sleep:10:c', 'html', q('user:c'))], // ≤ 64 bytes: urgent
    ]);
    expect(order).toEqual(['A write', 'C small', 'B export']);
  });

  it('charges its own budget key (`user:<id>:export`), never the human’s write bucket; the turn is still theirs', async () => {
    const pool = makePool();
    await pool.serialize({ script: 'sleep:80:b' }, 'markdown', q('user:b', 'user:b:export'));
    expect(pool.budgetLeft('user:b:export')).toBeLessThan(LIMITS.budgetCapacityMs);
    expect(pool.budgetLeft('user:b')).toBe(LIMITS.budgetCapacityMs);
  });
});
