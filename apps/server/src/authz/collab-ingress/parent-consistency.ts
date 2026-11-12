/**
 * CCC collab integration — NOT upstream Docmost code (#840, ADR 0036).
 *
 * The parent-consistency rule: every item a frame integrates sits beside neighbours of its own parent and key. Yjs sets
 * an item's `parent` (and key) from what the wire names, or from its declared origin, but links it where its integrate
 * lands: the tail of a partly known struct goes next to the same client's previous clock, which a crafted frame can
 * place in another list. The item is then checked against one parent while it lives in another, the named parent's
 * `_length` counts content its list lacks, and a reload re-derives the parent from the neighbours, so live and every
 * reload disagree for good. The guard's `cross-list` reads `left`; this reads both neighbours, so a frame placed beside a
 * foreign item a stored document already holds is caught too. A remote integrate never does it honestly: `right` is
 * `left.right` or the head of the item's own list or key (0 hits in the #840 experiments' 338,673 honest frames, and
 * in parent-consistency.spec.ts's seeded corpus).
 *
 * For frames only: a LOCAL keyed redo under a redone parent can split the author's own replica (Yjs redoItem), but the
 * frame it sends is consistent wherever it applies. Called inside the frame's transaction, after it integrated and before
 * Yjs's cleanup, whose struct merge ignores parents and can join a split tail to its left. It reads Yjs internals
 * (`beforeState`, `findIndexSS`, item neighbours): order-parity.spec.ts's tripwire pins the yjs version for both.
 */
import * as Y from 'yjs';

/** The first newly integrated item with a neighbour of another parent or key, or null. */
export function parentConsistencyViolation(tr: Y.Transaction): { client: number; clock: number } | null {
  const store = tr.doc.store;
  for (const [client, structs] of store.clients) {
    const before = tr.beforeState.get(client) ?? 0;
    if (Y.getState(store, client) <= before) continue;
    for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
      const item = structs[i];
      if (!(item instanceof Y.Item)) continue; // GC: no parent, no neighbours
      for (const n of [item.left, item.right]) {
        if (n !== null && (n.parent !== item.parent || n.parentSub !== item.parentSub)) return { client, clock: item.id.clock };
      }
    }
  }
  return null;
}
