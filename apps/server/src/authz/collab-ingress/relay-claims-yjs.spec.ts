import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { encodeStructs } from './conflict-scan.testkit';

/**
 * #842 (ADR 0036 §4) tripwire: the Yjs wire facts the owner-claim comparison (relay-claims.ts R0–R6) and its pre-pass
 * rules rely on, as golden behaviour vectors on the installed yjs. Follows conflict-scan.spec.ts: a yjs bump fails here
 * first, with what to re-validate.
 */
const PINNED_YJS_VERSION = '13.6.30';
const RE_VALIDATE = [
  'yjs changed under the #842 owner-claim comparison (relay-claims.ts, ADR 0036 §4). Before updating the pin:',
  '1. re-check each vector below against the new yjs (src/utils/updates.js decodeUpdate/diffUpdate, encoding.js',
  '   readClientsStructRefs/integrateStructs, structs/Item.js write/getMissing/integrate, ContentString.splice, GC);',
  '2. a changed vector: re-derive the rule it backs (R1 straddle, R3 normalization, R4/R6 deleted and GC, the',
  '   client-blocks and zero-length pre-pass rules) and re-run relay-claims.spec.ts, relay-binding.spec.ts and the crash',
  '   corpus in honest-concurrency.spec.ts;',
  '3. then update PINNED_YJS_VERSION.',
].join('\n');

/** A one-paragraph page: root > paragraph > XmlText('hello'), all by client 1. */
function page() {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  doc.transact(() => {
    doc.getXmlFragment('default').insert(0, [p]);
    p.insert(0, [t]);
    t.insert(0, 'hello');
  });
  return { doc, p, t, first: (t as any)._start as Y.Item };
}
const copy = (doc: Y.Doc): Y.Doc => {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(doc));
  return d;
};
const writer = (base: Y.Doc, client: number): Y.Doc => {
  const d = copy(base);
  d.clientID = client;
  return d;
};

describe('#842 tripwire: the yjs wire facts the owner-claim comparison relies on', () => {
  it('the installed yjs is the pinned one', () => {
    const version = (JSON.parse(readFileSync(require.resolve('yjs/package.json'), 'utf8')) as { version: string }).version;
    if (version !== PINNED_YJS_VERSION) throw new Error(`${RE_VALIDATE}\n(installed yjs ${version})`);
  });

  it('R3: a decoded item with an origin carries no parent and no parentSub (Yjs derives them); only both-null carries them', () => {
    const { doc, p } = page();
    const w = writer(doc, 7);
    const wp = w.getXmlFragment('default').get(0) as Y.XmlElement;
    const step = (edit: () => void): Y.Item[] => {
      const sv = Y.encodeStateVector(w);
      w.transact(edit);
      return Y.decodeUpdate(Y.encodeStateAsUpdate(w, sv)).structs as Y.Item[];
    };
    const [fresh] = step(() => wp.setAttribute('textAlign', 'left')); // a fresh key: no origin; parent and key on the wire
    expect(fresh).toMatchObject({ origin: null, rightOrigin: null, parentSub: 'textAlign' });
    expect(fresh.parent).toEqual(p._item!.id);
    const [next] = step(() => wp.setAttribute('textAlign', 'right')); // its next value: an origin; the key NOT on the wire
    const [typed] = step(() => (wp.get(0) as Y.XmlText).insert(5, '!'));
    for (const s of [next, typed]) {
      expect(s.origin).not.toBeNull();
      expect({ parent: s.parent, parentSub: s.parentSub }).toEqual({ parent: null, parentSub: null });
    }
  });

  it('R3: a diff from inside a struct writes its tail with origin (x, p-1), no parent, the same rightOrigin', () => {
    const { doc } = page();
    const w = writer(doc, 7);
    w.transact(() => ((w.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'abcdef'));
    const whole = Y.decodeUpdate(Y.encodeStateAsUpdate(w, Y.encodeStateVector(doc))).structs.find((s) => s.id.client === 7) as Y.Item;
    expect(whole.origin).toBeNull();
    const sv = new Map(Y.decodeStateVector(Y.encodeStateVector(doc)));
    sv.set(7, 2);
    const tail = Y.decodeUpdate(Y.encodeStateAsUpdate(w, Y.encodeStateVector(sv))).structs.find((s) => s.id.client === 7) as Y.Item;
    expect(tail.id.clock).toBe(2);
    expect(tail.origin).toEqual(Y.createID(7, 1));
    expect(tail.rightOrigin).toEqual(whole.rightOrigin);
    expect(tail.parent).toBeNull();
    expect((tail.content as Y.ContentString).str).toBe('cdef');
  });

  it('R1: a partly-held struct\'s tail takes its parent from the WIRE start origin, not from (x, h-1)', () => {
    const { doc } = page();
    const live = copy(doc);
    const w = writer(doc, 7);
    w.transact(() => ((w.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'a'));
    Y.applyUpdate(live, Y.encodeStateAsUpdate(w, Y.encodeStateVector(live))); // live holds 7:0 (in the text)
    const paragraph = (live.getXmlFragment('default').get(0) as Y.XmlElement)._item!.id; // an item of the ROOT list
    const crafted = encodeStructs([
      { client: 7, clock: 0, structs: [new Y.Item(Y.createID(7, 0), null, paragraph, null, null, null, null, new Y.ContentString('ab'))] },
    ]);
    Y.applyUpdate(live, crafted);
    const tail = Y.getItem(live.store, Y.createID(7, 1)) as Y.Item;
    expect(tail.left!.id).toEqual(Y.createID(7, 0)); // linked after the held clock, in the text...
    expect(tail.parent).toBe(live.getXmlFragment('default')); // ...with the root as its parent (the wire origin's)
  });

  it('client-blocks: a repeated client block decodes twice and applies only the last one', () => {
    const { doc, first } = page();
    const at = (s: string) => new Y.Item(Y.createID(7, 0), null, first.id, null, null, null, null, new Y.ContentString(s));
    const twice = encodeStructs([
      { client: 7, clock: 0, structs: [at('GOOD')] },
      { client: 7, clock: 0, structs: [at('BAD!')] },
    ]);
    expect(Y.decodeUpdate(twice).structs.map((s) => ((s as Y.Item).content as Y.ContentString).str)).toEqual(['GOOD', 'BAD!']);
    const live = copy(doc);
    Y.applyUpdate(live, twice);
    expect(((live.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).toString()).toBe('helloBAD!');
  });

  it('zero-length: a zero-length GC integrates, and then the document cannot be encoded', () => {
    const { doc, first } = page();
    const live = copy(doc);
    Y.applyUpdate(live, encodeStructs([{ client: 7, clock: 0, structs: [new Y.Item(Y.createID(7, 0), null, first.id, null, null, null, null, new Y.ContentString('x'))] }]));
    Y.applyUpdate(live, encodeStructs([{ client: 7, clock: 1, structs: [new Y.GC(Y.createID(7, 1), 0)] }]));
    expect(live.store.clients.get(7)!.length).toBe(2);
    expect(() => Y.encodeStateAsUpdate(live)).toThrow();
  });

  it('R4/R6: a deleted item in a live parent becomes ContentDeleted; the children of a deleted type become GC', () => {
    const { doc } = page();
    const w = writer(doc, 7);
    w.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, 'gone');
      w.getXmlFragment('default').insert(1, [p]);
      ((w.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'z');
    });
    w.transact(() => {
      ((w.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(0, 1);
      w.getXmlFragment('default').delete(1, 1);
    });
    const kinds = (Y.decodeUpdate(Y.encodeStateAsUpdate(w, Y.encodeStateVector(doc))).structs as Array<Y.Item | Y.GC>)
      .filter((s) => s.id.client === 7)
      .map((s) => (s instanceof Y.GC ? 'GC' : s.content.constructor.name));
    expect(kinds).toEqual(['ContentDeleted', 'GC', 'ContentDeleted']); // the paragraph, its XmlText+text, the 'z'
  });

  it('R6 evidence: an item whose origin is a GC integrates as a GC; one into a deleted type ends deleted', () => {
    const { doc, first } = page();
    const live = copy(doc);
    Y.applyUpdate(live, encodeStructs([{ client: 7, clock: 0, structs: [new Y.GC(Y.createID(7, 0), 1)] }]));
    Y.applyUpdate(live, encodeStructs([{ client: 8, clock: 0, structs: [new Y.Item(Y.createID(8, 0), null, Y.createID(7, 0), null, null, null, null, new Y.ContentString('x'))] }]));
    expect(Y.getItem(live.store, Y.createID(8, 0))).toBeInstanceOf(Y.GC);
    const para = (live.getXmlFragment('default').get(0) as Y.XmlElement)._item!;
    live.transact(() => live.getXmlFragment('default').delete(0, 1));
    expect(para.deleted).toBe(true);
    Y.applyUpdate(live, encodeStructs([{ client: 9, clock: 0, structs: [new Y.Item(Y.createID(9, 0), null, first.id, null, null, null, null, new Y.ContentString('y'))] }]));
    const late = Y.getItem(live.store, Y.createID(9, 0));
    expect(late instanceof Y.GC || (late as Y.Item).deleted).toBe(true);
  });

  it('R5: ContentString.splice rewrites a split surrogate pair to U+FFFD on both halves; V1 strings are well-formed', () => {
    const c = new Y.ContentString('a\u{1F600}b');
    const right = c.splice(2);
    expect(c.str).toBe('a�');
    expect(right.str).toBe('�b');
    // the raw slices the comparison uses are never spliced: a lone surrogate written to the wire reads back as U+FFFD
    const d = new Y.Doc();
    d.getText('t').insert(0, '\uD83D');
    const back = Y.decodeUpdate(Y.encodeStateAsUpdate(d)).structs[0] as Y.Item;
    expect((back.content as Y.ContentString).str).toBe('�');
  });

  it('claims: a state vector of MAX drops those clients\' structs from a diff and keeps the whole delete set', () => {
    const { doc } = page();
    const a = writer(doc, 7);
    a.transact(() => ((a.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'A'));
    const b = writer(a, 8);
    b.transact(() => {
      const t = (b.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
      t.insert(0, 'B');
      t.delete(1, 1); // 7's 'A'
    });
    const u = Y.encodeStateAsUpdate(b, Y.encodeStateVector(doc));
    const own = Y.decodeUpdate(Y.diffUpdate(u, Y.encodeStateVector(new Map([[7, Number.MAX_SAFE_INTEGER]]))));
    expect(new Set(own.structs.map((s) => s.id.client))).toEqual(new Set([8]));
    expect([...own.ds.clients.keys()]).toEqual([7]);
  });

  it('strict equal: lib0 decodes a "__proto__" key as a prototype, so {"__proto__": null} arrives prototype-less', () => {
    const d = new Y.Doc();
    d.getArray('a').insert(0, [JSON.parse('{"__proto__": null}')]);
    const back = Y.decodeUpdate(Y.encodeStateAsUpdate(d)).structs[0] as Y.Item;
    const value = (back.content as Y.ContentAny).arr[0] as object;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Reflect.ownKeys(value)).toEqual([]);
    const zero = new Y.Doc();
    zero.getArray('a').insert(0, [-0]);
    expect(Object.is(((Y.decodeUpdate(Y.encodeStateAsUpdate(zero)).structs[0] as Y.Item).content as Y.ContentAny).arr[0], -0)).toBe(true);
  });
});
