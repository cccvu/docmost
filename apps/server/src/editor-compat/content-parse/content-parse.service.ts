/**
 * #626 — convert untrusted HTML/Markdown to ProseMirror JSON OFF the event loop, inside fixed bounds.
 *
 * Fork-owned. Every write that carries HTML or Markdown (`/api/pages/*` content writes, the `/v1` and MCP page tools
 * relayed to them, validate-content, and both importers) converts it here. The conversion itself is unchanged
 * (`content-parse.worker.ts` runs `markdownToHtml` → `htmlToJson`), but it runs in ONE persistent worker thread,
 * because on the main thread its cost is unbounded: happy-dom spends ~0.1–0.3 ms and ~5–8 KB of heap per element, so
 * 1 MiB of plain block markup blocked the event loop for 8–130 s, or exhausted its heap (see ADR 0031).
 *
 * Bounds (CONTENT_PARSE_LIMITS), all fail-closed; nothing ever falls back to a parse on the main thread:
 *   - admission: one conversion at a time (`slot`), and at most ONE per principal queued or running (`principals`),
 *     so a principal's concurrent writes wait for each other and can never fill the queue ahead of everyone else.
 *     No slot within `waitMs` → 503 `engine_busy` (retryable; the content was not applied). A principal is a HUMAN
 *     (`user:<id>`) wherever one is known: their requests, the zip imports they start (`batchConversion`, which may
 *     wait `batchWaitMs`) and the platform's validate-content on their behalf all share that one key (#642).
 *   - fairness (#642): `waitMs` > `deadlineMs`, and a principal whose conversion killed the worker keeps its own turn
 *     until the replacement worker is ready, so one principal can delay another by at most one conversion, never
 *     past its wait.
 *   - `deadlineMs` from dispatch, enforced with `terminate()` (it stops a synchronous parse; a Promise race cannot),
 *     `memoryMb` heap via `resourceLimits`, and `maxNodes` nodes / `maxChars` characters in the result → 422
 *     `content_too_complex` (not retryable unchanged). A killed worker is replaced at once, not on the next job.
 *   - a worker that crashes or cannot start → 503 `engine_busy`, logged as an error.
 *   - budget (#642): each human's key has a token bucket of WORKER time (`budgetCapacityMs`, refilled at
 *     `budgetRefillMsPerMinute`), charged on settle with the conversion's wall time — a killed one up to its kill — plus
 *     the reload it caused. A key whose bucket is empty (≤ 0) is refused at admission, before it queues: 429
 *     `conversion_budget_exhausted` with the seconds until it is positive again. A batch caller (`batchConversion`)
 *     is admitted ONCE, on its first conversion, where it waits for the refill within its batch wait instead; its
 *     later conversions are charged but never gated, because the zip import converts inside its open transaction and
 *     a budget wait there would hold the connection and the inserted rows (one turn at a time still applies).
 *     Actorless keys (`background`, `batch:<id>`) are exempt.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { OpSemaphore, OpSemaphoreTimeout } from '../../authz/page-write/op-semaphore';
import { AUDIT_CONTEXT_KEY, type AuditContext } from '../../common/middlewares/audit-context.middleware';
import type { ParseFormat, ParseReply, ParseRequest, WorkerMessage } from './content-parse.worker';

export type { ParseFormat } from './content-parse.worker';

export interface ContentParseLimits {
  /** Wall-clock limit for one conversion, from the moment it is handed to a ready worker. */
  deadlineMs: number;
  /** How long a request may wait for its turn (its own earlier conversion, then the worker), in total. */
  waitMs: number;
  /** The worker's old-generation heap cap. */
  memoryMb: number;
  /** The most nodes a converted document may have. */
  maxNodes: number;
  /** The most characters a result may carry: every string in the JSON, or the HTML of a Markdown → HTML conversion. */
  maxChars: number;
  /** How long work with no request actor (a queue job, not a caller waiting on a response) may wait for its turn. */
  batchWaitMs: number;
  /** How long a fresh worker may take to load the parsers. */
  startupMs: number;
  /** #642: a human key's bucket of worker time, in ms: how much it may use in a burst. */
  budgetCapacityMs: number;
  /** #642: worker ms a key's bucket regains per minute: its sustained share of the one worker. */
  budgetRefillMsPerMinute: number;
}

/**
 * Measured on a dev laptop; production (Graviton ARM64) is estimated ~2–2.5× slower single-threaded (ADR 0031):
 *   - deadline 7 s: ~1 MiB of real Markdown (1.28 Mi characters of HTML, 42k nodes) converts in ~0.56 s here with
 *     happy-dom 21 (it was ~2.0 s on 20.8.9, which re-parsed every CSS selector on every match), so ≤~1.4 s in
 *     production at idle. Past it is 422 `content_too_complex`.
 *   - wait 8 s, longer than the deadline (#642): a principal is admitted behind at most one conversion of each
 *     principal ahead of it, and a killed conversion's principal waits out the worker's reload (`convert`), so one
 *     principal looping deadline-length conversions can never make another wait past this. Wait + a worker load
 *     (~0.5–3.5 s) + deadline ≤ 18.5 s stays under the platform's 20 s content-write relay timeout.
 *   - heap 1 GiB: that page needs ~384 MB; dense 1 MiB markup (99k nodes) 768 MB. The task has 4 GB (ADR 0031), and
 *     this must equal docmost's process-wide `--max-old-space-size` (check-infra-config §27 reads it from here).
 *   - nodes 100k: dense 1 MiB markup is 99k nodes, the real 1.25 MiB page 61k. It bounds what the main thread does
 *     with the result (clone, validation, Yjs: ~3 µs a node), independently of how fast the parser is.
 *   - characters 8 Mi: what the node cap cannot bound, one long string repeated in many nodes (a Markdown reference
 *     definition, an `<a href>` around many blocks), which ~200 KiB of input expanded to a 286 MiB result and 1–5 GB
 *     on the main thread. Real content carries ~1.3–1.7 characters of strings per input character (the repo's own
 *     docs: 1.31 MiB of Markdown → 1.68 Mi), so a 1 MiB body stays ≤~2 Mi; input that would reach 8 Mi does not
 *     convert within the deadline anyway.
 *   - batch wait 60 s: a zip import converts every page inside one transaction with no retry, so one busy answer
 *     failed the whole import. Nobody waits on a response for it, and the worker is ~one job per principal away.
 *   - budget 30 s, refilled 15 s a minute (#642): the fairness rerun after the echo fix had one abuser looping
 *     deadline-length conversions on the single worker (7 s + kill + reload > the 8 s wait), and 35% of a second
 *     person's small writes were refused busy. 15 s a minute is a quarter of the worker per human, sustained; the 30 s
 *     burst is four deadline-length conversions with their reloads. A legitimate heavy writer — a ~1 MiB page every
 *     20 s at ~1.4–4 s a conversion — uses 4–12 s a minute and is never refused. An abuser, once spent, gets ~one
 *     deadline-length conversion every 40 s, so the worker is free for everyone else most of the time.
 */
export const CONTENT_PARSE_LIMITS: Readonly<ContentParseLimits> = Object.freeze({
  deadlineMs: 7_000,
  waitMs: 8_000,
  memoryMb: 1024,
  maxNodes: 100_000,
  maxChars: 8 * 1024 * 1024,
  batchWaitMs: 60_000,
  startupMs: 30_000,
  budgetCapacityMs: 30_000,
  budgetRefillMsPerMinute: 15_000,
});

/** 422: the content is beyond what one write may convert. Deterministic for the same content: split it, never retry. */
export class ContentTooComplexException extends UnprocessableEntityException {
  constructor() {
    super({
      message:
        'The content is too large or complex to convert in one write, so it was not applied. ' +
        'Split it into smaller pages, or add it in parts with append.',
      code: 'content_too_complex',
    });
  }
}

/** 503: no conversion could run in time (or the worker is down). The content was not applied; retry shortly. */
export class ContentParseBusyException extends ServiceUnavailableException {
  constructor() {
    super({ message: 'the wiki engine is busy converting content; the content was not applied — retry shortly', code: 'engine_busy' });
  }
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

/** A conversion refused on its bounds (422), its capacity (503) or its budget (429) — passed on as is, never relabeled. */
export function isContentParseRefusal(
  err: unknown,
): err is ContentTooComplexException | ContentParseBusyException | ConversionBudgetExhaustedException {
  return (
    err instanceof ContentTooComplexException ||
    err instanceof ContentParseBusyException ||
    err instanceof ConversionBudgetExhaustedException
  );
}

/** #642: keys with no human behind them share no budget — actorless requests and imports nobody started. */
export function isBudgetExempt(principal: string): boolean {
  return principal === 'background' || principal.startsWith('batch:');
}

/** How often idle (full) buckets are swept, at most. Buckets are also dropped whenever they are read full. */
const BUDGET_PRUNE_EVERY_MS = 60_000;

export type SpawnWorker = (memoryMb: number) => Worker;

const COMPILED_WORKER = path.join(__dirname, 'content-parse.worker.js');
const SOURCE_WORKER = path.join(__dirname, 'content-parse.worker.ts');

/** The real worker: the compiled file beside this one, or — running from TypeScript sources (jest) — via ts-node. */
export const spawnContentParseWorker: SpawnWorker = (memoryMb) => {
  // stackSizeMb 1 ≈ the main thread's own stack (a worker's default is 4). Nesting that overflowed the main thread
  // still fails fast (→ 422) instead of recursing 4× deeper into parse work that grows with the square of the depth:
  // 10 KB of nested Markdown quotes held a 4 MB-stack worker past its deadline.
  const resourceLimits = { maxOldGenerationSizeMb: memoryMb, stackSizeMb: 1 };
  if (fs.existsSync(COMPILED_WORKER)) return new Worker(COMPILED_WORKER, { resourceLimits });
  // No compiled worker: this is `src`, not `dist`. Compile it on the fly, as `pnpm test:debug` runs the server.
  const project = path.resolve(__dirname, '../../../tsconfig.json');
  return new Worker(
    `require('ts-node').register({ transpileOnly: true, project: ${JSON.stringify(project)} });` +
      `require('tsconfig-paths/register');` +
      `require(${JSON.stringify(SOURCE_WORKER)});`,
    { eval: true, resourceLimits, env: { ...process.env, TS_NODE_PROJECT: project } },
  );
};

/** `Omit` applied to each member of a union (plain `Omit` would merge them). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What happened to one conversion: the worker's reply, or what the parent saw instead. */
type Outcome = ParseReply | { ok: false; reason: 'deadline' | 'heap' | 'crashed' | 'unavailable' };

/** One conversion's outcome, its own time, and — when it cost the worker — the replacement's load. */
interface Run {
  outcome: Outcome;
  ms: number;
  /** Set when this conversion killed or lost the worker: settles once the replacement is ready (or failed to start). */
  reload: Promise<unknown> | null;
}

export class ContentParsePool {
  private readonly logger = new Logger('ContentParse');
  /** The one worker: one conversion at a time. */
  private readonly slot: OpSemaphore;
  /** One conversion queued or running per principal. Entries are dropped when idle. */
  private readonly principals = new Map<string, OpSemaphore>();
  /** #642: worker-time buckets of the keys that are below capacity. A missing key is full. */
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private lastPrune = 0;
  private current: Worker | null = null;
  private starting: Promise<Worker> | null = null;
  private nextId = 1;

  constructor(
    private readonly limits: Readonly<ContentParseLimits> = CONTENT_PARSE_LIMITS,
    private readonly spawn: SpawnWorker = spawnContentParseWorker,
  ) {
    this.slot = new OpSemaphore(1, limits.waitMs);
  }

  /**
   * HTML or Markdown → ProseMirror JSON. `waitMs`: how long it may wait for its turn (default `limits.waitMs`).
   * `batch`: an empty budget is waited out within `waitMs` rather than refused (#642); with `turn`, only until the
   * batch's first admission (`BatchBudgetTurn`).
   */
  async parse(
    content: string,
    format: ParseFormat,
    principal: string,
    waitMs?: number,
    batch = false,
    turn?: BatchBudgetTurn,
  ): Promise<Record<string, unknown>> {
    const { maxNodes, maxChars } = this.limits;
    const req = { op: 'to-json', format, content, maxNodes, maxChars } as const;
    return (await this.convert(req, principal, `format=${format}`, waitMs, batch, turn)) as Record<string, unknown>;
  }

  /**
   * Markdown → HTML only (the importers rewrite the HTML before it is parsed). `maxChars` lowers the cap on the
   * HTML's length for this call (an importer bounds it by its own input cap); it never raises it past the limit.
   */
  async toHtml(
    markdown: string,
    principal: string,
    waitMs?: number,
    maxChars?: number,
    batch = false,
    turn?: BatchBudgetTurn,
  ): Promise<string> {
    const cap = Math.min(maxChars ?? this.limits.maxChars, this.limits.maxChars);
    const req = { op: 'markdown-to-html', content: markdown, maxChars: cap } as const;
    return (await this.convert(req, principal, 'op=markdown-to-html', waitMs, batch, turn)) as string;
  }

  /** #642: the key's worker-time left, in ms, refilled to now (may be negative). Drops a bucket that is full again. */
  budgetLeft(principal: string, now = Date.now()): number {
    const { budgetCapacityMs: cap, budgetRefillMsPerMinute: perMin } = this.limits;
    const b = this.buckets.get(principal);
    if (!b) return cap;
    const tokens = Math.min(cap, b.tokens + ((now - b.at) * perMin) / 60_000);
    if (tokens >= cap) {
      this.buckets.delete(principal);
      return cap;
    }
    b.tokens = tokens;
    b.at = now;
    return tokens;
  }

  /** How many keys hold a bucket below capacity (tests, diagnostics). */
  get budgetKeys(): number {
    return this.buckets.size;
  }

  /** #642: charge `ms` of worker time to the key (on settle). Exempt keys are never charged. */
  private charge(principal: string, ms: number): void {
    if (isBudgetExempt(principal) || !(ms > 0)) return;
    const now = Date.now();
    const tokens = this.budgetLeft(principal, now) - ms;
    this.buckets.set(principal, { tokens, at: now });
  }

  /** Sweep the buckets that have refilled, at most once a `BUDGET_PRUNE_EVERY_MS`, so idle keys do not accumulate. */
  private pruneBuckets(now: number): void {
    if (now - this.lastPrune < BUDGET_PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    for (const key of [...this.buckets.keys()]) this.budgetLeft(key, now);
  }

  /**
   * #642: admit the key only while its bucket is positive. Empty: an interactive caller is refused at once (429 with
   * the seconds until it is positive again); a batch caller waits for the refill if that fits in what is left of its
   * wait, else is refused the same way. A batch whose `turn` was already admitted is not gated at all (charged only).
   */
  private async admitBudget(
    principal: string,
    batch: boolean,
    left: () => number,
    context: string,
    turn?: BatchBudgetTurn,
  ): Promise<void> {
    if (isBudgetExempt(principal) || (batch && turn?.admitted)) return;
    const perMin = this.limits.budgetRefillMsPerMinute;
    for (;;) {
      const tokens = this.budgetLeft(principal);
      if (tokens > 0) return;
      // ms until the bucket is strictly positive again.
      const needMs = perMin > 0 ? Math.floor((-tokens * 60_000) / perMin) + 1 : Number.POSITIVE_INFINITY;
      if (batch && needMs <= left()) {
        await new Promise<void>((resolve) => setTimeout(resolve, needMs));
        continue;
      }
      const retryAfter = Number.isFinite(needMs) ? Math.max(1, Math.ceil(needMs / 1000)) : 60;
      this.logger.warn(
        `CONTENT_PARSE_BUDGET principal=${principal} ${context} budgetMs=${Math.round(tokens)}: worker-time budget spent; answered 429 conversion_budget_exhausted retryAfter=${retryAfter}`,
      );
      throw new ConversionBudgetExhaustedException(retryAfter);
    }
  }

  private async convert(
    req: DistributiveOmit<ParseRequest, 'id'>,
    principal: string,
    what: string,
    waitMs = this.limits.waitMs,
    batch = false,
    turn?: BatchBudgetTurn,
  ): Promise<unknown> {
    const bytes = Buffer.byteLength(String(req.content ?? ''), 'utf8');
    const admitBy = Date.now() + waitMs;
    const left = () => Math.max(0, admitBy - Date.now());
    const context = `${what} bytes=${bytes}`;
    this.pruneBuckets(Date.now());
    // #642: refused before it queues — an over-budget key never waits in line, nor holds its own turn.
    await this.admitBudget(principal, batch, left, context, turn);

    let own = this.principals.get(principal);
    if (!own) {
      own = new OpSemaphore(1, waitMs);
      this.principals.set(principal, own);
    }
    const forgetIfIdle = (sem: OpSemaphore) => {
      // Idle means nobody holds it and nobody waits (a release hands the slot to a waiter synchronously).
      if (sem.inUse === 0 && this.principals.get(principal) === sem) this.principals.delete(principal);
    };
    try {
      const releaseOwn = await own.acquire(left());
      let reload: Promise<unknown> | null = null;
      try {
        // Again once it is this key's turn: its own previous conversion (just settled) may have spent the budget.
        await this.admitBudget(principal, batch, left, context, turn);
        if (batch && turn) turn.admitted = true; // later conversions of this batch are charged, never gated
        const releaseSlot = await this.slot.acquire(left());
        try {
          const run = await this.run({ ...req, id: this.nextId++ } as ParseRequest);
          reload = run.reload;
          // #642: charged on settle — the conversion's own wall time (a killed one up to its kill)…
          this.charge(principal, run.ms);
          if (reload) {
            // …and the reload it caused, once the replacement worker is ready.
            const reloadFrom = Date.now();
            void reload.then(() => this.charge(principal, Date.now() - reloadFrom));
          }
          return this.settle(run.outcome, run.ms, `principal=${principal} ${what} bytes=${bytes} ms=${run.ms}`);
        } finally {
          releaseSlot();
        }
      } finally {
        if (reload) {
          // #642: this conversion cost the worker. Its principal keeps its own turn until the replacement is ready,
          // so the reload is spent by whoever took the slot meanwhile (outside their wait), never by this principal's
          // next conversion ahead of them. The answer itself is not held back.
          const sem = own;
          void reload.then(() => {
            releaseOwn();
            forgetIfIdle(sem);
          });
        } else {
          releaseOwn();
        }
      }
    } catch (err) {
      if (err instanceof OpSemaphoreTimeout) {
        this.logger.warn(
          `CONTENT_PARSE_BUSY principal=${principal} ${what} bytes=${bytes}: no conversion slot within ${waitMs} ms; answered 503 engine_busy`,
        );
        throw new ContentParseBusyException();
      }
      throw err;
    } finally {
      forgetIfIdle(own);
    }
  }

  /** Stop the worker (tests, shutdown). The next conversion starts a new one. */
  async close(): Promise<void> {
    const worker = this.current;
    this.current = null;
    this.starting = null;
    if (worker) await worker.terminate();
  }

  /** The caller's answer for one outcome. `context` is for logs only: sizes and ids, never content. */
  private settle(outcome: Outcome, ms: number, context: string): unknown {
    if (outcome.ok) {
      if (ms > this.limits.deadlineMs / 2) {
        this.logger.warn(`CONTENT_PARSE_SLOW ${context} nodes=${outcome.nodes ?? '-'}: over half the ${this.limits.deadlineMs} ms deadline`);
      }
      return outcome.result;
    }
    // Explicit: this project's non-strict compiler settings do not narrow on the `ok` literal.
    const failure = outcome as Exclude<Outcome, { ok: true }>;
    switch (failure.reason) {
      case 'invalid':
        throw new BadRequestException('Invalid content format');
      case 'too_complex':
      case 'deadline':
      case 'heap': {
        const why = failure.reason === 'too_complex' ? failure.detail : failure.reason;
        this.logger.warn(`CONTENT_PARSE_TOO_COMPLEX reason=${why} ${context}: answered 422 content_too_complex`);
        throw new ContentTooComplexException();
      }
      case 'crashed':
        this.logger.error(`CONTENT_PARSE_WORKER_CRASHED ${context}: answered 503 engine_busy; the next conversion starts a new worker`);
        throw new ContentParseBusyException();
      case 'unavailable': // already logged as CONTENT_PARSE_WORKER_START_FAILED
        throw new ContentParseBusyException();
    }
  }

  /**
   * Hand one request to the (started) worker and wait for its reply, the deadline, or the worker's death. `ms` is
   * the conversion's own time, from dispatch: loading a new worker counts toward neither it nor the deadline.
   */
  private async run(req: ParseRequest): Promise<Run> {
    let worker: Worker;
    try {
      worker = await this.ready();
    } catch (err) {
      this.logger.error(`CONTENT_PARSE_WORKER_START_FAILED: ${(err as Error).message}; answered 503 engine_busy`);
      return { outcome: { ok: false, reason: 'unavailable' }, ms: 0, reload: null };
    }
    const dispatched = Date.now();
    return new Promise((resolve) => {
      const finish = (outcome: Outcome, discard: boolean) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        worker.unref();
        const reload = discard ? this.replace(worker) : null;
        resolve({ outcome, ms: Date.now() - dispatched, reload });
      };
      const onMessage = (m: WorkerMessage) => {
        if ('id' in m && m.id === req.id) finish(m, false);
      };
      const onError = (err: Error & { code?: string }) =>
        finish({ ok: false, reason: err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'heap' : 'crashed' }, true);
      const onExit = () => finish({ ok: false, reason: 'crashed' }, true);
      const timer = setTimeout(() => finish({ ok: false, reason: 'deadline' }, true), this.limits.deadlineMs);
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.ref(); // keep the process alive while a caller waits on this worker
      worker.postMessage(req);
    });
  }

  /** The loaded worker, starting one if there is none. */
  private ready(): Promise<Worker> {
    if (this.starting) return this.starting;
    const worker = this.spawn(this.limits.memoryMb);
    this.current = worker;
    // Always listened to, so an 'error' after a job's own listener is gone can never become an uncaught exception.
    worker.on('error', () => undefined);
    // An idle worker that dies is replaced on the next conversion.
    worker.once('exit', () => {
      if (this.current === worker) {
        this.current = null;
        this.starting = null;
      }
    });
    this.starting = new Promise<Worker>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      const fail = (err: Error) => {
        cleanup();
        this.discard(worker);
        reject(err);
      };
      const onMessage = (m: WorkerMessage) => {
        if ('ready' in m) {
          cleanup();
          worker.unref(); // an idle worker never holds the process open
          resolve(worker);
        }
      };
      const onError = (err: Error) => fail(err);
      const onExit = (code: number) => fail(new Error(`the worker exited with code ${code} while loading`));
      const timer = setTimeout(
        () => fail(new Error(`the worker did not load within ${this.limits.startupMs} ms`)),
        this.limits.startupMs,
      );
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
    });
    return this.starting;
  }

  /**
   * Drop a worker a job killed or lost, and start its replacement now, so the next caller does not pay the load
   * (~0.5–3.5 s) inside its own request. A replacement that cannot start is logged, and the next conversion tries again.
   * Resolves (never rejects) once the replacement is ready or has failed to start, bounded by `startupMs`.
   */
  private replace(worker: Worker): Promise<void> {
    this.discard(worker);
    return this.ready().then(
      () => undefined,
      (err: Error) =>
        this.logger.error(`CONTENT_PARSE_WORKER_START_FAILED: ${err.message}; the next conversion tries again`),
    );
  }

  private discard(worker: Worker): void {
    if (this.current === worker) {
      this.current = null;
      this.starting = null;
    }
    void worker.terminate();
  }
}

const pool = new ContentParsePool();

/** Whose turn a conversion takes (one queued or running per principal), and how long it may wait for it. */
export interface ConversionQueue {
  principal: string;
  waitMs: number;
  /** #642: work nobody waits on a response for: an empty budget is waited out within `waitMs`, not refused. */
  batch?: boolean;
  /** #642: a batch's budget admission, shared by all its conversions (`batchConversion` sets it). */
  budgetTurn?: BatchBudgetTurn;
}

/**
 * #642: a batch is admitted against its human's budget once, on its first conversion; after that its conversions are
 * charged but never gated. The zip import converts every page inside one open transaction, so a budget wait on each
 * conversion would hold that connection and the inserted rows' locks for minutes. It still takes one turn at a time,
 * so it can never hold more than one conversion's share of the worker.
 */
export interface BatchBudgetTurn {
  admitted: boolean;
}

/** A human's admission key: the one key their requests, imports and validations all take their turn under (#642). */
export function userConversionKey(userId: string): string {
  return `user:${userId}`;
}

/**
 * The queue for work nobody waits on a response for (the zip import's queue job), with the batch wait. It takes the
 * turn of the human who started it (`userId`), so their import and their requests are one principal, not two; work
 * no human started names its own unit (`id`, e.g. `file-task:<id>`).
 */
export function batchConversion(id: string, userId?: string | null): ConversionQueue {
  return {
    principal: userId ? userConversionKey(userId) : `batch:${id}`,
    waitMs: CONTENT_PARSE_LIMITS.batchWaitMs,
    batch: true,
    budgetTurn: { admitted: false },
  };
}

/**
 * An east-west call made FOR a human (validate-content: the platform names the acting user): conversions run inside
 * `fn` take that human's turn, with the interactive wait. Without a user, `fn` runs with no override (the request
 * queue below).
 */
const onBehalfOf = new AsyncLocalStorage<string>();
export function convertOnBehalfOf<T>(userId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return userId ? onBehalfOf.run(userConversionKey(userId), fn) : fn();
}

/**
 * A request's queue: its actor, with the interactive wait — or the human an east-west caller named
 * (`convertOnBehalfOf`). Only work with neither shares the one `background` key.
 */
export function requestQueue(): ConversionQueue {
  const named = onBehalfOf.getStore();
  if (named) return { principal: named, waitMs: CONTENT_PARSE_LIMITS.waitMs };
  const ctx = ClsServiceManager.getClsService()?.get<AuditContext>(AUDIT_CONTEXT_KEY);
  const principal = ctx?.actorId ? `${ctx.actorType}:${ctx.actorId}` : 'background';
  return { principal, waitMs: CONTENT_PARSE_LIMITS.waitMs };
}

/**
 * Convert untrusted HTML or Markdown to ProseMirror JSON, off the event loop. Throws `BadRequestException('Invalid
 * content format')` for content that does not convert, `ContentTooComplexException` (422) past the bounds,
 * `ContentParseBusyException` (503) when no conversion can run in time, and `ConversionBudgetExhaustedException` (429)
 * when the caller's worker-time budget is spent (#642). This call never writes anything.
 */
export function parseUntrustedContent(
  content: string,
  format: ParseFormat,
  queue: ConversionQueue = requestQueue(),
): Promise<Record<string, unknown>> {
  return pool.parse(content, format, queue.principal, queue.waitMs, queue.batch === true, queue.budgetTurn);
}

/**
 * Convert untrusted Markdown to HTML, off the event loop, with the same bounds and errors. `options.maxChars` lowers
 * the cap on the HTML's length for this call (never past `CONTENT_PARSE_LIMITS.maxChars`).
 */
export function untrustedMarkdownToHtml(
  markdown: string,
  queue: ConversionQueue = requestQueue(),
  options: { maxChars?: number } = {},
): Promise<string> {
  return pool.toHtml(markdown, queue.principal, queue.waitMs, options.maxChars, queue.batch === true, queue.budgetTurn);
}

/** Stop the shared worker (tests). */
export function closeContentParser(): Promise<void> {
  return pool.close();
}
