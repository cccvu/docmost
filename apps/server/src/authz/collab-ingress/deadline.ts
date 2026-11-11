/**
 * CCC collab integration — NOT upstream Docmost code (#827, ADR 0036).
 *
 * A wall-clock deadline for synchronous Yjs work: the shadow apply of a frame, a document load, the probe, a compaction
 * build. Yjs has paths no step meter can count (formatting cleanup after a delete, struct splits, load-order inversion),
 * and desired_count=1 makes a stall an outage, so the work runs where V8 can interrupt it.
 *
 * How: one precompiled `vm.Script('run()')` and one reused context. `run` is the outer-realm function, so the work runs
 * in this realm, with this realm's `yjs`; the `timeout` makes Node start a watchdog that terminates execution once `ms`
 * pass. Measured (yjs-bounds.sizing.bench.cjs, deadline.spec.ts): the cut lands within about ±1.5 ms of `ms` on Yjs
 * and plain JS loops, the call costs about 24 µs on Node 22 and 40 µs on Node 24 (the watchdog thread), and termination
 * never leaks into the caller.
 *
 * What a caller must hold to:
 *   - A deadline means "outcome unknown", never "not applied". Termination skips every `finally` inside the call (Yjs's
 *     `transact` never runs `cleanupTransactions`, so `doc._transaction` stays set), and a call that finished at the
 *     boundary can still report a timeout. The document the work touched must be thrown away: a shadow, a scratch doc,
 *     a document still loading. Never live.
 *   - Nothing inside may depend on a `finally`, or on module or object state it sets and resets. So the call goes
 *     INNERMOST, e.g. `meter.metered(scan, () => runWithDeadline(() => Y.applyUpdate(shadow, u), T))`: the meter's own
 *     `finally` then runs after the timeout has become an ordinary error.
 *   - The work is pure Yjs on a disposable document: no Node API that keeps state in JS (timers, emitters with Node
 *     listeners, streams), no AsyncLocalStorage / CLS, no AsyncResource, no nested deadline (deadline.fitness.spec.ts
 *     checks the callbacks it can see). Termination skips Node's own `finally` blocks too: an AsyncResource scope
 *     entered inside and cut leaves node's async-hook stack corrupted, which ABORTS the process (measured on Node 22
 *     and 24), and a store entered inside would stay current for the caller. The call itself runs in its own async
 *     scope (`AsyncResource.runInAsyncScope`), entered and left outside the timed region, which restores the caller's
 *     context on every exit.
 *   - No nesting: a call made while another deadline is running throws, before running anything (fail closed). An outer
 *     timeout firing inside an inner call is exactly the cut-inside-a-scope case above.
 *   - A long native call (a 100 MB `JSON.parse`) cannot be interrupted; the cut then lands when it returns. Yjs and lib0
 *     decoding are JS loops.
 *
 * Detect a timeout with `isDeadlineExceeded` (the error's `code`), never `instanceof`: the error is made in the vm's
 * realm, and jest runs specs in realms of their own.
 */
import { AsyncResource } from 'node:async_hooks';
import * as vm from 'node:vm';

/** The `code` Node gives the error of a `vm` call that ran out of time. */
export const DEADLINE_EXCEEDED_CODE = 'ERR_SCRIPT_EXECUTION_TIMEOUT';

/** Runs `fn` synchronously and interrupts it once `ms` pass. Returns what `fn` returns; rethrows what `fn` throws. */
export type DeadlineRunner = <T>(fn: () => T, ms: number) => T;

/** A deadline call made inside another (refused: see the module comment). */
export class NestedDeadlineError extends Error {
  constructor() {
    super('runWithDeadline: a deadline is already running; nested deadlines are refused (#827)');
  }
}

const context = vm.createContext({ run: undefined as unknown });
let running = false;
const script = new vm.Script('run()', { filename: 'ccc-collab-deadline.vm' });

/** The vm runner. The work's own errors keep their identity; a timeout is an Error whose `code` is DEADLINE_EXCEEDED_CODE. */
export const vmRunWithDeadline: DeadlineRunner = <T>(fn: () => T, ms: number): T => {
  if (typeof fn !== 'function') throw new TypeError('runWithDeadline: fn must be a function');
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`runWithDeadline: ms must be a positive finite number, got ${ms}`);
  if (running) throw new NestedDeadlineError();
  const timeout = Math.max(1, Math.ceil(ms));
  // A fresh resource per call: its scope is the caller's context, restored when the call ends however it ends.
  return new AsyncResource('CCC_COLLAB_DEADLINE').runInAsyncScope(() => {
    running = true;
    context.run = fn;
    try {
      return script.runInContext(context, { timeout }) as T;
    } finally {
      // Outside the timed region: a timeout is an ordinary error by now, so this always runs.
      context.run = undefined;
      running = false;
    }
  });
};

let current: DeadlineRunner = vmRunWithDeadline;

/** Run `fn` under a wall-clock deadline of `ms` (see the module comment for what a caller must hold to). */
export function runWithDeadline<T>(fn: () => T, ms: number): T {
  return current(fn, ms);
}

/** True when `err` is a deadline's timeout (also one a test runner made with `deadlineExceeded`). */
export function isDeadlineExceeded(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === DEADLINE_EXCEEDED_CODE;
}

/** A timeout error shaped as the vm's, for a test runner that simulates one. */
export function deadlineExceeded(ms: number): Error {
  return Object.assign(new Error(`Script execution timed out after ${ms}ms`), { code: DEADLINE_EXCEEDED_CODE });
}

/**
 * Replace the runner behind `runWithDeadline` (jest only: refuses anywhere else). Returns the restore function. Classes
 * that take a `DeadlineRunner` in their options are the first choice; this is for code that calls `runWithDeadline`.
 * Name an injected runner `runWithDeadline` too (`this.runWithDeadline(() => …, T)`): deadline.fitness.spec.ts finds
 * the calls by that name.
 */
export function overrideDeadlineForTests(runner: DeadlineRunner): () => void {
  if (process.env.JEST_WORKER_ID === undefined) throw new Error('overrideDeadlineForTests is for jest only (#827)');
  const previous = current;
  current = runner;
  return () => {
    current = previous;
  };
}
