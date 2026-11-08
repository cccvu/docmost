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
 *     Actorless keys (`background`, `batch:<id>`) are exempt. The bucket itself is `ConversionBudget`
 *     (conversion-budget.ts, #716 M7); an admitted batch is refused 429 once it overdraws past `batchOverdraftMs`
 *     (#716 I3). A human with no Docmost user converts under `identity:<platform id>` (#716 I6), never `background`.
 *   - small interactive inputs (#716): a non-batch conversion of at most `smallInputBytes` takes the worker ahead of
 *     larger waiters (an urgent turn, aged after `smallAgingMs` so a large waiter is never starved, but never ahead of
 *     a small one that has already waited out a large conversion, #731). That priority is
 *     all it gets: the same `deadlineMs` and `waitMs` as every other conversion (#716 load run: a 3 s deadline of its
 *     own killed a 17 KB page that took 3.3 s on a contended CPU, a non-retryable 422 for an ordinary edit). A killed
 *     conversion holds the worker until its replacement is ready, and the
 *     waiters' clocks stop for that reload (credited up to `reloadCreditMs` each), so it is bounded and counted once.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { OpSemaphore, OpSemaphoreTimeout } from '../../authz/page-write/op-semaphore';
import { AUDIT_CONTEXT_KEY, type AuditContext } from '../../common/middlewares/audit-context.middleware';
import type { ParseFormat, ParseReply, ParseRequest, WorkerMessage } from './content-parse.worker';
import {
  type BatchBudgetTurn,
  ConversionBudget,
  ConversionBudgetExhaustedException,
  type ConversionBudgetLimits,
  isBudgetExempt,
} from './conversion-budget';

export type { ParseFormat } from './content-parse.worker';
// #716 M7: the budget moved to conversion-budget.ts; re-exported so every existing import keeps working.
export { ConversionBudget, ConversionBudgetExhaustedException, isBudgetExempt };
export type { BatchBudgetTurn, ConversionBudgetLimits };

/** #734: milliseconds since `from` on the monotonic clock (`performance.now()`), which a wall-clock step cannot move. */
function elapsedSince(from: number): number {
  return performance.now() - from;
}

export interface ContentParseLimits extends ConversionBudgetLimits {
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
  /** #716: a non-batch input of at most this many UTF-8 bytes is a small interactive conversion. */
  smallInputBytes: number;
  /**
   * #716: the queue-aging bound, NOT a deadline: a large waiter that has waited this long is served before any small
   * one. A small conversion keeps the normal `deadlineMs` and `waitMs`; only its place in the queue differs.
   */
  smallAgingMs: number;
  /**
   * #716: the most wait a worker reload (after a kill) gives back to one waiter: the reload holds the worker without
   * converting anything, so a waiter's clock stops for it, up to this much in total.
   */
  reloadCreditMs: number;
}

/**
 * Measured on a dev laptop; production (Graviton ARM64) is estimated ~2–2.5× slower single-threaded (ADR 0031):
 *   - deadline 7 s: ~1 MiB of real Markdown (1.28 Mi characters of HTML, 42k nodes) converts in ~0.56 s here with
 *     happy-dom 21 (it was ~2.0 s on 20.8.9, which re-parsed every CSS selector on every match), so ≤~1.4 s in
 *     production at idle. Past it is 422 `content_too_complex`.
 *   - wait 8 s, longer than the deadline plus lag (#642): a principal is admitted behind at most one conversion of each
 *     principal ahead of it, a killed conversion's principal waits out the worker's reload (`convert`), and (#716) the
 *     worker is not handed on until that reload is done — but the reload is nobody's conversion, so it stops the
 *     waiters' clocks (`reloadCreditMs`, 3.5 s at most per waiter): one principal looping deadline-length conversions
 *     can never make another wait past 7 s + its lag of its own wait time. Worst case, with a reload: 8 + 3.5 + 7 =
 *     18.5 s; without one: 8 + 7 = 15 s (#716 review: folding the reload into an 11.5 s wait had raised the no-reload
 *     worst case to 18.5 s too). That is only the CONVERSION's share of the platform's 20 s content-write relay
 *     timeout: the same relay call also reads the page, runs the edit check and applies + stores the result (the
 *     settle and pageInfo are separate calls, before it). Under load those took the rest and more (#716: 1 write in
 *     12 crossed 20 s), so the margin comes from cutting their main-thread work, not from this budget.
 *   - small inputs (#716), ≤ 32 KiB, non-batch: served ahead of larger waiters, and otherwise like any conversion:
 *     deadline 7 s, wait 8 s (a 32 KiB page converts in ~0.25 s here, ≤~1.2 s at Graviton × CFS contention; the #716
 *     load run saw a 17 KB page take 3.3 s on a contended CPU, which a 3 s small deadline answered 422). Worst case,
 *     the same as a large write's: wait 8 + reload ≤ 3.5 + deadline 7 = 18.5 s < the 20 s relay. A small write waits
 *     out at most ONE large conversion (≤ 7 s + lag ≤ 8 s, its reload credited), plus the small conversions of the
 *     small principals queued ahead of it; past the wait is 503 as before. Aging 3 s (`smallAgingMs`, a queue bound,
 *     not a deadline): a large waiter that has waited that long goes before a small one, so it waits at most 3 + one
 *     small conversion + lag (≤ 1 s) past the running one: within its own 8 s for every small conversion up to 4 s
 *     (~3× the contended measurement), reloads credited. A pathological small input that runs longer can push that
 *     one large waiter to a retryable 503; the budget bounds how often one principal can do that.
 *     #731: except a small write that has already waited out a large conversion, which goes first. Before, aging
 *     granted the next aged large conversion ahead of it too, so whenever large conversions ran past 3 s (always, at
 *     the A1 load) a small write waited the running one AND an aged one, past its 8 s (2.7% of A1's small writes were
 *     503). Now a large waiter behind a large conversion also waits out the small writes queued behind that one (at
 *     most one per small principal, each a small conversion), then goes; the small stream's rate never delays it
 *     more, so it still never starves (op-semaphore.ts `agingMs`).
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
 *   - batch overdraft 120 s (#716 I3, `CONTENT_PARSE_BATCH_OVERDRAFT_MS`, clamped 30 s–10 min): an admitted zip import
 *     is refused 429 (and rolls back) once it has been charged this much past the -capacity floor, so one import gets
 *     at most ~2 × 30 s + 120 s + the refill of worker time (~3 min, ~180 s of legit conversions), not unbounded.
 */
/** #716 I3: `CONTENT_PARSE_BATCH_OVERDRAFT_MS`, whole ms, clamped to [30 s, 10 min]; unset or junk is 120 s. */
export function batchOverdraftFromEnv(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return 120_000;
  return Math.min(600_000, Math.max(30_000, Math.floor(n)));
}

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
  batchOverdraftMs: batchOverdraftFromEnv(process.env.CONTENT_PARSE_BATCH_OVERDRAFT_MS),
  smallInputBytes: 32 * 1024,
  smallAgingMs: 3_000,
  reloadCreditMs: 3_500,
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
type Outcome =
  | ParseReply
  | { ok: false; reason: 'heap' | 'crashed' | 'unavailable' }
  /** #716: `lateMs` is how far past the deadline the kill fired: the main thread's lag at that moment. */
  | { ok: false; reason: 'deadline'; lateMs: number };

/** One conversion's outcome, its own time, and — when it cost the worker — the replacement's load. */
interface Run {
  outcome: Outcome;
  ms: number;
  /** Set when this conversion killed or lost the worker: settles once the replacement is ready (or failed to start). */
  reload: Promise<unknown> | null;
}

export class ContentParsePool {
  private readonly logger = new Logger('ContentParse');
  /** The one worker: one conversion at a time. Small interactive conversions take an urgent turn (#716). */
  private readonly slot: OpSemaphore;
  /**
   * #716: export serializations wait for the worker through this lane of ONE, so at most one of them is ever queued on
   * (or holding) the worker: a write waits behind at most one export page, however many exports are running.
   */
  private readonly serializeLane: OpSemaphore;
  /** One conversion queued or running per principal. Entries are dropped when idle. */
  private readonly principals = new Map<string, OpSemaphore>();
  private current: Worker | null = null;
  private starting: Promise<Worker> | null = null;
  private nextId = 1;

  constructor(
    private readonly limits: Readonly<ContentParseLimits> = CONTENT_PARSE_LIMITS,
    private readonly spawn: SpawnWorker = spawnContentParseWorker,
    /** #642/#716 M7: the per-key worker-time budget (injectable with its own clock, for tests). */
    private readonly budget: ConversionBudget = new ConversionBudget(limits),
  ) {
    // `smallAgingMs`: a large waiter that has waited that long is served before a small one, unless that small one has
    // already waited out a large conversion (#731, see CONTENT_PARSE_LIMITS).
    // #716: a reload after a kill pauses the waiters' clocks (credited up to `reloadCreditMs` each), see `convert`.
    const pauseCreditMs = limits.reloadCreditMs;
    this.slot = new OpSemaphore(1, limits.waitMs, { agingMs: limits.smallAgingMs, pauseCreditMs });
    this.serializeLane = new OpSemaphore(1, limits.waitMs, { pauseCreditMs });
  }

  /** HTML or Markdown → ProseMirror JSON, under `queue`'s turn, wait and budget. */
  async parse(content: string, format: ParseFormat, queue: ConversionQueue): Promise<Record<string, unknown>> {
    const { maxNodes, maxChars } = this.limits;
    const req = { op: 'to-json', format, content, maxNodes, maxChars } as const;
    return (await this.convert(req, queue, `format=${format}`)) as Record<string, unknown>;
  }

  /**
   * Markdown → HTML only (the importers rewrite the HTML before it is parsed). `maxChars` lowers the cap on the
   * HTML's length for this call (an importer bounds it by its own input cap); it never raises it past the limit.
   */
  async toHtml(markdown: string, queue: ConversionQueue, maxChars?: number): Promise<string> {
    const cap = Math.min(maxChars ?? this.limits.maxChars, this.limits.maxChars);
    const req = { op: 'markdown-to-html', content: markdown, maxChars: cap } as const;
    return (await this.convert(req, queue, 'op=markdown-to-html')) as string;
  }

  /**
   * #716: a stored page (ProseMirror JSON) → the native export's HTML or Markdown, in the worker. Never a small/urgent
   * turn, and through the serialize lane (above). Output past `maxChars` is 422 like any other bound. Stored content
   * that does not serialize is the server's fault, not the caller's: 500, never the 400 "Invalid content format".
   */
  async serialize(json: unknown, format: ParseFormat, queue: ConversionQueue): Promise<string> {
    const req = { op: 'serialize', format, json, maxChars: this.limits.maxChars } as const;
    try {
      return (await this.convert(req, queue, `op=serialize format=${format}`)) as string;
    } catch (err) {
      if (err instanceof BadRequestException) {
        this.logger.error(`CONTENT_SERIALIZE_FAILED principal=${queue.principal} format=${format}: answered 500`);
        throw new InternalServerErrorException('The page could not be converted for export.');
      }
      throw err;
    }
  }

  /** #642: the key's worker-time left, in ms, refilled to now (may be negative). Drops a bucket that is full again. */
  budgetLeft(key: string, now?: number): number {
    return this.budget.left(key, now);
  }

  /** How many keys hold a bucket below capacity (tests, diagnostics). */
  get budgetKeys(): number {
    return this.budget.size;
  }

  /**
   * One conversion under `queue`: admission against the budget (keyed `queue.budgetKey ?? queue.principal`), the
   * principal's own turn, then the worker. `what` is for logs only. A new worker op calls this with its request.
   */
  protected async convert(req: DistributiveOmit<ParseRequest, 'id'>, queue: ConversionQueue, what: string): Promise<unknown> {
    const { principal } = queue;
    const budgetKey = queue.budgetKey ?? principal;
    const batch = queue.batch === true;
    // Not narrowed on `batch`: this project's non-strict compiler settings collapse that union to `never`.
    const turn = batch ? (queue as BatchConversionQueue).budgetTurn : undefined;
    // #716: a serialization carries JSON, not `content`: it counts 0 bytes here and is never small (below).
    const serializing = req.op === 'serialize';
    const bytes = Buffer.byteLength(String(('content' in req ? req.content : '') ?? ''), 'utf8');
    // #716: a small interactive input waits ahead of larger ones, and that is all: the same wait and deadline as every
    // conversion (a shorter deadline of its own turned a contended-CPU edit into a non-retryable 422). An export
    // serialization is never small: its cost is the stored page's, which no input size here measures.
    const small = !batch && !serializing && bytes <= this.limits.smallInputBytes;
    const waitMs = queue.waitMs ?? this.limits.waitMs;
    const deadlineMs = this.limits.deadlineMs;
    const admitBy = Date.now() + waitMs;
    const left = () => Math.max(0, admitBy - Date.now());
    const context = `${what} bytes=${bytes}${small ? ' class=small' : ''}`;
    const admit = () => this.budget.admit(budgetKey, { batch, turn, left, context });
    this.budget.prune();
    // #642: refused before it queues — an over-budget key never waits in line, nor holds its own turn.
    await admit();

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
        await admit();
        if (turn) turn.admitted = true; // later conversions of this batch are charged, never gated (bar #716 I3)
        // #716: an export serialization queues for the worker only through its lane of one (never urgent).
        const releaseLane = serializing ? await this.serializeLane.acquire(left()) : null;
        let releaseSlot: () => void;
        try {
          releaseSlot = await this.slot.acquire(left(), { urgent: small });
        } catch (err) {
          releaseLane?.();
          throw err;
        }
        const releaseWorker = () => {
          releaseSlot(); // the worker first: a write already waiting for it goes ahead of the next serialization
          releaseLane?.();
        };
        try {
          const run = await this.run({ ...req, id: this.nextId++ } as ParseRequest, deadlineMs);
          reload = run.reload;
          // #642: charged on settle — the conversion's own wall time (a killed one up to its kill)…
          this.budget.charge(budgetKey, run.ms, turn);
          if (reload) {
            // …and the reload it caused, once the replacement worker is ready.
            const reloadFrom = performance.now();
            void reload.then(() => this.budget.charge(budgetKey, Math.ceil(elapsedSince(reloadFrom)), turn));
          }
          return this.settle(run.outcome, run.ms, deadlineMs, `principal=${principal} ${context} ms=${run.ms}`);
        } finally {
          // #716: a conversion that cost the worker hands the slot on only once the replacement is ready, so the
          // next caller spends the reload inside its wait (bounded, and counted), never after it. Registered before
          // the turn's release below, so a waiting newcomer still goes ahead of this principal's next conversion.
          // The reload is nobody's conversion, so it does not count against the waiters' waits (each is credited up to
          // `reloadCreditMs`): a wait counts the conversions ahead of it, never a recovery folded into every wait.
          if (reload) {
            this.slot.pause();
            this.serializeLane.pause();
            void reload.then(() => {
              this.slot.resume();
              this.serializeLane.resume();
              releaseWorker();
            });
          } else releaseWorker();
        }
      } finally {
        if (reload) {
          // #642: this conversion cost the worker. Its principal keeps its own turn until the replacement is ready,
          // so the reload is spent by whoever waits for the slot meanwhile, never by this principal's next
          // conversion ahead of them. The answer itself is not held back.
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
          `CONTENT_PARSE_BUSY principal=${principal} ${context}: no conversion slot within ${waitMs} ms; answered 503 engine_busy`,
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
  private settle(outcome: Outcome, ms: number, deadlineMs: number, context: string): unknown {
    if (outcome.ok) {
      if (ms > deadlineMs / 2) {
        this.logger.warn(`CONTENT_PARSE_SLOW ${context} nodes=${outcome.nodes ?? '-'}: over half the ${deadlineMs} ms deadline`);
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
        const why =
          failure.reason === 'too_complex'
            ? failure.detail
            : failure.reason === 'deadline'
              ? `deadline lateMs=${(failure as { lateMs: number }).lateMs}`
              : failure.reason;
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
  private async run(req: ParseRequest, deadlineMs: number): Promise<Run> {
    let worker: Worker;
    try {
      worker = await this.ready();
    } catch (err) {
      this.logger.error(`CONTENT_PARSE_WORKER_START_FAILED: ${(err as Error).message}; answered 503 engine_busy`);
      return { outcome: { ok: false, reason: 'unavailable' }, ms: 0, reload: null };
    }
    // #734: one MONOTONIC clock for the deadline and the charge. The wall clock can step backward (NTP/chrony
    // makestep, a host correction), which would postpone the kill by the step and hold the one worker past ADR 0031's
    // bound, and would undercharge the conversion.
    const dispatched = performance.now();
    return new Promise((resolve) => {
      const finish = (outcome: Outcome, discard: boolean) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        worker.unref();
        const reload = discard ? this.replace(worker) : null;
        resolve({ outcome, ms: Math.ceil(elapsedSince(dispatched)), reload });
      };
      const onMessage = (m: WorkerMessage) => {
        if ('id' in m && m.id === req.id) finish(m, false);
      };
      const onError = (err: Error & { code?: string }) =>
        finish({ ok: false, reason: err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'heap' : 'crashed' }, true);
      const onExit = () => finish({ ok: false, reason: 'crashed' }, true);
      // The timer runs on this (main) thread, so it fires late by the event loop's lag; `lateMs` logs by how much.
      // #734: it can also fire about 1 ms EARLY (libuv starts it from its cached, ms-truncated loop time), so it
      // re-arms for the remainder: a conversion is never killed, or charged, before its full deadline, and, the clock
      // being monotonic, never killed later than the deadline plus that lag.
      let timer: NodeJS.Timeout;
      const arm = (ms: number) => {
        timer = setTimeout(() => {
          const elapsed = elapsedSince(dispatched);
          if (elapsed < deadlineMs) return arm(Math.ceil(deadlineMs - elapsed));
          finish({ ok: false, reason: 'deadline', lateMs: Math.round(elapsed - deadlineMs) }, true);
        }, ms);
      };
      arm(deadlineMs);
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

interface ConversionQueueBase {
  /** Whose turn it takes: one conversion queued or running per principal. */
  principal: string;
  /** How long it may wait for its turn, in total. Absent: the pool's `waitMs`. */
  waitMs?: number;
  /**
   * #716: the budget key to admit and charge under, when it differs from the turn (`principal`): e.g. an export's
   * `user:<id>:export`, so a human's exports spend their own bucket but still take that human's one turn.
   */
  budgetKey?: string;
}

/** An interactive conversion: an empty budget is refused at once (429). */
export interface InteractiveConversionQueue extends ConversionQueueBase {
  batch?: false;
}

/**
 * #642: work nobody waits on a response for: an empty budget is waited out within `waitMs`, not refused. Always carries
 * its `budgetTurn` (#716 M9: a batch without one would be gated on every conversion, inside the import's transaction).
 */
export interface BatchConversionQueue extends ConversionQueueBase {
  batch: true;
  budgetTurn: BatchBudgetTurn;
}

/** Whose turn a conversion takes, how long it may wait for it, and how its budget is gated. */
export type ConversionQueue = InteractiveConversionQueue | BatchConversionQueue;

/** A human's admission key: the one key their requests, imports and validations all take their turn under (#642). */
export function userConversionKey(userId: string): string {
  return `user:${userId}`;
}

/**
 * #716 I6: the key of a human the platform names by their PLATFORM identity because they have no Docmost user yet. Not
 * exempt: their own bucket, never the shared `background` key.
 */
export function identityConversionKey(identityId: string): string {
  return `identity:${identityId}`;
}

/** #716 I6: the key an east-west caller's human converts under: their Docmost user, else their platform identity. */
export function humanConversionKey(userId?: string | null, identityId?: string | null): string | undefined {
  if (userId) return userConversionKey(userId);
  if (identityId) return identityConversionKey(identityId);
  return undefined;
}

/**
 * The queue for work nobody waits on a response for (the zip import's queue job), with the batch wait. It takes the
 * turn of the human who started it (`userId`), so their import and their requests are one principal, not two; work
 * no human started names its own unit (`id`, e.g. `file-task:<id>`).
 */
export function batchConversion(id: string, userId?: string | null): BatchConversionQueue {
  return {
    principal: userId ? userConversionKey(userId) : `batch:${id}`,
    waitMs: CONTENT_PARSE_LIMITS.batchWaitMs,
    batch: true,
    budgetTurn: { admitted: false, overdraftMs: 0 },
  };
}

/**
 * An east-west call made FOR a human (validate-content: the platform names the acting human): conversions run inside
 * `fn` take that human's turn, with the interactive wait. `key` is ready-made (`humanConversionKey`). Without one, `fn`
 * runs with no override (the request queue below).
 */
const onBehalfOf = new AsyncLocalStorage<string>();
export function convertOnBehalfOf<T>(key: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return key ? onBehalfOf.run(key, fn) : fn();
}

/**
 * A request's queue: its actor, with the interactive wait — or the human an east-west caller named
 * (`convertOnBehalfOf`). Only work with neither shares the one `background` key.
 */
export function requestQueue(): ConversionQueue {
  const named = onBehalfOf.getStore();
  if (named) return { principal: named, waitMs: CONTENT_PARSE_LIMITS.waitMs };
  const ctx = ClsServiceManager.getClsService()?.get<AuditContext>(AUDIT_CONTEXT_KEY);
  // #716 M8: the ONE key helper, whatever `actorType` says, so a human's requests can never split from their imports
  // and validations into two turns and two buckets.
  const principal = ctx?.actorId ? userConversionKey(ctx.actorId) : 'background';
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
  return pool.parse(content, format, queue);
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
  return pool.toHtml(markdown, queue, options.maxChars);
}

/**
 * #716: serialize a stored page for the native export, off the event loop (`ContentParsePool.serialize`). The export
 * names its queue (`editor-compat/export/export-conversion.ts`): the human's turn, their own `:export` budget key.
 */
export function serializePageContent(json: unknown, format: ParseFormat, queue: ConversionQueue): Promise<string> {
  return pool.serialize(json, format, queue);
}

/** Stop the shared worker (tests). */
export function closeContentParser(): Promise<void> {
  return pool.close();
}
