import * as Y from 'yjs';

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
 * Imports ONLY `yjs` (not the tiptap/lib0 graph) so it stays unit-testable against real CRDT semantics.
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

  // The ops present in the row's state that the resident document does not already have.
  const missing = Y.diffUpdate(rowYdocBytes, Y.encodeStateVector(document));

  // `structs.length === 0` ⇒ the resident is a superset of the row (normal operation) ⇒ nothing to fold in.
  if (Y.decodeUpdate(missing).structs.length === 0) {
    return { merged: false };
  }

  Y.applyUpdate(document, missing);
  return { merged: true };
}
