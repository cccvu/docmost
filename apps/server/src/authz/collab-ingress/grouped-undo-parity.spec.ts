import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as vm from 'node:vm';
import type * as Y from 'yjs';
import type * as OrderParity from './order-parity';

/**
 * #840 (ADR 0036): the honest grouped-undo corpus. 2–4 peers edit tiptap-shaped pages (paragraphs, headings, nested
 * bullet lists, marks) under Y.UndoManager, with y-tiptap's `captureTimeout` 500 on a simulated clock (typing groups
 * into one stack item, pauses split) and with 0. Frames reach the server replica (live) and the other peers late and
 * interleaved. Sessions also play the recreated-parent shape (yjs #823 with a co-editor). On the patched yjs, live
 * equals its reload strictly, every peer equals its own reload, and every peer converges with live. The same corpus on
 * the unpatched `redoItem` diverges. Both arms compile the installed dist (yjs-redo-patch.spec pins that every
 * consumer loads it); the unpatched arm is that file with patch B cut out, never written to disk.
 */

const SESSIONS = 1500;
const OPS = 120;
/** Live is compared with its reload every CHECK_EVERY steps; every replica at the end. */
const CHECK_EVERY = 40;
const MARKER = '[ccc #840]';
const WORDS = ['lorem ', 'ipsum ', 'x', 'é', 'dolor sit '];
const YJS_CJS = createRequire(join(__dirname, '../../../package.json')).resolve('yjs');

/** The installed dist without patch B: the marker comment through the end of its `if` block (as yjs-redo-patch.spec). */
function unpatched(src: string): string {
  const at = src.indexOf(`    // ${MARKER}`);
  const block = src.indexOf('    if (left !== null && right !== null) {\n', at);
  const end = src.indexOf('\n    }\n', block);
  if (at < 0 || block < at || end < block) throw new Error('patch B block not found in the installed yjs');
  return src.slice(0, at) + src.slice(end + '\n    }\n'.length);
}

/** A strict difference in split boundaries only: the same id with another length, or item runs cut differently. */
const isSplit = (d: OrderParity.OrderDiff) => d.kind === 'length' || (d.kind === 'store' && /^\[\d+\] a=\d+\+\d+item b=\d+\+\d+item$/.test(d.detail));

type Arm = { Y: typeof Y; op: typeof OrderParity; clock: { now: number } };

/**
 * A yjs compiled from `src` in a vm with `lib0/time` reading a simulated clock (lib0 binds `Date.now` at load, so a
 * fake timer cannot reach the UndoManager), and order-parity loaded against it so its `instanceof` checks match.
 */
function loadArm(src: string): Arm {
  const clock = { now: 1_000_000 };
  const fn = vm.compileFunction(src, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: `${YJS_CJS}.spec` });
  const req = createRequire(YJS_CJS);
  const withClock = (id: string) => (id === 'lib0/time' ? { ...req(id), getUnixTime: () => clock.now } : req(id));
  const outer = vm.runInThisContext('globalThis') as Record<string, unknown>;
  const flag = '__ $YJS$ __';
  const had = outer[flag];
  delete outer[flag]; // silence yjs's double-import warning
  const module = { exports: {} as typeof Y };
  fn(module.exports, withClock, module, YJS_CJS, dirname(YJS_CJS));
  outer[flag] = had;
  let op!: typeof OrderParity;
  jest.isolateModules(() => {
    jest.doMock('yjs', () => module.exports);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    op = require('./order-parity') as typeof OrderParity;
  });
  jest.dontMock('yjs');
  return { Y: module.exports, op, clock };
}

/** Deterministic PRNG (mulberry32). */
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

/** Per corpus: sessions, the replicas (live, peers) that failed each check, and what the corpus exercised. */
type Tally = {
  sessions: number;
  liveUnstable: number;
  peerUnstable: number;
  unconverged: number;
  peerSplits: number;
  diverged: number;
  checks: number;
  undo: number;
  redo: number;
  grouped: number;
  stackItems: number;
  shapes: number;
  foreignShapes: number;
  first: string | null;
};

/** One session on `arm`, counted into `t`; a diverging session records its first divergence. */
function session({ Y, op, clock }: Arm, seed: number, captureTimeout: number, t: Tally): void {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const live = new Y.Doc();
  live.clientID = 1 + Math.floor(r() * 999); // seeded: it writes the starting page
  type Peer = { doc: Y.Doc; undo: Y.UndoManager; out: Uint8Array[]; inbox: Uint8Array[] };
  const peers: Peer[] = [];
  live.on('update', (u: Uint8Array, origin: unknown) => {
    for (const p of peers) if (p !== origin) p.inbox.push(u);
  });

  const text = (s: string, marks?: object) => {
    const x = new Y.XmlText();
    x.insert(0, s, marks as never);
    return x;
  };
  const block = (name = r() < 0.15 ? 'heading' : 'paragraph') => {
    const p = new Y.XmlElement(name);
    if (name === 'heading') p.setAttribute('level', String(1 + Math.floor(r() * 3)));
    p.insert(0, [text(pick(WORDS), r() < 0.3 ? { bold: {} } : undefined)]);
    return p;
  };
  const listItem = (depth: number): Y.XmlElement => {
    const li = new Y.XmlElement('listItem');
    li.insert(0, depth < 2 && r() < 0.3 ? [block('paragraph'), list(depth + 1)] : [block('paragraph')]);
    return li;
  };
  const list = (depth = 0): Y.XmlElement => {
    const l = new Y.XmlElement('bulletList');
    l.insert(0, Array.from({ length: 1 + Math.floor(r() * 2) }, () => listItem(depth)));
    return l;
  };
  /** Containers (the fragment, lists, list items) and the blocks' texts on `doc`. */
  const walk = (doc: Y.Doc) => {
    const f = doc.getXmlFragment('default');
    const containers: Array<Y.XmlFragment | Y.XmlElement> = [f];
    const blocks: Y.XmlElement[] = [];
    const texts: Y.XmlText[] = [];
    const visit = (c: Y.XmlFragment | Y.XmlElement) => {
      for (const x of c.toArray()) {
        if (x instanceof Y.XmlText) texts.push(x);
        else if (x instanceof Y.XmlElement) {
          if (x.nodeName === 'bulletList' || x.nodeName === 'listItem') containers.push(x);
          else blocks.push(x);
          visit(x);
        }
      }
    };
    visit(f);
    return { f, containers, blocks, texts };
  };
  const ship = (p: Peer, n = p.out.length) => {
    for (const u of p.out.splice(0, n)) Y.applyUpdate(live, u, p);
  };
  const receive = (p: Peer, n = p.inbox.length) => {
    for (const u of p.inbox.splice(0, n)) Y.applyUpdate(p.doc, u, 'remote');
  };

  // a page to start from
  live.getXmlFragment('default').insert(0, [block(), list(), block(), list(1), block()]);
  for (let i = 2 + Math.floor(r() * 3); i > 0; i--) {
    const doc = new Y.Doc();
    doc.clientID = 1000 * i + Math.floor(r() * 1000); // seeded: conflict resolution compares client ids
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(live), 'remote');
    const peer: Peer = { doc, undo: new Y.UndoManager(doc.getXmlFragment('default'), { captureTimeout }), out: [], inbox: [] };
    peer.undo.on('stack-item-added', () => t.stackItems++);
    peer.undo.on('stack-item-updated', () => t.grouped++);
    doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') peer.out.push(u);
    });
    peers.push(peer);
  }

  const edit = (p: Peer) => {
    const { f, containers, blocks, texts } = walk(p.doc);
    const x = r();
    if (x < 0.28 && texts.length) {
      const s = pick(texts);
      s.insert(Math.floor(r() * (s.length + 1)), pick(WORDS), r() < 0.2 ? { bold: {} } : r() < 0.1 ? { italic: {}, link: { href: 'https://example.com/a' } } : undefined);
    } else if (x < 0.4 && texts.length) {
      const s = pick(texts);
      const at = Math.floor(r() * s.length);
      if (s.length) s.delete(at, Math.min(s.length - at, 1 + Math.floor(r() * 6)));
    } else if (x < 0.48 && texts.length) {
      const s = pick(texts);
      const at = Math.floor(r() * s.length);
      if (s.length) s.format(at, 1 + Math.floor(r() * 5), { [pick(['bold', 'italic'])]: r() < 0.6 ? {} : null });
    } else if (x < 0.6) {
      const c = pick(containers);
      const node = c instanceof Y.XmlElement && c.nodeName === 'bulletList' ? listItem(1) : r() < 0.3 ? list() : block();
      c.insert(Math.floor(r() * (c.length + 1)), [node]);
    } else if (x < 0.68) {
      const c = pick(containers);
      if (c.length > (c === f ? 1 : 0)) c.delete(Math.floor(r() * c.length), 1);
    } else if (x < 0.72 && blocks.length) {
      pick(blocks).setAttribute('textAlign', pick(['left', 'center', 'right']));
    } else if (x < 0.86) {
      t.undo++;
      p.undo.undo();
    } else {
      t.redo++;
      p.undo.redo();
    }
  };

  /** The block on `p`'s replica whose item is `id`, if it is live there. */
  const blockOn = (p: Peer, id: Y.ID | null | undefined) => (id ? walk(p.doc).blocks.find((el) => Y.compareIDs(el._item!.id, id)) : undefined);
  /** An insert into a block's text, inside [from, from + len) when it can. */
  const typeInto = (el: Y.XmlElement | undefined, from = 0, len = Infinity) => {
    const s = el?.get(0);
    if (!(s instanceof Y.XmlText)) return false;
    s.insert(Math.min(s.length, from + Math.floor(r() * Math.min(len, s.length - from + 1))), pick(WORDS));
    return true;
  };
  /**
   * The recreated-parent shape (yjs #823 with a co-editor): A deletes part of a block's text and undoes it (a restored
   * copy), B types into the copy, A deletes the block and undoes it (a recreated parent), B types into the recreated
   * block, then A undoes and redoes. B is another peer, or A itself (#823 as reported).
   */
  const recreatedParent = () => {
    const a = pick(peers);
    const b = r() < 0.7 ? pick(peers.filter((p) => p !== a)) : a;
    receive(a);
    const blocks = walk(a.doc).blocks.filter((el) => ((el.get(0) as Y.XmlText | null)?.length ?? 0) > 1);
    if (!blocks.length) return;
    const target = pick(blocks);
    const s = target.get(0) as Y.XmlText;
    const at = Math.floor(r() * (s.length - 1));
    const len = 1 + Math.floor(r() * (s.length - at - 1));
    a.undo.stopCapturing();
    s.delete(at, len);
    a.undo.stopCapturing();
    a.undo.undo();
    ship(a);
    receive(b);
    typeInto(blockOn(b, target._item!.id), at + 1, len - 1);
    ship(b);
    receive(a);
    if (target._item!.deleted) return;
    const parent = target.parent as Y.XmlElement | Y.XmlFragment;
    a.undo.stopCapturing();
    parent.delete(parent.toArray().indexOf(target), 1);
    a.undo.stopCapturing();
    a.undo.undo();
    ship(a);
    receive(b);
    if (typeInto(blockOn(b, target._item!.redone))) {
      t.shapes++;
      if (b !== a) t.foreignShapes++;
    }
    if (r() < 0.7) {
      ship(b);
      receive(a);
    }
    for (let k = 1 + Math.floor(r() * 4); k > 0; k--) {
      clock.now += Math.floor(r() * 700);
      if (r() < 0.5) a.undo.undo();
      else a.undo.redo();
    }
  };

  /**
   * Live has no UndoManager: it must equal its reload strictly. A peer's UndoManager keeps deleted items from gc (and
   * may stop keeping them later, ungc'd), so the peer's reload gc's exactly what the peer did. It also splits items at
   * its stack items' ranges, and an item it redid never merges again (`Item.mergeWith`); a reload does neither. So a
   * peer is held to the same items in the same order, tombstones included (displacedItems), and a split boundary is
   * the only strict difference it may have.
   */
  const check = (doc: Y.Doc, who: string): string | null => {
    t.checks++;
    if (doc === live) {
      const { diff } = op.isReloadStable(live);
      return diff ? `${who} != its reload ${JSON.stringify(diff)}` : null;
    }
    const reload = new Y.Doc({
      gcFilter: (item) => {
        const s = Y.getItem(doc.store, item.id);
        return !(s instanceof Y.Item) || s.content instanceof Y.ContentDeleted;
      },
    });
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(doc));
    const diff = op.strictOrderDiff(doc, reload);
    if (diff && !isSplit(diff)) return `${who} != its reload ${JSON.stringify(diff)}`;
    if (diff) t.peerSplits++;
    const moved = op.displacedItems(doc, reload);
    return moved.length ? `${who} displaced from its reload ${JSON.stringify(moved)}` : null;
  };
  let first: string | null = null;
  const note = (kind: 'liveUnstable' | 'peerUnstable' | 'unconverged', msg: string | null) => {
    if (!msg) return;
    t[kind]++;
    first ??= `seed ${seed} timeout ${captureTimeout}: ${msg}`;
  };

  const shapes = new Set(Array.from({ length: Math.floor(r() * 4) }, () => Math.floor(r() * OPS)));
  for (let i = 0; i < OPS; i++) {
    clock.now += Math.floor(r() * r() * 1500); // typing bursts group under captureTimeout 500, pauses split
    if (shapes.has(i)) recreatedParent();
    const p = pick(peers);
    const y = r();
    if (y < 0.55) edit(p);
    else if (y < 0.8) ship(p, 1 + Math.floor(r() * p.out.length));
    else receive(p, 1 + Math.floor(r() * p.inbox.length));
    if (i % CHECK_EVERY === CHECK_EVERY - 1 && !first) note('liveUnstable', check(live, 'live'));
  }
  // quiesce: a remote format change makes the receiver write a cleanup transaction, so deliver until nothing is queued
  while (peers.some((p) => p.out.length || p.inbox.length)) {
    for (const p of peers) ship(p);
    for (const p of peers) receive(p);
  }

  t.sessions++;
  if (!first) note('liveUnstable', check(live, 'live'));
  const want = live.getXmlFragment('default').toString();
  peers.forEach((p, k) => {
    note('peerUnstable', check(p.doc, `peer ${k}`));
    const got = p.doc.getXmlFragment('default').toString();
    note('unconverged', got === want ? null : `peer ${k} != live:\n  ${got}\n  ${want}`);
  });
  if (first) t.diverged++;
  t.first ??= first;
}

function corpus(arm: Arm, captureTimeout: number, base: number): Tally {
  const t: Tally = { sessions: 0, liveUnstable: 0, peerUnstable: 0, unconverged: 0, peerSplits: 0, diverged: 0, checks: 0, undo: 0, redo: 0, grouped: 0, stackItems: 0, shapes: 0, foreignShapes: 0, first: null };
  for (let s = 1; s <= SESSIONS; s++) session(arm, base + s * 7919, captureTimeout, t);
  return t;
}

describe('#840 honest grouped-undo corpus', () => {
  const src = readFileSync(YJS_CJS, 'utf8');
  const patched = loadArm(src);
  const upstream = loadArm(unpatched(src));

  it.each([500, 0])(`captureTimeout %i, ${SESSIONS} sessions × ${OPS} ops: live and every peer equal their reloads and converge; the unpatched redoItem diverges`, (captureTimeout) => {
    const base = captureTimeout ? 0 : 50_000_000;
    const ok = corpus(patched, captureTimeout, base);
    const bad = corpus(upstream, captureTimeout, base);
    console.log(`#840 grouped-undo corpus, captureTimeout ${captureTimeout}: ${JSON.stringify({ patched: ok, unpatched: { ...bad, first: bad.first?.slice(0, 200) } })}`);
    // Anti-vacuity: the corpus undid, redid, grouped typing into stack items (500; pauses still split them) or not (0),
    // and played the recreated-parent shape with a co-editor.
    expect(ok.undo).toBeGreaterThan(SESSIONS * 5);
    expect(ok.redo).toBeGreaterThan(SESSIONS * 5);
    expect(ok.foreignShapes).toBeGreaterThan(SESSIONS / 2);
    expect(ok.stackItems).toBeGreaterThan(SESSIONS * 40);
    if (captureTimeout) expect(ok.grouped).toBeGreaterThan(ok.stackItems / 10);
    else expect(ok.grouped).toBe(0);
    expect(ok.first).toBeNull();
    expect(ok).toMatchObject({ sessions: SESSIONS, diverged: 0, liveUnstable: 0, peerUnstable: 0, unconverged: 0 });
    // The unpatched redoItem trips every detector on the same corpus.
    expect(bad.sessions).toBe(SESSIONS);
    expect(bad.diverged).toBeGreaterThan(SESSIONS / 100);
    for (const k of ['liveUnstable', 'peerUnstable', 'unconverged'] as const) expect({ [k]: bad[k] > 0 }).toEqual({ [k]: true });
  });
});
