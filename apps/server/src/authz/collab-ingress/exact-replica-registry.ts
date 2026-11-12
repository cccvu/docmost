/**
 * CCC collab integration — NOT upstream Docmost code (#840, ADR 0036).
 *
 * The replay log of each live document (exact-replica.ts), recorded from live's own events so its order is live's:
 *   - an accepted client frame: the guard queues its RAW payload on the connection's FIFO when it accepts it
 *     (`noteAcceptedFrame`); live's next transaction with that connection as origin (Hocuspocus 4.7.1 applies a frame
 *     with `{ source: 'connection', connection }`, a new object per frame, one frame at a time per connection) takes
 *     it off the FIFO and records it;
 *   - every other transaction (an API write, a Redis relay, the lineage write): live's 'update' payload.
 * Yjs emits, per transaction, `beforeTransaction`, then `afterTransaction`, `afterTransactionCleanup` and 'update', so
 * the entries keep live's order. The log stops being trusted (`replicaLogOf` answers null) when it may not: a
 * connection transaction with no accepted frame queued, a frame accepted but never applied by the next macrotask
 * (`settleAcceptedFrames`), or a transaction opened inside another's cleanup (Yjs then runs the outer one's GC and
 * merges after the inner one integrated, which a replay of separate transactions does not). One nested transaction is
 * Yjs's own and is kept: the formatting cleanup a remote transaction that integrated formatting opens after its
 * `afterTransaction` (`cleanupYTextAfterTransaction`, origin null). A replay of the outer transaction's input opens
 * the same one at the same point, so the inner one's recorded update replays as a no-op. Whatever the log misses, the
 * guard's tripwire (a strict compare of every replay with live) catches. An untrusted log is trusted
 * again only by a verified checkpoint (`attachReplicaLog` again, or the guard's rebuild when a reload strict-equals live).
 *
 * The listeners never throw (a throw in a Yjs listener stops later listeners and wedges the document's cleanup for good).
 * `onApplied` (the guard's charge of live's own apply, #840 part 4) is called with the CPU ms from `beforeTransaction`
 * to `afterTransactionCleanup`, on the clocks the guard passed.
 */
import * as Y from 'yjs';
import { ExactReplicaLog } from './exact-replica';

/** An accepted frame waiting for live to apply it. */
export interface AcceptedFrame {
  raw: Uint8Array;
  /** What its integrate walked on the shadow (the replay cost the log's step cap counts). */
  steps: number;
  /** The CPU clock `onApplied`'s ms are read on, and the wall clock its `wallStarted` is. */
  clock?: () => number;
  wall?: () => number;
  /** Live applied it, in `ms` of CPU (its transaction, cleanup included), from `wallStarted`. Never throws into Yjs. */
  onApplied?: (ms: number, wallStarted: number) => void;
}

type Entry = {
  log: ExactReplicaLog;
  trusted: boolean;
  /** Why it is not (diagnostics). */
  why: string | null;
  /** Live's transactions so far: the join check's cache key (#840 part 5). */
  generation: number;
  /** Per connection, the frames accepted and not yet applied (one, in practice: 4.7.1 handles a connection's frames in turn). */
  readonly fifos: Map<object, AcceptedFrame[]>;
  /** The open connection transaction's frame and when it began. */
  readonly open: WeakMap<Y.Transaction, { frame: AcceptedFrame; start: number; wallStarted: number }>;
  /** Transactions whose `afterTransaction` has run (the nested-transaction rule). */
  readonly afterDone: WeakSet<Y.Transaction>;
};

const entries = new WeakMap<Y.Doc, Entry>();
const EMPTY = Y.encodeStateAsUpdate(new Y.Doc());

/** Hocuspocus's connection origin, or null (any other origin is server-local). */
function connectionOf(origin: unknown): object | null {
  if (typeof origin !== 'object' || origin === null) return null;
  const o = origin as { source?: unknown; connection?: unknown };
  return o.source === 'connection' && typeof o.connection === 'object' && o.connection !== null ? o.connection : null;
}

/** Why a log past its caps stopped being trusted: the guard's next frame re-verifies (a stable reload re-arms it). */
export const LOG_OVER_CAP = 'log over cap';

function distrust(entry: Entry, why: string): void {
  if (!entry.trusted) return;
  entry.trusted = false;
  entry.why = why;
  entry.log.advance(EMPTY); // its entries no longer rebuild anything: never kept (only a verified checkpoint re-arms it)
}

/**
 * Recording never drops an entry, so past its caps the log stops being trusted (and its bytes go) right away: with no
 * client frame to checkpoint it (a reader open while API writes land), it would otherwise grow without bound (#840).
 */
function capped(entry: Entry): void {
  if (entry.log.overCap()) distrust(entry, LOG_OVER_CAP);
}

/**
 * Start (or re-arm) `live`'s log from `loadBytes`: the exact bytes live was built from (the load's ydoc bytes, the update
 * a content-only load applied, an empty doc's encoding, a verified heal image), or any encoding of live that a reload
 * strict-equals live (exact-replica.ts `tryAdvance`). Call it right after those bytes are applied and before any other
 * transaction on live. Idempotent per document: listeners are installed once; a second call re-arms the checkpoint and
 * trusts the log again (the caller asserts the bytes rebuild live exactly).
 */
export function attachReplicaLog(live: Y.Doc, loadBytes: Uint8Array): void {
  const known = entries.get(live);
  if (known) {
    known.log.advance(loadBytes);
    known.trusted = true;
    known.why = null;
    return;
  }
  install(live, new ExactReplicaLog(loadBytes), true);
}

/** The guard's fallback for a document nobody attached a log to: listeners on, the log untrusted until verified. */
export function ensureReplicaLog(live: Y.Doc): void {
  if (!entries.has(live)) install(live, new ExactReplicaLog(EMPTY), false, 'not attached at load');
}

/** `live`'s log while it is trusted (it rebuilds live exactly, over its caps or not); otherwise null. */
export function replicaLogOf(live: Y.Doc): ExactReplicaLog | null {
  const entry = entries.get(live);
  return entry?.trusted ? entry.log : null;
}

/** Why `live`'s log is not trusted (null: it is, or there is none). Diagnostics and specs. */
export function replicaLogDistrust(live: Y.Doc): string | null {
  const entry = entries.get(live);
  return entry && !entry.trusted ? entry.why : null;
}

/** Live's transactions so far (0 with no log). */
export function mutationGeneration(live: Y.Doc): number {
  return entries.get(live)?.generation ?? 0;
}

/** The guard accepted `frame` from `connection`: live applies it next on that connection. */
export function noteAcceptedFrame(live: Y.Doc, connection: object, frame: AcceptedFrame): void {
  const entry = entries.get(live);
  if (!entry) return;
  const fifo = entry.fifos.get(connection);
  if (fifo) fifo.push(frame);
  else entry.fifos.set(connection, [frame]);
}

/** Whether a frame the guard accepted on `live` has not been applied yet (it is still between the hook and the apply). */
export function hasUnappliedFrames(live: Y.Doc): boolean {
  return (entries.get(live)?.fifos.size ?? 0) > 0;
}

/** The next macrotask after an accept: every accepted frame has applied by now. One that has not makes the log unsure. */
export function settleAcceptedFrames(live: Y.Doc): void {
  const entry = entries.get(live);
  if (!entry || entry.fifos.size === 0) return;
  entry.fifos.clear();
  distrust(entry, 'accepted frame never applied');
}

/** Stop trusting `live`'s log (the guard saw it disagree with live). */
export function distrustReplicaLog(live: Y.Doc, why: string): void {
  const entry = entries.get(live);
  if (entry) distrust(entry, why);
}

/**
 * Yjs's own formatting cleanup: one transaction nested in a remote one that integrated formatting, opened once that
 * outer one's `afterTransaction` ran (`cleanupTransactions` → `cleanupYTextAfterTransaction`), local, origin null.
 */
function isFormattingCleanup(tr: Y.Transaction, cleanups: Y.Transaction[], entry: Entry): boolean {
  const outer = cleanups[0] as Y.Transaction & { _needFormattingCleanup?: boolean };
  return cleanups.length === 2 && cleanups[1] === tr && tr.origin === null && tr.local && !outer.local && outer._needFormattingCleanup === true && entry.afterDone.has(outer);
}

function install(live: Y.Doc, log: ExactReplicaLog, trusted: boolean, why: string | null = null): void {
  const entry: Entry = { log, trusted, why, generation: 0, fifos: new Map(), open: new WeakMap(), afterDone: new WeakSet() };
  entries.set(live, entry);
  const guarded = (fn: (...args: any[]) => void) => (...args: any[]) => {
    try {
      fn(...args);
    } catch {
      distrust(entry, 'listener failed'); // never out of a Yjs listener
    }
  };
  live.on(
    'beforeTransaction',
    guarded((tr: Y.Transaction) => {
      const cleanups = (live as unknown as { _transactionCleanups: Y.Transaction[] })._transactionCleanups;
      if (cleanups.length > 1 && !isFormattingCleanup(tr, cleanups, entry)) distrust(entry, 'nested transaction');
      const connection = connectionOf(tr.origin);
      if (connection === null) return;
      const fifo = entry.fifos.get(connection);
      const frame = fifo?.shift();
      if (fifo && fifo.length === 0) entry.fifos.delete(connection);
      if (!frame) return distrust(entry, 'connection transaction with no accepted frame');
      entry.open.set(tr, { frame, start: frame.clock?.() ?? 0, wallStarted: frame.wall?.() ?? 0 });
    }),
  );
  live.on(
    'afterTransaction',
    guarded((tr: Y.Transaction) => {
      entry.generation++;
      entry.afterDone.add(tr);
      const open = entry.open.get(tr);
      if (open && entry.trusted) {
        entry.log.recordFrame(open.frame.raw, Math.max(1, open.frame.steps));
        capped(entry);
      }
    }),
  );
  live.on(
    'afterTransactionCleanup',
    guarded((tr: Y.Transaction) => {
      const open = entry.open.get(tr);
      if (!open) return;
      entry.open.delete(tr);
      const { frame, start, wallStarted } = open;
      if (frame.onApplied && frame.clock) frame.onApplied(frame.clock() - start, wallStarted);
    }),
  );
  live.on(
    'update',
    guarded((update: Uint8Array, origin: unknown) => {
      if (connectionOf(origin) !== null || !entry.trusted) return;
      entry.log.recordServerUpdate(update, Math.max(1, update.length));
      capped(entry);
    }),
  );
}
