import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { serverSchema } from '../page-write/prelim-content';
import { contentOf, DOC_NAME, MSG, RemoteClient, renderLikeABrowser, SYNC, syncFrame } from './collab-ingress.testkit';
import { rawUpdate, type RawId } from './conflict-scan.testkit';
import { SocketLimitLog } from './socket-limit-log';
import { COLLAB_REFUSAL_CODE, COLLAB_TRY_LATER_CODE, CollabUpdateGuard } from './update-guard';

/**
 * #781 lineage (ADR 0036): an item is linked into the list it names. Yjs links the tail of a partly known struct (its
 * head at clocks the document already holds: Item.integrate with offset > 0) after the SAME client's previous clock,
 * but keeps the parent getMissing resolved: from the wire parent, or from the struct's ORIGINAL origin. A crafted frame
 * therefore names one list and lands in another, which the guard's per-struct checks (they read `item.parent`) never
 * looked at. The rule `cross-list` reads Yjs's own result: an integrated item's `left` must share its parent and key.
 *
 * Every attack has a CONTROL arm (the same bytes with no guard: the damage) and a TREATMENT arm (the refusal, live and
 * the peer unchanged). The honest arms send what Yjs really sends at offset > 0 (partial sends, then a y-indexeddb
 * full-state echo or a merged resend), and a seeded corpus of concurrent editors does it at scale.
 */
const schema = serverSchema();
const REFUSED = (rule: string) => `ccc:collab-update-refused:${rule}`;
type Conn = { readOnly: boolean; webSocket: { close: () => void }; context: { user: { id: string } } };

function setup(seed: unknown) {
  const live = new Y.Doc() as Y.Doc & { name: string };
  live.name = DOC_NAME;
  Y.applyUpdate(live, Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema, seed, 'default')));
  const logs: string[] = [];
  const guard = new CollabUpdateGuard({
    mode: 'enforce',
    logger: { warn: (m: string) => logs.push(m) },
    limitLog: new SocketLimitLog({ warn: (m: string) => logs.push(m) }),
  });
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
  live.on('update', (u: Uint8Array) => Y.applyUpdate(peer, u));
  const conn = (id: string): Conn => ({ readOnly: false, webSocket: { close: () => undefined }, context: { user: { id } } });
  /** One Update frame through the guard; when it passes, applied the way Hocuspocus applies it. */
  const send = (c: Conn, update: Uint8Array, subtype: number = SYNC.Update): string => {
    try {
      guard.check({ connection: c, document: live, update: syncFrame(update, subtype, MSG.Sync), context: c.context });
    } catch (err: any) {
      expect(err).toEqual({ code: COLLAB_REFUSAL_CODE, reason: expect.any(String) });
      return err.reason;
    }
    Y.applyUpdate(live, update, c);
    return 'applied';
  };
  return { live, guard, peer, logs, conn, send };
}

/** The same update with no guard, on a copy: the control arm. */
function unguarded(base: Y.Doc, update: Uint8Array): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(base));
  Y.applyUpdate(copy, update);
  return copy;
}
/** The doc as a fresh load (a reload, or another node) sees it. */
function reloaded(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}
function find(doc: Y.Doc, name: string, nth = 0): Y.XmlElement {
  const stack: Y.XmlElement[] = (doc.getXmlFragment('default').toArray() as Y.XmlElement[]).reverse();
  let seen = 0;
  while (stack.length) {
    const el = stack.pop()!;
    if (!(el instanceof Y.XmlElement)) continue;
    if (el.nodeName === name && seen++ === nth) return el;
    stack.push(...(el.toArray() as Y.XmlElement[]).reverse());
  }
  throw new Error(`no ${name}`);
}
const textOf = (el: Y.XmlElement): Y.XmlText => el.toArray().find((c) => c instanceof Y.XmlText) as Y.XmlText;
const idOf = (type: Y.AbstractType<any>): RawId => [type._item!.id.client, type._item!.id.clock];
/** The last clock of a list's last item: an origin that places a struct at the list's end. */
function lastOf(type: Y.AbstractType<any>): RawId {
  let item = type._start;
  while (item!.right !== null) item = item!.right;
  return [item!.id.client, item!.id.clock + item!.length - 1];
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
/** Some struct in `update` has its head at clocks `live` holds and its tail at clocks it lacks (Yjs: offset > 0). */
const straddles = (live: Y.Doc, update: Uint8Array): number =>
  Y.decodeUpdate(update).structs.filter((st) => {
    if (st instanceof Y.Skip) return false;
    const state = Y.getState(live.store, st.id.client);
    return st.id.clock < state && state < st.id.clock + st.length;
  }).length;
/** The struct of `doc` holding (client, clock). */
const structAt = (doc: Y.Doc, client: number, clock: number) =>
  doc.store.clients.get(client)!.find((st) => st.id.clock <= clock && clock < st.id.clock + st.length)!;

function expectRefused(s: ReturnType<typeof setup>, c: Conn, update: Uint8Array, reason: string) {
  const before = { live: Y.encodeStateAsUpdate(s.live), peer: Y.encodeStateAsUpdate(s.peer) };
  expect(s.send(c, update)).toBe(reason);
  expect(sameBytes(Y.encodeStateAsUpdate(s.live), before.live)).toBe(true);
  expect(sameBytes(Y.encodeStateAsUpdate(s.peer), before.peer)).toBe(true);
  expect(renderLikeABrowser(s.peer)).toMatchObject({ deleted: false, threw: false });
}

/** Control for a splice into the root list: a non-element in `default`, on live and after a reload; every render throws. */
function expectRootWedge(control: Y.Doc) {
  for (const doc of [control, reloaded(control)]) {
    expect(doc.getXmlFragment('default').toArray().some((c) => !(c instanceof Y.XmlElement))).toBe(true);
    expect(renderLikeABrowser(doc).threw).toBe(true);
    expect(() => TiptapTransformer.fromYdoc(doc, 'default')).toThrow();
  }
}

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const SEED = { type: 'doc', content: [para('victim text')] };
const ATTACKER = 777;

/** The attacker's honest first frame: an empty paragraph at the end of the root list, struct (777, 0). */
function withRootParagraph() {
  const s = setup(SEED);
  const attacker = new RemoteClient(s.live, ATTACKER);
  expect(s.send(s.conn('attacker'), attacker.edit(s.live, (f) => f.insert(1, [new Y.XmlElement('paragraph')])))).toBe('applied');
  expect(Y.getState(s.live.store, ATTACKER)).toBe(1); // precondition: a length-2 struct at clock 0 straddles
  return s;
}

describe('#781 lineage: an item is linked into the list it names (cross-list)', () => {
  it('A1 a tail whose wire parent is a paragraph\'s text is linked into the ROOT list: control wedges every browser and the store', () => {
    const s = withRootParagraph();
    const pt = textOf(find(s.live, 'paragraph'));
    const frame = rawUpdate([{ client: ATTACKER, clock: 0, structs: [{ origin: null, right: null, parent: idOf(pt), content: new Y.ContentString('zb') }] }]);
    expect(straddles(s.live, frame)).toBe(1);
    expectRootWedge(unguarded(s.live, frame));
    expectRefused(s, s.conn('attacker'), frame, REFUSED('cross-list'));
  });

  it('A1o the same tail with NO wire parent, only an origin in the text (getMissing takes the parent from it): refused', () => {
    const s = withRootParagraph();
    const pt = textOf(find(s.live, 'paragraph'));
    const frame = rawUpdate([{ client: ATTACKER, clock: 0, structs: [{ origin: lastOf(pt), right: null, content: new Y.ContentString('zb') }] }]);
    expect(Y.decodeUpdate(frame).structs.every((st) => (st as Y.Item).parent === null)).toBe(true); // no parent on the wire
    expectRootWedge(unguarded(s.live, frame));
    expectRefused(s, s.conn('attacker'), frame, REFUSED('cross-list'));
  });

  it('A2 text named for one element lands in another element\'s text: control stores it there; treatment refuses', () => {
    const s = setup({ type: 'doc', content: [para('one'), { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'two' }] }] });
    const attacker = new RemoteClient(s.live, ATTACKER);
    expect(s.send(s.conn('attacker'), attacker.edit(s.live, () => textOf(find(attacker.doc, 'codeBlock')).insert(3, 'q')))).toBe('applied');
    const frame = rawUpdate([{ client: ATTACKER, clock: 0, structs: [{ origin: null, right: null, parent: idOf(textOf(find(s.live, 'paragraph'))), content: new Y.ContentString('zb') }] }]);
    const control = unguarded(s.live, frame);
    const ct = textOf(find(control, 'paragraph'));
    expect(ct.toString()).toBe('one');
    expect(ct.length).not.toBe(ct.toString().length); // the paragraph's length counts a character its list lacks
    expect(textOf(find(reloaded(control), 'codeBlock')).toString()).toBe('twoqb'); // kept there for good
    expectRefused(s, s.conn('attacker'), frame, REFUSED('cross-list'));
    expect(textOf(find(s.live, 'codeBlock')).toString()).toBe('twoq');
  });

  const HEADINGS = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H1' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H2' }] },
    ],
  };
  /** 777 sets H1's textAlign (an honest frame): struct (777, 0), H1's current textAlign value. */
  function withAlignedHeading() {
    const s = setup(HEADINGS);
    const attacker = new RemoteClient(s.live, ATTACKER);
    expect(s.send(s.conn('attacker'), attacker.edit(s.live, () => find(attacker.doc, 'heading', 0).setAttribute('textAlign', 'left')))).toBe('applied');
    expect(Y.getState(s.live.store, ATTACKER)).toBe(1);
    return s;
  }

  it('A3 a keyed tail naming ANOTHER element: control writes H2\'s textAlign and deletes H1\'s; treatment refuses', () => {
    const s = withAlignedHeading();
    const h2 = find(s.live, 'heading', 1);
    const frame = rawUpdate([
      { client: ATTACKER, clock: 0, structs: [{ origin: null, right: null, parent: idOf(h2), sub: 'textAlign', content: new Y.ContentAny(['left', 'center']) }] },
    ]);
    const control = unguarded(s.live, frame);
    const tail = structAt(control, ATTACKER, 1) as Y.Item;
    expect(tail.left!.parent).not.toBe(tail.parent);
    expect(find(control, 'heading', 1).getAttribute('textAlign')).toBe('center');
    expect(find(control, 'heading', 0).getAttribute('textAlign')).toBeUndefined(); // collateral: the left value deleted
    expectRefused(s, s.conn('attacker'), frame, REFUSED('cross-list'));
    expect(find(s.live, 'heading', 0).getAttribute('textAlign')).toBe('left');
  });

  it('A4 a keyed tail naming the SAME element under ANOTHER key: control rewrites level and deletes textAlign; refused', () => {
    const s = withAlignedHeading();
    const h1 = find(s.live, 'heading', 0);
    const frame = rawUpdate([
      { client: ATTACKER, clock: 0, structs: [{ origin: null, right: null, parent: idOf(h1), sub: 'level', content: new Y.ContentAny(['x', 3]) }] },
    ]);
    const control = unguarded(s.live, frame);
    const tail = structAt(control, ATTACKER, 1) as Y.Item;
    expect(tail.left!.parent).toBe(tail.parent); // same element: only the key differs (the parentSub half of the rule)
    expect(tail.left!.parentSub).toBe('textAlign');
    expect(find(control, 'heading', 0).getAttribute('level')).toBe(3);
    expect(find(control, 'heading', 0).getAttribute('textAlign')).toBeUndefined();
    expectRefused(s, s.conn('attacker'), frame, REFUSED('cross-list'));
    expect(find(s.live, 'heading', 0).getAttribute('level')).toBe(1);
  });

  it('a tail deleted on arrival (ContentDeleted) is still linked into the foreign list: refused before the deleted return', () => {
    const s = withRootParagraph();
    const pt = textOf(find(s.live, 'paragraph'));
    const frame = rawUpdate([{ client: ATTACKER, clock: 0, structs: [{ origin: null, right: null, parent: idOf(pt), content: new Y.ContentDeleted(2) }] }]);
    const control = unguarded(s.live, frame);
    // control: the root list now holds an item whose parent is the paragraph's text. Read untyped: getXmlFragment on a
    // doc whose root is not typed yet re-parents every item of its list (Doc.get), the splice included.
    const root = control.share.get('default')!;
    const foreign: Y.Item[] = [];
    for (let item = root._start; item !== null; item = item.right) if (item.parent !== root) foreign.push(item);
    expect(foreign.map((i) => [i.id.client, i.id.clock, i.deleted])).toEqual([[ATTACKER, 1, true]]);
    expectRefused(s, s.conn('attacker'), frame, REFUSED('cross-list'));
  });
});

describe('#781 lineage cross-list false positives: what Yjs really sends at offset > 0 is accepted', () => {
  /** An editor's run of one-character transactions at the end of the first paragraph: Yjs merges them into one struct. */
  function typed(s: ReturnType<typeof setup>, n: number) {
    const editor = new RemoteClient(s.live);
    const frames: Uint8Array[] = [];
    editor.doc.on('update', (u: Uint8Array) => frames.push(u));
    const t = () => textOf(editor.fragment.get(0) as Y.XmlElement);
    for (let i = 0; i < n; i++) editor.doc.transact(() => t().insert(t().length, String(i % 10)));
    expect(editor.doc.store.clients.get(editor.doc.clientID)!.length).toBe(1); // merged into one struct
    return { editor, frames };
  }

  it('B1 a page\'s local copy echoed after a partial send (y-indexeddb), and a merged resend, are applied', () => {
    for (const variant of ['echo', 'merged'] as const) {
      const s = setup(SEED);
      const { editor, frames } = typed(s, 10);
      const c = s.conn('editor');
      for (const u of frames.slice(0, 5)) expect(s.send(c, u)).toBe('applied');
      const resend = variant === 'echo' ? Y.encodeStateAsUpdate(editor.doc) : Y.mergeUpdates(frames);
      // anti-vacuity: the echo carries the merged run, which Yjs integrates at offset > 0 (mergeUpdates keeps the
      // frames' structs apart, so the merged resend is held structs plus new ones)
      expect(straddles(s.live, resend)).toBe(variant === 'echo' ? 1 : 0);
      expect(s.send(c, resend)).toBe('applied');
      expect(renderLikeABrowser(s.live).text).toBe('victim text0123456789');
    }
  });

  it('B2 a keyed run (set, set, remove: one ContentDeleted struct) echoed after its first frame is applied', () => {
    const s = setup(SEED);
    const editor = new RemoteClient(s.live);
    const frames: Uint8Array[] = [];
    editor.doc.on('update', (u: Uint8Array) => frames.push(u));
    const p = () => editor.fragment.get(0) as Y.XmlElement;
    editor.doc.transact(() => p().setAttribute('textAlign', 'center'));
    editor.doc.transact(() => p().setAttribute('textAlign', 'right'));
    editor.doc.transact(() => p().removeAttribute('textAlign'));
    const c = s.conn('editor');
    expect(s.send(c, frames[0])).toBe('applied');
    const echo = Y.encodeStateAsUpdate(editor.doc);
    expect(straddles(s.live, echo)).toBeGreaterThan(0);
    expect(s.send(c, echo)).toBe('applied');
    expect(find(s.live, 'paragraph').getAttribute('textAlign')).toBeUndefined();
  });

  it('B3 a partial run whose forced left was garbage-collected (its paragraph deleted meanwhile) integrates as GC: applied', () => {
    const s = setup({ type: 'doc', content: [para('victim text'), para('other')] });
    const { editor, frames } = typed(s, 10);
    const c = s.conn('editor');
    for (const u of frames.slice(0, 5)) expect(s.send(c, u)).toBe('applied');
    const remover = new RemoteClient(s.live);
    expect(s.send(s.conn('remover'), remover.edit(s.live, (f) => f.delete(0, 1)))).toBe('applied');
    const id = editor.doc.clientID;
    expect(structAt(s.live, id, 4)).toBeInstanceOf(Y.GC); // the forced left is a GC now
    const echo = Y.encodeStateAsUpdate(editor.doc);
    expect(straddles(s.live, echo)).toBeGreaterThan(0);
    expect(s.send(c, echo)).toBe('applied');
    for (let clock = 5; clock < 10; clock++) expect(structAt(s.live, id, clock)).toBeInstanceOf(Y.GC); // the tail too
    expect(renderLikeABrowser(s.live).text).toBe('other');
  });
});

describe('#781 lineage cross-list: the Yjs internals the rule reads (re-check on a Yjs bump)', () => {
  it('a tail integrated at offset > 0 is linked after (client, clock - 1) but keeps the parent from the wire', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, rawUpdate([{ client: 5, clock: 0, structs: [{ origin: null, right: null, parent: 'a', content: new Y.ContentAny([1]) }] }]));
    Y.transact(doc, () => {
      Y.applyUpdate(doc, rawUpdate([{ client: 5, clock: 0, structs: [{ origin: null, right: null, parent: 'b', content: new Y.ContentAny([1, 2]) }] }]));
      const tail = structAt(doc, 5, 1) as Y.Item;
      expect(tail.id.clock).toBe(1);
      expect(tail.parent).toBe(doc.share.get('b'));
      expect([tail.left!.id.client, tail.left!.id.clock]).toEqual([5, 0]);
      expect(tail.left!.parent).toBe(doc.share.get('a'));
    }, 'probe', false);
    // linked into 'a' for good (cleanup merges it into its left, parents aside); 'b' counts an item its list lacks
    expect(doc.getArray('a').toArray()).toEqual([1, 2]);
    expect(doc.getArray('b').toArray()).toEqual([]);
    expect(doc.getArray('b').length).toBe(1);
  });
});

/**
 * Honest concurrency at offset > 0, at scale. 2–4 editors type in runs (one transaction per character, continuing at
 * their last insert, so runs merge into one struct), edit marks and attributes, delete and insert paragraphs, undo and
 * redo, and receive broadcasts late. Their providers send a PREFIX of their pending updates; later the rest arrives as a
 * y-indexeddb full-state echo, a merged resend of everything they ever wrote, or the remaining frames. Every frame goes
 * through a real guard in enforce mode: no refusal, every peer converges, and straddling structs really were sent.
 */
describe('#781 lineage cross-list: honest concurrent editing at offset > 0 is never refused', () => {
  const SEEDS = 12;
  const OPS = 400;
  const WORDS = 'abcdefghijklmnopqrstuvwxyz';
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
  type Peer = { user: string; doc: Y.Doc; conn: Conn; out: Uint8Array[]; all: Uint8Array[]; inbox: Uint8Array[]; undo: Y.UndoManager; cursor: { t: Y.XmlText; at: number } | null };
  const seen = { frames: 0, straddling: 0, echoes: 0, merged: 0, remounts: 0, undo: 0 };

  function run(seed: number) {
    const r = rng(seed);
    let now = 1_000_000;
    const live = new Y.Doc() as Y.Doc & { name: string };
    live.name = DOC_NAME;
    const refused: string[] = [];
    const guard = new CollabUpdateGuard({
      mode: 'enforce',
      logger: { warn: (m: string) => m.startsWith('COLLAB_UPDATE_REFUSED') && refused.push(m) },
      limitLog: new SocketLimitLog({ warn: (m: string) => refused.push(m) }),
      now: () => now,
      cpuNow: () => 0, // the CPU budget is not under test here
    });
    const seedDoc = new Y.Doc();
    seedDoc.transact(() =>
      seedDoc.getXmlFragment('default').insert(
        0,
        Array.from({ length: 12 }, (_, i) => {
          const p = new Y.XmlElement('paragraph');
          p.insert(0, [new Y.XmlText(`paragraph ${i} `)]);
          return p;
        }),
      ),
    );
    Y.applyUpdate(live, Y.encodeStateAsUpdate(seedDoc));
    const peers: Peer[] = [];
    live.on('update', (u: Uint8Array, origin: unknown) => {
      for (const p of peers) if (p.conn !== origin) p.inbox.push(u);
    });
    const send = (peer: Peer, update: Uint8Array) => {
      seen.frames++;
      seen.straddling += straddles(live, update);
      try {
        guard.check({ connection: peer.conn, document: live, update: syncFrame(update, SYNC.Update), context: peer.conn.context });
      } catch (err: any) {
        refused.push(`${err?.code === COLLAB_TRY_LATER_CODE ? '1013' : err?.code} ${err?.reason}`);
        return false;
      }
      Y.applyUpdate(live, update, peer.conn);
      return true;
    };
    const mount = (user: string, localCopy?: Y.Doc): Peer => {
      const doc = new Y.Doc();
      const conn: Conn = { readOnly: false, webSocket: { close: () => undefined }, context: { user: { id: user } } };
      const peer: Peer = { user, doc, conn, out: [], all: [], inbox: [], undo: null as never, cursor: null };
      if (localCopy) {
        // y-indexeddb's load: one transaction with its own origin, which the provider then sends as an Update
        let echo: Uint8Array | null = null;
        doc.on('update', (u: Uint8Array, o: unknown) => o === 'idb' && (echo = u));
        Y.transact(doc, () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(localCopy)), 'idb', false);
        seen.remounts++;
        if (echo) send(peer, echo);
      }
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(live, Y.encodeStateVector(doc)), 'remote');
      peer.undo = new Y.UndoManager(doc.getXmlFragment('default'), { captureTimeout: 0 });
      doc.on('update', (u: Uint8Array, o: unknown) => {
        if (o === 'remote' || o === 'idb') return;
        peer.out.push(u);
        peer.all.push(u);
      });
      return peer;
    };
    const texts = (d: Y.Doc): Y.XmlText[] => {
      const out: Y.XmlText[] = [];
      d.getXmlFragment('default').forEach((el) => el instanceof Y.XmlElement && el.forEach((c) => c instanceof Y.XmlText && out.push(c)));
      return out;
    };
    const visible = (t: Y.XmlText) => {
      for (let x: Y.AbstractType<any> = t; x._item !== null; x = x._item.parent as Y.AbstractType<any>) if (x._item.deleted) return false;
      return true;
    };

    const edit = (peer: Peer) => {
      const d = peer.doc;
      const f = d.getXmlFragment('default');
      const x = r();
      if (x < 0.55) {
        // typing: continue the run at the cursor, one character per transaction
        if (!peer.cursor || !visible(peer.cursor.t) || peer.cursor.at > peer.cursor.t.length || r() < 0.1) {
          const ts = texts(d);
          if (!ts.length) return;
          const t = ts[Math.floor(r() * ts.length)];
          peer.cursor = { t, at: Math.floor(r() * (t.length + 1)) };
        }
        const run = 1 + Math.floor(r() * 6);
        for (let k = 0; k < run; k++) {
          const cur = peer.cursor!;
          d.transact(() => cur.t.insert(cur.at, WORDS[Math.floor(r() * WORDS.length)], r() < 0.1 ? { bold: {} } : undefined));
          cur.at++;
        }
        return;
      }
      if (x < 0.62) {
        const stack = r() < 0.5 ? peer.undo.undoStack : peer.undo.redoStack;
        if (!stack.length) return;
        if (stack === peer.undo.undoStack) peer.undo.undo();
        else peer.undo.redo();
        seen.undo++;
        return;
      }
      d.transact(() => {
        const ts = texts(d);
        if (x < 0.72 && ts.length) {
          const t = ts[Math.floor(r() * ts.length)];
          if (t.length) {
            const at = Math.floor(r() * t.length);
            t.delete(at, Math.min(t.length - at, 1 + Math.floor(r() * 4)));
          }
        } else if (x < 0.82 && f.length) {
          const el = f.get(Math.floor(r() * f.length));
          if (el instanceof Y.XmlElement) {
            if (r() < 0.3) el.removeAttribute('textAlign');
            else el.setAttribute('textAlign', ['left', 'center', 'right'][Math.floor(r() * 3)]);
          }
        } else if (x < 0.88 && f.length > 3) {
          f.delete(Math.floor(r() * f.length), 1);
        } else if (x < 0.94) {
          const p = new Y.XmlElement('paragraph');
          p.insert(0, [new Y.XmlText('new ')]);
          f.insert(Math.floor(r() * (f.length + 1)), [p]);
        } else if (ts.length) {
          const t = ts[Math.floor(r() * ts.length)];
          if (t.length) t.format(0, Math.min(t.length, 1 + Math.floor(r() * 5)), { italic: r() < 0.7 ? {} : null });
        }
      });
    };

    const n = 2 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) peers.push(mount(`user-${i}`));
    for (let op = 0; op < OPS; op++) {
      now += 300;
      const i = Math.floor(r() * peers.length);
      const peer = peers[i];
      edit(peer);
      const y = r();
      if (peer.out.length && y < 0.35) {
        const k = 1 + Math.floor(r() * peer.out.length); // a prefix: the rest stays pending
        for (const u of peer.out.splice(0, k)) send(peer, u);
      } else if (peer.out.length && y < 0.45) {
        send(peer, Y.encodeStateAsUpdate(peer.doc)); // the page's local copy, echoed whole
        peer.out.length = 0;
        seen.echoes++;
      } else if (peer.out.length && y < 0.5) {
        send(peer, Y.mergeUpdates(peer.all)); // everything this session wrote, merged and resent
        peer.out.length = 0;
        seen.merged++;
      } else if (y < 0.52) {
        peers[i] = mount(peer.user, peer.doc); // a reload: a fresh doc from the local copy, a new client id
        continue;
      }
      for (const p of peers) {
        if (!p.inbox.length || r() < 0.4) continue;
        for (const u of p.inbox.splice(0)) Y.applyUpdate(p.doc, u, 'remote'); // late broadcasts
      }
    }
    for (const p of peers) if (p.out.length) send(p, Y.encodeStateAsUpdate(p.doc));
    for (const p of peers) Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(live, Y.encodeStateVector(p.doc)), 'remote');
    return { live, peers, refused, send, mount };
  }

  it(`${SEEDS} seeded sessions: every frame accepted, every peer converges, and straddling structs were really sent`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const h = run(seed);
      expect({ seed, refused: h.refused }).toEqual({ seed, refused: [] });
      const expected = contentOf(h.live);
      for (const p of h.peers) expect(contentOf(p.doc)).toEqual(expected);
      expect(renderLikeABrowser(h.live)).toMatchObject({ deleted: false, threw: false });
    }
    if (process.env.CROSS_LIST_TALLY) console.log(JSON.stringify(seen));
    // anti-vacuity: the corpus sent what it claims, offset > 0 integrations above all
    expect(seen.straddling).toBeGreaterThan(50);
    for (const v of Object.values(seen)) expect(v).toBeGreaterThan(0);
  });

  it('anti-vacuity: in the same harness, one adversarial peer\'s splice into the root list is refused cross-list', () => {
    const h = run(SEEDS + 1);
    const attacker = h.mount('attacker');
    const fresh = 900_001;
    attacker.doc.clientID = fresh;
    attacker.doc.transact(() => attacker.doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]));
    expect(h.send(attacker, Y.mergeUpdates(attacker.out.splice(0)))).toBe(true);
    const t = textOf(h.live.getXmlFragment('default').toArray().find((el) => el instanceof Y.XmlElement && textOf(el)) as Y.XmlElement);
    const frame = rawUpdate([{ client: fresh, clock: 0, structs: [{ origin: null, right: null, parent: idOf(t), content: new Y.ContentString('zb') }] }]);
    expect(h.send(attacker, frame)).toBe(false);
    expect(h.refused.filter((l) => !l.startsWith('COLLAB_UPDATE_REFUSED'))).toEqual(['4422 ccc:collab-update-refused:cross-list']);
  });
});
