/**
 * CCC integration — NOT upstream Docmost code (#731, UPSTREAM_MODIFICATIONS.md #122, ADR 0031 #731 amendment).
 *
 * Steps of the persistence extension's load and store that the seam (`collaboration/extensions/persistence.extension.ts`)
 * calls out to, so the upstream file keeps one call per step.
 */
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { storeGenerationOf } from './store-failure-registry';
// #840: the reconcile memo decides whether a snapshot taken before the row lock still holds the locked row.
import { coveredRowDigest } from './reconcile-store';
// CCC #773: the stored projection is made storable (no lone surrogate or NUL) before anything reads or writes it.
import { storeSafeJson } from './store-safe-json';
// #827: a load waits for the page's compaction in flight, so it reads the compacted row, never the one being replaced.
import { awaitCompaction } from './compaction-registry';

/** The subset of `PageRepo.findById` the load uses. */
type FindPageById<P> = (
  pageId: string,
  opts: { includeContent?: boolean; includeYdoc?: boolean },
) => Promise<P | undefined | null>;

/**
 * The row `onLoadDocument` builds the document from, read without the `content` column whenever it is not needed.
 *
 * The load uses `content` only for a legacy row with no `ydoc` (it converts the JSON). Reading it anyway made every load
 * parse the page's jsonb and walk it once more (Kysely's CamelCasePlugin maps nested object keys): a page-sized pass
 * on the event loop, for a value that was thrown away. So the ydoc is read first, and only a row without one is read
 * again with its content. The second read is the one the load uses in full, so the branches see what a single read at
 * that moment would have returned: a row that gained a ydoc in between loads from it, and a row deleted in between is
 * "page not found".
 *
 * #827: first, it waits for a compaction of the page that is in flight (one started by a failed load, or at an unload
 * on this node). That one rewrites the row's ydoc; a load that read the row before it lands would serve the old
 * lineage, which the compacted row then refuses to merge. `awaitCompaction` never rejects, and a compaction is bounded
 * (its build by a deadline, its write by lock and statement timeouts).
 */
export async function findPageRowForLoad<P extends { ydoc?: unknown }>(
  findById: FindPageById<P>,
  pageId: string,
): Promise<P | undefined | null> {
  await awaitCompaction(pageId);
  const page = await findById(pageId, { includeYdoc: true });
  if (!page || page.ydoc) return page;
  return findById(pageId, { includeContent: true, includeYdoc: true });
}

/** What a store persists: one snapshot of the document, and the generation it covers. */
export interface StoreSnapshot {
  generation: number | undefined;
  json: any;
  state: Buffer;
}

/**
 * The store's snapshot of `document` (#390, #731): its generation, `fromYdoc` and `encodeStateAsUpdate`, in ONE
 * synchronous run. #840: taken before the row lock (heal-image.ts `prepareStore`, so its order check and heal image stay
 * out of the lock) and written only while it holds the locked row (`snapshotHoldsRow`); else taken again under the lock,
 * after the reconcile.
 *
 * Never split it, and never make it async. A transaction between `fromYdoc` and the encode (an edit landing in a
 * yield) would persist a `content` and a `ydoc` that disagree in the same row; one between the generation read and
 * `fromYdoc` would let the next store be skipped over an edit this one never saw (store-failure-registry.ts). The
 * store yields only around this run (`yieldToEventLoop`, before it and after it), and an edit landing in those yields
 * either is in the snapshot (before) or bumps the generation past the recorded one so the next store runs (after).
 * Pinned in `persistence-steps.spec.ts`.
 */
export function snapshotForStore(document: Y.Doc): StoreSnapshot {
  const generation = storeGenerationOf(document);
  const json = storedProjection(document);
  const state = Buffer.from(Y.encodeStateAsUpdate(document));
  return { generation, json, state };
}

/**
 * #840: the row bytes `document` was known to cover (reconcile-store.ts's memo), read in the same synchronous run as a
 * snapshot taken BEFORE the store's row lock. Coverage only grows, so the snapshot holds every struct in those bytes.
 */
export function coveredRowAtSnapshot(document: Y.Doc): string | null {
  return coveredRowDigest(document);
}

/**
 * #840: whether a snapshot taken before the row lock may be written over the locked row and still keep #390's rule
 * (the write is a superset of the locked row): the row has no Yjs state, or its bytes are exactly the ones the document
 * covered when the snapshot was taken (`coveredRowAtSnapshot`). Anything else (another node's write, an out-of-band
 * write the reconcile folded in, a memo the document never had) is false: the store snapshots again under the lock.
 * Compared by digest, the reconcile's own rule, so it adds no page-sized pass but a hash.
 */
export function snapshotHoldsRow(coveredRow: string | null, rowYdoc: Uint8Array | null | undefined): boolean {
  if (!rowYdoc || rowYdoc.length === 0) return true;
  return coveredRow !== null && createHash('sha256').update(rowYdoc).digest('base64') === coveredRow;
}

/**
 * The JSON a store writes as the page's `content`: `storeSafeJson(fromYdoc(document))` (#773). #827: compaction
 * rebuilds a page from exactly this, so its ADR 0019 digest (`stableHash` of it) is the one a conditional write names.
 */
export function storedProjection(document: Y.Doc): any {
  return storeSafeJson(TiptapTransformer.fromYdoc(document, 'default'));
}
