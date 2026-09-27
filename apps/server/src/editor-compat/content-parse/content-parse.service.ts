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
 *     No slot within `waitMs` → 503 `engine_busy` (retryable; the content was not applied). Work with no request
 *     actor (the zip import's queue job) names its own queue key and may wait `batchWaitMs` (`batchConversion`).
 *   - `deadlineMs` from dispatch, enforced with `terminate()` (it stops a synchronous parse; a Promise race cannot),
 *     `memoryMb` heap via `resourceLimits`, and `maxNodes` nodes / `maxChars` characters in the result → 422
 *     `content_too_complex` (not retryable unchanged). A killed worker is replaced at once, not on the next job.
 *   - a worker that crashes or cannot start → 503 `engine_busy`, logged as an error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  BadRequestException,
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
}

/**
 * Measured on a dev laptop; production (Graviton ARM64) is estimated ~2–2.5× slower single-threaded (ADR 0031):
 *   - deadline 10 s: a real 1.25 MiB page of HTML (what ~1 MiB of Markdown becomes; bodies are capped at 1 MiB)
 *     converts in ~2.3 s here, ≤~6 s in production. The same deadline as the MCP attachment-extract worker. Deadline
 *     + wait (15 s) stays under the platform's 20 s content-write relay timeout, except when the worker is loading:
 *     the first conversion after a boot pays ~0.5–3.5 s of load on top (a replacement after a kill is started at
 *     once, so it is usually warm by the next job).
 *   - heap 1 GiB: that page needs ~384 MB; dense 1 MiB markup (99k nodes) 768 MB. The task has 8 GB.
 *   - nodes 100k: dense 1 MiB markup is 99k nodes, the real 1.25 MiB page 61k. It bounds what the main thread does
 *     with the result (clone, validation, Yjs: ~3 µs a node), independently of how fast the parser is.
 *   - characters 8 Mi: what the node cap cannot bound, one long string repeated in many nodes (a Markdown reference
 *     definition, an `<a href>` around many blocks), which ~200 KiB of input expanded to a 286 MiB result and 1–5 GB
 *     on the main thread. Real content carries ~1.3–1.7 characters of strings per input character (the repo's own
 *     docs: 1.31 MiB of Markdown → 1.68 Mi), so a 1 MiB body stays ≤~2 Mi; input that would reach 8 Mi does not
 *     convert within the deadline anyway.
 *   - batch wait 60 s: a zip import converts every page inside one transaction with no retry, so one busy answer
 *     failed the whole import. Nobody waits on a response for it, and the worker is ~one job per principal away.
 */
export const CONTENT_PARSE_LIMITS: Readonly<ContentParseLimits> = Object.freeze({
  deadlineMs: 10_000,
  waitMs: 5_000,
  memoryMb: 1024,
  maxNodes: 100_000,
  maxChars: 8 * 1024 * 1024,
  batchWaitMs: 60_000,
  startupMs: 30_000,
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

/** A conversion refused on its bounds (422) or its capacity (503) — an answer to pass on as is, never to relabel. */
export function isContentParseRefusal(err: unknown): err is ContentTooComplexException | ContentParseBusyException {
  return err instanceof ContentTooComplexException || err instanceof ContentParseBusyException;
}

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

export class ContentParsePool {
  private readonly logger = new Logger('ContentParse');
  /** The one worker: one conversion at a time. */
  private readonly slot: OpSemaphore;
  /** One conversion queued or running per principal. Entries are dropped when idle. */
  private readonly principals = new Map<string, OpSemaphore>();
  private current: Worker | null = null;
  private starting: Promise<Worker> | null = null;
  private nextId = 1;

  constructor(
    private readonly limits: Readonly<ContentParseLimits> = CONTENT_PARSE_LIMITS,
    private readonly spawn: SpawnWorker = spawnContentParseWorker,
  ) {
    this.slot = new OpSemaphore(1, limits.waitMs);
  }

  /** HTML or Markdown → ProseMirror JSON. `waitMs`: how long it may wait for its turn (default `limits.waitMs`). */
  async parse(content: string, format: ParseFormat, principal: string, waitMs?: number): Promise<Record<string, unknown>> {
    const { maxNodes, maxChars } = this.limits;
    const req = { op: 'to-json', format, content, maxNodes, maxChars } as const;
    return (await this.convert(req, principal, `format=${format}`, waitMs)) as Record<string, unknown>;
  }

  /** Markdown → HTML only (the importers rewrite the HTML before it is parsed). */
  async toHtml(markdown: string, principal: string, waitMs?: number): Promise<string> {
    const req = { op: 'markdown-to-html', content: markdown, maxChars: this.limits.maxChars } as const;
    return (await this.convert(req, principal, 'op=markdown-to-html', waitMs)) as string;
  }

  private async convert(
    req: DistributiveOmit<ParseRequest, 'id'>,
    principal: string,
    what: string,
    waitMs = this.limits.waitMs,
  ): Promise<unknown> {
    const bytes = Buffer.byteLength(String(req.content ?? ''), 'utf8');
    const admitBy = Date.now() + waitMs;
    const left = () => Math.max(0, admitBy - Date.now());

    let own = this.principals.get(principal);
    if (!own) {
      own = new OpSemaphore(1, waitMs);
      this.principals.set(principal, own);
    }
    try {
      const releaseOwn = await own.acquire(left());
      try {
        const releaseSlot = await this.slot.acquire(left());
        try {
          const { outcome, ms } = await this.run({ ...req, id: this.nextId++ } as ParseRequest);
          return this.settle(outcome, ms, `principal=${principal} ${what} bytes=${bytes} ms=${ms}`);
        } finally {
          releaseSlot();
        }
      } finally {
        releaseOwn();
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
      // Idle means nobody holds it and nobody waits (a release hands the slot to a waiter synchronously).
      if (own.inUse === 0 && this.principals.get(principal) === own) this.principals.delete(principal);
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
  private async run(req: ParseRequest): Promise<{ outcome: Outcome; ms: number }> {
    let worker: Worker;
    try {
      worker = await this.ready();
    } catch (err) {
      this.logger.error(`CONTENT_PARSE_WORKER_START_FAILED: ${(err as Error).message}; answered 503 engine_busy`);
      return { outcome: { ok: false, reason: 'unavailable' }, ms: 0 };
    }
    const dispatched = Date.now();
    return new Promise((resolve) => {
      const finish = (outcome: Outcome, discard: boolean) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        worker.unref();
        if (discard) this.replace(worker);
        resolve({ outcome, ms: Date.now() - dispatched });
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
   */
  private replace(worker: Worker): void {
    this.discard(worker);
    this.ready().catch((err: Error) =>
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
}

/**
 * The queue for work with no request actor that nobody waits on a response for: its own key, and the batch wait.
 * `id` names the unit of work (e.g. `file-task:<id>`), so concurrent imports never queue behind each other.
 */
export function batchConversion(id: string): ConversionQueue {
  return { principal: `batch:${id}`, waitMs: CONTENT_PARSE_LIMITS.batchWaitMs };
}

/**
 * A request's queue: its actor, with the interactive wait. Work with no actor that has not named a batch queue
 * (validate-content, called by the platform's service principal) shares one `background` key.
 */
function requestQueue(): ConversionQueue {
  const ctx = ClsServiceManager.getClsService()?.get<AuditContext>(AUDIT_CONTEXT_KEY);
  const principal = ctx?.actorId ? `${ctx.actorType}:${ctx.actorId}` : 'background';
  return { principal, waitMs: CONTENT_PARSE_LIMITS.waitMs };
}

/**
 * Convert untrusted HTML or Markdown to ProseMirror JSON, off the event loop. Throws `BadRequestException('Invalid
 * content format')` for content that does not convert, `ContentTooComplexException` (422) past the bounds, and
 * `ContentParseBusyException` (503) when no conversion can run in time. This call never writes anything.
 */
export function parseUntrustedContent(
  content: string,
  format: ParseFormat,
  queue: ConversionQueue = requestQueue(),
): Promise<Record<string, unknown>> {
  return pool.parse(content, format, queue.principal, queue.waitMs);
}

/** Convert untrusted Markdown to HTML, off the event loop, with the same bounds and errors. */
export function untrustedMarkdownToHtml(markdown: string, queue: ConversionQueue = requestQueue()): Promise<string> {
  return pool.toHtml(markdown, queue.principal, queue.waitMs);
}

/** Stop the shared worker (tests). */
export function closeContentParser(): Promise<void> {
  return pool.close();
}
