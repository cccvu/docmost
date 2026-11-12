/**
 * CCC collab integration — NOT upstream Docmost code (#840, ADR 0036, UPSTREAM_MODIFICATIONS.md #122).
 *
 * Never serve a reload-unstable page, and keep every persisted one recoverable without loss. Yjs integrates some frames
 * into one order live and another after a reload (order-parity.ts), and a reload is not even idempotent: the stored
 * bytes of such a page show every joiner and every restart another order than the editors saw, and can flip on each
 * load. So the persistence seam (#122) checks order where it encodes and where it loads:
 *
 *   - Store (`checkStoreOrder`, in the snapshot's synchronous run; `persistOrderState`, in the store's transaction).
 *     Stable: store as before and delete any heal row (one naming the row's bytes while `content` is unchanged: also
 *     write the stable bytes, which the unchanged-content return would skip, or the named bytes stay unhealed).
 *     Unstable: store the raw bytes and live-order `content` as before (no item is lost; live's lineage stays
 *     continuous for the #390 reconcile; the bytes are written even when `content` is unchanged, so `row_sha` names
 *     them), and in the SAME transaction upsert the page's heal row: a
 *     compacted copy of live (#827's tree copy at the next epoch), verified (its ADR 0019 digest is live's, and it
 *     reloads strict-equal to itself), with `row_sha` = sha256 of the raw bytes. If it cannot be built or verified the
 *     row still goes in, with no image: the page then answers try-later and alerts; nothing heals from a lossy source.
 *     After the commit, compaction is requested (`order_divergence`), draining now when one can start.
 *   - Load (`loadStableYdoc`, the only loader of `pages.ydoc`; heal-image.fitness.spec.ts pins it).
 *     (a) a heal row naming the row's bytes: once compaction is armed, one transaction compare-and-swaps the image in
 *         and deletes the heal row (compaction's own swap, which deletes it), then the image is served; before that,
 *         try-later. A swap that loses a race re-reads the row.
 *     (b) a heal row without an image: try-later + alert.
 *     (c) a heal row naming other bytes (stale: only a pre-#840 task in a rolling overlap writes ydoc without one):
 *         the loaded row's stability decides; stable is served and the stale row dropped, unstable is try-later + alert.
 *     (d) no heal row: served as before; an unstable (legacy, pre-#840) row requests compaction from the loaded tree,
 *         which is the order users already see today, and from then on the only one.
 *   Every branch hands the exact bytes it applied to the guard's replica log (`attachReplicaLog`).
 *
 * Invariants (the plan's crash table): I1 `pages.ydoc` always holds every item live had at the last committed store;
 * I2 an unstable row is never served unhealed; I3 a heal uses a verified image or live itself, never JSON or a reload;
 * I4 every write is one transaction or one compare-and-swap. Pinned on real Postgres by heal-image.pg.spec.ts (T9).
 *
 * Reloads run under the #816 meter with a deadline innermost (the load's budget); a reload that throws counts as
 * unstable. The image is built under COMPACTION_DEADLINE_MS from documents it made (the live tree is read with the
 * snapshot, outside any deadline). Logs: `COLLAB_ORDER_DIVERGENCE` (order-divergence-log.ts), and
 * `COLLAB_COMPACTION_FAILED` when an image cannot be built.
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
  compactionStoreOf,
  countStructs,
  ledgerOfDoc,
  LOAD_BOUNDS,
  loadStoredYdoc,
  snapshotTree,
  type CompactionStore,
  type LedgerEntry,
  type LoadBounds,
  type TreeNode,
} from './compaction';
import { canStartCompaction, compactionArmed, lineageEpoch, requestCompaction, type CompactionRequest } from './compaction-registry';
import { ensureHealImageTable } from './heal-image.installer';
import { logOrderDivergence, type OrderDivergence } from './order-divergence-log';
import type { StoreSnapshot } from './persistence-steps';
import { stableHash } from './stable-hash';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64');

let meterInstance: ConflictScanMeter | null = null;
const meter = (): ConflictScanMeter => (meterInstance ??= installConflictScanMeter());

/**
 * Whether `live` and a reload of `encoded` (an encode of live, taken in the same synchronous run) are strict-equal: null
 * when they are, else the first difference's kind, or `reload_failed` when the reload threw (a trip of the walk budget
 * or the deadline, a malformed state). Only the reload runs under the meter and the deadline; live is read outside.
 */
function reloadDiff(live: Y.Doc, encoded: Uint8Array, bounds: LoadBounds): string | null {
  const reload = new Y.Doc({ gc: live.gc, gcFilter: live.gcFilter });
  try {
    const scan = new ConflictScan(reload, true, bounds.steps);
    meter().metered(scan, () => runWithDeadline(() => Y.applyUpdate(reload, encoded), bounds.deadlineMs));
  } catch {
    return 'reload_failed';
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
  /** Live's ADR 0019 digest (`stableHash` of the stored projection). */
  digest: string;
}

/** Flat, not a union: the server's tsconfig has strictNullChecks off, which defeats narrowing. */
export interface StoreOrder {
  /** The stored bytes reload into exactly live's order. */
  stable: boolean;
  /** Why not: an order-diff kind, or `reload_failed`. */
  why: string | null;
  structs: number;
  ms: number;
  /** An unstable store's image source (null when stable, or when live's tree could not be read). */
  source: HealSource | null;
}

/**
 * The store's order check: does exactly `snapshot.state` reload into `document`'s order? Call it right after
 * `snapshotForStore`, with no await in between (live must still be the snapshot). An unstable store also reads what its
 * heal image is built from, in the same run.
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
      source = { tree: snapshotTree(document.getXmlFragment('default')), ledger: ledgerOfDoc(document), epoch, digest: stableHash(snapshot.json) };
    } catch {
      source = null;
    }
  }
  return { stable: why === null, why, structs: countStructs(document).structs, ms: performance.now() - started, source };
}

/** The image reloads into another order than its own: never written as a heal. */
export class HealImageUnstableError extends Error {
  constructor() {
    super('the heal image does not reload strict-equal to itself; not written (#840)');
  }
}

/**
 * The verified heal image of `source` (#827's build: a fresh document from live's tree, its digest checked against
 * live's), which must also reload strict-equal to itself. Pure Yjs on documents it made, under the compaction deadline.
 */
export function buildHealImage(source: HealSource | null, at: number = Date.now()): { update: Uint8Array; epoch: number } {
  if (source === null || source.epoch === null) throw new Error('no heal image source (#840)');
  const { tree, ledger, digest } = source;
  const epoch = source.epoch + 1;
  return runWithDeadline(() => {
    const built = buildCompacted({ tree }, ledger, epoch, at, { digest });
    const check = new Y.Doc();
    Y.applyUpdate(check, built.update);
    if (!isReloadStable(check).stable) throw new HealImageUnstableError();
    return { update: built.update, epoch: built.epoch };
  }, COMPACTION_DEADLINE_MS);
}

/** What the store did about order (flat, see StoreOrder). */
export interface OrderStoreOutcome {
  unstable: boolean;
  /** The heal row holds a verified image. */
  imaged: boolean;
  /** This step wrote `pages.ydoc` itself (an unstable store whose content was unchanged): mark it covered. */
  ydocWritten: boolean;
  structs: number;
  ms: number;
}

/**
 * Inside the store's transaction, after the snapshot and before the unchanged-content return: stable deletes the page's
 * heal row (and, when it had one and `contentUnchanged`, writes the stable bytes over the unstable ones it named); unstable writes the raw bytes (when `contentUnchanged`, else the store's own write does) and upserts the heal
 * row with the verified image, or with none when it cannot be built (logged COLLAB_COMPACTION_FAILED). Throws only what
 * the database throws (the store then rolls back and records a failure, as for any store).
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
  if (order.stable) {
    // A heal row names the row's (unstable) bytes: with content unchanged nothing else rewrites them, so this step does,
    // or the row would be served unhealed (I2).
    const ydocWritten = await store.clear(trx, pageId, contentUnchanged ? snapshot.state : null);
    return { unstable: false, imaged: false, ydocWritten, structs: order.structs, ms: order.ms };
  }
  const started = performance.now();
  let image: { update: Uint8Array; epoch: number } | null = null;
  try {
    image = buildHealImage(order.source);
  } catch (err) {
    logCompactionFailed(pageId, 'order_divergence', 'heal_image', err);
  }
  const epoch = image?.epoch ?? (order.source?.epoch != null ? order.source.epoch + 1 : -1);
  await store.put(trx, pageId, { image: image?.update ?? null, rowSha: sha256(snapshot.state), epoch }, contentUnchanged ? snapshot.state : null);
  return { unstable: true, imaged: image !== null, ydocWritten: contentUnchanged, structs: order.structs, ms: order.ms + performance.now() - started };
}

/**
 * After the store committed: an unstable one requests compaction from live (`order_divergence`), drains the page now
 * when a compaction can start (its sockets close 1013, so it unloads and compacts; the heal row covers a crash until
 * then), and logs. Never throws.
 */
export function afterOrderStore(document: Y.Doc, pageId: string, outcome: OrderStoreOutcome | null | undefined): void {
  try {
    if (!outcome?.unstable) return;
    const request: CompactionRequest = { reason: 'order_divergence', userId: null, drain: canStartCompaction(pageId) };
    if (requestCompaction(document, request)) logCompactionRequested(pageId, request, { structs: outcome.structs });
    if (request.drain) drainSockets(document);
    divergence({ page: pageId, where: 'store', structs: outcome.structs, ms: outcome.ms, outcome: outcome.imaged ? 'heal_image' : 'image_failed' }, !outcome.imaged);
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
      divergence({ page: pageId, where: 'load', structs, ms: performance.now() - started, outcome }, alert);
    if (heal && heal.currentSha !== rowSha) {
      // The row moved since it was read: decide on what it holds now.
      row = attempt < LOAD_HEAL_ATTEMPTS ? await store.readYdoc(pageId) : null;
      if (row === null || row.length === 0) {
        log('row_moved');
        throw pageCompactingRefusal();
      }
      continue;
    }
    if (heal && heal.rowSha === rowSha) {
      if (heal.image === null) {
        log('image_missing', true);
        throw pageCompactingRefusal();
      }
      // A pre-#827 task overlapping a deploy would merge its stale copy into the new lineage: not before it is armed.
      if (!compactionArmed()) {
        log('not_armed');
        throw pageCompactingRefusal();
      }
      const swap = await compactionStoreOf(db as KyselyDB | CompactionStore).swapYdoc(pageId, heal.image, { covered: rowSha });
      if (!swap.swapped) {
        row = attempt < LOAD_HEAL_ATTEMPTS ? await store.readYdoc(pageId) : null;
        if (row === null || row.length === 0) {
          log('cas_lost');
          throw pageCompactingRefusal();
        }
        continue;
      }
      loadStoredYdoc(document, pageId, heal.image, db as KyselyDB | CompactionStore, bounds);
      attachReplicaLog(document, heal.image);
      log('healed', false, countStructs(document).structs);
      return;
    }
    // (c) a stale heal row, or (d) none: the row as it is.
    loadStoredYdoc(document, pageId, row, db as KyselyDB | CompactionStore, bounds);
    attachReplicaLog(document, row);
    const why = reloadDiff(document, Y.encodeStateAsUpdate(document), bounds);
    const structs = countStructs(document).structs;
    if (heal) {
      if (why !== null) {
        log('stale_unstable', true, structs);
        throw pageCompactingRefusal();
      }
      try {
        await store.dropStale(pageId, heal.rowSha);
      } catch {
        // the next load drops it (it stays stale)
      }
      log('stale_dropped', false, structs);
      return;
    }
    if (why !== null) {
      // A row stored before #840: compact from the tree just loaded (the order users already see), at its unload.
      const request: CompactionRequest = { reason: 'order_divergence', userId: null, drain: false };
      if (requestCompaction(document, request)) logCompactionRequested(pageId, request, { structs });
      log('legacy', false, structs);
    }
    return;
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
  /** sha256 (base64) of the page's ydoc now (null: none), read in the same statement. */
  currentSha: string | null;
}

/** The statements the heal needs (an interface so the unit specs run without Postgres). */
export interface HealImageStore {
  /** The page's heal row and its row's current ydoc digest (one statement), or null. */
  read(pageId: string): Promise<HealRow | null>;
  /** The page's ydoc now (null: none, or no page). */
  readYdoc(pageId: string): Promise<Uint8Array | null>;
  /** Delete the heal row iff it still names `rowSha` and the row's ydoc no longer has that digest. */
  dropStale(pageId: string, rowSha: string): Promise<void>;
  /** In the store's transaction: delete the page's heal row; when there was one and `ydoc` is given, write `ydoc` alone. True: written. */
  clear(trx: unknown, pageId: string, ydoc: Uint8Array | null): Promise<boolean>;
  /** In the store's transaction: write `ydoc` alone when given (no `updated_at`, no `content`), and upsert the heal row. */
  put(trx: unknown, pageId: string, heal: { image: Uint8Array | null; rowSha: string; epoch: number }, ydoc: Uint8Array | null): Promise<void>;
}

/** The Postgres store. Each method awaits the table first (ensureHealImageTable: a resolved promise after the boot). */
export function kyselyHealImageStore(db: KyselyDB): HealImageStore {
  return {
    async read(pageId) {
      await ensureHealImageTable(db);
      // Aliases without underscores, so the CamelCasePlugin leaves them as written.
      const { rows } = await sql<{ image: Uint8Array | null; rowsha: string; epoch: number; currentsha: string | null }>`
        select h.image, h.row_sha as rowsha, h.epoch, encode(sha256(p.ydoc), 'base64') as currentsha
        from ccc_page_heal_image h join pages p on p.id = h.page_id
        where h.page_id = ${pageId}`.execute(db);
      const r = rows[0];
      if (!r) return null;
      return { image: r.image ? new Uint8Array(r.image) : null, rowSha: r.rowsha, epoch: Number(r.epoch), currentSha: r.currentsha };
    },
    async readYdoc(pageId) {
      const { rows } = await sql<{ ydoc: Uint8Array | null }>`select ydoc from pages where id = ${pageId}`.execute(db);
      return rows[0]?.ydoc ? new Uint8Array(rows[0].ydoc) : null;
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
        insert into ccc_page_heal_image (page_id, image, row_sha, epoch)
        values (${pageId}, ${heal.image ? Buffer.from(heal.image) : null}, ${heal.rowSha}, ${heal.epoch})
        on conflict (page_id) do update
          set image = excluded.image, row_sha = excluded.row_sha, epoch = excluded.epoch, created_at = now()`.execute(t);
    },
  };
}

const stores = new WeakMap<object, HealImageStore>();
/** The Postgres store for a Kysely handle (one per handle), or `db` itself when it is a store (the unit specs'). */
export function healStoreOf(db: KyselyDB | HealImageStore): HealImageStore {
  const s = db as HealImageStore;
  if (typeof s.read === 'function' && typeof s.put === 'function' && typeof s.clear === 'function') return s;
  let store = stores.get(db);
  if (!store) stores.set(db, (store = kyselyHealImageStore(db as KyselyDB)));
  return store;
}
