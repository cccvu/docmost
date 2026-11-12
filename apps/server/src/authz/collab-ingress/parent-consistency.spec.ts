import * as Y from 'yjs';
import { initProseMirrorDoc, updateYFragment } from '@tiptap/y-tiptap';
import { Node as PMNode } from '@tiptap/pm/model';
import { serverSchema } from '../page-write/prelim-content';
import { copyOf, rawUpdate, type RawId } from './conflict-scan.testkit';
import { parentConsistencyViolation } from './parent-consistency';
import { isKeyedSplit } from './update-guard';

/**
 * #840 (ADR 0036): every item a frame integrates sits beside neighbours of its own parent and key. A crafted frame that
 * re-sends a partly known struct with another origin is linked into a list it does not name (control arms: `_length`
 * drift, live and a reload disagree); honest frames never do it, whatever the undo grouping, the nesting or the offline
 * merges (a seeded corpus: every frame the server applies and every remote integration on a peer, checked).
 */
type Hit = ReturnType<typeof parentConsistencyViolation>;

/** #847: the guard's keyed-split rule over what `tr` integrated (the corpus checks it with the parent rule). */
function keyedSplitIn(tr: Y.Transaction): Hit {
  const store = tr.doc.store;
  for (const [client, structs] of store.clients) {
    const before = tr.beforeState.get(client) ?? 0;
    if (Y.getState(store, client) <= before) continue;
    for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
      const item = structs[i];
      if (!(item instanceof Y.Item) || item.parentSub === null) continue;
      seen.keyed++;
      if (isKeyedSplit(item)) return { client, clock: item.id.clock };
    }
  }
  return null;
}

/** `update` applied as the guard applies a frame: the rule read inside the transaction, before Yjs's cleanup. */
function applyChecked(doc: Y.Doc, update: Uint8Array, origin: unknown = 'remote'): Hit {
  let hit: Hit = null;
  Y.transact(
    doc,
    (tr) => {
      Y.applyUpdate(doc, update, origin);
      hit = parentConsistencyViolation(tr) ?? (watchingKeyed ? keyedSplitIn(tr) : null);
    },
    origin,
    false,
  );
  return hit;
}
const idOf = (type: Y.AbstractType<any>): RawId => [type._item!.id.client, type._item!.id.clock];
const textIn = (doc: Y.Doc, i: number): Y.XmlText => (doc.getXmlFragment('default').get(i) as Y.XmlElement).get(0) as Y.XmlText;
const structAt = (doc: Y.Doc, client: number, clock: number) => doc.store.clients.get(client)!.find((st) => st.id.clock <= clock && clock < st.id.clock + st.length)!;
/** Visible characters actually linked in a text's list (what a render reads), against its `_length`. */
const linked = (t: Y.XmlText): number => {
  let n = 0;
  for (let item = t._start; item !== null; item = item.right) if (!item.deleted && item.countable) n += item.length;
  return n;
};

const ATTACKER = 777;

/** `default` > [paragraph > 'one', codeBlock > 'two'] by client 1, and the attacker's honest 'q' at the code's end: (777, 0). */
function twoTexts() {
  const base = new Y.Doc();
  base.clientID = 1;
  const p = new Y.XmlElement('paragraph');
  const c = new Y.XmlElement('codeBlock');
  const pt = new Y.XmlText();
  const ct = new Y.XmlText();
  base.transact(() => {
    base.getXmlFragment('default').insert(0, [p, c]);
    p.insert(0, [pt]);
    c.insert(0, [ct]);
    pt.insert(0, 'one');
    ct.insert(0, 'two');
  });
  const attacker = copyOf(base);
  attacker.clientID = ATTACKER;
  textIn(attacker, 1).insert(3, 'q');
  const live = copyOf(base);
  expect(applyChecked(live, Y.encodeStateAsUpdate(attacker, Y.encodeStateVector(base)))).toBeNull();
  const o = pt._start!.id; // 'one' is one struct: 'n' and 'e' follow 'o'
  return { live, n: [o.client, o.clock + 1] as RawId, e: [o.client, o.clock + 2] as RawId };
}

describe('#840 parent consistency: an integrated item\'s neighbours share its parent and key', () => {
  it('the parent split: (777, 0) re-sent with an origin in the paragraph is linked in the code block; flagged at its tail', () => {
    const { live, e } = twoTexts();
    const frame = rawUpdate([{ client: ATTACKER, clock: 0, structs: [{ origin: e, right: null, content: new Y.ContentString('zb') }] }]);
    expect(applyChecked(copyOf(live), frame)).toEqual({ client: ATTACKER, clock: 1 });

    // control (the frame applied): the tail's parent is the paragraph's text, but it is linked after 'q' in the code
    const control = copyOf(live);
    Y.transact(control, () => {
      Y.applyUpdate(control, frame);
      const tail = structAt(control, ATTACKER, 1) as Y.Item;
      expect(tail.parent).toBe(textIn(control, 0));
      expect(tail.left!.parent).toBe(textIn(control, 1));
    });
    // after cleanup Yjs has merged the tail into 'q' (mergeWith ignores parents): only a check inside the transaction sees it
    const [pt, ct] = [textIn(control, 0), textIn(control, 1)];
    expect((structAt(control, ATTACKER, 1) as Y.Item).id.clock).toBe(0);
    expect((structAt(control, ATTACKER, 1) as Y.Item).parent).toBe(ct);
    // live `_length` still counts the character in the wrong text; a reload re-derives it from the list
    expect([pt.length, linked(pt), ct.length, linked(ct)]).toEqual([4, 3, 4, 5]);
    const reload = copyOf(control);
    expect([textIn(reload, 0).length, textIn(reload, 1).length]).toEqual([3, 5]);
  });

  it('the same split on a keyed item: H1\'s textAlign tail re-sent under `level`; live and a reload disagree on the attributes', () => {
    const base = new Y.Doc();
    base.clientID = 1;
    const h = new Y.XmlElement('heading');
    base.transact(() => {
      base.getXmlFragment('default').insert(0, [h]);
      h.setAttribute('level', 1 as never);
    });
    const attacker = copyOf(base);
    attacker.clientID = ATTACKER;
    (attacker.getXmlFragment('default').get(0) as Y.XmlElement).setAttribute('textAlign', 'left');
    const live = copyOf(base);
    expect(applyChecked(live, Y.encodeStateAsUpdate(attacker, Y.encodeStateVector(base)))).toBeNull();

    const frame = rawUpdate([{ client: ATTACKER, clock: 0, structs: [{ origin: null, right: null, parent: idOf(h), sub: 'level', content: new Y.ContentAny(['x', 3]) }] }]);
    const control = copyOf(live);
    expect(applyChecked(control, frame)).toEqual({ client: ATTACKER, clock: 1 }); // same parent: the parentSub half
    const el = (d: Y.Doc) => (d.getXmlFragment('default').get(0) as Y.XmlElement).getAttributes();
    expect(el(control)).toEqual({ level: 3 }); // textAlign deleted, level rewritten
    expect(el(copyOf(control))).toEqual({ level: 1, textAlign: 3 }); // a reload reads the tail as textAlign
  });

  it('a right neighbour of another parent: an item placed before a foreign item a stored document already holds', () => {
    // a stored corruption that Yjs's cleanup does not merge away (its rightOrigin differs from (777, 0)'s): the tail
    // (777, 1), parent the paragraph's text, linked after 'q' at the end of the code block. Only this replica holds it
    // (a copy re-derives the parent), so each arm applies it.
    const { live, n, e } = twoTexts();
    const corrupt = rawUpdate([{ client: ATTACKER, clock: 0, structs: [{ origin: n, right: e, content: new Y.ContentString('zb') }] }]);
    const corrupted = () => {
      const doc = copyOf(live);
      expect(applyChecked(doc, corrupt)).toEqual({ client: ATTACKER, clock: 1 });
      expect((structAt(doc, ATTACKER, 1) as Y.Item).parent).toBe(textIn(doc, 0)); // still split after cleanup
      return doc;
    };
    // a frame naming the code block (origin 'q') and placed before that tail: left is fine, right is foreign
    const frame = rawUpdate([{ client: 888, clock: 0, structs: [{ origin: [ATTACKER, 0], right: [ATTACKER, 1], content: new Y.ContentString('r') }] }]);
    const probe = corrupted();
    Y.transact(probe, (tr) => {
      expect(parentConsistencyViolation(tr)).toBeNull(); // nothing new yet: the walk starts at beforeState
      Y.applyUpdate(probe, frame);
      const item = structAt(probe, 888, 0) as Y.Item;
      expect([item.left!.parent === item.parent, item.right!.parent === item.parent]).toEqual([true, false]);
    });
    expect(applyChecked(corrupted(), frame)).toEqual({ client: 888, clock: 0 });
  });

  it('an author\'s own grouped undo (keyed redo under a redone parent) keeps its replica, the server and a reload consistent', () => {
    // yjs 13.6.30's redoItem keyed branch started `left` at the old item, in the deleted parent: the redone value was
    // linked into the old paragraph's key on the author's replica only, and every other replica derived the parent from
    // that origin (the old, deleted paragraph). Patch B's keyed hunk (yjs #757) starts it in the recreated paragraph.
    const author = new Y.Doc();
    author.clientID = 5;
    const f = author.getXmlFragment('default');
    const undo = new Y.UndoManager(f, { captureTimeout: 1e9 }); // grouped until stopCapturing, never by the wall clock
    const local: Hit[] = [];
    author.on('afterTransaction', (tr: Y.Transaction) => tr.local && local.push(parentConsistencyViolation(tr)));
    const p = new Y.XmlElement('paragraph');
    f.insert(0, [p]);
    p.setAttribute('indent', 'left');
    undo.stopCapturing();
    p.setAttribute('indent', 'right'); // one undo step: change the attribute, delete the block
    f.delete(0, 1);
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(author));
    local.length = 0;
    undo.undo();
    expect(local).toEqual([null]);
    expect(f.toString()).toBe('<paragraph indent="left"></paragraph>');
    expect(applyChecked(server, Y.encodeStateAsUpdate(author, Y.encodeStateVector(server)))).toBeNull(); // the frame
    expect(server.getXmlFragment('default').toString()).toBe('<paragraph indent="left"></paragraph>');
    expect(copyOf(author).getXmlFragment('default').toString()).toBe('<paragraph indent="left"></paragraph>'); // a reload
    // a co-editor's honest attribute frame lands consistently on both replicas
    const coEditor = copyOf(server);
    coEditor.clientID = 2;
    (coEditor.getXmlFragment('default').get(0) as Y.XmlElement).setAttribute('indent', 'center');
    const honest = Y.encodeStateAsUpdate(coEditor, Y.encodeStateVector(server));
    expect(applyChecked(server, honest)).toBeNull();
    expect(applyChecked(author, honest)).toBeNull();
    expect([server, author].map((d) => d.getXmlFragment('default').toString())).toEqual(['<paragraph indent="center"></paragraph>', '<paragraph indent="center"></paragraph>']);
  });

  it('map and attribute items: overwrites, deletes and undo/redo across keys of one parent never trip', () => {
    // every transaction, local ones too: no parent here is ever deleted, so no keyed redo re-parents (the scope spec)
    const r = rng(840_003);
    const docs = Array.from({ length: 4 }, (_, i) => {
      const d = new Y.Doc();
      d.clientID = 10 + i;
      return d;
    });
    const el = new Y.XmlElement('paragraph');
    docs[0].getXmlFragment('default').insert(0, [el]);
    for (const d of docs.slice(1)) Y.applyUpdate(d, Y.encodeStateAsUpdate(docs[0]));
    const undos = docs.map((d, i) => new Y.UndoManager([d.getMap('m'), d.getXmlFragment('default')], { captureTimeout: i % 2 ? 0 : 1e9 }));
    const keys = ['a', 'b', 'c', 'textAlign', 'indent', 'level'];
    const hits: Hit[] = [];
    let checked = 0;
    let keyedWithLeft = 0;
    for (const d of docs) {
      d.on('afterTransaction', (tr: Y.Transaction) => {
        checked++;
        keyedWithLeft += tally(tr).keyedWithLeft;
        const hit = parentConsistencyViolation(tr);
        if (hit) hits.push(hit);
      });
    }
    const outbox: Uint8Array[][] = docs.map(() => []);
    docs.forEach((d, i) => d.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && outbox[i].push(u)));
    for (let op = 0; op < 4000; op++) {
      const i = Math.floor(r() * docs.length);
      const d = docs[i];
      const x = r();
      const key = keys[Math.floor(r() * keys.length)];
      const target = d.getXmlFragment('default').get(0) as Y.XmlElement;
      if (x < 0.35) d.getMap('m').set(key, r() < 0.5 ? Math.floor(r() * 9) : { v: key });
      else if (x < 0.45) d.getMap('m').delete(key);
      else if (x < 0.75 && target) target.setAttribute(key, ['left', 'center', 1, 2][Math.floor(r() * 4)] as never);
      else if (x < 0.8 && target) target.removeAttribute(key);
      else if (x < 0.88) undos[i].undo();
      else if (x < 0.96) undos[i].redo();
      else undos[i].stopCapturing();
      if (r() < 0.4) {
        const j = Math.floor(r() * docs.length);
        for (const u of outbox[i].splice(0)) for (const other of docs) if (other !== d) Y.applyUpdate(other, u, 'remote');
        if (j !== i) Y.applyUpdate(docs[j], Y.encodeStateAsUpdate(d, Y.encodeStateVector(docs[j])), 'remote');
      }
    }
    for (const d of docs) for (const o of docs) if (o !== d) Y.applyUpdate(o, Y.encodeStateAsUpdate(d, Y.encodeStateVector(o)), 'remote');
    console.log(`#840 keyed corpus: ${checked} transactions, ${keyedWithLeft} keyed items with a left neighbour`);
    expect(hits).toEqual([]);
    for (const d of docs.slice(1)) expect(d.getMap('m').toJSON()).toEqual(docs[0].getMap('m').toJSON());
    expect(keyedWithLeft).toBeGreaterThan(1000); // anti-vacuity: overwrites really link items beside earlier values
  });
});

/** Seeded mulberry32. */
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

/** What a transaction integrated, for the anti-vacuity counts (the rule's own walk, counted instead of checked). */
function tally(tr: Y.Transaction) {
  const out = { items: 0, withLeft: 0, withRight: 0, keyedWithLeft: 0, deletedNeighbour: 0 };
  const store = tr.doc.store;
  for (const [client, structs] of store.clients) {
    const before = tr.beforeState.get(client) ?? 0;
    if (Y.getState(store, client) <= before) continue;
    for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
      const item = structs[i];
      if (!(item instanceof Y.Item)) continue;
      out.items++;
      if (item.left) out.withLeft++;
      if (item.right) out.withRight++;
      if (item.left && item.parentSub !== null) out.keyedWithLeft++;
      if (item.left?.deleted || item.right?.deleted) out.deletedNeighbour++;
    }
  }
  return out;
}

/**
 * The honest corpus: 3–5 peers on one page, each with a y-tiptap-shaped undo manager (captureTimeout 500 on a
 * simulated clock, grouped until `stopCapturing`, or 0), typing, formatting, attributes, nested lists, paragraph and
 * list deletes (parents others are editing in), undo and redo of all of it, y-tiptap (`updateYFragment`) rewrites,
 * offline runs sent as one Step2, and remounts under a new client id. The server applies every frame as the guard does,
 * and peers' remote integrations are checked too. lib0 binds `Date.now` at load, so jest's fake timers never reach the
 * UndoManager: the 500 arm runs with an endless captureTimeout and stops capturing once the simulated gap since its last
 * captured change reaches 500 ms (the UndoManager's own rule), so no wall-clock time decides a grouping.
 */
const schema = serverSchema();
const SEEDS = 30;
const OPS = 2500;
const WORDS = ['lorem ', 'ipsum ', 'x', 'é', 'dolor sit ', 'the quick brown fox '];

type Peer = { doc: Y.Doc; undo: Y.UndoManager; out: Uint8Array[]; inbox: Uint8Array[]; offline: number; grouped: boolean; last: number };

const elementsOf = (f: Y.XmlFragment): Y.XmlElement[] => {
  const out: Y.XmlElement[] = [];
  const walk = (t: Y.XmlFragment | Y.XmlElement) =>
    t.forEach((c) => {
      if (c instanceof Y.XmlElement) {
        out.push(c);
        walk(c);
      }
    });
  walk(f);
  return out;
};
const textsOf = (els: Y.XmlElement[]): Y.XmlText[] => els.flatMap((e) => e.toArray().filter((c): c is Y.XmlText => c instanceof Y.XmlText));
const paragraph = (r: () => number, words = 3): Y.XmlElement => {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  p.insert(0, [t]);
  let at = 0; // a prelim text's length is not readable
  for (let w = 0; w < words; w++) {
    const s = WORDS[Math.floor(r() * WORDS.length)];
    t.insert(at, s, r() < 0.2 ? { bold: {} } : undefined);
    at += s.length;
  }
  return p;
};
const bulletList = (r: () => number, depth: number): Y.XmlElement => {
  const list = new Y.XmlElement('bulletList');
  list.insert(0, Array.from({ length: 1 + Math.floor(r() * 3) }, () => listItem(r, depth)));
  return list;
};
const listItem = (r: () => number, depth: number): Y.XmlElement => {
  const li = new Y.XmlElement('listItem');
  li.insert(0, depth > 1 && r() < 0.5 ? [paragraph(r, 2), bulletList(r, depth - 1)] : [paragraph(r, 2)]);
  return li;
};

let watchingKeyed = false;
const seen = { keyed: 0, frames: 0, step2: 0, peerIntegrations: 0, undo: 0, redo: 0, ytiptap: 0, parentDeletes: 0, nested: 0, remounts: 0, items: 0, withLeft: 0, withRight: 0, deletedNeighbour: 0, grouped: 0, pauses: 0 };

function edit(r: () => number, peer: Peer): void {
  const d = peer.doc;
  const f = d.getXmlFragment('default');
  const x = r();
  if (x < 0.015) {
    const { doc: pm, meta } = initProseMirrorDoc(f, schema);
    const json = pm.toJSON() as { content?: unknown[] };
    const content = json.content ?? [];
    const at = Math.floor(r() * (content.length + 1));
    if (r() < 0.5) content.splice(at, 0, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] });
    else if (content.length) content.splice(Math.min(at, content.length - 1), 1, { type: 'paragraph', content: [{ type: 'text', text: 'rewritten', marks: [{ type: 'bold' }] }] });
    json.content = content.length ? content : [{ type: 'paragraph' }];
    d.transact(() => updateYFragment(d, f, PMNode.fromJSON(schema, json), meta as never));
    seen.ytiptap++;
    return;
  }
  if (x < 0.09) {
    if (peer.undo.undoStack.length && peer.undo.undo()) seen.undo++;
    if (r() < 0.4 && peer.undo.redo()) seen.redo++; // undo, then redo at once
    return;
  }
  if (x < 0.15) {
    if (peer.undo.redoStack.length && peer.undo.redo()) seen.redo++;
    return;
  }
  if (x < 0.17) return peer.undo.stopCapturing();
  const els = elementsOf(f);
  const ts = textsOf(els);
  d.transact(() => {
    if (x < 0.45 && ts.length) {
      const t = ts[Math.floor(r() * ts.length)];
      t.insert(Math.floor(r() * (t.length + 1)), WORDS[Math.floor(r() * WORDS.length)], r() < 0.2 ? { italic: {} } : undefined);
    } else if (x < 0.55 && ts.length) {
      const t = ts[Math.floor(r() * ts.length)];
      if (t.length) {
        const at = Math.floor(r() * t.length);
        t.delete(at, Math.min(t.length - at, 1 + Math.floor(r() * 8)));
      }
    } else if (x < 0.61 && ts.length) {
      const t = ts[Math.floor(r() * ts.length)];
      if (t.length) {
        const at = Math.floor(r() * t.length);
        t.format(at, Math.min(t.length - at, 1 + Math.floor(r() * 10)), { bold: r() < 0.7 ? {} : null });
      }
    } else if (x < 0.67 && els.length) {
      const el = els[Math.floor(r() * els.length)];
      if (r() < 0.8) el.setAttribute(r() < 0.5 ? 'textAlign' : 'indent', ['left', 'center', 'right'][Math.floor(r() * 3)]);
      else el.removeAttribute('textAlign');
    } else if (x < 0.74) {
      f.insert(Math.floor(r() * (f.length + 1)), Array.from({ length: 1 + Math.floor(r() * 4) }, () => paragraph(r)));
    } else if (x < 0.8) {
      seen.nested++;
      const lists = els.filter((e) => e.nodeName === 'bulletList');
      if (lists.length && r() < 0.6) {
        const list = lists[Math.floor(r() * lists.length)];
        list.insert(Math.floor(r() * (list.length + 1)), [listItem(r, 2)]);
      } else {
        f.insert(Math.floor(r() * (f.length + 1)), [bulletList(r, 3)]);
      }
    } else if (x < 0.88 && f.length > 3) {
      seen.parentDeletes++;
      const at = Math.floor(r() * f.length);
      f.delete(at, Math.min(f.length - at, 1 + Math.floor(r() * 3)));
    } else if (x < 0.94) {
      const containers = els.filter((e) => e.nodeName === 'bulletList' || e.nodeName === 'listItem');
      if (containers.length) {
        seen.parentDeletes++;
        const c = containers[Math.floor(r() * containers.length)];
        if (c.length) c.delete(Math.floor(r() * c.length), 1);
      }
    } else if (els.length) {
      // a block moved as y-tiptap moves one: deleted and re-created elsewhere
      const at = Math.floor(r() * f.length);
      const el = f.get(at);
      if (el instanceof Y.XmlElement) {
        const copy = el.clone();
        f.delete(at, 1);
        f.insert(Math.floor(r() * (f.length + 1)), [copy]);
      }
    }
  });
}

function runSeed(seed: number): Hit[] {
  const r = rng(seed);
  let now = 1_700_000_000_000;
  const hits: Hit[] = [];
  const live = new Y.Doc();
  live.clientID = 1;
  live.getXmlFragment('default').insert(0, Array.from({ length: 20 }, () => paragraph(r)));
  const peers: Peer[] = [];
  /** Every transaction on a peer is checked too, its own undo and redo included (patch B's keyed hunk, yjs #757). */
  const watch = (peer: Peer) =>
    peer.doc.on('afterTransaction', (tr: Y.Transaction) => {
      const hit = parentConsistencyViolation(tr) ?? keyedSplitIn(tr);
      if (hit) hits.push(hit);
      if (tr.local) return;
      seen.peerIntegrations++;
      const t = tally(tr);
      seen.items += t.items;
      seen.withLeft += t.withLeft;
      seen.withRight += t.withRight;
      seen.deletedNeighbour += t.deletedNeighbour;
    });
  /** A frame to the server, applied as the guard applies it, then broadcast (delivered late). */
  const send = (from: Peer, update: Uint8Array, step2 = false) => {
    seen.frames++;
    if (step2) seen.step2++;
    const hit = applyChecked(live, update, from);
    if (hit) hits.push(hit);
  };
  live.on('update', (u: Uint8Array, origin: unknown) => {
    for (const p of peers) if (p !== origin) p.inbox.push(u);
  });
  const sync = (peer: Peer) => {
    const missing = Y.encodeStateAsUpdate(peer.doc, Y.encodeStateVector(live));
    if (Y.parseUpdateMeta(missing).to.size || Y.decodeUpdate(missing).ds.clients.size) send(peer, missing, true);
    peer.out.length = 0;
    peer.inbox.length = 0;
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(live, Y.encodeStateVector(peer.doc)), 'remote');
  };
  const mount = (from: Y.Doc): Peer => {
    const doc = new Y.Doc();
    doc.clientID = 2 + Math.floor(r() * 2 ** 30); // seeded: client order decides conflicts
    const kind = r(); // captureTimeout 500 on the simulated clock, grouped until stopCapturing only, or 0
    const grouped = kind < 0.3;
    const undo = new Y.UndoManager(doc.getXmlFragment('default'), { captureTimeout: kind < 0.5 ? Infinity : 0 });
    const peer: Peer = { doc, undo, out: [], inbox: [], offline: 0, grouped, last: 0 };
    undo.on('stack-item-added', () => !undo.undoing && !undo.redoing && (peer.last = now));
    undo.on('stack-item-updated', () => {
      if (grouped) seen.grouped++; // merged into the open group by the 500 arm
      peer.last = now;
    });
    watch(peer);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(from), 'remote'); // a load re-derives every parent: never split
    doc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && peer.out.push(u));
    sync(peer);
    return peer;
  };
  const n = 3 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) peers.push(mount(live));
  for (let op = 0; op < OPS; op++) {
    now += Math.floor(r() * 900);
    const i = Math.floor(r() * peers.length);
    const peer = peers[i];
    if (peer.grouped && now - peer.last >= 500) {
      seen.pauses++;
      peer.undo.stopCapturing(); // captureTimeout 500 on the simulated clock
    }
    edit(r, peer);
    if (!peer.offline && r() < 0.01) peer.offline = 20 + Math.floor(r() * 150);
    if (peer.offline) {
      if (--peer.offline === 0) {
        if (r() < 0.7) sync(peer); // reconnect: everything unsent in one Step2
        else {
          seen.remounts++;
          peers[i] = mount(peer.doc); // a reload over the local copy: a new client id, the old edits in its Step2
        }
      }
    } else if (peer.out.length && r() < 0.6) {
      if (r() < 0.8) for (const u of peer.out.splice(0)) send(peer, u);
      else send(peer, Y.mergeUpdates(peer.out.splice(0)));
    }
    for (const p of peers) {
      if (p.offline || !p.inbox.length || r() < 0.4) continue;
      for (const u of p.inbox.splice(0)) Y.applyUpdate(p.doc, u, 'remote');
    }
  }
  for (const p of peers) {
    p.offline = 0;
    sync(p);
  }
  for (const p of peers) Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(live, Y.encodeStateVector(p.doc)), 'remote');
  const expected = live.getXmlFragment('default').toString();
  for (const p of peers) expect(p.doc.getXmlFragment('default').toString()).toBe(expected);
  return hits;
}

describe('#840 parent consistency: honest editing never trips it', () => {
  it(`${SEEDS} seeded sessions: grouped undo/redo, parent deletes, nested lists, Step2 merges: 0 hits (and 0 keyed-split, #847)`, () => {
    watchingKeyed = true;
    for (let seed = 1; seed <= SEEDS; seed++) expect({ seed, hits: runSeed(840_000 + seed) }).toEqual({ seed, hits: [] });
    console.log(`#840 honest corpus: ${JSON.stringify(seen)}`);
    expect(seen.frames).toBeGreaterThan(SEEDS * 1000);
    expect(seen.withRight).toBeGreaterThan(seen.frames); // anti-vacuity: items really land between neighbours
    for (const [k, v] of Object.entries(seen)) expect([k, v > 0]).toEqual([k, true]); // informational
  });
});


