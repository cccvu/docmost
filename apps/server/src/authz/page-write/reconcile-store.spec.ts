// #390 — the symmetric guard for ADR 0019. Uses REAL yjs (imports only `yjs`, no tiptap graph), so the
// CRDT merge semantics the fix depends on are actually exercised rather than mocked. Docs are modelled as a
// root XmlFragment 'default' of paragraph elements, matching the shape TiptapTransformer produces.
import * as Y from 'yjs';
import { markRowCovered, reconcileRowIntoDoc } from './reconcile-store';

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
