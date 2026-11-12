import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import * as vm from 'node:vm';
import * as Y from 'yjs';

/**
 * #840 (ADR 0036): yjs 13.6.30's `redoItem` can give a redone item contradictory origins (upstream yjs #794/#823), so
 * honest grouped undo leaves live and a reload of it in different orders. The fork carries patch B
 * (`patches/yjs@13.6.30.patch`, upstream PR #795's fallback). These specs pin that every Yjs consumer, server and SPA,
 * loads that one patched copy, that its `redoItem` is the reviewed text, and that it closes the divergence that the
 * unpatched `redoItem` (rebuilt here from the same file) still shows.
 */

const PINNED_YJS_VERSION = '13.6.30';
const MARKER = '[ccc #840]';
/** sha256 of `redoItem` in dist/yjs.cjs and dist/yjs.mjs, patched (the two are byte-identical) and upstream. */
const PINNED_REDO_SHA256 = '1d264a2b6a20084c0ed1f559f78074f634154b2a528c102774117bbb3684d478';
const UPSTREAM_REDO_SHA256 = 'a97a69c271b02ffad94e600145305ed51989fce30f801cd7b05249ed4edb6382';
const RE_VALIDATE = 'yjs redoItem changed: re-validate #840 patch B against upstream (yjs #794/#823, PR #795/#810) before updating this pin';

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

/** The dist without patch B: the marker comment through the end of its `if` block (4-space indented). */
function unpatched(src: string): string {
  const at = src.indexOf(`    // ${MARKER}`);
  expect(at).toBeGreaterThanOrEqual(0);
  const block = src.indexOf('    if (left !== null && right !== null) {\n', at);
  expect(block).toBeGreaterThan(at);
  const end = src.indexOf('\n    }\n', block);
  expect(end).toBeGreaterThan(block);
  return src.slice(0, at) + src.slice(end + '\n    }\n'.length);
}

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

/**
 * One client editing paragraphs under an UndoManager with the editor's `captureTimeout` (500 ms) on a simulated clock,
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
      } else if (op < 0.65 && f.length > 1) {
        const at = pick(f.length);
        f.delete(at, 1 + pick(Math.min(2, f.length - at - 1)));
      } else if (op < 0.85) {
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
      expect({ [name]: dist(name).split(MARKER).length - 1 }).toEqual({ [name]: 1 });
    }
  });

  it('pins redoItem in both dist files, patched and (with the patch removed) upstream', () => {
    for (const name of ['yjs.cjs', 'yjs.mjs'] as const) {
      const src = dist(name);
      const pins = { file: name, patched: sha256(redoItemOf(src)), upstream: sha256(redoItemOf(unpatched(src))) };
      if (pins.patched !== PINNED_REDO_SHA256 || pins.upstream !== UPSTREAM_REDO_SHA256) throw new Error(`${RE_VALIDATE}\n${JSON.stringify(pins)}`);
    }
  });

  it('yjs #823: live and a reload agree on the patched yjs, and diverge on the unpatched redoItem', () => {
    const [live, reload] = repro823(Y);
    expect(live).toBe('<paragraph>awo++rd</paragraph>');
    expect(reload).toBe(live);
    // Anti-vacuity: the same file without patch B reproduces upstream's divergence.
    const [uLive, uReload] = repro823(loadYjs(unpatched(dist('yjs.cjs')), { now: 0 }));
    expect(uLive).toBe('<paragraph>awo++rd</paragraph>');
    expect(uReload).toBe('<paragraph>ardwo++</paragraph>');
  });

  it(`seeded grouped-undo fuzz (${SESSIONS} sessions x ${OPS} ops): 0 sessions where live != reload`, () => {
    const patched = groupedUndoFuzz(dist('yjs.cjs'));
    const upstream = groupedUndoFuzz(unpatched(dist('yjs.cjs')));
    if (process.env.CONFLICT_SCAN_TALLY) console.log(JSON.stringify({ patched, upstream }));
    expect(patched.sessions).toBe(SESSIONS);
    expect(patched.diverged).toBe(0);
    // Anti-vacuity: the corpus grouped edits, undid and redid, and upstream's redoItem diverges on it.
    expect(patched.grouped).toBeGreaterThan(patched.stackItems / 10);
    expect(patched.undo).toBeGreaterThan(SESSIONS * 10);
    expect(patched.redo).toBeGreaterThan(SESSIONS * 5);
    expect(upstream.diverged).toBeGreaterThan(10);
  });
});
