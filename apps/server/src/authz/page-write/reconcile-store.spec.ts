// #390 — the symmetric guard for ADR 0019. Uses REAL yjs (imports only `yjs`, no tiptap graph), so the
// CRDT merge semantics the fix depends on are actually exercised rather than mocked. Docs are modelled as a
// root XmlFragment 'default' of paragraph elements, matching the shape TiptapTransformer produces.
import * as Y from 'yjs';
import { reconcileRowIntoDoc } from './reconcile-store';

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

  it('is a no-op when the row has no ydoc (null/undefined/empty)', () => {
    const resident = docWith(['x']);
    const before = Buffer.from(Y.encodeStateVector(resident));

    expect(reconcileRowIntoDoc(resident, null).merged).toBe(false);
    expect(reconcileRowIntoDoc(resident, undefined as unknown as Buffer).merged).toBe(false);
    expect(reconcileRowIntoDoc(resident, Buffer.alloc(0)).merged).toBe(false);
    expect(Buffer.from(Y.encodeStateVector(resident))).toEqual(before);
  });
});
