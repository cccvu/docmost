/**
 * CCC collab integration — NOT upstream Docmost code (#840, ADR 0036, UPSTREAM_MODIFICATIONS.md #122).
 *
 * Never serve a reload-unstable page, and keep every persisted one recoverable without loss. Yjs integrates some frames
 * into one order live and another after a reload (order-parity.ts), and a reload is not even idempotent: the stored
 * bytes of such a page show every joiner and every restart another order than the editors saw, and can flip on each
 * load. So the persistence seam (#122) checks order where it encodes and where it loads:
 *
 *   - Store. Before the row lock (`prepareStore`): the snapshot and its order check in one synchronous run, then an
 *     unstable store's heal image; under the lock (`storeSnapshotUnderLock`) that snapshot is written only while it
 *     holds the locked row (#390), else it is taken again there. In the store's transaction (`persistOrderState`):
 *     Stable: store as before and delete any heal row (one naming the row's bytes while `content` is unchanged: also
 *     write the stable bytes, which the unchanged-content return would skip, or the named bytes stay unhealed).
 *     Unstable, or unknown (the reload threw: `reload_failed`): store the raw bytes and live-order `content` as before
 *     (no item is lost; live's lineage stays continuous for the #390 reconcile; the bytes are written even when
 *     `content` is unchanged, so `row_sha` names them), and in the SAME transaction upsert the page's heal row: a
 *     compacted copy of live (#827's tree copy at the next epoch), verified (its ADR 0019 digest is live's once text
 *     runs Yjs left split are joined, #827's `textRunsDigest`, and it reloads strict-equal to itself), with `row_sha` =
 *     sha256 of the raw bytes, or no image when it cannot be built.
 *     After the commit, compaction is requested (`order_divergence`): unstable drains now when one can start; unknown
 *     waits for the next unload (one slow reload is no evidence; a joiner still meets the guard's join check).
 *   - Load (`loadStableYdoc`, the only loader of `pages.ydoc`; heal-image.fitness.spec.ts pins it).
 *     (a) a heal row naming the row's bytes: once compaction is armed, one transaction compare-and-swaps the image in
 *         and deletes the heal row (compaction's own swap, which deletes it), then the image is served; before that,
 *         try-later. A swap that loses a race re-reads the row.
 *     (b) a heal row without an image: once armed, the image is rebuilt from the row's `content` (live's JSON at that
 *         store) and used only if it verifies losslessly (`healImageFromContent`); else try-later + alert.
 *     (c) a heal row naming other bytes (stale: only a pre-#840 task in a rolling overlap or after a rollback writes
 *         ydoc without one, and it served the reload order): the stale row is dropped and the row is (d).
 *     (d) no heal row: served as before; an unstable (legacy, pre-#840) row requests compaction from the loaded tree,
 *         which is the order users already see today, and from then on the only one.
 *   Every branch hands the exact bytes it applied to the guard's replica log (`attachReplicaLog`). The load's
 *   `COLLAB_ORDER_DIVERGENCE` lines are rate-limited per page and outcome (order-divergence-log.ts).
 *
 * Invariants (the plan's crash table): I1 `pages.ydoc` always holds every item live had at the last committed store;
 * I2 an unstable row is never served unhealed; I3 a heal uses live itself or a verified image (from live's tree, or
 * from `content` only when it is exactly what live showed at the store), never unverified JSON or a reload; I4 every
 * write is one transaction or one compare-and-swap. Pinned on real Postgres by heal-image.pg.spec.ts (T9).
 *
 * Reloads run under the #816 meter with a deadline innermost (the load's budget). Images are built under
 * COMPACTION_DEADLINE_MS from documents they made (the live tree is read with the snapshot, outside any deadline).
 * Logs: `COLLAB_ORDER_DIVERGENCE` (order-divergence-log.ts), and `COLLAB_COMPACTION_FAILED` when an image cannot be
 * built.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import { sql } from 'kysely';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import { COLLAB_PAGE_COMPACTING_REASON, pageCompactingRefusal } from '../collab-ingress/collab-reasons';
import { logCompactionFailed, logCompactionRequested } from '../collab-ingress/compaction-log';
import { ConflictScan, installConflictScanMeter, type ConflictScanMeter } from '../collab-ingress/conflict-scan';
import { runWithDeadline } from '../collab-ingress/deadline';
import { COMPACTION_DEADLINE_MS } from '../collab-ingress/doc-bounds';
import { attachReplicaLog } from '../collab-ingress/exact-replica-registry';
import { isReloadStable, strictOrderDiff } from '../collab-ingress/order-parity';
import {
  buildCompacted,
  COMPACTION_TRY_LATER_CODE,
  readRowLineage,
  compactionStoreOf,
  countStructs,
  LOAD_BOUNDS,
  loadStoredYdoc,
  snapshotTree,
  textRunsDigest,
  type CompactionStore,
  type LoadBounds,
  type TreeNode,
} from './compaction';
import { canStartCompaction, compactionArmed, lineageEpoch, requestCompaction, type CompactionRequest } from './compaction-registry';
import { ensureHealImageTable } from './heal-image.installer';
import { loadDivergenceLog, logOrderDivergence, type OrderDivergence } from './order-divergence-log';
import { coveredRowAtSnapshot, snapshotForStore, snapshotHoldsRow, type StoreSnapshot } from './persistence-steps';
import { unloadCanCompact } from './reconcile-store';
import { stableHash } from './stable-hash';
// The write-idem ledger is read and carried only through write-idem.ts (write-idem.fitness.spec.ts, PR 91).
import { ledgerOfDoc, type LedgerEntry } from './write-idem';
import { yieldToEventLoop } from './yield-to-event-loop';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64');

let meterInstance: ConflictScanMeter | null = null;
const meter = (): ConflictScanMeter => (meterInstance ??= installConflictScanMeter());

/**
 * Whether `live` and a reload of `encoded` (an encode of live, taken in the same synchronous run) are strict-equal: null
 * when they are, else the first difference's kind, or `reload_failed` when the reload threw (a trip of the walk budget
 * or the deadline, a malformed state). Only the reload runs under the meter and the deadline; live is read outside.
 */
const RELOAD_FAILED = 'reload_failed';

function reloadDiff(live: Y.Doc, encoded: Uint8Array, bounds: LoadBounds): string | null {
  const reload = new Y.Doc({ gc: live.gc, gcFilter: live.gcFilter });
  try {
    const scan = new ConflictScan(reload, true, bounds.steps);
    meter().metered(scan, () => runWithDeadline(() => Y.applyUpdate(reload, encoded), bounds.deadlineMs));
  } catch {
    return RELOAD_FAILED;
  }
  return strictOrderDiff(live, reload)?.kind ?? null;
}

// --- the store

/** What a heal image is built from: read from live with the store's snapshot. */
export interface HealSource {
  tree: TreeNode[];
  ledger: LedgerEntry[];
  /** Live's lineage epoch (the image takes the next); null when it is malformed (no image can be built). */
  epoch: number | null;
  /** Live's ADR 0019 digest (`stableHash` of the stored projection): the heal row's `content_digest`. */
  digest: string;
  /**
   * The same projection with adjacent equal-marked text joined (#827's `textRunsDigest`): what the image is checked
   * against. A rebuild never keeps a run Yjs left split (the #781 load repair leaves one), so the exact digest would
   * refuse every image of such a page, as it refused its compaction before #827 joined runs.
   */
  runs: string;
}

/** Flat, not a union: the server's tsconfig has strictNullChecks off, which defeats narrowing. */
export interface StoreOrder {
  /** The stored bytes reload into exactly live's order. */
  stable: boolean;
  /** Why not: an order-diff kind, or `reload_failed` (the reload threw: its deadline or walk budget; no evidence). */
  why: string | null;
  structs: number;
  ms: number;
  /** An unstable store's image source (null when stable, or when live's tree could not be read). */
  source: HealSource | null;
  /** The verified heal image, built before the row lock (`withHealImage`); null when stable or when it failed. */
  image: HealImage | null;
}

export interface HealImage {
  update: Uint8Array;
  epoch: number;
}

/**
 * The store's order check: does exactly `snapshot.state` reload into `document`'s order? Call it right after
 * `snapshotForStore`, with no await in between (live must still be the snapshot). An unstable store also reads what its
 * heal image is built from, in the same run (`withHealImage` builds it).
 */
export function checkStoreOrder(document: Y.Doc, snapshot: StoreSnapshot, bounds: LoadBounds = LOAD_BOUNDS): StoreOrder {
  const started = performance.now();
  const why = reloadDiff(document, snapshot.state, bounds);
  let source: HealSource | null = null;
  // Stable: these bytes rebuild live exactly, so they are the guard's new replay checkpoint (the log spans one store).
  if (why === null) attachReplicaLog(document, snapshot.state);
  if (why !== null) {
    try {
      let epoch: number | null;
      try {
        epoch = lineageEpoch(document);
      } catch {
        epoch = null; // MalformedLineageError: no image (the row still goes in, with none)
      }
      source = {
        tree: snapshotTree(document.getXmlFragment('default')),
        ledger: ledgerOfDoc(document),
        epoch,
        digest: stableHash(snapshot.json),
        runs: textRunsDigest(snapshot.json),
      };
    } catch {
      source = null;
    }
  }
  return { stable: why === null, why, structs: countStructs(document).structs, ms: performance.now() - started, source, image: null };
}

/** The image reloads into another order than its own: never written as a heal. */
export class HealImageUnstableError extends Error {
  constructor() {
    super('the heal image does not reload strict-equal to itself; not written (#840)');
  }
}

/**
 * The verified heal image of `source` (#827's build: a fresh document from live's tree, its digest checked against
 * live's with split text runs joined, as compaction checks it), which must also reload strict-equal to itself. Pure Yjs
 * on documents it made, under the compaction deadline.
 */
export function buildHealImage(source: HealSource | null, at: number = Date.now()): HealImage {
  if (source === null || source.epoch === null) throw new Error('no heal image source (#840)');
  const { tree, ledger, runs } = source;
  const epoch = source.epoch + 1;
  return runWithDeadline(() => {
    const built = buildCompacted({ tree }, ledger, epoch, at, { runs });
    const check = new Y.Doc();
    Y.applyUpdate(check, built.update);
    if (!isReloadStable(check).stable) throw new HealImageUnstableError();
    return { update: built.update, epoch: built.epoch };
  }, COMPACTION_DEADLINE_MS);
}

/**
 * `order` with its heal image (an unstable or unknown order only; a stable one is returned as is). A build that fails is
 * logged `COLLAB_COMPACTION_FAILED` and leaves `image` null: the heal row then goes in without one, and the load
 * rebuilds it from the row's `content` when that verifies (`loadStableYdoc`). Pure Yjs; no I/O.
 */
export function withHealImage(pageId: string, order: StoreOrder): StoreOrder {
  if (order.stable) return order;
  const started = performance.now();
  let image: HealImage | null = null;
  try {
    image = buildHealImage(order.source);
  } catch (err) {
    logCompactionFailed(pageId, 'order_divergence', 'heal_image', err);
  }
  return { ...order, image, ms: order.ms + performance.now() - started };
}

/** What a store writes, decided before its row lock where it can be (`prepareStore`). */
export interface PreparedStore {
  snapshot: StoreSnapshot;
  order: StoreOrder;
  /** The row bytes the document covered when the snapshot was taken (persistence-steps.ts `coveredRowAtSnapshot`). */
  coveredRow: string | null;
  /** Taken under the row lock (the row was not the one the document covered), not before it. */
  underLock: boolean;
}

/**
 * Seam #122, BEFORE the store's row lock: the snapshot, its order check (one synchronous run) and, after a loop turn, an
 * unstable store's heal image. All of it depends only on live and the snapshot's bytes, so none of it holds the row's
 * `FOR UPDATE` lock. `storeSnapshotUnderLock` then decides, under the lock, whether these bytes may be written.
 */
export async function prepareStore(document: Y.Doc, pageId: string): Promise<PreparedStore> {
  const coveredRow = coveredRowAtSnapshot(document);
  const snapshot = snapshotForStore(document);
  const order = checkStoreOrder(document, snapshot);
  if (order.stable) return { snapshot, order, coveredRow, underLock: false };
  await yieldToEventLoop();
  return { snapshot, order: withHealImage(pageId, order), coveredRow, underLock: false };
}

/**
 * Seam #122, under the row lock after the #390 reconcile: the prepared store when its snapshot holds the locked row
 * (`snapshotHoldsRow`: the row is the bytes the document covered at the snapshot, so the write stays a superset of it;
 * an edit made since is newer than the recorded generation and the next store persists it), else a snapshot, order
 * check and image taken now, under the lock, as before #840 (another node's or an out-of-band write moved the row).
 */
export async function storeSnapshotUnderLock(
  document: Y.Doc,
  pageId: string,
  prepared: PreparedStore,
  rowYdoc: Uint8Array | null | undefined,
): Promise<PreparedStore> {
  if (snapshotHoldsRow(prepared.coveredRow, rowYdoc)) return prepared;
  const snapshot = snapshotForStore(document);
  const order = checkStoreOrder(document, snapshot);
  if (order.stable) return { snapshot, order, coveredRow: null, underLock: true };
  await yieldToEventLoop();
  return { snapshot, order: withHealImage(pageId, order), coveredRow: null, underLock: true };
}

/** What the store did about order (flat, see StoreOrder). */
export interface OrderStoreOutcome {
  unstable: boolean;
  /** The order is unknown: the store's reload threw (a deadline, the walk budget), which is no evidence of instability. */
  reloadFailed: boolean;
  /** The heal row holds a verified image. */
  imaged: boolean;
  /** This step wrote `pages.ydoc` itself (an unstable store whose content was unchanged): mark it covered. */
  ydocWritten: boolean;
  structs: number;
  ms: number;
}

/**
 * Inside the store's transaction, after the snapshot and before the unchanged-content return: stable deletes the page's
 * heal row (and, when it had one and `contentUnchanged`, writes the stable bytes over the unstable ones it named);
 * unstable or unknown (`reload_failed`) writes the raw bytes (when `contentUnchanged`, else the store's own write does)
 * and upserts the heal row with the image built before the lock, or with none. `row_sha` names exactly the bytes this
 * store writes. Throws only what the database throws (the store then rolls back and records a failure, as for any store).
 */
export async function persistOrderState(
  db: KyselyDB | HealImageStore,
  trx: unknown,
  pageId: string,
  snapshot: StoreSnapshot,
  order: StoreOrder,
  contentUnchanged: boolean,
): Promise<OrderStoreOutcome> {
  const store = healStoreOf(db);
  const base = { reloadFailed: order.why === RELOAD_FAILED, structs: order.structs, ms: order.ms };
  if (order.stable) {
    // A heal row names the row's (unstable) bytes: with content unchanged nothing else rewrites them, so this step does,
    // or the row would be served unhealed (I2).
    const ydocWritten = await store.clear(trx, pageId, contentUnchanged ? snapshot.state : null);
    return { ...base, unstable: false, imaged: false, ydocWritten };
  }
  const image = order.image;
  const epoch = image?.epoch ?? (order.source?.epoch != null ? order.source.epoch + 1 : -1);
  // Live's digest at this store, which the `content` written in this transaction carries: a load that must rebuild the
  // image from `content` uses it only if it still hashes to this.
  const contentDigest = order.source?.digest ?? stableHash(snapshot.json);
  await store.put(trx, pageId, { image: image?.update ?? null, rowSha: sha256(snapshot.state), epoch, contentDigest }, contentUnchanged ? snapshot.state : null);
  return { ...base, unstable: true, imaged: image != null, ydocWritten: contentUnchanged };
}

/**
 * After the store committed: an unstable one requests compaction from live (`order_divergence`), drains the page now
 * when a compaction can start (its sockets close 1013, so it unloads and compacts; the heal row covers a crash until
 * then), and logs. An unknown order (`reload_failed`: one slow reload, a GC pause on an honest page) never drains: it
 * is compacted at its next unload, and a joiner is still checked by the guard's own join check. #827: like every drain,
 * only when the page heals after it: the unload can compact it (`unloadCanCompact`, which a failed build never stops for
 * an order heal), or the store wrote an image the next load adopts. A page with neither (bytes that leave structs
 * pending, no image) keeps its writers; its joiners wait on the guard's join check. Never throws.
 */
export function afterOrderStore(document: Y.Doc, pageId: string, outcome: OrderStoreOutcome | null | undefined): void {
  try {
    if (!outcome?.unstable) return;
    const heals = outcome.imaged || unloadCanCompact(document, pageId, 'order_divergence');
    const request: CompactionRequest = { reason: 'order_divergence', userId: null, drain: !outcome.reloadFailed && canStartCompaction(pageId) && heals };
    if (requestCompaction(document, request)) logCompactionRequested(pageId, request, { structs: outcome.structs });
    if (request.drain) drainSockets(document);
    const word = outcome.reloadFailed ? RELOAD_FAILED : outcome.imaged ? 'heal_image' : 'image_failed';
    divergence({ page: pageId, where: 'store', structs: outcome.structs, ms: outcome.ms, outcome: word });
  } catch {
    // bookkeeping after a committed store: never a reason to fail it
  }
}

/** Close every socket of a Hocuspocus document 1013 with the compacting reason (the update guard's drain). */
function drainSockets(document: Y.Doc): void {
  const connections = (document as { getConnections?: () => Array<{ webSocket?: { close(code: number, reason: string): void } }> }).getConnections?.() ?? [];
  for (const connection of connections) {
    try {
      connection.webSocket?.close(COMPACTION_TRY_LATER_CODE, COLLAB_PAGE_COMPACTING_REASON);
    } catch {
      // already closing
    }
  }
}

const divergence = (e: Omit<OrderDivergence, 'suspects'>, alert = false): void => logOrderDivergence({ ...e, suspects: [] }, alert);

// --- the load

/** How many times a load re-reads a row that moved under it before it answers try-later. */
const LOAD_HEAL_ATTEMPTS = 3;

/**
 * Seam #122, the ONLY load of a stored `pages.ydoc` (in place of `loadStoredYdoc`, which it calls): applies a
 * reload-stable state into `document`, or throws `pageCompactingRefusal()` (try-later; Hocuspocus destroys the
 * half-loaded document). See the header for the branches.
 */
export async function loadStableYdoc(
  document: Y.Doc,
  pageId: string,
  bytes: Uint8Array,
  db: KyselyDB | (HealImageStore & CompactionStore),
  bounds: LoadBounds = LOAD_BOUNDS,
): Promise<void> {
  const store = healStoreOf(db as KyselyDB | HealImageStore);
  let row: Uint8Array | null = bytes;
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    const heal = await store.read(pageId);
    const rowSha = sha256(row);
    const log = (outcome: string, alert = false, structs = 0) =>
      loadDivergenceLog({ page: pageId, where: 'load', structs, ms: performance.now() - started, outcome, suspects: [] }, alert);
    const reread = async (outcome: string): Promise<void> => {
      row = attempt < LOAD_HEAL_ATTEMPTS ? await store.readYdoc(pageId) : null;
      if (row === null || row.length === 0) {
        log(outcome);
        throw pageCompactingRefusal();
      }
    };
    if (heal && heal.currentSha !== rowSha) {
      await reread('row_moved'); // the row moved since it was read: decide on what it holds now
      continue;
    }
    if (heal && heal.rowSha === rowSha) {
      // A pre-#827 task overlapping a deploy would merge its stale copy into the new lineage: not before it is armed.
      if (!compactionArmed()) {
        log('not_armed');
        throw pageCompactingRefusal();
      }
      let image = heal.image;
      let contentHash: string | undefined;
      let outcome = 'healed';
      if (image === null) {
        // The store could not build one: rebuild it from the row's `content`, used only if it verifies (I3).
        const rebuilt = await healImageFromContent(store, pageId, row, heal);
        if (rebuilt.moved) {
          await reread('row_moved');
          continue;
        }
        if (rebuilt.update === null) {
          log('image_missing', true);
          throw pageCompactingRefusal();
        }
        image = rebuilt.update;
        contentHash = rebuilt.contentHash;
        outcome = 'healed_from_content';
      }
      const swap = await compactionStoreOf(db as KyselyDB | CompactionStore).swapYdoc(pageId, image, { covered: rowSha, contentHash });
      if (!swap.swapped) {
        await reread('cas_lost');
        continue;
      }
      loadStoredYdoc(document, pageId, image, db as KyselyDB | CompactionStore, bounds);
      attachReplicaLog(document, image);
      log(outcome, false, countStructs(document).structs);
      return;
    }
    // (c) a stale heal row, or (d) none: the row as it is.
    loadStoredYdoc(document, pageId, row, db as KyselyDB | CompactionStore, bounds);
    attachReplicaLog(document, row);
    const why = reloadDiff(document, Y.encodeStateAsUpdate(document), bounds);
    const structs = countStructs(document).structs;
    if (heal) {
      // Only a pre-#840 writer leaves a heal row naming other bytes, and that code served the reload order: drop the row
      // (a compare-and-swap on its row_sha) and treat the bytes as a legacy row.
      try {
        await store.dropStale(pageId, heal.rowSha);
      } catch {
        // the next load drops it (it stays stale)
      }
    }
    if (why !== null) {
      // A row stored before #840: compact from the tree just loaded (the order users already see), at its unload.
      const request: CompactionRequest = { reason: 'order_divergence', userId: null, drain: false };
      if (requestCompaction(document, request)) logCompactionRequested(pageId, request, { structs });
      log(heal ? 'stale_legacy' : 'legacy', false, structs);
    } else if (heal) {
      log('stale_dropped', false, structs);
    }
    return;
  }
}

/** Flat, not a union (strictNullChecks is off). */
interface ContentImage {
  /** The verified image, or null (with `why`). */
  update: Uint8Array | null;
  /** md5 of the `content` it was verified against, for the swap's compare-and-swap. */
  contentHash?: string;
  /** The row no longer holds the bytes the heal row names: re-read it. */
  moved: boolean;
  why?: string;
}

/**
 * The heal image of a heal row stored without one, rebuilt from the row's `content`: the store writes `content` in the
 * same transaction as the raw bytes and the heal row, from the same snapshot, so it is live's JSON at that store. It is
 * used only when it is lossless against that store:
 *   - the row still holds the bytes the heal row names (`row_sha`), read in the same statement as `content`;
 *   - `content` still hashes to live's ADR 0019 digest at that store (`content_digest`, written with the heal row);
 *   - `content` holds no U+FFFD (`storeSafeJson` writes a lone surrogate or NUL as one, which the Yjs tree kept raw);
 *   - every write-idem ledger entry and the lineage epoch read from the raw bytes (the row path's reader, which
 *     integrates nothing), and the epoch is the heal row's;
 *   - the rebuilt page equals `content` with adjacent equal-marked text joined (`buildCompacted` with #827's
 *     `textRunsDigest`, under the compaction deadline: ProseMirror joins such runs on the way in, so the only
 *     difference allowed is how Yjs split a run, never a character, a mark or an attribute), and it reloads
 *     strict-equal to itself.
 * The conversion goes through the server schema, so a tree it normalizes otherwise (elements without their default
 * attributes: raw or crafted writes) cannot match and stays try-later.
 * Anything else is null (try-later and an alert, as before), logged `COLLAB_COMPACTION_FAILED` `heal_from_content` once:
 * the refusal is remembered for the same row and content (CONTENT_HEAL_RETRY_MS), so a client retrying try-later does
 * not rerun a page-sized conversion per attempt. The swap then also checks `content` is unchanged.
 */
async function healImageFromContent(store: HealImageStore, pageId: string, row: Uint8Array, heal: HealRow): Promise<ContentImage> {
  const read = await store.readContent(pageId);
  if (!read || read.currentSha !== heal.rowSha) return { update: null, moved: true };
  const key = `${heal.rowSha}|${read.contentHash}|${heal.contentDigest}`;
  const refused = contentHealRefusals.get(pageId);
  if (refused && refused.key === key && refused.until > Date.now()) return { update: null, moved: false, why: refused.why };
  const result = await verifiedImageFromContent(pageId, row, heal, read);
  if (result.update === null) rememberContentHealRefusal(pageId, key, result.why ?? 'unverified');
  return result;
}

/** A refused rebuild from `content` is not retried for the same row and content within this window. */
export const CONTENT_HEAL_RETRY_MS = 10 * 60_000;
const CONTENT_HEAL_REFUSALS_MAX = 1_024;
const contentHealRefusals = new Map<string, { key: string; why: string; until: number }>();

function rememberContentHealRefusal(pageId: string, key: string, why: string): void {
  contentHealRefusals.delete(pageId); // re-inserted last: the map evicts the oldest first
  if (contentHealRefusals.size >= CONTENT_HEAL_REFUSALS_MAX) contentHealRefusals.delete(contentHealRefusals.keys().next().value);
  contentHealRefusals.set(pageId, { key, why, until: Date.now() + CONTENT_HEAL_RETRY_MS });
}

/** The specs: forget every remembered refusal. */
export function resetContentHealRefusalsForTests(): void {
  contentHealRefusals.clear();
}

async function verifiedImageFromContent(
  pageId: string,
  row: Uint8Array,
  heal: HealRow,
  read: { content: unknown; contentHash: string | null },
): Promise<ContentImage> {
  const content = read.content;
  const digest = heal.contentDigest;
  const refuse = (why: string): ContentImage => {
    logCompactionFailed(pageId, 'order_divergence', 'heal_from_content', new HealFromContentRefusedError(why));
    return { update: null, moved: false, why };
  };
  if (content === null || content === undefined || read.contentHash === null || digest === null) return refuse('no_content');
  try {
    if (stableHash(content) !== digest) return refuse('content_changed');
    if (JSON.stringify(content).includes('\uFFFD')) return refuse('replacement_char');
    await yieldToEventLoop();
    const at = Date.now();
    const update = runWithDeadline(() => {
      const lineage = readRowLineage(row);
      if (lineage.ledgerUnresolved > 0 || lineage.epoch + 1 !== heal.epoch) throw new HealSourceMismatchError();
      // `content` is exactly live's projection (its exact digest matched above); the rebuild is checked against it with
      // split text runs joined, as compaction checks it (#827: ProseMirror joins them on the way in)
      const built = buildCompacted({ json: content }, lineage.ledger, heal.epoch, at, { runs: textRunsDigest(content) });
      const check = new Y.Doc();
      Y.applyUpdate(check, built.update);
      if (!isReloadStable(check).stable) throw new HealImageUnstableError();
      return built.update;
    }, COMPACTION_DEADLINE_MS);
    return { update, contentHash: read.contentHash, moved: false };
  } catch (err) {
    logCompactionFailed(pageId, 'order_divergence', 'heal_from_content', err);
    return { update: null, moved: false, why: 'unverified' };
  }
}

/** A rebuild from `content` was refused before it ran (`why`: a fixed word). */
export class HealFromContentRefusedError extends Error {
  constructor(readonly why: string) {
    super(`no heal image from content: ${why} (#840)`);
  }
}

/** The raw bytes do not carry exactly the ledger and epoch the heal row was stored with: no image from `content`. */
export class HealSourceMismatchError extends Error {
  constructor() {
    super('the row\'s ledger or lineage does not match its heal row; no image rebuilt from content (#840)');
  }
}

/**
 * Seam #122: a load that applied no stored ydoc (a content-only row's conversion, a fresh or missing page) hands the
 * exact bytes it applied (the empty document's own encoding when it applied none) to the guard's replica log.
 */
export function noteLoadedBytes(document: Y.Doc, bytes: Uint8Array): void {
  attachReplicaLog(document, bytes);
}

// --- the store of heal rows

export interface HealRow {
  image: Uint8Array | null;
  rowSha: string;
  epoch: number;
  /** Live's ADR 0019 digest at the store that wrote it (the `content` it wrote); null: unknown. */
  contentDigest: string | null;
  /** sha256 (base64) of the page's ydoc now (null: none), read in the same statement. */
  currentSha: string | null;
}

/** The statements the heal needs (an interface so the unit specs run without Postgres). */
export interface HealImageStore {
  /** The page's heal row and its row's current ydoc digest (one statement), or null. */
  read(pageId: string): Promise<HealRow | null>;
  /** The page's ydoc now (null: none, or no page). */
  readYdoc(pageId: string): Promise<Uint8Array | null>;
  /** The page's `content` (parsed from its text, as stored), md5 of that text, and its ydoc's digest, in one statement. */
  readContent(pageId: string): Promise<{ content: unknown; contentHash: string | null; currentSha: string | null } | null>;
  /** Delete the heal row iff it still names `rowSha` and the row's ydoc no longer has that digest. */
  dropStale(pageId: string, rowSha: string): Promise<void>;
  /** In the store's transaction: delete the page's heal row; when there was one and `ydoc` is given, write `ydoc` alone. True: written. */
  clear(trx: unknown, pageId: string, ydoc: Uint8Array | null): Promise<boolean>;
  /** In the store's transaction: write `ydoc` alone when given (no `updated_at`, no `content`), and upsert the heal row. */
  put(
    trx: unknown,
    pageId: string,
    heal: { image: Uint8Array | null; rowSha: string; epoch: number; contentDigest: string | null },
    ydoc: Uint8Array | null,
  ): Promise<void>;
}

/** The Postgres store. Each method awaits the table first (ensureHealImageTable: a resolved promise after the boot). */
export function kyselyHealImageStore(db: KyselyDB): HealImageStore {
  return {
    async read(pageId) {
      await ensureHealImageTable(db);
      // Aliases without underscores, so the CamelCasePlugin leaves them as written.
      const { rows } = await sql<{ image: Uint8Array | null; rowsha: string; epoch: number; contentdigest: string | null; currentsha: string | null }>`
        select h.image, h.row_sha as rowsha, h.epoch, h.content_digest as contentdigest, encode(sha256(p.ydoc), 'base64') as currentsha
        from ccc_page_heal_image h join pages p on p.id = h.page_id
        where h.page_id = ${pageId}`.execute(db);
      const r = rows[0];
      if (!r) return null;
      return {
        image: r.image ? new Uint8Array(r.image) : null,
        rowSha: r.rowsha,
        epoch: Number(r.epoch),
        contentDigest: r.contentdigest,
        currentSha: r.currentsha,
      };
    },
    async readYdoc(pageId) {
      const { rows } = await sql<{ ydoc: Uint8Array | null }>`select ydoc from pages where id = ${pageId}`.execute(db);
      return rows[0]?.ydoc ? new Uint8Array(rows[0].ydoc) : null;
    },
    async readContent(pageId) {
      // `content::text`, parsed here: the CamelCasePlugin would rewrite a jsonb value's nested keys. The md5 is the one
      // compaction's swap compares (`md5(content::text)`).
      const { rows } = await sql<{ contenttext: string | null; contenthash: string | null; currentsha: string | null }>`
        select content::text as contenttext, md5(content::text) as contenthash, encode(sha256(ydoc), 'base64') as currentsha
        from pages where id = ${pageId}`.execute(db);
      const r = rows[0];
      if (!r) return null;
      return { content: r.contenttext === null ? null : JSON.parse(r.contenttext), contentHash: r.contenthash, currentSha: r.currentsha };
    },
    async dropStale(pageId, rowSha) {
      await ensureHealImageTable(db);
      await sql`
        delete from ccc_page_heal_image h
        where h.page_id = ${pageId} and h.row_sha = ${rowSha}
          and h.row_sha is distinct from (select encode(sha256(p.ydoc), 'base64') from pages p where p.id = ${pageId})`.execute(db);
    },
    async clear(trx, pageId, ydoc) {
      await ensureHealImageTable(db);
      const t = trx as KyselyDB;
      const { rows } = await sql`delete from ccc_page_heal_image where page_id = ${pageId} returning page_id`.execute(t);
      if (rows.length === 0 || !ydoc) return false;
      await sql`update pages set ydoc = ${Buffer.from(ydoc)} where id = ${pageId}`.execute(t);
      return true;
    },
    async put(trx, pageId, heal, ydoc) {
      await ensureHealImageTable(db);
      const t = trx as KyselyDB;
      if (ydoc) await sql`update pages set ydoc = ${Buffer.from(ydoc)} where id = ${pageId}`.execute(t);
      await sql`
        insert into ccc_page_heal_image (page_id, image, row_sha, epoch, content_digest)
        values (${pageId}, ${heal.image ? Buffer.from(heal.image) : null}, ${heal.rowSha}, ${heal.epoch}, ${heal.contentDigest})
        on conflict (page_id) do update
          set image = excluded.image, row_sha = excluded.row_sha, epoch = excluded.epoch,
              content_digest = excluded.content_digest, created_at = now()`.execute(t);
    },
  };
}

const stores = new WeakMap<object, HealImageStore>();
/** The Postgres store for a Kysely handle (one per handle), or `db` itself when it is a store (the unit specs'). */
export function healStoreOf(db: KyselyDB | HealImageStore): HealImageStore {
  const s = db as HealImageStore;
  if (typeof s.read === 'function' && typeof s.put === 'function' && typeof s.readContent === 'function') return s;
  let store = stores.get(db);
  if (!store) stores.set(db, (store = kyselyHealImageStore(db as KyselyDB)));
  return store;
}
