/**
 * CCC collab integration — NOT upstream Docmost code (#827, ADR 0036).
 *
 * The cross-hook state of automatic compaction. The guard (collab-ingress), the persistence seam (#122) and the direct
 * write gate (seam #2) each hold the SAME resident Hocuspocus `Document`, so per-document state is a WeakMap keyed by
 * it (entries vanish with the document, as in store-failure-registry.ts). A compaction outlives its document (it runs
 * at unload, or after a failed load), so the loader of the next document for that page waits on it by page id.
 *
 * Per document:
 *   - requested: compaction is wanted at the next unload (a soft cap, a probe, a mirror timeout), with why and for
 *     whom; `drain` (a hard cap) also closes the document's sockets so the unload comes now.
 *   - compacting: a compaction of this document is running; joins and writes answer try-later.
 *   - superseded: the stored row now holds a newer lineage (compacted, or another node's); this document must never
 *     store or serve again.
 *   - pageFull: the last cap verdict (`capVerdict`: a load, a rebuild, a probe, a mirrored server write, or a frame that
 *     would grow it) found it at or over a hard cap that compaction cannot fix (its visible content is too big, or it was
 *     compacted within the interval): an API append/prepend is refused `page_too_large` (`refusesGrowth`). Cleared by
 *     the next exact measure under the caps (a replace that shrank it, mirrored; a probe; a reload).
 *
 * The lineage epoch is a server-only Yjs root (LINEAGE_ROOT, `{ epoch, at }`) inside `pages.ydoc`, so the bytes and the
 * epoch that labels them can never disagree. Only `writeLineage` writes it (compaction's fresh document), and only the
 * server: the update guard keeps every root but `default` out of client frames.
 */
import * as Y from 'yjs';
import {
  COMPACTION_ARM_DELAY_MS,
  COMPACTION_GAP_FACTOR,
  COMPACTION_MIN_INTERVAL_MS,
  COMPACTIONS_IN_FLIGHT_MAX,
} from '../collab-ingress/doc-bounds';

/** The server-only root that carries the page's lineage epoch. */
export const LINEAGE_ROOT = '__ccc_lineage';

/** Why compaction was requested (logged as is: fixed words only). */
export const COMPACTION_REASONS = [
  'structs',
  'client_ids',
  'children',
  'load_steps',
  'load_trip',
  'probe',
  'mirror_deadline',
  'rebuild_deadline',
] as const;
export type CompactionReason = (typeof COMPACTION_REASONS)[number];

export interface CompactionRequest {
  readonly reason: CompactionReason;
  /** The user whose frame (or load) crossed the bound; null for a server-caused request. */
  readonly userId: string | null;
  /** Close the document's sockets now (a hard cap) instead of waiting for the last to leave. */
  readonly drain: boolean;
}

interface DocState {
  requested: CompactionRequest | null;
  compacting: boolean;
  superseded: boolean;
  /** The epoch the row moved to, when known (another node's foreign lineage, or this node's compaction). */
  supersededBy: number | null;
  /** Page-full (false: not), until when (ms, the registry's clock; null: until a measure clears it). */
  pageFull: false | { until: number | null };
}

const docs = new WeakMap<object, DocState>();
const stateOf = (doc: object): DocState => {
  let s = docs.get(doc);
  if (!s) {
    s = { requested: null, compacting: false, superseded: false, supersededBy: null, pageFull: false };
    docs.set(doc, s);
  }
  return s;
};

/**
 * Request compaction of `doc`. The first reason wins (it is what crossed first); a later `drain` upgrades a request
 * that had none. Returns true when the request is new or newly draining (log it then), false when nothing changed.
 */
export function requestCompaction(doc: object, request: CompactionRequest): boolean {
  const s = stateOf(doc);
  if (s.requested === null) {
    s.requested = { reason: request.reason, userId: request.userId, drain: request.drain };
    return true;
  }
  if (request.drain && !s.requested.drain) {
    s.requested = { ...s.requested, drain: true };
    return true;
  }
  return false;
}

export function compactionRequest(doc: object): CompactionRequest | null {
  return docs.get(doc)?.requested ?? null;
}
export function isDraining(doc: object): boolean {
  return docs.get(doc)?.requested?.drain === true;
}
export function isCompacting(doc: object): boolean {
  return docs.get(doc)?.compacting === true;
}
export function isSuperseded(doc: object): boolean {
  return docs.get(doc)?.superseded === true;
}
export function supersededBy(doc: object): number | null {
  return docs.get(doc)?.supersededBy ?? null;
}
/** Page-full now: marked, and the mark has not expired (`markPageFull`'s `until`). */
export function isPageFull(doc: object, now: number = clock.now()): boolean {
  const full = docs.get(doc)?.pageFull;
  return !!full && (full.until === null || now < full.until);
}
/** True while the document must take no join and no write: compacting, superseded or draining. */
export function isClosedForCompaction(doc: object): boolean {
  const s = docs.get(doc);
  return !!s && (s.compacting || s.superseded || s.requested?.drain === true);
}

export function markCompacting(doc: object): void {
  stateOf(doc).compacting = true;
}
/** A compaction of `doc` ended without superseding it (aborted, failed): the document serves again. */
export function clearCompacting(doc: object): void {
  const s = docs.get(doc);
  if (s) s.compacting = false;
}
/** The row moved to another lineage (`epoch` when known). Final: a superseded document never serves or stores again. */
export function markSuperseded(doc: object, epoch: number | null = null): void {
  const s = stateOf(doc);
  s.superseded = true;
  s.compacting = false;
  if (epoch !== null) s.supersededBy = epoch;
}
/**
 * Set or clear the page-full mark (a cap verdict, every time it measures the page exactly). `until`: the mark lapses
 * then (a page full only because it was compacted within the interval is compactable again once it ends); null: it
 * holds until a later verdict clears it (its visible content is too big).
 */
export function markPageFull(doc: object, full = true, until: number | null = null): void {
  stateOf(doc).pageFull = full ? { until } : false;
}

// --- by page: the compaction in flight (it outlives its document), the rate limit, the per-process limit

const inflight = new Map<string, Promise<void>>();
/** When each page last started a compaction (ms, the registry's clock). Pruned past the interval. */
const lastStarted = new Map<string, number>();
/**
 * Process-wide: no compaction starts before this (ms, the registry's clock). Set when one settles, to its end plus
 * COMPACTION_GAP_FACTOR × its duration, so back-to-back compactions of different pages hold at most about a third of
 * the process.
 */
let nextStartAt = 0;

export interface CompactionClock {
  /** Wall clock, ms. */
  now(): number;
  /** This process's uptime, ms. */
  uptimeMs(): number;
}
const processClock: CompactionClock = { now: () => Date.now(), uptimeMs: () => process.uptime() * 1000 };
let clock: CompactionClock = processClock;

/** Replace the clock (jest only). Returns the restore function. */
export function setCompactionClockForTests(next: CompactionClock): () => void {
  if (process.env.JEST_WORKER_ID === undefined) throw new Error('setCompactionClockForTests is for jest only (#827)');
  const previous = clock;
  clock = next;
  return () => {
    clock = previous;
  };
}

/**
 * False until the process has been up COMPACTION_ARM_DELAY_MS: during a rolling deploy a pre-#827 task may still serve
 * the page, and it would merge a stale copy into a compacted one. A page that needs compaction before then answers
 * try-later.
 */
export function compactionArmed(uptimeMs: number = clock.uptimeMs()): boolean {
  return uptimeMs >= COMPACTION_ARM_DELAY_MS;
}

let stopped = false;

/**
 * The process is shutting down (the collab gateway's drain began, seam §3 via `CollabSocketBounds.beginDrain`): no
 * compaction starts from now on; one in flight finishes. The drain unloads every resident document, and a compaction
 * at that unload would race the task that replaces this one, which on a rollback may predate #827 (it would merge a
 * pre-compaction copy into the compacted page). The page compacts on a later residency instead. Final for the process.
 */
export function stopCompactions(): void {
  stopped = true;
}

/** Undo `stopCompactions` (jest only). */
export function resumeCompactionsForTests(): void {
  if (process.env.JEST_WORKER_ID === undefined) throw new Error('resumeCompactionsForTests is for jest only (#827)');
  stopped = false;
}

/** Clear the process-wide gap after the last compaction (jest only: specs run many compactions back to back). */
export function resetCompactionGapForTests(): void {
  if (process.env.JEST_WORKER_ID === undefined) throw new Error('resetCompactionGapForTests is for jest only (#827)');
  nextStartAt = 0;
}

/**
 * Whether a compaction of `pageId` may start now: armed, the process not draining, none in flight for the page, fewer
 * than the per-process limit in flight, the process-wide gap after the last one elapsed (COMPACTION_GAP_FACTOR), and
 * none started for the page within COMPACTION_MIN_INTERVAL_MS. A page that may not start waits as for the in-flight
 * limit: its request stays, and the next unload (or load) tries again.
 */
export function canStartCompaction(pageId: string, now: number = clock.now()): boolean {
  if (!compactionArmed() || stopped) return false;
  if (inflight.has(pageId) || inflight.size >= COMPACTIONS_IN_FLIGHT_MAX) return false;
  if (now < nextStartAt) return false;
  const last = lastStarted.get(pageId);
  return last === undefined || now - last >= COMPACTION_MIN_INTERVAL_MS;
}

/**
 * Register `pageId`'s compaction (call when it starts, after `canStartCompaction`). It stays registered until it
 * settles; a loader of the page awaits it first (`awaitCompaction`). Throws if one is registered already: two
 * compactions of one page must never race.
 */
export function registerInflight(pageId: string, compaction: Promise<unknown>, now: number = clock.now()): Promise<void> {
  if (inflight.has(pageId)) throw new Error(`a compaction of page ${pageId} is in flight already (#827)`);
  for (const [id, at] of lastStarted) if (now - at >= COMPACTION_MIN_INTERVAL_MS) lastStarted.delete(id);
  lastStarted.set(pageId, now);
  const settled: Promise<void> = compaction.then(
    () => undefined,
    () => undefined,
  );
  const tracked = settled.finally(() => {
    if (inflight.get(pageId) === tracked) inflight.delete(pageId);
    const ended = clock.now();
    nextStartAt = Math.max(nextStartAt, ended + COMPACTION_GAP_FACTOR * Math.max(0, ended - now));
  });
  inflight.set(pageId, tracked);
  return tracked;
}

/** Resolves once no compaction of `pageId` is in flight. Never rejects (the loader reads the row whatever happened). */
export function awaitCompaction(pageId: string): Promise<void> {
  return inflight.get(pageId) ?? Promise.resolve();
}

export function isCompactionInflight(pageId: string): boolean {
  return inflight.has(pageId);
}

// --- the lineage epoch

/** The lineage root holds something only compaction could not have written: refuse rather than guess an epoch. */
export class MalformedLineageError extends Error {
  constructor(what: string) {
    super(`the page's ${LINEAGE_ROOT} root is malformed (${what}) (#827)`);
  }
}

/**
 * The document's lineage epoch: 0 when the root is absent (every page before its first compaction). Reads without
 * creating the root. Throws MalformedLineageError on a value that is not a non-negative safe integer.
 */
export function lineageEpoch(doc: Y.Doc): number {
  if (!doc.share.has(LINEAGE_ROOT)) return 0;
  const epoch = doc.getMap<unknown>(LINEAGE_ROOT).get('epoch');
  if (epoch === undefined) return 0;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) throw new MalformedLineageError('epoch');
  return epoch;
}

/** When the document's lineage was written (its last compaction), or null (never compacted, or a value compaction never writes). */
export function lineageAt(doc: Y.Doc): number | null {
  if (!doc.share.has(LINEAGE_ROOT)) return null;
  const at = doc.getMap<unknown>(LINEAGE_ROOT).get('at');
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/**
 * The document's lineage was compacted within COMPACTION_MIN_INTERVAL_MS (while compaction is armed): no compaction of
 * it can run before the interval ends, and the last one did not keep it under the caps. A cap verdict reads this as
 * page-full (`capVerdict`'s `recentlyCompacted`).
 */
export function compactedRecently(doc: Y.Doc, now: number = clock.now()): boolean {
  const at = lineageAt(doc);
  return at !== null && compactionArmed() && now - at < COMPACTION_MIN_INTERVAL_MS;
}

/**
 * When a page-full verdict lapses: null (never, until a measure clears it) when the page's visible content is too big
 * (`contentFull`), else when the compaction interval of its lineage ends (it is compactable again then).
 */
export function pageFullUntil(doc: Y.Doc, verdict: { full: boolean; contentFull: boolean }): number | null {
  if (!verdict.full || verdict.contentFull) return null;
  const at = lineageAt(doc);
  return at === null ? null : at + COMPACTION_MIN_INTERVAL_MS;
}

/** Write the lineage of a freshly built (compacted) document. The ONE writer of LINEAGE_ROOT. */
export function writeLineage(doc: Y.Doc, epoch: number, at: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError(`lineage epoch must be a non-negative safe integer, got ${epoch}`);
  doc.transact(() => {
    const lineage = doc.getMap<number>(LINEAGE_ROOT);
    lineage.set('epoch', epoch);
    lineage.set('at', at);
  });
}
