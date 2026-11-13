/**
 * CCC collab integration — NOT upstream Docmost code (#827, ADR 0036, UPSTREAM_MODIFICATIONS.md §2 and #122).
 *
 * Automatic compaction and the bounded load. Yjs never shrinks a document: tombstones, client ids and a crafted struct
 * order stay in `pages.ydoc` for good, and a full replace does not help (it adds structs). Some of that makes every
 * later load of the page cost seconds (load-order inversion: two cheap frames, 7 s+ per load, growing M·N), and with
 * desired_count=1 a stall is an outage. So:
 *
 *   - The load (`loadStoredYdoc`, seam #122) applies the stored bytes under the #816 meter in count/enforce mode
 *     (W_MAX walk steps) with a vm deadline as the backstop (LOAD_DEADLINE_MS). A trip throws the compacting refusal
 *     (`{ reason }`, no message): Hocuspocus closes the waiting sockets and destroys the half-loaded document, the
 *     editor waits read-only and retries, a direct connection (the API) answers a retryable 503 (`directOpenRefusal`),
 *     and a compaction of the page starts from the row. A page whose stored bytes tripped deterministically is refused
 *     at once on its next loads (no second walk), until its row changes.
 *   - Compaction rebuilds the page as a FRESH document from its visible content: a plain copy of the live document's
 *     tree at an unload (`compactOnUnload`, seam #122), or the row's `content` after a load trip (`compactFromRow`; the
 *     store writes `content` and `ydoc` from one snapshot, #390). It carries the #429 write-idem ledger over and writes
 *     the next lineage epoch (`LINEAGE_ROOT`, compaction-registry.ts). It never changes visible content: the rebuilt
 *     bytes are decoded again and must reproduce the source (the live document's ADR 0019 digest, or `content` as the
 *     server schema reads it), or it aborts.
 *   - The write is a compare-and-swap on the row's ydoc (`sha256`) and touches nothing else: no `updated_at`, no
 *     `content`, no event (the page ETag reads `updated_at`, `last_updated_by_id` and `content` only). #840: the same
 *     transaction deletes the page's heal image (heal-image.ts), which named the bytes the swap replaced.
 *
 * When it may run: only with no connection (the unload, or a load nobody got), once the process has been up
 * COMPACTION_ARM_DELAY_MS (a pre-#827 task overlapping a deploy has no epoch rule and would merge a stale copy into a
 * compacted page), at most once per page per COMPACTION_MIN_INTERVAL_MS and one at a time per process
 * (`canStartCompaction`). Before that, a page that needs it answers try-later and nothing is written.
 *
 * The build runs under `runWithDeadline` (COMPACTION_DEADLINE_MS) and touches only documents it made: the live
 * document is read before it, outside the deadline. Its row's lineage and ledger are read from the decoded update
 * (write-idem.ts `ledgerOfDecoded`, over reconcile-store.ts `readRootMapEntries`), which integrates nothing and so also works on a row too costly to load.
 *
 * Logs: `COLLAB_PAGE_COMPACTION {"event":"requested"|"done"|"skipped"|"load_refused",…}` and `COLLAB_COMPACTION_FAILED
 * {…}`, written only through collab-ingress/compaction-log.ts, the guard's emitter too (check-infra-config §14 lists
 * the tokens, informational until the collab alarms of #792).
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import { ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { TiptapTransformer } from '@hocuspocus/transformer';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { ConflictScan, installConflictScanMeter, type ConflictScanMeter } from '../collab-ingress/conflict-scan';
import { logCompactionFailed, logCompactionRequested, logPageCompaction } from '../collab-ingress/compaction-log';
import { isDeadlineExceeded, runWithDeadline } from '../collab-ingress/deadline';
import {
  COMPACT_MAX_LIVE_STRUCTS,
  COMPACTION_DEADLINE_MS,
  C_MAX,
  E_MAX,
  LOAD_DEADLINE_MS,
  S_MAX,
  W_MAX,
} from '../collab-ingress/doc-bounds';
import { COLLAB_PAGE_COMPACTING_REASON, pageCompactingRefusal } from '../collab-ingress/collab-reasons';
import { capVerdict, compactionWouldHelp, liveStructure, type LiveStructure } from '../collab-ingress/live-structure';
import {
  buildRefused,
  canStartCompaction,
  clearCompacting,
  compactedRecently,
  compactionRequest,
  forgetBuildFailure,
  isClosedForCompaction,
  isCompacting,
  isPageFull,
  isSuperseded,
  lineageEpoch,
  liveWedged,
  markCompacting,
  markPageFull,
  markSuperseded,
  noteBuildFailed,
  orderHealRequested,
  pageFullUntil,
  MalformedLineageError,
  registerInflight,
  requestCompaction,
  resetBuildFailuresForTests,
  writeLineage,
  type CompactionReason,
  type CompactionRequest,
} from './compaction-registry';
import { accumulates } from './page-size';
import { liveContentDigest } from './doc-version';
import { storedProjection } from './persistence-steps';
import { serverSchema } from './prelim-content';
import { coveredRowDigest, lineageEpochOfStructs, markRowCovered, unloadCanCompact } from './reconcile-store';
import { stableHash, stableStringify } from './stable-hash';
import { hasStoreFailure, isStoreCurrent, recordStoreFailure, storeGenerationOf } from './store-failure-registry';
import { storeSafeJson } from './store-safe-json';
import { carryLedgerOver, ledgerOfDecoded, ledgerOfDoc, type LedgerEntry } from './write-idem';
import { yieldToEventLoop } from './yield-to-event-loop';
import { ensureHealImageTable } from './heal-image.installer';
import { deleteSealInTransaction } from './binding-seal';

/**
 * The non-detaching try-later close code: update-guard.ts's COLLAB_TRY_LATER_CODE (1013), restated rather than imported
 * because that module pulls in Hocuspocus and the guard, which the persistence and handler seams load this file
 * without. compaction.spec.ts pins the two equal.
 */
export const COMPACTION_TRY_LATER_CODE = 1013;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64');
const round = (ms: number): number => Math.round(ms);

// --- counts

export interface PageCounts {
  /** Structs in the document's store (items, GCs). */
  structs: number;
  /** Client ids in the document's store. */
  clients: number;
}

/** The document's struct and client-id counts: O(client ids). */
export function countStructs(doc: Y.Doc): PageCounts {
  let structs = 0;
  for (const list of doc.store.clients.values()) structs += list.length;
  return { structs, clients: doc.store.clients.size };
}

// --- the write gate (seam #2)

/**
 * 503: the page is being compacted (or drains to be, or this copy was superseded by a compaction, or its load was
 * refused as too costly). Nothing was changed; retry shortly (the fork's RetryAfterFilter adds `Retry-After`). The
 * `engine_busy` code is the platform's retryable "refused, nothing changed".
 */
export class PageCompactingException extends ServiceUnavailableException {
  constructor() {
    super({ message: 'this page is being compacted; nothing was changed — retry shortly', code: 'engine_busy' });
  }
}

/** A refusal thrown with the compacting reason (a load trip, a join refused while compacting). */
export function isPageCompactingRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { reason?: unknown }).reason === COLLAB_PAGE_COMPACTING_REASON;
}

/**
 * Seam #2, the first statement of a direct write once its connection is open (before any Yjs transaction, so a refusal
 * does not even bump the document's generation): a document compacting, draining or superseded takes no write. #847:
 * nor does a wedged one (`liveWedged`): the write would integrate but never be stored, broadcast or counted, so
 * answering it would acknowledge a write the row never gets. Refused until the page heals (compaction from live) or
 * unloads; never unwedged in place.
 */
export function assertDocWritable(doc: object | null | undefined): void {
  if (doc && (isClosedForCompaction(doc) || liveWedged(doc))) throw new PageCompactingException();
}

/** #847: the one wedge predicate (compaction-registry.ts), for the handler seam (#2), which imports this module. */
export { liveWedged };

/**
 * Seam #2, inside a content write's transaction: an append/prepend is refused as the API cap's `page_too_large` when
 * the page is page-full (the cap rule's mark: an exact measure found it past a structure cap compaction cannot fix),
 * or when its root already holds E_MAX children (O(1); an append/prepend only grows the root, and a page only the API
 * writes has no shadow to measure it, nor a load that counts children). A replace passes: it is how such a page gets
 * smaller. Comment marks pass (they add formatting, not nodes).
 */
export function refusesGrowth(doc: object, operation: string | undefined, rootChildrenCap: number = E_MAX): boolean {
  return accumulates(operation) && (isPageFull(doc) || rootChildren(doc) >= rootChildrenCap);
}

/** Live children of the page's `default` root, without creating it (0 for a non-Yjs or empty document). */
function rootChildren(doc: object): number {
  const share = (doc as { share?: unknown }).share;
  const root = share instanceof Map ? (share.get('default') as { _length?: unknown } | undefined) : undefined;
  return typeof root?._length === 'number' ? root._length : 0;
}

/** Seam #2: a direct connection's open failed. A load refused as compacting becomes the retryable 503; anything else as is. */
export function rethrowDirectOpenRefusal(err: unknown): never {
  throw isPageCompactingRefusal(err) ? new PageCompactingException() : err;
}

// --- the bounded load (seam #122)

/** What the last load of a document measured, for the caps (the guard reads it). */
export interface LoadStats extends PageCounts {
  /** Walk steps the meter counted. */
  steps: number;
  ms: number;
  /** The document's generation right after the load (store-failure-registry): unchanged = it still holds the row. */
  generation: number | undefined;
}
const loadStats = new WeakMap<object, LoadStats>();

/** The load's measurements for `doc`, or null when it was not loaded from stored bytes. */
export function loadStatsOf(doc: object): LoadStats | null {
  return loadStats.get(doc) ?? null;
}

/**
 * The load repair (legacy-repair.ts, `afterLoadDocument`) changed the freshly loaded document, from `before` (its
 * generation just before the repair). The document still counts as holding its row for compaction (`holdsItsRow`): the
 * repair only deletes, and makes the same deletes on every load of those bytes, so the compare-and-swap (on the row's
 * own bytes) and the digest check (on the repaired document) stay exact. Without this a drain requested at load would
 * never compact (the unload sees a changed, unstored document) and would refuse every join and write again on each
 * reload. Only when nothing else changed the document since its load.
 */
export function noteLoadRepaired(doc: object, before: number | undefined): void {
  const stats = loadStats.get(doc);
  if (!stats || before === undefined || stats.generation !== before) return;
  stats.generation = storeGenerationOf(doc);
}

/**
 * Pages whose stored bytes tripped a load: refused at once on the next load (no second walk) while the bytes are the
 * same. A meter trip is deterministic (strikes at once); a deadline can be a one-off stall, so it takes two. Bounded
 * (oldest out); forgotten when a load of the page succeeds or a compaction rewrites it.
 */
const LOAD_TRIP_STRIKES = 2;
const LOAD_TRIPS_MAX = 1_024;
const loadTrips = new Map<string, { digest: string; strikes: number }>();

function noteLoadTrip(pageId: string, digest: string, deterministic: boolean): void {
  const memo = loadTrips.get(pageId);
  const strikes = deterministic ? LOAD_TRIP_STRIKES : memo?.digest === digest ? memo.strikes + 1 : 1;
  loadTrips.delete(pageId);
  if (loadTrips.size >= LOAD_TRIPS_MAX) loadTrips.delete(loadTrips.keys().next().value as string);
  loadTrips.set(pageId, { digest, strikes });
}

/** Forget every load trip (jest only). */
export function resetLoadTripsForTests(): void {
  if (process.env.JEST_WORKER_ID === undefined) throw new Error('resetLoadTripsForTests is for jest only (#827)');
  loadTrips.clear();
  resetBuildFailuresForTests();
}

let meterInstance: ConflictScanMeter | null = null;
const meter = (): ConflictScanMeter => (meterInstance ??= installConflictScanMeter());

/** A load's bounds: W_MAX walk steps and LOAD_DEADLINE_MS in production (the spec passes smaller ones). */
export interface LoadBounds {
  /** Walk steps the load may take (the meter's budget). */
  steps: number;
  /** The vm backstop, ms. */
  deadlineMs: number;
  /** The page structure caps the loaded page is held to (LOAD_CAPS unless a spec passes smaller ones). */
  caps?: LoadCaps;
}
export interface LoadCaps {
  structs: number;
  clientIds: number;
  children: number;
  /** Live structs past which compaction is never attempted (COMPACT_MAX_LIVE_STRUCTS unless a spec passes smaller). */
  compactLive?: number;
}
const LOAD_CAPS: LoadCaps = Object.freeze({ structs: S_MAX, clientIds: C_MAX, children: E_MAX, compactLive: COMPACT_MAX_LIVE_STRUCTS });
export const LOAD_BOUNDS: LoadBounds = Object.freeze({ steps: W_MAX, deadlineMs: LOAD_DEADLINE_MS, caps: LOAD_CAPS });

/**
 * Seam #122: apply a page's stored ydoc into the loading Hocuspocus `document`, bounded. Replaces upstream's
 * `Y.applyUpdate(document, dbState)`; also records the bytes as covered (#731) and the load's counts.
 *
 * On a trip (W_MAX walk steps, or LOAD_DEADLINE_MS) it throws `pageCompactingRefusal()` and starts a compaction of the
 * page from its row when one may start. The half-loaded document must be discarded (Hocuspocus destroys it when the
 * hook throws). Any other failure (a malformed row, a meter that failed) is rethrown: the load fails, as before.
 *
 * Nothing listening on `document` may run deadline work: a nested deadline is refused.
 */
export function loadStoredYdoc(
  document: Y.Doc,
  pageId: string,
  bytes: Uint8Array,
  db: KyselyDB | CompactionStore,
  bounds: LoadBounds = LOAD_BOUNDS,
): void {
  let digest: string | undefined;
  const memo = loadTrips.get(pageId);
  if (memo) {
    digest = sha256(bytes);
    if (memo.digest === digest && memo.strikes >= LOAD_TRIP_STRIKES) {
      startRowCompaction(storeOf(db), pageId, 'load_trip', digest);
      throw pageCompactingRefusal();
    }
  }
  const scan = new ConflictScan(document, true, bounds.steps, pageCompactingRefusal());
  const started = performance.now();
  let deadline = false;
  try {
    // The deadline innermost, so the meter's own finally runs after a timeout has become an ordinary error.
    meter().metered(scan, () => runWithDeadline(() => Y.applyUpdate(document, bytes), bounds.deadlineMs));
  } catch (err) {
    deadline = isDeadlineExceeded(err);
    if (!deadline && scan.trip === null) throw err;
  }
  const ms = performance.now() - started;
  if (deadline || scan.trip !== null) {
    digest ??= sha256(bytes);
    noteLoadTrip(pageId, digest, !deadline);
    logPageCompaction('load_refused', pageId, { why: deadline ? 'deadline' : 'steps', steps: scan.steps, bytes: bytes.length, ms: round(ms) });
    startRowCompaction(storeOf(db), pageId, 'load_trip', digest);
    throw pageCompactingRefusal();
  }
  loadTrips.delete(pageId);
  markRowCovered(document, bytes); // #731: the next store's reconcile of these bytes is a no-op
  const stats: LoadStats = { ...countStructs(document), steps: scan.steps, ms, generation: storeGenerationOf(document) };
  loadStats.set(document, stats);
  requestIfOverSoftCaps(document, pageId, stats, bounds.steps, bounds.caps ?? LOAD_CAPS);
}

/**
 * The cap rule (`capVerdict`, live-structure.ts, the update guard's too) on a loaded page: past a soft cap it is
 * compacted at its next unload; past a hard cap it drains now when a compaction can start (else it waits for the next
 * unload, and its joins are served meanwhile); past a hard structure cap compaction would not fix (its visible content
 * is too big, measured with `liveStructure` only then; or it was compacted within the interval) it is marked page-full,
 * so an API append/prepend answers `page_too_large`.
 */
function requestIfOverSoftCaps(
  document: Y.Doc,
  pageId: string,
  stats: LoadStats,
  stepCap: number,
  caps: LoadCaps,
): void {
  let live: LiveStructure | undefined;
  const compactLive = caps.compactLive ?? COMPACT_MAX_LIVE_STRUCTS;
  // live ≤ every struct, so the walk runs only for a page that could be past COMPACT_MAX_LIVE_STRUCTS
  const liveStructs = stats.structs > compactLive ? (live = liveStructure(document)).structs : 0;
  const verdict = capVerdict(
    [
      { reason: 'structs', n: stats.structs, cap: caps.structs },
      { reason: 'client_ids', n: stats.clients, cap: caps.clientIds },
      { reason: 'load_steps', n: stats.steps, cap: stepCap },
      { reason: 'structs', n: liveStructs, cap: compactLive, hardOnly: true },
    ],
    () => compactionWouldHelp((live ??= liveStructure(document)), caps), // O(structs), as the load just was
    () => compactedRecently(document),
  );
  markPageFull(document, verdict.full, pageFullUntil(document, verdict));
  if (verdict.reason === null) return;
  const request: CompactionRequest = {
    reason: verdict.reason,
    userId: null,
    // Drain only when the unload can compact: a compaction can start, and the row is covered (a row whose bytes left
    // structs pending is not, and no writer can join a draining page to store it), or the drain would repeat on every
    // load with nothing compacting. Otherwise the request waits; a frame or probe can drain it once writers stored.
    drain: verdict.hard && canStartCompaction(pageId) && unloadCanCompact(document, pageId),
  };
  if (requestCompaction(document, request)) {
    logCompactionRequested(pageId, request, {
      structs: stats.structs,
      clientIds: stats.clients,
      steps: stats.steps,
      ...(live ? { liveStructs: live.structs, liveChildren: live.children } : {}),
    });
  }
}

// --- the unload (seam #122)

/** The part of a Hocuspocus `Document` compaction reads. */
export type CompactableDocument = Y.Doc & {
  readonly name: string;
  getConnectionsCount(): number;
  readonly connections: Map<{ close(event?: { code: number; reason: string }): void }, unknown>;
};

/**
 * Seam #122, `beforeUnloadDocument`: compact the document now if compaction was requested for it, nothing holds it, its
 * last store covers its current state, and a compaction may start. Never throws (a throw there keeps the document
 * resident). Resolves once the compaction settled; Hocuspocus then unloads the document if nothing joined meanwhile.
 */
export async function compactOnUnload(document: CompactableDocument, db: KyselyDB | CompactionStore): Promise<void> {
  let marked = false;
  try {
    if (isSuperseded(document) || isCompacting(document)) return;
    const request = compactionRequest(document);
    if (request === null) return;
    const pageId = pageIdOfDocumentName(document.name);
    if (pageId === null) return;
    // A socket or a direct write still holds it: its last leave unloads (and comes here) again.
    if (document.getConnectionsCount() !== 0) return;
    // Never past an unsaved or failed store: the CAS names the bytes this document last stored (or found stored), or
    // loaded when nothing changed since (a page opened and left without an edit never stores).
    if (!holdsItsRow(document)) return skipUnload(pageId, request, 'not_stored');
    const covered = coveredRowDigest(document);
    if (covered === null) return skipUnload(pageId, request, 'uncovered');
    // #840: an order heal is retried after a failed build (`orderHealRequested`): its page is closed to joiners until
    // it heals, so the per-page interval and the process gap bound its retries instead of the memo
    if (buildRefused(pageId, covered) && !orderHealRequested(document)) return skipUnload(pageId, request, 'failed_before');
    if (!canStartCompaction(pageId)) return;
    markCompacting(document); // synchronously: from here joins and writes answer try-later
    marked = true;
    await registerInflight(pageId, compactResident(document, pageId, request, covered, storeOf(db)));
  } catch (err) {
    // compactResident never rejects; this is the setup failing (never leave the document closed for nothing).
    if (marked && !isSuperseded(document)) clearCompacting(document);
    const page = pageIdOfDocumentName(document.name) ?? document.name;
    logCompactionFailed(page, compactionRequest(document)?.reason ?? null, 'unexpected', err);
  }
}

/** A requested compaction the unload cannot run: logged when it drained the page (everyone was closed for it). */
function skipUnload(pageId: string, request: CompactionRequest, why: 'not_stored' | 'uncovered' | 'failed_before'): void {
  if (request.drain) logPageCompaction('skipped', pageId, { reason: request.reason, why });
}

/** The document holds exactly the row bytes it last covered: stored since its last change, or unchanged since its load. */
function holdsItsRow(document: Y.Doc): boolean {
  if (isStoreCurrent(document)) return true;
  const stats = loadStats.get(document);
  const generation = storeGenerationOf(document);
  return !!stats && generation !== undefined && stats.generation === generation && !hasStoreFailure(document);
}

async function compactResident(
  document: CompactableDocument,
  pageId: string,
  request: CompactionRequest,
  covered: string,
  store: CompactionStore,
): Promise<void> {
  const started = performance.now();
  try {
    // The live reads, outside the deadline: a deadline may only cut work on documents it can throw away. The root
    // fragment is typed first (no transaction; `fromYdoc` would type it inside one, which reads as an edit).
    document.getXmlFragment('default');
    const generation = storeGenerationOf(document);
    const fromEpoch = lineageEpoch(document);
    const tree = snapshotTree(document.getXmlFragment('default'));
    // The ADR 0019 digest (doc-version.ts's), with adjacent same-marked text merged (`textRunsDigest`)
    const expected = textRunsDigest(storedProjection(document));
    const ledger = ledgerOfDoc(document);
    const before = countStructs(document);
    await yieldToEventLoop();
    if (storeGenerationOf(document) !== generation) return abandon(document, pageId, request.reason, 'changed');
    const at = Date.now();
    let built: CompactedBuild;
    try {
      built = runWithDeadline(() => buildCompacted({ tree }, ledger, fromEpoch + 1, at, { runs: expected }), COMPACTION_DEADLINE_MS);
    } catch (err) {
      return buildFailed(pageId, covered, err);
    }
    await yieldToEventLoop();
    const swap = await store.swapYdoc(pageId, built.update, {
      covered,
      stillCurrent: () => storeGenerationOf(document) === generation,
    });
    if (!swap.swapped) return abandon(document, pageId, request.reason, swap.why);
    markSuperseded(document, built.epoch);
    forgetBuildFailure(pageId);
    loadTrips.delete(pageId);
    closeJoinedConnections(document);
    logCompactionDone(pageId, request.reason, 'unload', {
      fromEpoch,
      toEpoch: built.epoch,
      before: { ...before, bytes: swap.beforeBytes ?? null },
      after: { ...built.counts, bytes: built.update.length },
      ms: performance.now() - started,
    });
  } catch (err) {
    clearCompacting(document);
    logCompactionFailed(pageId, request.reason, isDeadlineExceeded(err) ? 'deadline' : failureWhy(err), err);
  }
}

function abandon(document: object, pageId: string, reason: CompactionReason, why: string): void {
  clearCompacting(document);
  logPageCompaction('skipped', pageId, { reason, why });
}

/** A socket that joined while the document compacted (its auth passed just before): try later, on the new lineage. */
function closeJoinedConnections(document: CompactableDocument): void {
  for (const connection of [...document.connections.keys()]) {
    try {
      connection.close({ code: COMPACTION_TRY_LATER_CODE, reason: COLLAB_PAGE_COMPACTING_REASON });
    } catch {
      // a socket already gone
    }
  }
}

/**
 * Seam #122, in the store after the #731 skip: a superseded document (compacted, or of a lineage the row has left)
 * never stores. It records a store failure, so a settle on it fails closed instead of reporting its content as stored.
 */
export function skipStoreOfSuperseded(document: object): boolean {
  if (!isSuperseded(document)) return false;
  recordStoreFailure(document);
  return true;
}

// --- compaction from the row (after a load trip)

/** Start a compaction of `pageId` from its row in the background, when one may start. Returns whether it started. */
/**
 * Start a compaction of `pageId` from its row (after a load trip), unless one may not start now, or a build of these
 * very bytes (`digest`, when the caller has it) already failed for good (`buildRefused`).
 */
export function startRowCompaction(store: CompactionStore, pageId: string, reason: CompactionReason, digest?: string): boolean {
  if (digest !== undefined && buildRefused(pageId, digest)) return false;
  if (!canStartCompaction(pageId)) return false;
  logCompactionRequested(pageId, { reason, userId: null, drain: false }, null);
  void registerInflight(pageId, compactFromRow(store, pageId, reason));
  return true;
}

export type CompactionOutcome = 'done' | 'skipped' | 'failed';

/**
 * Rebuild `pageId`'s ydoc from its row's `content` (a page too costly to load). The row's ledger and epoch are read
 * from its decoded bytes; the rebuilt page must show exactly `content`, or nothing is written. Never rejects.
 */
export async function compactFromRow(
  store: CompactionStore,
  pageId: string,
  reason: CompactionReason,
): Promise<CompactionOutcome> {
  const started = performance.now();
  try {
    const row = await store.readRow(pageId);
    if (!row || !row.ydoc || row.ydoc.length === 0) {
      logPageCompaction('skipped', pageId, { reason, why: 'no_ydoc' });
      return 'skipped';
    }
    if (row.content === null || row.content === undefined) {
      logCompactionFailed(pageId, reason, 'no_content', null);
      return 'failed';
    }
    const bytes = row.ydoc;
    const content = row.content;
    const covered = sha256(bytes);
    await yieldToEventLoop();
    const at = Date.now();
    let built: CompactedBuild & { lineage: ReturnType<typeof readRowLineage> };
    try {
      built = runWithDeadline(() => {
        const lineage = readRowLineage(bytes);
        const json = storeSafeJson(content);
        return { lineage, ...buildCompacted({ json }, lineage.ledger, lineage.epoch + 1, at, { content: json }) };
      }, COMPACTION_DEADLINE_MS);
    } catch (err) {
      return buildFailed(pageId, covered, err);
    }
    await yieldToEventLoop();
    const swap = await store.swapYdoc(pageId, built.update, { covered, contentHash: row.contentHash });
    if (!swap.swapped) {
      logPageCompaction('skipped', pageId, { reason, why: swap.why });
      return 'skipped';
    }
    loadTrips.delete(pageId);
    forgetBuildFailure(pageId);
    logCompactionDone(pageId, reason, 'row', {
      fromEpoch: built.lineage.epoch,
      toEpoch: built.epoch,
      before: { structs: built.lineage.structs, clients: built.lineage.clients, bytes: bytes.length },
      after: { ...built.counts, bytes: built.update.length },
      ms: performance.now() - started,
      ledgerDropped: built.lineage.ledgerUnresolved,
    });
    return 'done';
  } catch (err) {
    logCompactionFailed(pageId, reason, isDeadlineExceeded(err) ? 'deadline' : failureWhy(err), err);
    return 'failed';
  }
}

/**
 * A compaction build (run under COMPACTION_DEADLINE_MS) threw: record it against the row bytes it was built from
 * (`noteBuildFailed`: the digest check, a malformed lineage, the deadline) and rethrow to the caller's catch. Only the
 * build: a store error around it (reading the row, the compare-and-swap: a lock or statement timeout, a dropped
 * connection) is transient, logged by the caller and retried after the per-page interval, never recorded.
 */
function buildFailed(pageId: string, digest: string, err: unknown): never {
  noteBuildFailed(pageId, digest, isDeadlineExceeded(err));
  throw err;
}

// --- reading the lineage and the ledger

/** The ledger as compaction reads and carries it (write-idem.ts owns the root: write-idem.fitness.spec.ts). */
export { ledgerOfDoc, type LedgerEntry };

export interface RowLineage extends PageCounts {
  epoch: number;
  ledger: LedgerEntry[];
  /** Live ledger entries whose key could not be read from the bytes (left out; their writes dedup no more). */
  ledgerUnresolved: number;
}

/**
 * A stored row's lineage epoch, write-idem ledger and counts, read from its decoded bytes (nothing is integrated).
 * Throws MalformedLineageError when the lineage root holds something compaction cannot have written.
 */
export function readRowLineage(bytes: Uint8Array): RowLineage {
  const { structs, ds } = Y.decodeUpdate(bytes);
  const epoch = lineageEpochOfStructs(structs, ds);
  if (epoch === null) throw new MalformedLineageError('epoch');
  const { ledger, unresolved } = ledgerOfDecoded(structs, ds);
  const clients = new Set<number>();
  for (const s of structs) clients.add(s.id.client);
  return { epoch, ledger, ledgerUnresolved: unresolved, structs: structs.length, clients: clients.size };
}

// --- the build

/** The rebuilt document would not show the content it was built from: nothing is written. */
export class CompactionDigestMismatchError extends Error {
  constructor() {
    super('the compacted page does not reproduce its source content; compaction aborted (#827)');
  }
}

export interface CompactedBuild {
  /** The rebuilt document's full update (what `pages.ydoc` gets). */
  update: Uint8Array;
  epoch: number;
  /** The counts of the rebuilt document as a load will see it. */
  counts: PageCounts;
  /** Its ADR 0019 digest. */
  digest: string;
}

/** A plain copy of a Yjs XML tree: what `fromYdoc` reads (node names, element attributes, text deltas), nothing else. */
export type TreeNode = { name: string; attrs: Record<string, unknown>; children: TreeNode[] } | { delta: unknown[] };

/**
 * A plain, deep copy of the live fragment's tree (read outside any deadline: it is the live document). Element
 * attributes and text deltas (inserts and their formats) are copied as stored, so the rebuilt page holds exactly what
 * `fromYdoc` reads from the live one, including attributes the schema would default or drop. A rebuild through the
 * schema instead (`toYdoc`) fills those in, which changes the digest: an element written without its default
 * attributes (any client can send one) would then make the page impossible to compact.
 */
export function snapshotTree(parent: Y.XmlFragment | Y.XmlElement): TreeNode[] {
  const out: TreeNode[] = [];
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlElement) {
      const attrs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(child.getAttributes())) attrs[key] = plainCopy(value);
      out.push({ name: child.nodeName, attrs, children: snapshotTree(child) });
    } else if (child instanceof Y.XmlText) {
      out.push({ delta: plainCopy(child.toDelta()) as unknown[] });
    }
    // Anything else (an XmlHook) the editor never writes; if fromYdoc read it, the digest check aborts the build.
  }
  return out;
}

/** A copy that shares nothing with the live document; a Yjs type (a legacy attribute value) as its JSON, as the store
 *  writes it (store-safe-json.ts calls `toJSON` first), so the digest is unchanged. */
const plainCopy = (value: unknown): unknown =>
  structuredClone(value instanceof Y.AbstractType ? (value as Y.AbstractType<unknown>).toJSON() : value);

const toPrelim = (node: TreeNode): Y.XmlElement | Y.XmlText => {
  if ('delta' in node) {
    const text = new Y.XmlText();
    text.applyDelta(node.delta);
    return text;
  }
  const element = new Y.XmlElement(node.name);
  for (const [key, value] of Object.entries(node.attrs)) element.setAttribute(key, value as never);
  if (node.children.length > 0) element.insert(0, node.children.map(toPrelim));
  return element;
};

/**
 * Build the compacted document from its source: the live tree (`snapshotTree`, the unload) or the row's `content`
 * (converted as upstream converts a content-only row, `TiptapTransformer.toYdoc`), plus the ledger and the lineage at
 * `epoch`. Then decode the encoded update into another fresh document, as the next load will, and require:
 *   - from the live tree, its ADR 0019 digest to equal `expected.digest` (the live document's): the version a
 *     conditional write holds survives the compaction;
 *   - from `content`, the same document as `expected.content` once both go through the server schema (the conversion
 *     fills in default attributes, so the digest can differ; nobody can hold a live version of a page that cannot
 *     load, and the page ETag reads `content`, which compaction never writes);
 *   - its epoch to be `epoch`.
 * Pure Yjs and ProseMirror on documents it made: safe under a deadline.
 */
export function buildCompacted(
  source: { tree: TreeNode[] } | { json: unknown },
  ledger: readonly LedgerEntry[],
  epoch: number,
  at: number,
  expected: { digest: string } | { runs: string } | { content: unknown },
): CompactedBuild {
  let built: Y.Doc;
  if ('tree' in source) {
    built = new Y.Doc();
    const nodes = source.tree.map(toPrelim);
    built.transact(() => {
      const fragment = built.getXmlFragment('default');
      if (nodes.length > 0) fragment.insert(0, nodes);
    });
  } else {
    built = TiptapTransformer.toYdoc(source.json as never, 'default', tiptapExtensions);
  }
  try {
    built.transact(() => carryLedgerOver(built, ledger));
    writeLineage(built, epoch, at);
    const update = Y.encodeStateAsUpdate(built);
    const check = new Y.Doc();
    try {
      Y.applyUpdate(check, update);
      check.getXmlFragment('default');
      const digest = liveContentDigest(check); // the ADR 0019 digest, as a conditional write will compute it
      const same =
        'digest' in expected
          ? digest === expected.digest
          : 'runs' in expected
            ? textRunsDigest(storedProjection(check)) === expected.runs
            : schemaDigest(storedProjection(check)) === schemaDigest(expected.content);
      if (!same || lineageEpoch(check) !== epoch) throw new CompactionDigestMismatchError();
      return { update, epoch, counts: countStructs(check), digest };
    } finally {
      check.destroy();
    }
  } finally {
    built.destroy();
  }
}

/**
 * The ADR 0019 digest of a stored projection with adjacent text nodes of equal marks merged into one: the same
 * ProseMirror document (ProseMirror itself joins such nodes), told apart only by how Yjs split the run. A live page can
 * hold such a split (a delete of a mark's opening format item that leaves its closing one, as the #781 load repair
 * does, keeps Yjs from cleaning the run up, and `fromYdoc` then emits two text nodes), while the rebuilt page never
 * does; compared exactly, such a page could never compact. After its compaction the page's exact digest changes once
 * (a conditional write that held the old one gets one 412 and re-reads).
 */
export function textRunsDigest(projection: unknown): string {
  return stableHash(mergeTextRuns(projection));
}

function mergeTextRuns(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(mergeTextRuns);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = k === 'content' && Array.isArray(v) ? joinRuns(v) : mergeTextRuns(v);
  return out;
}

function joinRuns(children: unknown[]): unknown[] {
  const joined: unknown[] = [];
  for (const raw of children) {
    const child = mergeTextRuns(raw) as { type?: unknown; text?: unknown; marks?: unknown };
    const last = joined[joined.length - 1] as { type?: unknown; text?: unknown; marks?: unknown } | undefined;
    if (
      last && last.type === 'text' && child?.type === 'text' && typeof last.text === 'string' && typeof child.text === 'string' &&
      Object.keys(last).every((k) => k === 'type' || k === 'text' || k === 'marks') &&
      Object.keys(child).every((k) => k === 'type' || k === 'text' || k === 'marks') &&
      stableStringify(last.marks ?? []) === stableStringify(child.marks ?? [])
    ) {
      joined[joined.length - 1] = { ...last, text: last.text + child.text };
    } else joined.push(child);
  }
  return joined;
}

/**
 * The digest of `json` as the server schema reads it (defaults filled in, unknown attributes dropped). ProseMirror's
 * `toJSON` hands out a node type's ONE defaultAttrs object for every node built without attrs, and stableStringify
 * writes an object it has already seen as null; so the JSON is copied first (a tree again), or two attrs-less
 * paragraphs in a row's content would never match the rebuilt page and the page could never compact.
 */
const schemaDigest = (json: unknown): string =>
  stableHash(JSON.parse(JSON.stringify(serverSchema().nodeFromJSON(json).toJSON())));

// --- the store

export interface CompactionRow {
  content: unknown;
  ydoc: Uint8Array | null;
  /** md5 of `content::text` (null for a null content): the row path's CAS on what it built from. */
  contentHash: string | null;
}

/** Flat, not a union: the server's tsconfig has strictNullChecks off, which defeats narrowing on `swapped`. */
export interface SwapResult {
  swapped: boolean;
  /** The row's ydoc size before the swap (null when unknown). */
  beforeBytes?: number | null;
  /** Why nothing was written: the row moved (`cas_miss`) or the document changed meanwhile (`changed`). */
  why?: 'cas_miss' | 'changed';
}

export interface SwapOptions {
  /** sha256 (base64) the row's ydoc must still have. */
  covered: string;
  /** For the row path: md5 of `content::text` the row must still have. */
  contentHash?: string | null;
  /** For the unload path: re-checked before commit; false rolls the write back (the document changed meanwhile). */
  stillCurrent?: () => boolean;
}

/** The two statements compaction needs (an interface so the unit spec runs without Postgres). */
export interface CompactionStore {
  readRow(pageId: string): Promise<CompactionRow | null>;
  /** Write `next` as the row's ydoc iff its current ydoc (and content, when given) still match. Nothing else changes. */
  swapYdoc(pageId: string, next: Uint8Array, options: SwapOptions): Promise<SwapResult>;
}

class StillCurrentRollback extends Error {}

/** The Postgres store. Each swap is one short transaction with lock and statement timeouts set before its lock. */
export function kyselyCompactionStore(db: KyselyDB): CompactionStore {
  return {
    async readRow(pageId) {
      // Aliases without underscores, so the CamelCasePlugin leaves them as written.
      const { rows } = await sql<{ content: unknown; ydoc: Uint8Array | null; contenthash: string | null }>`
        select content, ydoc, md5(content::text) as contenthash from pages where id = ${pageId}`.execute(db);
      const row = rows[0];
      if (!row) return null;
      return { content: row.content, ydoc: row.ydoc ? new Uint8Array(row.ydoc) : null, contentHash: row.contenthash };
    },
    async swapYdoc(pageId, next, { covered, contentHash, stillCurrent }) {
      await ensureHealImageTable(db); // #840: the heal row goes with the CAS
      try {
        return await db.transaction().execute(async (trx): Promise<SwapResult> => {
          await sql`set local lock_timeout = '2s'`.execute(trx);
          await sql`set local statement_timeout = '10s'`.execute(trx);
          // Only `ydoc`: no updated_at, content or event (the page ETag and history are untouched).
          const { rows } = await sql<{ before: number | string | null }>`
            update pages as p set ydoc = ${Buffer.from(next)}
            from (select id, octet_length(ydoc) as before from pages where id = ${pageId}) as o
            where p.id = o.id
              and encode(sha256(p.ydoc), 'base64') = ${covered}
              ${contentHash === undefined ? sql`` : sql`and md5(p.content::text) is not distinct from ${contentHash}`}
            returning o.before`.execute(trx);
          if (rows.length !== 1) return { swapped: false, why: 'cas_miss' };
          // #840 (I4): the row now holds a fresh, reload-stable lineage; a heal image of the bytes it replaced goes in the
          // same transaction (heal-image.ts).
          await sql`delete from ccc_page_heal_image where page_id = ${pageId}`.execute(trx);
          // #793: the epoch moves, so no binding sealed against the replaced bytes may be restored
          await deleteSealInTransaction(trx as unknown as KyselyDB, pageId);
          if (stillCurrent && !stillCurrent()) throw new StillCurrentRollback();
          const before = rows[0].before === null ? null : Number(rows[0].before);
          return { swapped: true, beforeBytes: before };
        });
      } catch (err) {
        if (err instanceof StillCurrentRollback) return { swapped: false, why: 'changed' };
        throw err;
      }
    },
  };
}

const stores = new WeakMap<object, CompactionStore>();
/** The Postgres store for a Kysely handle (one per handle), or `db` itself when it is a store (the unit specs'). */
export function compactionStoreOf(db: KyselyDB | CompactionStore): CompactionStore {
  return storeOf(db);
}
function storeOf(db: KyselyDB | CompactionStore): CompactionStore {
  if (typeof (db as CompactionStore).swapYdoc === 'function') return db as CompactionStore;
  let store = stores.get(db);
  if (!store) stores.set(db, (store = kyselyCompactionStore(db as KyselyDB)));
  return store;
}

// --- helpers and logs

const DOCUMENT_NAME = /^page\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The page id of a `page.<uuid>` document name (frame-admission.ts admits no other), or null. */
export function pageIdOfDocumentName(name: string): string | null {
  return DOCUMENT_NAME.exec(name)?.[1] ?? null;
}

function failureWhy(err: unknown): string {
  if (err instanceof CompactionDigestMismatchError) return 'digest_mismatch';
  if (err instanceof MalformedLineageError) return 'malformed_lineage';
  return 'error';
}

interface Counted extends PageCounts {
  bytes: number | null;
}

function logCompactionDone(
  pageId: string,
  reason: CompactionReason,
  from: 'unload' | 'row',
  r: { fromEpoch: number; toEpoch: number; before: Counted; after: Counted; ms: number; ledgerDropped?: number },
): void {
  logPageCompaction('done', pageId, {
    reason,
    from,
    fromEpoch: r.fromEpoch,
    toEpoch: r.toEpoch,
    structsBefore: r.before.structs,
    structsAfter: r.after.structs,
    clientIdsBefore: r.before.clients,
    clientIdsAfter: r.after.clients,
    bytesBefore: r.before.bytes,
    bytesAfter: r.after.bytes,
    ms: round(r.ms),
    ledgerDropped: r.ledgerDropped || undefined,
  });
}

