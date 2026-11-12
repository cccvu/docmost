// #390 — the symmetric guard for ADR 0019. Uses REAL yjs (imports only `yjs`, no tiptap graph), so the
// CRDT merge semantics the fix depends on are actually exercised rather than mocked. Docs are modelled as a
// root XmlFragment 'default' of paragraph elements, matching the shape TiptapTransformer produces.
import * as Y from 'yjs';
import {
  coveredRowDigest,
  ForeignLineageError,
  lineageEpochOfStructs,
  markRowCovered,
  readRootMapEntries,
  reconcileRowIntoDoc,
  WedgedDocumentError,
} from './reconcile-store';
import { isSuperseded, LINEAGE_ROOT, liveWedged, supersededBy, writeLineage } from './compaction-registry';

function paragraph(text: string): Y.XmlElement {
  const el = new Y.XmlElement('paragraph');
  if (text) el.insert(0, [new Y.XmlText(text)]);
  return el;
}
function docWith(texts: string[]): Y.Doc {
  const doc = new Y.Doc();
  doc.getXmlFragment('default').insert(0, texts.map(paragraph));
  return doc;
}
function len(doc: Y.Doc): number {
  return doc.getXmlFragment('default').length;
}
function rowBytesOf(doc: Y.Doc): Buffer {
  // Mimics the `pages.ydoc` bytea column (a Node Buffer of Y.encodeStateAsUpdate).
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

describe('reconcileRowIntoDoc (#390 stale-doc clobber guard)', () => {
  it('recovers content a stale resident doc lacks (the #390 clobber) — lossless', () => {
    // Row holds a full API write (40 nodes) from an out-of-band writer (fresh lineage).
    const row = docWith(Array.from({ length: 40 }, (_, i) => `node ${i}`));
    // Resident doc is stale/blank (opened while the page was blank) — a single empty paragraph.
    const resident = docWith(['']);

    const { merged } = reconcileRowIntoDoc(resident, rowBytesOf(row));

    expect(merged).toBe(true);
    // The 40 row nodes are now present in the resident doc, so a subsequent store cannot drop them.
    expect(len(resident)).toBeGreaterThanOrEqual(40);
    const text = resident.getXmlFragment('default').toString();
    expect(text).toContain('node 0');
    expect(text).toContain('node 39');
  });

  it('does NOT merge in normal operation (resident is the source; row is a prior subset)', () => {
    // Live editing: the resident doc is the source of truth; the row is an earlier store of it,
    // and the resident even has a delete in its history. The row has nothing the resident lacks.
    const resident = docWith(['a', 'b', 'c']);
    const row = rowBytesOf(resident); // snapshot BEFORE further edits
    resident.getXmlFragment('default').delete(1, 1); // delete 'b'
    resident.getXmlFragment('default').insert(2, [paragraph('d')]); // add 'd'

    const before = Y.encodeStateVector(resident);
    const { merged } = reconcileRowIntoDoc(resident, row);

    expect(merged).toBe(false);
    // untouched
    expect(Buffer.from(Y.encodeStateVector(resident))).toEqual(Buffer.from(before));
  });

  it('preserves BOTH a concurrent human edit and an out-of-band API write', () => {
    const base = docWith(['base']);
    const baseBytes = rowBytesOf(base);

    // Resident = base + a live human edit not yet in the row.
    const resident = new Y.Doc();
    Y.applyUpdate(resident, Y.encodeStateAsUpdate(base));
    resident.getXmlFragment('default').insert(1, [paragraph('human-live-edit')]);

    // Row = base + an out-of-band API write (different lineage), missing the human edit.
    const row = new Y.Doc();
    Y.applyUpdate(row, baseBytes);
    row.getXmlFragment('default').insert(1, [paragraph('api-out-of-band')]);

    const { merged } = reconcileRowIntoDoc(resident, rowBytesOf(row));

    expect(merged).toBe(true);
    const text = resident.getXmlFragment('default').toString();
    expect(text).toContain('human-live-edit');
    expect(text).toContain('api-out-of-band');
  });

  it('divergent lineage DUPLICATES rather than loses content (bounded edge, alarmed; #390 doc note)', () => {
    // A content-without-ydoc page loaded independently on two nodes → each built its doc from `content` with
    // a FRESH clientID. Node A stored (its lineage became the row's ydoc); node B is the stale resident.
    const nodeA = docWith(['same one', 'same two']); // row ydoc lineage
    const nodeB = docWith(['same one', 'same two']); // stale resident, different lineage, SAME content
    const before = len(nodeB);

    const { merged } = reconcileRowIntoDoc(nodeB, rowBytesOf(nodeA));

    // Different lineage ⇒ the row's ops look "missing" to B ⇒ it folds them in. Content is DUPLICATED, NOT
    // lost — strictly better than the pre-#390 clobber; alarmed via COLLAB_STALE_RECONCILE. The routing fix
    // (#395) is the real cure.
    expect(merged).toBe(true);
    expect(len(nodeB)).toBe(before * 2);
    const txt = nodeB.getXmlFragment('default').toString();
    expect(txt).toContain('same one');
    expect(txt).toContain('same two'); // nothing lost
  });

  it('is a no-op when the row has no ydoc (null/undefined/empty)', () => {
    const resident = docWith(['x']);
    const before = Buffer.from(Y.encodeStateVector(resident));

    expect(reconcileRowIntoDoc(resident, null).merged).toBe(false);
    expect(reconcileRowIntoDoc(resident, undefined as unknown as Buffer).merged).toBe(false);
    expect(reconcileRowIntoDoc(resident, Buffer.alloc(0)).merged).toBe(false);
    expect(Buffer.from(Y.encodeStateVector(resident))).toEqual(before);
  });
});

// #731 — the reconcile memo: bytes a document is known to cover are not diffed again; anything else is.
describe('reconcileRowIntoDoc memo (#731)', () => {
  const spyDiff = () => jest.spyOn(Y, 'diffUpdate');
  afterEach(() => jest.restoreAllMocks());

  it('a hit: the second reconcile of the SAME bytes runs no diff (and still merges nothing)', () => {
    const resident = docWith(['a', 'b']);
    const row = rowBytesOf(resident);
    const diff = spyDiff();
    expect(reconcileRowIntoDoc(resident, row).merged).toBe(false);
    expect(diff).toHaveBeenCalledTimes(1);
    expect(reconcileRowIntoDoc(resident, Buffer.from(row)).merged).toBe(false); // equal bytes, another buffer
    expect(diff).toHaveBeenCalledTimes(1);
  });

  it('a miss: different bytes (an out-of-band write) are diffed and folded in, then memoized', () => {
    const resident = docWith(['a']);
    reconcileRowIntoDoc(resident, rowBytesOf(resident)); // memo = the resident's own bytes
    const row = new Y.Doc();
    Y.applyUpdate(row, Y.encodeStateAsUpdate(resident));
    row.getXmlFragment('default').insert(1, [paragraph('out-of-band')]);
    const diff = spyDiff();
    expect(reconcileRowIntoDoc(resident, rowBytesOf(row)).merged).toBe(true);
    expect(resident.getXmlFragment('default').toString()).toContain('out-of-band');
    expect(reconcileRowIntoDoc(resident, rowBytesOf(row)).merged).toBe(false);
    expect(diff).toHaveBeenCalledTimes(1); // the merged result covers the row: the repeat is a hit
  });

  it('markRowCovered seeds it (the load, a store\'s own write); a memo is per document', () => {
    const resident = docWith(['a']);
    const own = rowBytesOf(resident);
    markRowCovered(resident, own);
    const diff = spyDiff();
    expect(reconcileRowIntoDoc(resident, own).merged).toBe(false);
    expect(diff).not.toHaveBeenCalled();
    const other = docWith(['a']); // another document, the same bytes: no memo of its own
    expect(reconcileRowIntoDoc(other, own).merged).toBe(true); // divergent lineage, folded in (see #390 edge)
    expect(diff).toHaveBeenCalledTimes(1);
  });

  it('only the LAST covered bytes are memoized: earlier bytes diff again (one digest per document)', () => {
    const resident = docWith(['a']);
    const first = rowBytesOf(resident);
    reconcileRowIntoDoc(resident, first);
    resident.getXmlFragment('default').insert(1, [paragraph('b')]);
    markRowCovered(resident, rowBytesOf(resident));
    const diff = spyDiff();
    expect(reconcileRowIntoDoc(resident, first).merged).toBe(false); // still covered, just not memoized
    expect(diff).toHaveBeenCalledTimes(1);
  });

  it('never memoizes while the document holds pending structs (their bytes are encoded but not integrated)', () => {
    const source = docWith(['a']);
    source.getXmlFragment('default').insert(1, [paragraph('b')]);
    const sv1 = Y.encodeStateVector(source);
    source.getXmlFragment('default').insert(2, [paragraph('c')]);
    const resident = new Y.Doc();
    // Only the LAST change: it depends on structs the resident lacks, so it stays pending.
    Y.applyUpdate(resident, Y.encodeStateAsUpdate(source, sv1));
    expect((resident as any).store.pendingStructs).not.toBeNull();
    const own = Buffer.from(Y.encodeStateAsUpdate(resident)); // includes the pending structs
    markRowCovered(resident, own);
    const diff = spyDiff();
    reconcileRowIntoDoc(resident, own);
    expect(diff).toHaveBeenCalledTimes(1);
  });
});

// #827 — a FOREIGN lineage is refused, never merged: compaction rebuilds a page under a new lineage epoch, so a union
// with a copy of another epoch would duplicate every node (the #390 bounded edge above, now for every page).
describe('reconcileRowIntoDoc foreign lineage (#827)', () => {
  /** A compaction's output: a fresh document holding `texts`, at `epoch`. */
  function compacted(texts: string[], epoch: number): Y.Doc {
    const doc = docWith(texts);
    writeLineage(doc, epoch, 0);
    return doc;
  }
  const refusal = (fn: () => unknown): ForeignLineageError => {
    try {
      fn();
    } catch (err) {
      return err as ForeignLineageError;
    }
    throw new Error('expected a ForeignLineageError');
  };

  it('a row compacted since this copy loaded: refused, the copy superseded (epoch named), nothing merged', () => {
    const stale = docWith(['one', 'two']); // loaded before the compaction (epoch 0)
    const row = compacted(['one', 'two'], 3);
    const before = Buffer.from(Y.encodeStateVector(stale));

    const err = refusal(() => reconcileRowIntoDoc(stale, rowBytesOf(row)));

    expect(err).toBeInstanceOf(ForeignLineageError);
    expect(err.why).toBe('row-compacted');
    expect(err.rowEpoch).toBe(3);
    expect(isSuperseded(stale)).toBe(true);
    expect(supersededBy(stale)).toBe(3);
    expect(Buffer.from(Y.encodeStateVector(stale))).toEqual(before); // untouched: no duplicate
    expect(len(stale)).toBe(2);
  });

  it('this copy compacted, the row an older lineage (an older node stored over it): refused too', () => {
    const copy = compacted(['one', 'two'], 1);
    const olderRow = docWith(['one', 'two', 'three']);

    const err = refusal(() => reconcileRowIntoDoc(copy, rowBytesOf(olderRow)));

    expect(err.why).toBe('resident-compacted');
    expect(err.rowEpoch).toBe(0);
    expect(isSuperseded(copy)).toBe(true);
    expect(len(copy)).toBe(2);
  });

  it('the same lineage still merges an out-of-band write (#390 unchanged on a compacted page)', () => {
    const base = compacted(['base'], 2);
    const residentCopy = new Y.Doc();
    Y.applyUpdate(residentCopy, rowBytesOf(base));
    const rowCopy = new Y.Doc();
    Y.applyUpdate(rowCopy, rowBytesOf(base));
    rowCopy.getXmlFragment('default').insert(1, [paragraph('out-of-band')]);

    expect(reconcileRowIntoDoc(residentCopy, rowBytesOf(rowCopy)).merged).toBe(true);
    expect(residentCopy.getXmlFragment('default').toString()).toContain('out-of-band');
    expect(isSuperseded(residentCopy)).toBe(false);
  });

  it('the row covered by the copy (normal operation) is never inspected for lineage', () => {
    const copy = compacted(['a'], 5);
    const row = rowBytesOf(copy);
    expect(reconcileRowIntoDoc(copy, row).merged).toBe(false);
    expect(coveredRowDigest(copy)).not.toBeNull();
    expect(isSuperseded(copy)).toBe(false);
  });

  it('readRootMapEntries / lineageEpochOfStructs read the lineage from bytes without integrating them', () => {
    const doc = compacted(['x'], 9);
    const { structs, ds } = Y.decodeUpdate(rowBytesOf(doc));
    expect(lineageEpochOfStructs(structs, ds)).toBe(9);
    const { entries, unresolved } = readRootMapEntries(structs, ds, LINEAGE_ROOT);
    expect([...entries.keys()].sort()).toEqual(['at', 'epoch']);
    expect(unresolved).toBe(0);
    const plain = Y.decodeUpdate(rowBytesOf(docWith(['x'])));
    expect(lineageEpochOfStructs(plain.structs, plain.ds)).toBe(0);
    // element attributes are another type's entries: never read as the root's, never counted unresolved
    const withAttrs = docWith(['x']);
    const p = withAttrs.getXmlFragment('default').get(0) as Y.XmlElement;
    p.setAttribute('textAlign', 'left');
    p.setAttribute('textAlign', 'right');
    const d2 = Y.decodeUpdate(rowBytesOf(withAttrs));
    expect(readRootMapEntries(d2.structs, d2.ds, LINEAGE_ROOT)).toEqual({ entries: new Map(), unresolved: 0 });
  });
});

describe('reconcileRowIntoDoc into a wedged document (#847)', () => {
  /** A resident whose Yjs cleanup threw (M2: a parent delete over a stranded keyed piece): wedged for good. */
  function wedgedResident(): Y.Doc {
    const doc = docWith(['one', 'two']);
    const peer = new Y.Doc();
    peer.clientID = 9;
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const sv = Y.encodeStateVector(peer);
    const p = peer.getXmlFragment('default').get(0) as Y.XmlElement;
    p.setAttribute('textAlign', 'left');
    const item = p._map.get('textAlign')!;
    (item.content as Y.ContentAny).arr.push('center'); // a two-value keyed item (pre-#847 stored shape)
    item.length = 2;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, sv));
    Y.applyUpdate(doc, new Uint8Array([0, 1, 9, 1, 1, 1])); // its second value deleted: the first stranded
    expect(() => doc.getXmlFragment('default').delete(0, 1)).toThrow();
    expect(liveWedged(doc)).toBe(true);
    return doc;
  }

  it('an out-of-band row is never folded in: the store fails (WedgedDocumentError), nothing integrated', () => {
    const resident = wedgedResident();
    const row = new Y.Doc();
    Y.applyUpdate(row, Y.encodeStateAsUpdate(resident));
    row.getXmlFragment('default').insert(0, [paragraph('out of band')]);
    const state = Y.encodeStateVector(resident);
    expect(() => reconcileRowIntoDoc(resident, rowBytesOf(row))).toThrow(WedgedDocumentError);
    expect(Y.encodeStateVector(resident)).toEqual(state); // nothing applied
    expect(coveredRowDigest(resident)).toBeNull();
    // control: the same reconcile into a healthy copy folds the row in
    const healthy = new Y.Doc();
    Y.applyUpdate(healthy, Y.encodeStateAsUpdate(resident));
    expect(reconcileRowIntoDoc(healthy, rowBytesOf(row))).toEqual({ merged: true });
  });

  it('a row the wedged document already covers (its own store) is not refused: the store of live\'s encoding proceeds', () => {
    const resident = wedgedResident();
    expect(reconcileRowIntoDoc(resident, rowBytesOf(resident))).toEqual({ merged: false });
  });
});
