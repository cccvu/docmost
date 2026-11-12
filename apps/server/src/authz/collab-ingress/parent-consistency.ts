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
 *
 * #847: the keyed-split rules live here too. `isKeyedSplit` reads each new keyed item; `keyedSplitProduct` reads the
 * pieces a split of an EXISTING keyed item leaves (`tr._mergeStructs`, where Yjs's `splitItem` pushes every right half).
 */
import * as Y from 'yjs';

/**
 * The first newly integrated item with a neighbour of another parent or key, or null. `clients`: the ids whose structs
 * the transaction can have added (the guard passes the frame's and the pending ones, so a frame costs O(its clients),
 * never O(every id the page holds)); every id in the store by default. `side`: the neighbour that differs, `left`
 * first. A foreign `left` is the shape the guard's per-struct `cross-list` rule names (a legacy pending item is only
 * report-only there, so it reaches this walk); only a foreign `right` with a consistent `left` is `parent-split`, so one
 * shape always gets one rule (update-guard.ts).
 */
export function parentConsistencyViolation(
  tr: Y.Transaction,
  clients: Iterable<number> = tr.doc.store.clients.keys(),
): { client: number; clock: number; side: 'left' | 'right' } | null {
  const store = tr.doc.store;
  for (const client of clients) {
    const structs = store.clients.get(client);
    if (!structs) continue;
    const before = tr.beforeState.get(client) ?? 0;
    if (Y.getState(store, client) <= before) continue;
    for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
      const item = structs[i];
      if (!(item instanceof Y.Item)) continue; // GC: no parent, no neighbours
      const foreign = (n: Y.Item | null): boolean => n !== null && (n.parent !== item.parent || n.parentSub !== item.parentSub);
      if (foreign(item.left)) return { client, clock: item.id.clock, side: 'left' };
      if (foreign(item.right)) return { client, clock: item.id.clock, side: 'right' };
    }
  }
  return null;
}

/**
 * #847: a live keyed item must be one standalone value (Yjs's typeMapSet writes one; a later value of the key deletes
 * it). One holding several values, split by a later delete, wedges live's transaction cleanup (Item.gc on the split);
 * one with a right neighbour is not the key's value. Read inside the frame's transaction, on every item it created.
 */
export const isKeyedSplit = (item: Y.Item): boolean => item.parentSub !== null && !item.deleted && (item.length !== 1 || item.right !== null);

/**
 * #847: a live keyed piece that is not its key's head. Yjs's integrate deletes a keyed item that lands with a right
 * neighbour, and deletes the old head when a new head lands after it, so no integrate ever leaves one: only a split of an
 * existing keyed item does (a delete of its tail, or an origin inside it). A parent delete then deletes the head (the
 * key's `_map` entry) and never this piece, and Yjs's cleanup of that transaction throws (#847 M2, `Unexpected case`):
 * the document is wedged for good (no update event, broadcast or store again; compaction-registry.ts `liveWedged`). A live piece that IS the head
 * (`right === null`) is harmless whatever its length: a delete of only its first value leaves one, and the parent
 * delete deletes it whole, so the head is not checked for its length here (`isKeyedSplit` does, on new items).
 */
const isStrandedKeyed = (item: Y.Item): boolean => item.parentSub !== null && !item.deleted && item.right !== null;

/**
 * #847: the first live keyed piece a split in this transaction left that is not its key's head, or null. Yjs's
 * `splitItem` pushes every right half it makes onto `tr._mergeStructs` (so do a parent delete's already-deleted
 * children, which are never live); for each keyed one, the piece itself and its left half are read. The left half is
 * found by store position (the struct at the same client's previous clock, of the same parent and key), never by
 * `right.left`: a new item can be linked between the two halves. Covers splits of items the stored document already held,
 * which the per-struct `isKeyedSplit` (new clocks only) never sees. O(splits). Called inside the frame's transaction,
 * before Yjs's cleanup merges the halves back.
 */
export function keyedSplitProduct(tr: Y.Transaction): Y.Item | null {
  const store = tr.doc.store;
  for (const struct of tr._mergeStructs) {
    if (!(struct instanceof Y.Item) || struct.parentSub === null) continue;
    if (isStrandedKeyed(struct)) return struct;
    const { client, clock } = struct.id;
    if (clock === 0) continue;
    const left = Y.getItem(store, Y.createID(client, clock - 1)) as Y.Item | Y.GC;
    if (left instanceof Y.Item && left.parent === struct.parent && left.parentSub === struct.parentSub && isStrandedKeyed(left)) return left;
  }
  return null;
}
