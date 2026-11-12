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
 * (`settleAcceptedFrames`), a frame live applies before one the guard accepted earlier on another connection (each
 * accepted frame is numbered process-wide; `LOG_OUT_OF_ORDER`: the shadow took them in the guard's order, so the guard
 * rebuilds it), or a transaction opened inside another's cleanup (Yjs then runs the outer one's GC and
 * merges after the inner one integrated, which a replay of separate transactions does not). One nested transaction is
 * Yjs's own and is kept: the formatting cleanup a remote transaction that integrated formatting opens after its
 * `afterTransaction` (`cleanupYTextAfterTransaction`, origin null). A replay of the outer transaction's input opens
 * the same one at the same point, so the inner one's recorded update replays as a no-op. Whatever the log misses, the
 * guard's tripwire (a strict compare of every replay with live) catches. An untrusted log is trusted
 * again only by a verified checkpoint (`attachReplicaLog` again, or the guard's rebuild when a reload strict-equals live).
 *
 * Memory (#679: the log's buffer is native memory, outside every heap cap). Each log is capped (exact-replica.ts), and
 * all of them together by COLLAB_REPLICA_LOG_TOTAL_BYTES, counted here, in one place, by retained capacity. An entry
 * that does not fit its log's cap is not recorded: the log stops being trusted (`LOG_OVER_CAP`). One that would take
 * the total past its limit first stops trusting the largest logs until it fits (`LOG_OVER_TOTAL`; possibly its own).
 * Either way the log's bytes go at once and the guard's next frame re-verifies the page: a reload equal to live
 * re-arms it, otherwise the page heals. A destroyed document releases its share (`destroy`, which Hocuspocus calls on
 * unload and on a failed load); a document dropped without one releases it when it is collected. Not counted: the
 * checkpoint, one page-sized encoding per resident page (the bytes live loaded from, or a verified encoding of live),
 * which scales with resident pages as live and its shadow do.
 *
 * The listeners never throw (a throw in a Yjs listener stops later listeners and wedges the document's cleanup for good).
 * `onApplied` (the guard's charge of live's own apply, #840 part 4) is called with the CPU ms from `beforeTransaction`
 * to `afterTransactionCleanup`, on the clocks the guard passed.
 */
import * as Y from 'yjs';
import { ExactReplicaLog } from './exact-replica';
import { COLLAB_REPLICA_LOG_TOTAL_BYTES } from './limits';

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
/** An accepted frame, numbered in the order the guard accepted it (process-wide, monotonic). */
type QueuedFrame = AcceptedFrame & { seq: number };
let acceptedSeq = 0;

type Entry = {
  log: ExactReplicaLog;
  trusted: boolean;
  /** Why it is not (diagnostics). */
  why: string | null;
  /** Live's transactions that could change its encoding (`encodingChanged`): the join check's cache key (#840 part 5). */
  generation: number;
  /** Per open transaction, the store's pending structs and deletes when it began. */
  readonly pendingAt: WeakMap<Y.Transaction, PendingState>;
  /** Per connection, the frames accepted and not yet applied (one, in practice: 4.7.1 handles a connection's frames in turn). */
  readonly fifos: Map<object, QueuedFrame[]>;
  /** The open connection transaction's frame and when it began. */
  readonly open: WeakMap<Y.Transaction, { frame: QueuedFrame; start: number; wallStarted: number }>;
  /** Transactions whose `afterTransaction` has run (the nested-transaction rule). */
  readonly afterDone: WeakSet<Y.Transaction>;
  /** The log's retained bytes as the process total last counted them. */
  counted: number;
};

/** A store's pending structs and pending deletes, which `encodeStateAsUpdate` merges into its output. */
export type PendingState = { structs: unknown; update: Uint8Array | null; ds: Uint8Array | null };

export function pendingStateOf(store: Y.Doc['store']): PendingState {
  const structs = store.pendingStructs;
  return { structs, update: structs?.update ?? null, ds: store.pendingDs };
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean =>
  a === b || (a !== null && b !== null && a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length)));

/**
 * Could `tr` (once its `afterTransaction` runs, or after it) have changed what `encodeStateAsUpdate` of its document
 * gives? yjs 13.6.30 encodes the struct store and its delete set, then merges in the pending deletes and the pending
 * structs. So: a state vector that moved, a delete, a struct split (`_mergeStructs`: a split that Yjs fails to merge
 * back, a redone item, keeps its new boundary), or other pending structs or deletes. Anything unreadable answers yes
 * (a cache key that moves too often only costs a re-check). `before` is `pendingStateOf` at the transaction's start.
 */
export function encodingChanged(tr: Y.Transaction, before: PendingState | undefined): boolean {
  for (const ranges of tr.deleteSet.clients.values()) if (ranges.length > 0) return true;
  const after = tr.afterState;
  if (!(after instanceof Map) || after.size !== tr.beforeState.size) return true;
  for (const [client, clock] of after) if (tr.beforeState.get(client) !== clock) return true;
  const merges = (tr as unknown as { _mergeStructs?: unknown })._mergeStructs;
  if (!Array.isArray(merges) || merges.length > 0) return true;
  if (before === undefined) return true;
  const now = pendingStateOf(tr.doc.store);
  return now.structs !== before.structs || now.update !== before.update || !sameBytes(now.ds, before.ds);
}

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
/** Why the largest logs stopped being trusted when all of them together reached the process total: re-verified alike. */
export const LOG_OVER_TOTAL = 'log over process total';
/**
 * Why a log stopped being trusted when live applied an accepted frame before one accepted earlier on another
 * connection: the shadow took them in the guard's order, so it is not live's image. Re-verified alike (a tripwire:
 * 4.7.1 applies them in the order the synchronous guard saw them, collab-update-guard.wiring.spec.ts).
 */
export const LOG_OUT_OF_ORDER = 'frame applied out of order';

/**
 * The process total (COLLAB_REPLICA_LOG_TOTAL_BYTES): every log's retained bytes, kept here alone. `holders` are the
 * entries holding any (strongly: a log is freed by `distrust`, an advance, `destroy` or the finalizer, never dropped
 * while counted).
 */
const budget = { limit: COLLAB_REPLICA_LOG_TOTAL_BYTES, total: 0, holders: new Set<Entry>() };
/** A document dropped without `destroy` (never by Hocuspocus 4.7.1, which destroys on unload and on a failed load). */
const collected = new FinalizationRegistry<Entry>((entry) => release(entry));

/** Bring the total in line with what `entry`'s log retains now. Every path that changes a log's buffer ends here. */
function account(entry: Entry): void {
  const retained = entry.log.retained;
  budget.total += retained - entry.counted;
  entry.counted = retained;
  if (retained > 0) budget.holders.add(entry);
  else budget.holders.delete(entry);
}

function distrust(entry: Entry, why: string): void {
  if (!entry.trusted) return;
  entry.trusted = false;
  entry.why = why;
  entry.log.advance(EMPTY); // its entries no longer rebuild anything: never kept (only a verified checkpoint re-arms it)
  account(entry);
}

/** The document is gone: its log's bytes leave the total, and nothing more is recorded or trusted. */
function release(entry: Entry): void {
  entry.fifos.clear();
  entry.trusted = false;
  entry.why = 'document destroyed';
  entry.log.advance(EMPTY);
  account(entry);
}

/**
 * Room in the process total for `growth` more bytes of `entry`'s log: the largest logs stop being trusted until there
 * is. False when that took `entry`'s own log (it is then untrusted, and the entry is not recorded).
 */
function reserve(entry: Entry, growth: number): boolean {
  while (budget.total + growth > budget.limit) {
    let largest: Entry | null = null;
    for (const held of budget.holders) if (largest === null || held.counted > largest.counted) largest = held;
    if (largest === null) break;
    distrust(largest, LOG_OVER_TOTAL);
    if (largest === entry) return false;
  }
  if (budget.total + growth <= budget.limit) return true;
  distrust(entry, LOG_OVER_TOTAL); // more than the whole total on its own (a limit below one log's cap)
  return false;
}

/**
 * Record one entry, within the log's caps and the process total; never past either. Recording never drops an entry,
 * so one that does not fit makes the log untrusted instead (with no client frame to checkpoint it, a reader open while
 * API writes land, it would otherwise grow without bound).
 */
function record(entry: Entry, bytes: Uint8Array, steps: number): void {
  if (!entry.trusted) return;
  const retained = entry.log.wouldRetain(bytes.length, steps);
  if (retained === Infinity) return distrust(entry, LOG_OVER_CAP);
  if (retained > entry.counted && !reserve(entry, retained - entry.counted)) return;
  entry.log.recordFrame(bytes, steps);
  account(entry);
}

/** All replay logs' retained bytes in this process (specs and diagnostics). */
export function replicaLogTotal(): number {
  return budget.total;
}

/** Specs: run with another process total; returns the restore. */
export function setReplicaLogTotalForTests(limit: number): () => void {
  const was = budget.limit;
  budget.limit = limit;
  return () => {
    budget.limit = was;
  };
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
    account(known);
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

/**
 * Whether `live`'s log was distrusted for a reason that says nothing about live's order (its caps, the process total,
 * frames applied out of the guard's order): the guard rebuilds the page's shadow at its next frame or join, and a
 * reload equal to live re-arms the log.
 */
export function replicaLogNeedsReverify(live: Y.Doc): boolean {
  const why = replicaLogDistrust(live);
  return why === LOG_OVER_CAP || why === LOG_OVER_TOTAL || why === LOG_OUT_OF_ORDER;
}

/** Why `live`'s log is not trusted (null: it is, or there is none). Diagnostics and specs. */
export function replicaLogDistrust(live: Y.Doc): string | null {
  const entry = entries.get(live);
  return entry && !entry.trusted ? entry.why : null;
}

/** Live's transactions so far that could change its encoding (`encodingChanged`); 0 with no log. */
export function mutationGeneration(live: Y.Doc): number {
  return entries.get(live)?.generation ?? 0;
}

/** The guard accepted `frame` from `connection`: live applies it next on that connection. */
export function noteAcceptedFrame(live: Y.Doc, connection: object, frame: AcceptedFrame): void {
  const entry = entries.get(live);
  if (!entry) return;
  const queued: QueuedFrame = { ...frame, seq: ++acceptedSeq };
  const fifo = entry.fifos.get(connection);
  if (fifo) fifo.push(queued);
  else entry.fifos.set(connection, [queued]);
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
  const entry: Entry = { log, trusted, why, generation: 0, pendingAt: new WeakMap(), fifos: new Map(), open: new WeakMap(), afterDone: new WeakSet(), counted: 0 };
  entries.set(live, entry);
  collected.register(live, entry, entry);
  live.once('destroy', () => {
    release(entry);
    collected.unregister(entry);
  });
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
      entry.pendingAt.set(tr, pendingStateOf(live.store));
      const cleanups = (live as unknown as { _transactionCleanups: Y.Transaction[] })._transactionCleanups;
      if (cleanups.length > 1 && !isFormattingCleanup(tr, cleanups, entry)) distrust(entry, 'nested transaction');
      const connection = connectionOf(tr.origin);
      if (connection === null) return;
      const fifo = entry.fifos.get(connection);
      const frame = fifo?.shift();
      if (fifo && fifo.length === 0) entry.fifos.delete(connection);
      if (!frame) return distrust(entry, 'connection transaction with no accepted frame');
      // Every frame accepted before this one, on any connection, must have applied first: the shadow took them in order.
      for (const queue of entry.fifos.values()) if (queue.length > 0 && queue[0].seq < frame.seq) distrust(entry, LOG_OUT_OF_ORDER);
      entry.open.set(tr, { frame, start: frame.clock?.() ?? 0, wallStarted: frame.wall?.() ?? 0 });
    }),
  );
  live.on(
    'afterTransaction',
    guarded((tr: Y.Transaction) => {
      let changed = true;
      try {
        changed = encodingChanged(tr, entry.pendingAt.get(tr));
      } finally {
        if (changed) entry.generation++; // a throw counts as a change: the cache key never stays put by mistake
      }
      entry.afterDone.add(tr);
      const open = entry.open.get(tr);
      if (open) record(entry, open.frame.raw, Math.max(1, open.frame.steps));
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
      if (connectionOf(origin) !== null) return;
      record(entry, update, Math.max(1, update.length));
    }),
  );
}
