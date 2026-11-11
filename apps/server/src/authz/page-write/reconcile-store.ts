import { createHash } from 'node:crypto';
import * as Y from 'yjs';
// #827: the lineage root and the superseded mark (the registry imports only yjs and constants).
import { LINEAGE_ROOT, markSuperseded } from './compaction-registry';

/**
 * #390 — the SYMMETRIC guard for ADR 0019.
 *
 * ADR 0019 (#282) made the API→Y.Doc write direction a compare-and-swap so an API caller cannot clobber a
 * live human keystroke. The other direction — the debounced `onStoreDocument` persisting the resident Y.Doc
 * back to the `pages` row — was left unguarded: it overwrites `content`/`ydoc` unconditionally (bar a
 * deep-equal no-op skip). So when a resident Y.Doc goes STALE relative to the row (the row advanced
 * out-of-band — e.g. a second resident copy on another node during a rolling deploy, per ADR 0019's "known
 * degradations"), its next flush silently reverts the row to the stale state. That is the #390 data loss.
 *
 * This folds any row content the resident doc is MISSING back into the resident doc via a lossless Yjs CRDT
 * merge, BEFORE the store serializes what it will write. Because Yjs is a CRDT the merge is a pure union:
 * it never drops either side's content, so a legitimate concurrent human edit and an out-of-band API write
 * both survive. The caller (`onStoreDocument`) must serialize the write payload from `document` AFTER
 * calling this, inside the row's `SELECT … FOR UPDATE` transaction, so the persisted content is always a
 * superset of the locked row and can never be a stale subset (the TOCTOU proof in ADR 0019 / #390).
 *
 * Imports ONLY `yjs`, `node:crypto` and the #827 compaction registry (yjs and constants), not the tiptap/lib0 graph, so it
 * stays unit-testable against real CRDT semantics.
 *
 * The trigger is deliberately `structs > 0` — the row carries content OPS the resident lacks — which is
 * exactly the #390 shape (accepted content about to be lost) and yields ZERO false positives in normal
 * operation (a resident that is the source of truth is always a superset of the row, so the diff is empty).
 * A delete-only out-of-band divergence (content the resident would *resurrect*) is a different, non-data-loss
 * case and is intentionally out of scope here.
 *
 * BOUNDED EDGE (divergent lineage → duplication, not loss): if a page that had NO stored ydoc was loaded
 * independently on two nodes during a rollout, each built its Y.Doc from `content` with a FRESH clientID, so
 * once one node stores, the other's row-vs-resident diff sees the *same* content as "missing" (different
 * lineage) and folds it in — DUPLICATING it rather than losing it. This is strictly better than the pre-#390
 * clobber, it is alarmed (`COLLAB_STALE_RECONCILE`), and it is only reachable multi-node + for a legacy
 * content-without-ydoc row (verified absent from every live write path). The real cure is the RedisSync
 * routing fix (follow-up #395) that prevents the second resident copy; a content-level dedup here would cost
 * a full serialize+compare on the hot path and is not worth it for this edge. Pinned by test.
 */
export function reconcileRowIntoDoc(
  document: Y.Doc,
  rowYdocBytes: Uint8Array | Buffer | null | undefined,
): { merged: boolean } {
  if (!rowYdocBytes || rowYdocBytes.length === 0) {
    return { merged: false };
  }

  // #731: bytes this document is already known to cover need no diff (see `markRowCovered`).
  const rowDigest = bytesDigest(rowYdocBytes);
  if (coveredRows.get(document) === rowDigest) {
    return { merged: false };
  }

  // The ops present in the row's state that the resident document does not already have.
  const missing = Y.diffUpdate(rowYdocBytes, Y.encodeStateVector(document));

  // `structs.length === 0` ⇒ the resident is a superset of the row (normal operation) ⇒ nothing to fold in.
  const decoded = Y.decodeUpdate(missing);
  if (decoded.structs.length === 0) {
    coveredRows.set(document, rowDigest);
    return { merged: false };
  }

  // #827: never fold another lineage in (see the header).
  const foreign = foreignLineage(document, rowYdocBytes, decoded.structs);
  if (foreign) {
    markSuperseded(document, foreign.rowEpoch);
    throw new ForeignLineageError(foreign.why, foreign.rowEpoch);
  }

  // #790: under Hocuspocus 4.x every change to a live document schedules a store unless its origin opts out. This
  // merge runs INSIDE a store that serializes it next, so it opts out: as under 3.4.4 it schedules nothing, and it
  // cannot replace a pending human store's payload with one that has no user.
  Y.applyUpdate(document, missing, RECONCILE_ORIGIN);
  rememberIfIntegrated(document, rowDigest);
  return { merged: true };
}

/**
 * #731 — the reconcile memo. Every store reads the row's ydoc under the lock and diffs it against the resident
 * document (a page-sized `diffUpdate` + decode), and in normal operation that row is bytes this very document wrote
 * or loaded. Covering is monotonic: a document's state vector only grows (garbage-collected structs keep their
 * clocks) and the reconcile ignores the delete set, so once a document is known to hold every struct in some bytes,
 * the same bytes always diff to nothing against it. So one digest per document is kept: the sha256 of the full row
 * bytes last known to be covered. A hit skips the diff; any other bytes (an out-of-band write) diff in full.
 *
 * Seeded from facts about bytes, not about the row: the load (the row it just applied) and a store's write (its own
 * `encodeStateAsUpdate`), so it stays sound even when that write's commit then fails. Never seeded while the document
 * holds pending structs: those are in its encoding but not in its state vector.
 */
const coveredRows = new WeakMap<object, string>();

/** Hocuspocus 4.x `LocalTransactionOrigin` with `skipStoreHooks` (a plain object: this file imports only yjs). */
export const RECONCILE_ORIGIN = Object.freeze({ source: 'local' as const, skipStoreHooks: true });

const bytesDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64');

const hasPendingStructs = (document: Y.Doc): boolean =>
  (document as unknown as { store?: { pendingStructs?: unknown } }).store?.pendingStructs != null;

function rememberIfIntegrated(document: Y.Doc, digest: string): void {
  if (hasPendingStructs(document)) coveredRows.delete(document);
  else coveredRows.set(document, digest);
}

/** Record that `document` holds every struct in `bytes` (it just applied them, or they are its own encoding). */
export function markRowCovered(document: Y.Doc, bytes: Uint8Array | Buffer | null | undefined): void {
  if (!bytes || bytes.length === 0) return;
  rememberIfIntegrated(document, bytesDigest(bytes));
}

/** #827: the sha256 (base64) of the row bytes this document last covered, or null. Compaction's compare-and-swap names
 *  it: right after a successful store it is the digest of exactly the bytes the row holds (the store wrote them, or its
 *  reconcile found the row covered). */
export function coveredRowDigest(document: Y.Doc): string | null {
  return coveredRows.get(document) ?? null;
}

/** #827: the row and the resident document are of different lineages; the store refused to merge them. */
export class ForeignLineageError extends Error {
  constructor(
    readonly why: 'row-compacted' | 'resident-compacted',
    /** The row's lineage epoch, when its bytes name one. */
    readonly rowEpoch: number | null,
  ) {
    super(
      why === 'row-compacted'
        ? 'the stored page was compacted to another lineage since this copy loaded; refused to merge it (#827)'
        : 'the stored page holds an older lineage than this compacted copy; refused to merge it (#827)',
    );
  }
}

type DecodedStruct = ReturnType<typeof Y.decodeUpdate>['structs'][number];
type DecodedDeleteSet = ReturnType<typeof Y.decodeUpdate>['ds'];

/**
 * #827: the live entries of a top-level `Y.Map` named `root`, read from DECODED update structs without integrating
 * anything (so it works on bytes too costly to load). An entry set once carries its parent and key in the encoding; one
 * set again (or after a delete) carries only its `origin`, the previous entry for that key (possibly deleted and merged
 * with others into one longer struct), so it is resolved through that chain. Entries in `deleteSet` are skipped. A
 * value is the entry's last `ContentAny` value; any other content kind is skipped. `unresolved` counts live one-value
 * entries whose chain could not be followed to a placed entry (their key is unknown; they are left out).
 */
export function readRootMapEntries(
  structs: readonly DecodedStruct[],
  deleteSet: DecodedDeleteSet,
  root: string,
): { entries: Map<string, { value: unknown; id: Y.ID }>; unresolved: number } {
  // Per client, the items in clock order (decodeUpdate keeps each client's structs ascending), to find the item that
  // holds an origin id: a merged struct covers a clock range.
  const byClient = new Map<number, Y.Item[]>();
  for (const s of structs) {
    if (!(s instanceof Y.Item)) continue;
    let list = byClient.get(s.id.client);
    if (!list) byClient.set(s.id.client, (list = []));
    list.push(s);
  }
  const holder = (id: Y.ID): Y.Item | null => {
    const list = byClient.get(id.client);
    if (!list) return null;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const it = list[mid];
      if (id.clock < it.id.clock) hi = mid - 1;
      else if (id.clock >= it.id.clock + it.length) lo = mid + 1;
      else return it;
    }
    return null;
  };
  // What each item resolved to so far: its key under `root`, OTHER (an entry of another type), or UNPLACED (its chain
  // breaks: an origin not in these bytes, or a malformed cycle).
  const OTHER = 0;
  const UNPLACED = 1;
  const keyOf = new Map<Y.Item, string | typeof OTHER | typeof UNPLACED>();
  const resolve = (start: Y.Item): string | typeof OTHER | typeof UNPLACED => {
    const chain = new Set<Y.Item>(); // the walk so far: each item once, so the whole read stays linear (memoized)
    let item: Y.Item | null = start;
    let key: string | typeof OTHER | typeof UNPLACED = UNPLACED;
    while (item !== null) {
      const known = keyOf.get(item);
      if (known !== undefined) {
        key = known;
        break;
      }
      chain.add(item);
      if (item.parent !== null) {
        // A decoded item's parent is the root's NAME (a string) when the encoding carried it, never a type.
        key = (item.parent as unknown) === root && typeof item.parentSub === 'string' ? item.parentSub : OTHER;
        break;
      }
      item = item.origin === null ? null : holder(item.origin);
      if (item !== null && chain.has(item)) item = null; // a malformed cycle
    }
    for (const c of chain) keyOf.set(c, key);
    return key;
  };
  const entries = new Map<string, { value: unknown; id: Y.ID }>();
  let unresolved = 0;
  for (const list of byClient.values()) {
    for (const item of list) {
      if (item.length !== 1 || !(item.content instanceof Y.ContentAny) || Y.isDeleted(deleteSet, item.id)) continue;
      const key = resolve(item);
      if (key === UNPLACED) unresolved++;
      if (typeof key !== 'string') continue;
      const current = entries.get(key);
      // Two live entries for one key would be concurrent sets; Yjs keeps the higher client's. Mirror it.
      if (current && current.id.client > item.id.client) continue;
      const values = item.content.getContent();
      entries.set(key, { value: values[values.length - 1], id: item.id });
    }
  }
  return { entries, unresolved };
}

/** #827: the lineage epoch named by decoded update structs: 0 when they name none, null when the value is malformed. */
export function lineageEpochOfStructs(structs: readonly DecodedStruct[], deleteSet: DecodedDeleteSet): number | null {
  const { entries } = readRootMapEntries(structs, deleteSet, LINEAGE_ROOT);
  const epoch = entries.get('epoch')?.value;
  if (epoch === undefined) return 0;
  return typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
}

/** The document's lineage item (the struct that holds its epoch), or null for a document never compacted. */
function lineageItemOf(document: Y.Doc): Y.Item | null {
  const root = document.share.get(LINEAGE_ROOT);
  return (root?._map.get('epoch') as Y.Item | undefined) ?? null;
}

function foreignLineage(
  document: Y.Doc,
  rowYdocBytes: Uint8Array,
  missing: readonly DecodedStruct[],
): { why: ForeignLineageError['why']; rowEpoch: number | null } | null {
  // The row holds a lineage struct the resident lacks: the row was compacted after this copy loaded.
  if (missing.some((s) => s instanceof Y.Item && (s.parent as unknown) === LINEAGE_ROOT)) {
    const all = Y.decodeUpdate(rowYdocBytes);
    return { why: 'row-compacted', rowEpoch: lineageEpochOfStructs(all.structs, all.ds) };
  }
  // The resident holds a lineage struct the row lacks: the row is an older lineage than this copy.
  const own = lineageItemOf(document);
  if (own !== null) {
    const sv = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(rowYdocBytes));
    if ((sv.get(own.id.client) ?? 0) <= own.id.clock) {
      const all = Y.decodeUpdate(rowYdocBytes);
      return { why: 'resident-compacted', rowEpoch: lineageEpochOfStructs(all.structs, all.ds) };
    }
  }
  return null;
}
