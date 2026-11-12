import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { basePage, copyOf, rawUpdate, type RawId, type RawStruct } from './conflict-scan.testkit';
import { displacedItems, isReloadStable, strictOrderDiff } from './order-parity';

/**
 * #840 (ADR 0036): order parity. A crafted frame integrates into one order live and another after a reload; these specs
 * pin that the strict compare sees it (in text, elements, key chains, nested types, tombstones and split boundaries),
 * that it stays silent for honest concurrent editing, that the displaced set names the crafted item and not the honest
 * ones, and that the yjs internals it reads are the ones it was written against.
 */

/** Pinned: the yjs version and `Item` class source order-parity.ts reads (fields, split and merge rules). */
const PINNED_YJS_VERSION = '13.6.30';
const PINNED_ITEM_SHA256 = 'abce0f0d3aaebf08c7d93042a58df1cfb113fdade87d1fd5ad1c62b3428cb0db';
const RE_VALIDATE = [
  're-validate order-parity on a yjs bump (#840, ADR 0036). Before updating the pins:',
  '1. diff the new Item class (src/structs/Item.js: fields, splitItem, mergeWith, integrate) and AbstractType/StructStore',
  '   (_start, _map, _length, clients, pendingStructs, pendingDs) against 13.6.30;',
  '2. re-check that order-parity.ts reads every field an integration choice depends on, and that split and merge rules',
  '   still make struct boundaries part of the order (S1 and the split-only case in this spec), and that',
  '   parent-consistency.ts still reads what it needs (Transaction.beforeState, findIndexSS, each new item\'s neighbours);',
  '3. run this spec and the conflict-scan and honest-concurrency specs;',
  '4. then update PINNED_YJS_VERSION and PINNED_ITEM_SHA256.',
].join('\n');

const reloadOf = (doc: Y.Doc) => {
  const r = new Y.Doc({ gc: doc.gc });
  Y.applyUpdate(r, Y.encodeStateAsUpdate(doc));
  return r;
};
const chars = (origin: RawId | null, right: RawId | null, s = 'X'): RawStruct => ({ origin, right, content: new Y.ContentString(s) });
const element = (name: string) => new Y.ContentType(new Y.XmlElement(name)) as unknown as RawStruct['content'];
/** S1's frame: one item after the 6th character a struct holds, with its rightOrigin at the 4th (left of its origin). */
const s1Frame = (client: number, first: number, author = 1, text = 'X') =>
  rawUpdate([{ client, clock: 0, structs: [chars([author, first + 5], [author, first + 3], text)] }]);

/** S1: client 1 writes "abcdef" as ONE struct in root `text`; the crafted item splits it live and lands on a boundary after a reload. */
function s1(): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, rawUpdate([{ client: 1, clock: 0, structs: [{ origin: null, right: null, parent: 'text', content: new Y.ContentString('abcdef') }] }]));
  Y.applyUpdate(doc, s1Frame(2, 0));
  return doc;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('#840 strictOrderDiff: equal replicas', () => {
  it('a document, its copy and its reload are equal; a missing root equals an empty one', () => {
    const { doc } = basePage();
    expect(strictOrderDiff(doc, doc)).toBeNull();
    expect(strictOrderDiff(doc, copyOf(doc))).toBeNull();
    expect(isReloadStable(doc).stable).toBe(true);
    expect(strictOrderDiff(new Y.Doc(), new Y.Doc())).toBeNull();
    const a = copyOf(doc);
    a.getXmlFragment('unused');
    a.getMap('meta');
    expect(strictOrderDiff(a, doc)).toBeNull();
    expect(strictOrderDiff(doc, a)).toBeNull();
    // ... but a root with content is not missing
    a.getMap('meta').set('k', 1);
    expect(strictOrderDiff(doc, a)).toMatchObject({ path: 'meta.k', kind: 'chain' });
  });

  it('a reload keeps the gc setting (a gc:false replica keeps deleted content)', () => {
    const doc = new Y.Doc({ gc: false });
    doc.getText('t').insert(0, 'abcdef');
    doc.getText('t').delete(1, 2);
    const { stable, reload } = isReloadStable(doc);
    expect(stable).toBe(true);
    expect(reload.gc).toBe(false);
  });
});

describe('#840 strictOrderDiff: honest concurrent editing is reload-stable (seeded fuzz)', () => {
  const SEEDS = 120;
  const OPS = 300;
  /** A session where an unpatched yjs `redoItem` gives live and its reload different orders (found by this fuzz at 3000 sessions). */
  const REDO_SEED = 552;
  const WORDS = ['lorem ', 'ipsum ', 'x', 'é', 'dolor sit '];

  /** One session: 2–4 peers edit one page, frames reach the server late and in arrival order, grouped undo and redo. */
  function session(seed: number) {
    const r = rng(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
    const live = new Y.Doc();
    type Peer = { doc: Y.Doc; undo: Y.UndoManager; out: Uint8Array[]; inbox: Uint8Array[] };
    const peers: Peer[] = [];
    live.on('update', (u: Uint8Array, origin: unknown) => {
      for (const p of peers) if (p !== origin) p.inbox.push(u);
    });
    for (let i = 2 + Math.floor(r() * 3); i > 0; i--) {
      const doc = new Y.Doc();
      doc.clientID = 1000 * i + Math.floor(r() * 1000); // seeded: conflict resolution compares client ids
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(live), 'remote');
      // captureTimeout Infinity: undo groups end only at stopCapturing (grouped redo is the honest #840 source, without wall clock)
      const peer: Peer = { doc, undo: new Y.UndoManager(doc.getXmlFragment('default'), { captureTimeout: Infinity }), out: [], inbox: [] };
      doc.on('update', (u: Uint8Array, origin: unknown) => {
        if (origin !== 'remote') peer.out.push(u);
      });
      peers.push(peer);
    }
    const stats = { checks: 0, undo: 0, redo: 0, gcRuns: 0 };
    const check = () => {
      stats.checks++;
      // adjacent GC structs: live keeps them apart, a reload merges them (the compare treats a run as one range)
      for (const structs of live.store.clients.values()) {
        if (structs.some((x, k) => x instanceof Y.GC && structs[k + 1] instanceof Y.GC)) stats.gcRuns++;
      }
      const d = strictOrderDiff(live, reloadOf(live));
      if (d) throw new Error(`seed ${seed}: live != reload ${JSON.stringify(d)}`);
    };
    const paragraph = (text: string) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, text);
      p.insert(0, [t]);
      return p;
    };
    const list = () => {
      const l = new Y.XmlElement('bulletList');
      const li = new Y.XmlElement('listItem');
      li.insert(0, [paragraph(pick(WORDS))]);
      l.insert(0, [li]);
      return l;
    };
    /** The peer's containers (the fragment, lists, list items) and texts. */
    const walk = (doc: Y.Doc) => {
      const containers: Array<Y.XmlFragment | Y.XmlElement> = [doc.getXmlFragment('default')];
      const texts: Y.XmlText[] = [];
      const visit = (t: Y.XmlFragment | Y.XmlElement) => {
        for (const c of t.toArray()) {
          if (c instanceof Y.XmlText) texts.push(c);
          else if (c instanceof Y.XmlElement) {
            if (c.nodeName !== 'paragraph') containers.push(c);
            visit(c);
          }
        }
      };
      visit(doc.getXmlFragment('default'));
      return { containers, texts };
    };
    const edit = (p: Peer) => {
      const { containers, texts } = walk(p.doc);
      const x = r();
      if (x < 0.3 && texts.length) {
        const t = pick(texts);
        t.insert(Math.floor(r() * (t.length + 1)), pick(WORDS), r() < 0.2 ? { bold: true } : undefined);
      } else if (x < 0.42 && texts.length) {
        const t = pick(texts);
        const at = Math.floor(r() * t.length);
        if (t.length) t.delete(at, Math.min(t.length - at, 1 + Math.floor(r() * 6)));
      } else if (x < 0.52 && texts.length) {
        const t = pick(texts);
        const at = Math.floor(r() * t.length);
        if (t.length) t.format(at, 1 + Math.floor(r() * 5), { bold: r() < 0.6 ? true : null });
      } else if (x < 0.68) {
        const c = pick(containers);
        const kind = c instanceof Y.XmlElement && c.nodeName === 'bulletList' ? 'item' : r() < 0.25 ? 'list' : 'para';
        const node = kind === 'item' ? new Y.XmlElement('listItem') : kind === 'list' ? list() : paragraph(pick(WORDS));
        if (kind === 'item') node.insert(0, [paragraph(pick(WORDS))]);
        c.insert(Math.floor(r() * (c.length + 1)), [node]);
      } else if (x < 0.76) {
        const c = pick(containers);
        if (c.length) c.delete(Math.floor(r() * c.length), 1);
      } else if (x < 0.82) {
        const els = containers.filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
        if (els.length) pick(els).setAttribute('textAlign', pick(['left', 'center', 'right']));
      } else if (x < 0.9) {
        stats.undo++;
        p.undo.undo();
      } else {
        stats.redo++;
        p.undo.redo();
      }
      if (r() < 0.3) p.undo.stopCapturing();
    };
    for (let op = 0; op < OPS; op++) {
      const p = pick(peers);
      const y = r();
      if (y < 0.55) edit(p);
      else if (y < 0.8) {
        for (const u of p.out.splice(0, 1 + Math.floor(r() * p.out.length))) Y.applyUpdate(live, u, p);
      } else for (const u of p.inbox.splice(0, 1 + Math.floor(r() * p.inbox.length))) Y.applyUpdate(p.doc, u, 'remote');
      if (op % 25 === 24) check();
    }
    for (const p of peers) for (const u of p.out.splice(0)) Y.applyUpdate(live, u, p);
    check();
    expect(displacedItems(live, reloadOf(live))).toEqual([]);
    return { ...stats, structs: [...live.store.clients.values()].reduce((n, s) => n + s.length, 0) };
  }

  it(`${SEEDS} sessions × ${OPS} ops (and the grouped-redo session): live equals its reload at every check, and nothing is displaced`, () => {
    const total = { checks: 0, undo: 0, redo: 0, gcRuns: 0, structs: 0 };
    for (const seed of [...Array.from({ length: SEEDS }, (_, i) => i + 1), REDO_SEED]) {
      const s = session(seed * 7919);
      for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += s[k];
    }
    console.log(`#840 honest order-parity fuzz: ${JSON.stringify({ sessions: SEEDS + 1, ops: (SEEDS + 1) * OPS, ...total })}`);
    // Anti-vacuity: the corpus held real documents, and grouped undo and redo ran.
    expect(total.structs).toBeGreaterThan(SEEDS * 100);
    expect(total.redo).toBeGreaterThan(SEEDS * 5);
    expect(total.gcRuns).toBeGreaterThan(0);
  });
});

describe('#840 strictOrderDiff: crafted divergence', () => {
  it('S1 (text): live and its reload differ, by order and by split; the reload is not idempotent', () => {
    const live = s1();
    const reload = reloadOf(live);
    expect(live.getText('text').toString()).toBe('abcXdef');
    expect(reload.getText('text').toString()).toBe('abcdefX');
    expect(strictOrderDiff(live, reload)).toEqual({ path: 'text[0]', kind: 'length', detail: 'a=3 b=6' });
    const { stable, diff } = isReloadStable(live);
    expect(stable).toBe(false);
    expect(diff).toEqual({ path: 'text[0]', kind: 'length', detail: 'a=3 b=6' });
    expect(reloadOf(reload).getText('text').toString()).toBe('abcXdef'); // and back: every reload flips
    expect(isReloadStable(reload).stable).toBe(false);
  });

  it('S2-style (elements): a crafted heading lands before a paragraph live and after it on reload', () => {
    const live = new Y.Doc();
    live.clientID = 1;
    const f = live.getXmlFragment('default');
    f.insert(0, [0, 1, 2, 3, 4, 5].map(() => new Y.XmlElement('paragraph')));
    f.delete(0, 6); // one tombstone run 1:0+6, as six removed paragraphs leave it
    Y.applyUpdate(live, rawUpdate([{ client: 0, clock: 0, structs: [{ origin: [1, 5], right: null, content: element('paragraph') }] }]));
    Y.applyUpdate(live, rawUpdate([{ client: 2, clock: 0, structs: [{ origin: [1, 5], right: [1, 3], content: element('heading') }] }]));
    const reload = reloadOf(live);
    expect(f.toJSON()).toBe('<heading></heading><paragraph></paragraph>');
    expect(reload.getXmlFragment('default').toJSON()).toBe('<paragraph></paragraph><heading></heading>');
    expect(strictOrderDiff(live, reload)).toMatchObject({ path: 'default[0]', kind: 'length' });
    expect(displacedItems(live, reload)).toEqual([{ client: 2, clock: 0 }]);
  });

  it('a nested type: the path names the root and the XmlText item', () => {
    const b = basePage('abcdefgh');
    Y.applyUpdate(b.doc, s1Frame(2, b.first, 1, 'XYZ'));
    const textItem = b.t._item!.id;
    const { stable, diff, reload } = isReloadStable(b.doc);
    expect(stable).toBe(false);
    expect(diff).toEqual({ path: `default/${textItem.client}:${textItem.clock}[0]`, kind: 'length', detail: 'a=3 b=8' });
    expect(displacedItems(b.doc, reload)).toEqual([{ client: 2, clock: 0 }]); // one entry for the run 2:0..2
  });

  it('a key chain (an element attribute): the attribute holds another value after a reload', () => {
    const b = basePage();
    const values = new Y.ContentAny(['left', 'right', 'center', 'left', 'right', 'center']);
    Y.applyUpdate(b.doc, rawUpdate([{ client: 30, clock: 0, structs: [{ origin: null, right: null, parent: b.paragraphId, sub: 'textAlign', content: values }] }]));
    Y.applyUpdate(b.doc, s1Frame(2, 0, 30));
    const reload = reloadOf(b.doc);
    expect(b.p.getAttribute('textAlign')).toBe('center');
    expect((reload.getXmlFragment('default').get(0) as Y.XmlElement).getAttribute('textAlign')).toBeUndefined();
    const [c, k] = b.paragraphId;
    expect(strictOrderDiff(b.doc, reload)).toEqual({ path: `default/${c}:${k}.textAlign[0]`, kind: 'length', detail: 'a=3 b=6' });
    expect(displacedItems(b.doc, reload)).toEqual([{ client: 2, clock: 0 }]);
  });

  it('a tombstone alone in another place (same text, same splits) is a difference', () => {
    const live = s1();
    const reload = reloadOf(live);
    // A character between c and d on each replica (so both split abc|def), then X removed on both.
    const z = rawUpdate([{ client: 5, clock: 0, structs: [chars([1, 2], [1, 3], 'Z')] }]);
    const delX = rawUpdate([], [{ client: 2, ranges: [[0, 1]] }]);
    for (const d of [live, reload]) {
      Y.applyUpdate(d, z);
      Y.applyUpdate(d, delX);
    }
    expect(live.getText('text').toString()).toBe('abcZdef');
    expect(reload.getText('text').toString()).toBe('abcZdef');
    expect(strictOrderDiff(live, reload)).toEqual({ path: 'text[2]', kind: 'id', detail: 'a=2:0 b=1:3' });
    expect(displacedItems(live, reload)).toEqual([{ client: 2, clock: 0 }]);
  });

  it('split boundaries alone are a difference (strict): the next frame orders the two replicas differently', () => {
    const a = new Y.Doc();
    Y.applyUpdate(a, rawUpdate([{ client: 1, clock: 0, structs: [{ origin: null, right: null, parent: 'text', content: new Y.ContentString('abcdef') }] }]));
    const b = copyOf(a);
    b.transact((tr) => {
      Y.getItemCleanStart(tr, Y.createID(1, 3));
      (tr as unknown as { _mergeStructs: unknown[] })._mergeStructs.length = 0; // keep the split, as a reload of a split replica does
    });
    expect(b.getText('text').toString()).toBe(a.getText('text').toString());
    expect(strictOrderDiff(a, b)).toEqual({ path: 'text[0]', kind: 'length', detail: 'a=6 b=3' });
    // Why it must be strict: equal characters in equal order, yet S1's frame then lands in two places.
    Y.applyUpdate(a, s1Frame(2, 0));
    Y.applyUpdate(b, s1Frame(2, 0));
    expect(a.getText('text').toString()).not.toBe(b.getText('text').toString());
  });

  it('pending structs and deletes: equal on both is equal, one-sided or different is a difference', () => {
    const base = s1();
    const waiting = (doc: Y.Doc, client: number) => Y.applyUpdate(doc, rawUpdate([{ client, clock: 0, structs: [chars([9, 4], null)] }]));
    const [a, b] = [copyOf(base), copyOf(base)];
    expect(strictOrderDiff(a, b)).toBeNull();
    waiting(a, 40);
    expect(a.store.pendingStructs).not.toBeNull();
    expect(strictOrderDiff(a, b)).toEqual({ path: 'store', kind: 'pending', detail: 'structs a=true b=false' });
    waiting(b, 40);
    expect(strictOrderDiff(a, b)).toBeNull();
    const c = copyOf(base);
    waiting(c, 41);
    expect(strictOrderDiff(a, c)).toMatchObject({ kind: 'pending' });
    // a delete of a struct nobody has yet
    Y.applyUpdate(a, rawUpdate([], [{ client: 77, ranges: [[0, 1]] }]));
    expect(a.store.pendingDs).not.toBeNull();
    expect(strictOrderDiff(a, b)).toEqual({ path: 'store', kind: 'pending', detail: 'ds a=true b=false' });
  });

  it('per-client struct store: structs no chain reaches (under a deleted type) are compared too', () => {
    const [a, b] = [new Y.Doc({ gc: false }), new Y.Doc({ gc: false })];
    for (const d of [a, b]) {
      d.clientID = 1;
      d.getMap('m').set('t', new Y.Text('abc'));
    }
    const other = copyOf(a);
    other.clientID = 5;
    (other.getMap('m').get('t') as Y.Text).insert(1, 'Z');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(other));
    for (const d of [a, b]) d.getMap('m').delete('t');
    // a's text was split by Z and has client 5's struct; b's was not (no chain reaches either: the text is deleted)
    expect(strictOrderDiff(a, b)).toEqual({ path: 'store/1', kind: 'store', detail: '[1] a=1+1item b=1+3item' });
    b.store.clients.get(1)!.splice(0, Infinity, ...a.store.clients.get(1)!); // client 1 made equal by hand: client 5 remains
    expect(strictOrderDiff(a, b)).toEqual({ path: 'store/5', kind: 'store', detail: '[0] a=0+1item b=-' });
    expect(strictOrderDiff(b, a)).toEqual({ path: 'store/5', kind: 'store', detail: 'a=- b=1' });
  });

  it('per-client struct store: an item and a GC struct over the same clocks differ', () => {
    const [a, b] = [new Y.Doc({ gc: false }), new Y.Doc({ gc: false })];
    for (const d of [a, b]) {
      d.clientID = 1;
      d.getMap('m').set('t', new Y.Text('abc'));
      d.getMap('m').delete('t');
    }
    const structs = b.store.clients.get(1)!;
    expect(structs.map((st) => [st.id.clock, st.length])).toEqual([[0, 1], [1, 3]]);
    structs[1] = new Y.GC(structs[1].id, 3); // as gc would leave it: no chain reaches it
    expect(strictOrderDiff(a, b)).toEqual({ path: 'store/1', kind: 'store', detail: '[1] a=1+3item b=1+3gc' });
  });
});

describe('#840 strictOrderDiff: every item field it reads is compared (a copy corrupted by hand)', () => {
  const corrupt: Array<[string, (item: Y.Item, doc: Y.Doc) => void]> = [
    ['typeLength', (_, doc) => doc.getText('text')._length++],
    ['origin', (i) => (i.origin = Y.createID(9, 9))],
    ['rightOrigin', (i) => (i.rightOrigin = Y.createID(9, 9))],
    ['parentSub', (i) => (i.parentSub = 'k')],
    ['parent', (i, doc) => (i.parent = doc.getText('elsewhere'))],
    ['content', (i) => (i.content = new Y.ContentAny(['x', 'y', 'z']))],
    ['deleted', (i) => i.markDeleted()],
  ];
  it.each(corrupt)('%s', (kind, change) => {
    const a = new Y.Doc();
    a.getText('text').insert(0, 'abc');
    a.getText('text').insert(3, 'def', { bold: true });
    const b = copyOf(a);
    change(b.getText('text')._start!.right!, b);
    expect(strictOrderDiff(a, b)).toMatchObject({ path: kind === 'typeLength' ? 'text' : 'text[1]', kind });
    expect(strictOrderDiff(b, a)).toMatchObject({ path: kind === 'typeLength' ? 'text' : 'text[1]', kind }); // either side
  });

  it('content: a type item holding another kind of type', () => {
    const a = new Y.Doc();
    a.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    const b = copyOf(a);
    b.getXmlFragment('default')._start!.content = new Y.ContentType(new Y.XmlText());
    expect(strictOrderDiff(a, b)).toMatchObject({ path: 'default[0]', kind: 'content' });
  });

  it('parent: an item that claims another parent or key is unequal even to an identical replica', () => {
    const changes: Array<(i: Y.Item, doc: Y.Doc) => void> = [(i, doc) => (i.parent = doc.getText('elsewhere')), (i) => (i.parentSub = 'k')];
    for (const change of changes) {
      const a = new Y.Doc();
      a.getText('text').insert(0, 'abc');
      a.getText('text').insert(3, 'def', { bold: true });
      change(a.getText('text')._start!.right!, a);
      expect(strictOrderDiff(a, a)).toMatchObject({ path: 'text[1]', kind: 'parent' });
    }
  });
});

describe('#840 displacedItems: blame lands on the crafted item, never on honest concurrent ones', () => {
  it('honest peers type around the crafted item: only the crafted item is displaced, and the output is bounded', () => {
    const live = new Y.Doc();
    Y.applyUpdate(live, rawUpdate([{ client: 1, clock: 0, structs: [{ origin: null, right: null, parent: 'text', content: new Y.ContentString('abcdef') }] }]));
    const peers = [3, 4].map((client) => {
      const p = copyOf(live);
      p.clientID = client;
      return p;
    });
    peers[0].getText('text').insert(0, 'hello ');
    peers[1].getText('text').insert(6, ' world');
    peers[1].getText('text').insert(1, '-');
    for (const p of peers) Y.applyUpdate(live, Y.encodeStateAsUpdate(p));
    Y.applyUpdate(live, s1Frame(2, 0));
    Y.applyUpdate(live, rawUpdate([{ client: 8, clock: 0, structs: [{ origin: null, right: null, parent: 'other', content: new Y.ContentString('abcdef') }] }]));
    Y.applyUpdate(live, s1Frame(9, 0, 8));
    const reload = reloadOf(live);
    expect(strictOrderDiff(live, reload)).not.toBeNull();
    const all = displacedItems(live, reload);
    expect(all).toHaveLength(2);
    expect(all).toEqual(expect.arrayContaining([{ client: 2, clock: 0 }, { client: 9, clock: 0 }]));
    expect(displacedItems(live, reload, 1)).toHaveLength(1);
  });
});

describe('#840 tripwire: the yjs internals order-parity reads', () => {
  it('the yjs version, the Item class source and the shapes read equal the pinned ones', () => {
    const version = (JSON.parse(readFileSync(require.resolve('yjs/package.json'), 'utf8')) as { version: string }).version;
    const sha = createHash('sha256').update(Y.Item.toString()).digest('hex');
    const { doc, t } = basePage();
    doc.getMap('m').set('k', 1);
    const item = t._start as unknown as Record<string, unknown>;
    const fields = ['id', 'left', 'right', 'origin', 'rightOrigin', 'parent', 'parentSub', 'length', 'content'];
    const type = t as unknown as Record<string, unknown>;
    const store = doc.store as unknown as Record<string, unknown>;
    const shapes =
      fields.every((f) => f in item) &&
      typeof item.deleted === 'boolean' &&
      item.parent === t &&
      type._start === item &&
      typeof type._length === 'number' &&
      (doc.getMap('m') as unknown as { _map: unknown })._map instanceof Map &&
      store.clients instanceof Map &&
      'pendingStructs' in store &&
      'pendingDs' in store;
    if (version !== PINNED_YJS_VERSION || sha !== PINNED_ITEM_SHA256 || !shapes) {
      throw new Error(`${RE_VALIDATE}\n(installed yjs ${version}, Item sha256 ${sha}, shapes ${shapes ? 'ok' : 'CHANGED'})`);
    }
  });
});

describe('#840 displacedItems: the work is bounded by structs, never by the clocks a struct claims', () => {
  it('a 16-byte tombstone claiming 2^32 clocks, cut differently live and after a reload, is blamed per struct', () => {
    const live = new Y.Doc();
    Y.applyUpdate(live, rawUpdate([{ client: 1, clock: 0, structs: [{ origin: null, right: null, parent: 'text', content: new Y.ContentDeleted(2 ** 32) }] }]));
    Y.applyUpdate(live, s1Frame(2, 0));
    const reload = reloadOf(live);
    expect(strictOrderDiff(live, reload)).toMatchObject({ path: 'text[0]', kind: 'length' });
    expect(displacedItems(live, reload)).toEqual([{ client: 2, clock: 0 }]); // a per-clock walk runs out of heap here
    expect(displacedItems(reload, live)).toEqual([{ client: 2, clock: 0 }]); // cut at both chains' boundaries, either way round
  });
});

describe('#840 isReloadStable: the reload keeps the replica\'s gc settings', () => {
  it('a gcFilter that keeps an item is kept, so the reload holds the same content', () => {
    const doc = new Y.Doc({ gcFilter: (item) => !(item.content instanceof Y.ContentString) });
    doc.getText('t').insert(0, 'abcdef');
    doc.getText('t').delete(1, 2);
    const { stable, reload } = isReloadStable(doc);
    expect(reload.gcFilter).toBe(doc.gcFilter);
    expect(stable).toBe(true);
  });
});
