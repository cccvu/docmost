/**
 * CCC integration — NOT upstream Docmost code (#731, UPSTREAM_MODIFICATIONS.md #122, ADR 0031 #731 amendment).
 *
 * Steps of the persistence extension's load and store that the seam (`collaboration/extensions/persistence.extension.ts`)
 * calls out to, so the upstream file keeps one call per step.
 */
import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { storeGenerationOf } from './store-failure-registry';
// CCC #773: the stored projection is made storable (no lone surrogate or NUL) before anything reads or writes it.
import { storeSafeJson } from './store-safe-json';

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
 */
export async function findPageRowForLoad<P extends { ydoc?: unknown }>(
  findById: FindPageById<P>,
  pageId: string,
): Promise<P | undefined | null> {
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
 * synchronous run, called after the reconcile under the row lock.
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
  const json = storeSafeJson(TiptapTransformer.fromYdoc(document, 'default'));
  const state = Buffer.from(Y.encodeStateAsUpdate(document));
  return { generation, json, state };
}
