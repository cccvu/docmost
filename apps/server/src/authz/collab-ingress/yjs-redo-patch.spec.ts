import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import * as vm from 'node:vm';
import * as Y from 'yjs';
import { strictOrderDiff } from './order-parity';

/**
 * #840 (ADR 0036): yjs 13.6.30's `redoItem` can give a redone item contradictory origins (upstream yjs #794/#823), so
 * honest grouped undo leaves live and a reload of it in different orders. And when one undo recreates a block and
 * restores one of its attributes (yjs #757), the attribute is linked into the deleted block's key chain: the undoing
 * user sees it, every other replica and every reload drop it. The fork carries patch B (`patches/yjs@13.6.30.patch`):
 * a `list` hunk (upstream PR #795's fallback) and a `keyed` hunk (upstream's #757 fix, released in 13.6.31). These
 * specs pin that every Yjs consumer, server and SPA, loads that one patched copy, that its `redoItem` is the reviewed
 * text, and that each hunk closes the divergence that the `redoItem` without it (rebuilt here from the same file)
 * still shows.
 */

const PINNED_YJS_VERSION = '13.6.30';
const MARKER = '[ccc #840]';
/** sha256 of `redoItem` in dist/yjs.cjs and dist/yjs.mjs, patched (the two are byte-identical) and upstream. */
const PINNED_REDO_SHA256 = '21c6c856f3109488e868d319640df765a1e50152caff1d4e4c963af663f80be6';
const UPSTREAM_REDO_SHA256 = 'a97a69c271b02ffad94e600145305ed51989fce30f801cd7b05249ed4edb6382';
const RE_VALIDATE = 'yjs redoItem changed: re-validate #840 patch B against upstream (yjs #794/#823 and #757, PR #795/#810) before updating this pin';

const SERVER_DIR = resolve(__dirname, '../../..');
const CLIENT_DIR = resolve(SERVER_DIR, '../client');
/** Every package that imports yjs at runtime, server or SPA. */
const CONSUMERS = [
  'y-prosemirror',
  '@tiptap/y-tiptap',
  '@tiptap/extension-collaboration',
  '@tiptap/extension-collaboration-caret',
  '@hocuspocus/server',
  '@hocuspocus/provider',
  '@hocuspocus/transformer',
  'y-indexeddb',
  'y-protocols/sync',
];

/** The yjs package directory a module file sits in (realpath). */
function packageDir(file: string): string {
  let dir = dirname(realpathSync(file));
  while (dir !== dirname(dir)) {
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'yjs') return dir;
    } catch {
      // no package.json here
    }
    dir = dirname(dir);
  }
  throw new Error(`${file} is not inside a yjs package`);
}

const fromApp = (app: string) => createRequire(join(app, 'package.json'));
const YJS_DIR = packageDir(fromApp(SERVER_DIR).resolve('yjs'));
const dist = (name: 'yjs.cjs' | 'yjs.mjs') => readFileSync(join(YJS_DIR, 'dist', name), 'utf8');

/** `redoItem`'s text in a rollup dist: from its declaration to the first top-level `};`. */
function redoItemOf(src: string): string {
  const start = src.indexOf('const redoItem = ');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(src.indexOf('const redoItem = ', start + 1)).toBe(-1);
  const end = src.indexOf('\n};\n', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + 3);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Patch B's hunks, by the text that follows the marker. */
const HUNKS = { list: 'yjs #794/#823', keyed: 'yjs #757' } as const;

/** The dist without one hunk of patch B: its marker comment through the end of its `if` block (4-space indented). */
function cut(src: string, hunk: keyof typeof HUNKS): string {
  const at = src.indexOf(`    // ${MARKER} ${HUNKS[hunk]}`);
  expect(at).toBeGreaterThanOrEqual(0);
  const block = src.indexOf('\n    if (', at);
  expect(block).toBeGreaterThan(at);
  const end = src.indexOf('\n    }\n', block);
  expect(end).toBeGreaterThan(block);
  return src.slice(0, at) + src.slice(end + '\n    }\n'.length);
}

/** The dist without patch B. */
const unpatched = (src: string) => cut(cut(src, 'list'), 'keyed');

/** A scratch yjs compiled from `src` in a vm, reading `clock.now` as its time (never written to disk). */
function loadYjs(src: string, clock: { now: number }): typeof Y {
  const file = join(YJS_DIR, 'dist', 'yjs.cjs');
  const fn = vm.compileFunction(src, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: `${file}.spec` });
  const req = createRequire(file);
  const withClock = (id: string) => (id === 'lib0/time' ? { ...req(id), getUnixTime: () => clock.now } : req(id));
  const outer = vm.runInThisContext('globalThis') as Record<string, unknown>;
  const flag = '__ $YJS$ __';
  const had = outer[flag];
  delete outer[flag]; // silence yjs's double-import warning
  const module = { exports: {} as typeof Y };
  fn(module.exports, withClock, module, file, dirname(file));
  outer[flag] = had;
  return module.exports;
}

/** Live and a reload of it, as text. */
function liveAndReload(YY: typeof Y, doc: Y.Doc): [string, string] {
  const reload = new YY.Doc();
  YY.applyUpdate(reload, YY.encodeStateAsUpdate(doc));
  return [doc.getXmlFragment('default').toString(), reload.getXmlFragment('default').toString()];
}

function paragraph(YY: typeof Y, text: string): Y.XmlElement {
  const p = new YY.XmlElement('paragraph');
  const t = new YY.XmlText();
  p.insert(0, [t]);
  if (text) t.insert(0, text);
  return p;
}

/** yjs #823, one client: undo restores a copy of "word", "++" splits the copy, then the paragraph is deleted and undone. */
function repro823(YY: typeof Y): [string, string] {
  const doc = new YY.Doc();
  doc.clientID = 1;
  const f = doc.getXmlFragment('default');
  f.insert(0, [paragraph(YY, 'aword')]);
  const um = new YY.UndoManager(f, { captureTimeout: 0 });
  (f.get(0) as Y.XmlElement).get(0).delete(1, 4);
  um.stopCapturing();
  um.undo();
  ((f.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(3, '++');
  um.stopCapturing();
  f.delete(0, 1);
  um.stopCapturing();
  um.undo();
  return liveAndReload(YY, doc);
}

/**
 * yjs #757 in a page: one stack item changes a paragraph's alignment and deletes the paragraph; undo recreates it and
 * restores "left". Returns live, a reload of it, and a replica that received live's updates as they happened.
 */
function repro757(YY: typeof Y): [string, string, string] {
  const doc = new YY.Doc();
  doc.clientID = 1;
  const peer = new YY.Doc();
  doc.on('update', (u: Uint8Array) => YY.applyUpdate(peer, u));
  const f = doc.getXmlFragment('default');
  const p = paragraph(YY, 'hello');
  f.insert(0, [p]);
  p.setAttribute('textAlign', 'left');
  const um = new YY.UndoManager(f, { captureTimeout: 500 });
  p.setAttribute('textAlign', 'center');
  f.delete(0, 1);
  um.undo();
  return [...liveAndReload(YY, doc), peer.getXmlFragment('default').toString()];
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

const SESSIONS = 3000;
const OPS = 100;
const WORDS = ['a', 'bc', '++', 'word ', 'x'];
const ALIGN = ['left', 'center', 'right'];

/**
 * One client editing paragraphs (text and the `textAlign` attribute) under an UndoManager with the editor's `captureTimeout` (500 ms) on a simulated clock,
 * so edits group into multi-change stack items as typing does. Returns the sessions whose live text differs from a reload.
 */
function groupedUndoFuzz(src: string) {
  const clock = { now: 1_000_000 };
  const YY = loadYjs(src, clock);
  const seen = { sessions: 0, diverged: 0, undo: 0, redo: 0, stackItems: 0, grouped: 0 };
  for (let seed = 1; seed <= SESSIONS; seed++) {
    const r = rng(seed);
    const pick = (n: number) => Math.floor(r() * n);
    const doc = new YY.Doc();
    doc.clientID = 1;
    const f = doc.getXmlFragment('default');
    f.insert(0, [paragraph(YY, 'aword'), paragraph(YY, 'hello')]);
    const um = new YY.UndoManager(f, { captureTimeout: 500 });
    um.on('stack-item-added', () => seen.stackItems++);
    um.on('stack-item-updated', () => seen.grouped++);
    const text = () => (f.length ? ((f.get(pick(f.length)) as Y.XmlElement).get(0) as Y.XmlText | null) : null);
    for (let i = 0; i < OPS; i++) {
      clock.now += Math.floor(r() * r() * 1500);
      const op = r();
      if (op < 0.3) {
        const t = text();
        if (t) t.insert(pick(t.length + 1), WORDS[pick(WORDS.length)]);
      } else if (op < 0.45) {
        const t = text();
        if (t?.length) {
          const at = pick(t.length);
          t.delete(at, 1 + pick(Math.min(4, t.length - at)));
        }
      } else if (op < 0.55) {
        f.insert(pick(f.length + 1), [paragraph(YY, WORDS[pick(WORDS.length)])]);
      } else if (op < 0.6) {
        if (f.length) (f.get(pick(f.length)) as Y.XmlElement).setAttribute('textAlign', ALIGN[pick(ALIGN.length)]);
      } else if (op < 0.68 && f.length > 1) {
        const at = pick(f.length);
        f.delete(at, 1 + pick(Math.min(2, f.length - at - 1)));
      } else if (op < 0.86) {
        um.undo();
        seen.undo++;
      } else {
        um.redo();
        seen.redo++;
      }
    }
    const [live, reload] = liveAndReload(YY, doc);
    seen.sessions++;
    if (live !== reload) seen.diverged++;
  }
  return seen;
}

describe('#840 yjs redo patch B', () => {
  it('every Yjs consumer, server and SPA, loads the one patched yjs', () => {
    const copies = new Map<string, string[]>();
    const note = (dir: string, who: string) => copies.set(dir, [...(copies.get(dir) ?? []), who]);
    for (const [app, dir] of [['server', SERVER_DIR], ['client', CLIENT_DIR]]) {
      const req = fromApp(dir);
      note(packageDir(req.resolve('yjs')), `${app}: yjs`);
      for (const consumer of CONSUMERS) {
        const file = req.resolve(consumer);
        note(packageDir(createRequire(file).resolve('yjs')), `${app}: ${consumer}`);
      }
    }
    // The spec's own `yjs` (the jest graph) is the same file.
    note(packageDir(require.resolve('yjs')), 'jest: yjs');
    if (copies.size !== 1) {
      const report = [...copies].map(([dir, who]) => `${dir}\n  <- ${who.join(', ')}`).join('\n');
      throw new Error(`#840: more than one yjs copy resolves; patch B must be the only yjs (dedupe the lockfile):\n${report}`);
    }

    expect(JSON.parse(readFileSync(join(YJS_DIR, 'package.json'), 'utf8')).version).toBe(PINNED_YJS_VERSION);
    for (const name of ['yjs.cjs', 'yjs.mjs'] as const) {
      expect({ [name]: dist(name).split(MARKER).length - 1 }).toEqual({ [name]: Object.keys(HUNKS).length });
    }
  });

  it('pins redoItem in both dist files, patched and (with the patch removed) upstream', () => {
    for (const name of ['yjs.cjs', 'yjs.mjs'] as const) {
      const src = dist(name);
      const pins = { file: name, patched: sha256(redoItemOf(src)), upstream: sha256(redoItemOf(unpatched(src))) };
      if (pins.patched !== PINNED_REDO_SHA256 || pins.upstream !== UPSTREAM_REDO_SHA256) throw new Error(`${RE_VALIDATE}\n${JSON.stringify(pins)}`);
    }
  });

  it('yjs #823: live and a reload agree on the patched yjs, and diverge without the list hunk', () => {
    const [live, reload] = repro823(Y);
    expect(live).toBe('<paragraph>awo++rd</paragraph>');
    expect(reload).toBe(live);
    // Anti-vacuity: the same file without the list hunk reproduces upstream's divergence.
    const [uLive, uReload] = repro823(loadYjs(cut(dist('yjs.cjs'), 'list'), { now: 0 }));
    expect(uLive).toBe('<paragraph>awo++rd</paragraph>');
    expect(uReload).toBe('<paragraph>ardwo++</paragraph>');
  });

  it('yjs #757: an attribute restored with its block reaches the reload and a peer on the patched yjs, and only the undoing user without the keyed hunk', () => {
    const want = '<paragraph textAlign="left">hello</paragraph>';
    expect(repro757(Y)).toEqual([want, want, want]);
    // Anti-vacuity: without the keyed hunk the undoing user sees "left"; a reload and a peer drop it.
    // (A frozen, nonzero clock: both changes land in one stack item.)
    expect(repro757(loadYjs(cut(dist('yjs.cjs'), 'keyed'), { now: 1_000_000 }))).toEqual([want, '<paragraph>hello</paragraph>', '<paragraph>hello</paragraph>']);
  });

  it(`seeded grouped-undo fuzz (${SESSIONS} sessions x ${OPS} ops): 0 sessions where live != reload`, () => {
    const patched = groupedUndoFuzz(dist('yjs.cjs'));
    const noList = groupedUndoFuzz(cut(dist('yjs.cjs'), 'list'));
    const noKeyed = groupedUndoFuzz(cut(dist('yjs.cjs'), 'keyed'));
    if (process.env.CONFLICT_SCAN_TALLY) console.log(JSON.stringify({ patched, noList, noKeyed }));
    expect(patched.sessions).toBe(SESSIONS);
    expect(patched.diverged).toBe(0);
    // Anti-vacuity: the corpus grouped edits, undid and redid, and each hunk's divergence shows without it.
    expect(patched.grouped).toBeGreaterThan(patched.stackItems / 10);
    expect(patched.undo).toBeGreaterThan(SESSIONS * 10);
    expect(patched.redo).toBeGreaterThan(SESSIONS * 5);
    expect(noList.diverged).toBeGreaterThan(10);
    expect(noKeyed.diverged).toBeGreaterThan(10);
  });
});

/**
 * #847 (ADR 0036): yjs 13.6.30's `Item.integrate` offset branch (the tail of a struct this replica partly holds) links
 * the tail after the same client's previous clock and takes its origin from that struct's `lastId`. When that clock was
 * garbage-collected here (its parent was deleted), the struct is a GC, which has no `lastId` and no `right`: the walk
 * throws a TypeError with the update half-applied. Patch C (`[ccc #847]`) applies yjs #417's rule (getMissing, 29270b5):
 * the origin is that clock, and a GC there integrates the tail as a GC. For an Item there nothing changes (the origin
 * equals its `lastId`).
 */
const MARKER_C = '[ccc #847]';
/** sha256 of `Item.prototype.integrate` (its method text) in both dist files: patched, and with patch C reverted. */
const PINNED_INTEGRATE_SHA256 = '031193b8ffb9b780e46ac1b5d308276e05bd33b15ffd67e69216bb25a632471e';
const PRE_847_INTEGRATE_SHA256 = 'e1840302775981b0ed0c7b62f05695c53dc03dc3ab196fd70c44865a9638d267'; // stock 13.6.30 (patch B leaves integrate alone)
const RE_VALIDATE_C = 'yjs Item.integrate changed: re-validate #847 patch C (yjs #417, 29270b5) and conflict-scan.ts `replay` before updating these pins';

/** `Item.prototype.integrate`'s method text in a rollup dist (what `Function.prototype.toString` returns for it). */
function integrateOf(src: string): string {
  const cls = src.indexOf('\nclass Item extends AbstractStruct {');
  expect(cls).toBeGreaterThanOrEqual(0);
  expect(src.indexOf('\nclass Item extends AbstractStruct {', cls + 1)).toBe(-1);
  const start = src.indexOf('\n  integrate (transaction, offset) {', cls);
  expect(start).toBeGreaterThan(cls);
  const end = src.indexOf('\n  }\n', start + 1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start + 3, end + 4);
}

/** The dist with patch C reverted: its hunk (marker through the GC `if`) back to upstream's one line. */
function cutC(src: string): string {
  const at = src.indexOf(`      // ${MARKER_C}`);
  expect(at).toBeGreaterThanOrEqual(0);
  const tail = '        this.parent = null;\n      }\n';
  const end = src.indexOf(tail, at);
  expect(end).toBeGreaterThan(at);
  return src.slice(0, at) + '      this.origin = this.left.lastId;\n' + src.slice(end + tail.length);
}

/**
 * M1: client 1 holds texts P and Q in an array; client 7 writes "abc" into P, then P is deleted, so client 7's clocks
 * 0..2 are a GC here. A frame from a fresh client-7 doc writes "abcdef" (clocks 0..5) into Q, merged with client 9's
 * "zz" into Q. Yjs integrates client 9 first (higher ids first), then client 7's struct with offset 3 over the GC.
 */
function reproM1(YY: typeof Y) {
  const base = new YY.Doc();
  base.clientID = 1;
  base.getArray('arr').insert(0, [new YY.Text('P'), new YY.Text('Q')]);
  const b0 = YY.encodeStateAsUpdate(base);
  const write = (client: number, index: number, text: string): Uint8Array => {
    const d = new YY.Doc();
    d.clientID = client;
    YY.applyUpdate(d, b0);
    let u: Uint8Array | null = null;
    d.on('update', (x: Uint8Array) => (u = x));
    (d.getArray('arr').get(index) as Y.Text).insert(1, text);
    return u!;
  };
  const doc = new YY.Doc();
  doc.clientID = 2;
  YY.applyUpdate(doc, b0);
  YY.applyUpdate(doc, write(7, 0, 'abc'));
  doc.getArray('arr').delete(0, 1);
  const frame = YY.mergeUpdates([write(7, 1, 'abcdef'), write(9, 1, 'zz')]);
  const q = () => (doc.getArray('arr').get(0) as Y.Text).toString();
  const before = { state7: YY.getState(doc.store, 7), q: q(), gc7: doc.store.clients.get(7)!.every((s) => s instanceof YY.GC) };
  let updates = 0;
  doc.on('update', () => updates++);
  let thrown: unknown = null;
  try {
    YY.applyUpdate(doc, frame);
  } catch (e) {
    thrown = e;
  }
  const doc_ = doc as unknown as { _transaction: unknown; _transactionCleanups: unknown[] };
  return {
    doc,
    before,
    thrown,
    updates,
    q: q(),
    state7: YY.getState(doc.store, 7),
    state9: YY.getState(doc.store, 9),
    structs7: doc.store.clients.get(7)!.map((s) => [s.constructor === YY.GC ? 'GC' : s.constructor.name, s.id.clock, s.length]),
    clean: doc_._transaction === null && doc_._transactionCleanups.length === 0,
  };
}

describe('#847 yjs patch C: the tail of a partly known struct over a GC integrates as a GC', () => {
  it('the marker appears once in each dist file', () => {
    for (const name of ['yjs.cjs', 'yjs.mjs'] as const) {
      expect({ [name]: dist(name).split(MARKER_C).length - 1 }).toEqual({ [name]: 1 });
    }
  });

  it('pins integrate in both dist files, patched and (with the hunk reverted) stock, so the hunk is its only change', () => {
    // The extraction is the method text yjs itself runs (anti-vacuity: not a slice that merely hashes stably).
    expect(integrateOf(dist('yjs.cjs'))).toBe(loadYjs(dist('yjs.cjs'), { now: 0 }).Item.prototype.integrate.toString());
    for (const name of ['yjs.cjs', 'yjs.mjs'] as const) {
      const src = dist(name);
      const pins = { file: name, patched: sha256(integrateOf(src)), reverted: sha256(integrateOf(cutC(src))) };
      if (pins.patched !== PINNED_INTEGRATE_SHA256 || pins.reverted !== PRE_847_INTEGRATE_SHA256) throw new Error(`${RE_VALIDATE_C}\n${JSON.stringify(pins)}`);
      // Nothing outside integrate moves either: reverting the hunk restores the file the rest of the patch produced.
      expect(cutC(src).split(MARKER_C)).toHaveLength(1);
    }
  });

  it('M1 without the hunk: Yjs throws mid-update, half-applied: what integrated before the throw stays, the rest is lost', () => {
    const m1 = reproM1(loadYjs(cutC(dist('yjs.cjs')), { now: 0 }));
    expect(m1.before).toEqual({ state7: 3, q: 'Q', gc7: true }); // the precondition: client 7's clocks 0..2 are a GC
    // (the vm-compiled yjs throws its realm's TypeError, so the name, not instanceof)
    expect((m1.thrown as Error | null)?.constructor.name).toBe('TypeError');
    expect(String((m1.thrown as Error).message)).toMatch(/reading 'origin'/);
    // Half-applied: client 9's insert integrated (it went first) and transact's finally emitted it, while client 7's
    // struct (and anything Yjs would have read after it) is lost, with the frame reported as failed.
    expect(m1.q).toBe('Qzz');
    expect(m1.state9).toBe(2);
    expect(m1.state7).toBe(3);
    expect(m1.updates).toBe(1);
    expect(m1.clean).toBe(true); // transact's finally ran: no wedge, only the lost half
  });

  it('M1 with the hunk: no throw, the tail is a GC, the target text keeps only the honest insert, and a reload equals live', () => {
    const m1 = reproM1(Y);
    expect(m1.before).toEqual({ state7: 3, q: 'Q', gc7: true });
    expect(m1.thrown).toBeNull();
    expect(m1.structs7).toEqual([['GC', 0, 6]]); // clocks 3..5 integrated as a GC (merged with 0..2)
    expect(m1.state7).toBe(6);
    expect(m1.q).toBe('Qzz'); // the crafted "def" landed nowhere
    expect(m1.updates).toBe(1);
    expect(m1.clean).toBe(true);
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(m1.doc));
    expect(strictOrderDiff(m1.doc, reload)).toBeNull();
    expect(reload.getArray('arr').toJSON()).toEqual(['Qzz']);
  });

  it('an Item previous clock is unchanged by the hunk: the same tail over a live struct links as stock Yjs links it', () => {
    // Without the delete, client 7's clocks 0..2 are a live Item in P, so the tail follows it there (cross-list, the
    // guard's rule); patch C gives it the same origin (that Item's lastId) and the same placement as stock Yjs.
    const run = (YY: typeof Y) => {
      const base = new YY.Doc();
      base.clientID = 1;
      base.getArray('arr').insert(0, [new YY.Text('P'), new YY.Text('Q')]);
      const b0 = YY.encodeStateAsUpdate(base);
      const write = (index: number, text: string) => {
        const d = new YY.Doc();
        d.clientID = 7;
        YY.applyUpdate(d, b0);
        let u: Uint8Array | null = null;
        d.on('update', (x: Uint8Array) => (u = x));
        (d.getArray('arr').get(index) as Y.Text).insert(1, text);
        return u!;
      };
      const doc = new YY.Doc();
      doc.clientID = 2;
      YY.applyUpdate(doc, b0);
      YY.applyUpdate(doc, write(0, 'abc'));
      YY.applyUpdate(doc, write(1, 'abcdef'));
      const structs7 = doc.store.clients.get(7)!.map((s) => [s.constructor.name, s.id.clock, s.length, (s as Y.Item).parent === (doc.getArray('arr').get(0) as Y.Text)]);
      return { arr: doc.getArray('arr').toJSON(), structs7, update: Array.from(YY.encodeStateAsUpdate(doc)) };
    };
    const patched = run(Y);
    expect(patched).toEqual(run(loadYjs(cutC(dist('yjs.cjs')), { now: 0 })));
    expect(patched.arr).toEqual(['Pabcdef', 'Q']); // the tail followed clock 2 into P (merged with it)
    expect(patched.structs7).toEqual([['Item', 0, 6, true]]);
  });
});
