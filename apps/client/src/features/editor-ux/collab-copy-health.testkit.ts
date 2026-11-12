// cccvu/wiki-v2#847 — test helpers for the broken-copy detector (collab-copy-health.ts): bug M2 on a real Y.Doc.
import * as Y from "yjs";

/** Unsigned LEB128, as Yjs writes its varuints. */
export function varuint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push(0x80 | (n & 0x7f));
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

/**
 * Bug M2 on `doc`: a live keyed item holding two values (a shape only a crafted frame writes), split by a delete of
 * its second value, then its parent deleted. `Item.gc` throws "Unexpected case" in the cleanup, and the document is
 * wedged (`_transactionCleanups` never empties). Returns what the last step threw.
 */
export function wedgeWithKeyedSplit(doc: Y.Doc): unknown {
  const author = new Y.Doc();
  const map = new Y.Map<unknown>();
  author.getArray("list").insert(0, [map]);
  map.set("k", 1);
  const item = (map as unknown as { _map: Map<string, any> })._map.get("k");
  item.content.arr.push(2); // the crafted shape: one keyed item, two values
  item.length = 2;
  const { client, clock } = item.id;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(author));
  // a delete-set-only update (V1): no structs; one client with one range, its second value
  Y.applyUpdate(
    doc,
    Uint8Array.from([0, 1, ...varuint(client), 1, ...varuint(clock + 1), 1]),
  );
  try {
    doc.getArray("list").delete(0); // the parent goes, and the split keyed item with it
  } catch (e) {
    return e;
  }
  return undefined;
}

/** Whether `doc` is wedged: a transaction cleanup threw and yjs never emptied `_transactionCleanups`. */
export function isWedged(doc: Y.Doc): boolean {
  return (
    (doc as unknown as { _transactionCleanups: unknown[] })._transactionCleanups
      .length > 0
  );
}
