import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { Hocuspocus } from '@hocuspocus/server';
import { Node as PMNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { fixTables, TableMap } from '@tiptap/pm/tables';
import { initProseMirrorDoc, prosemirrorJSONToYDoc, updateYFragment } from '@tiptap/y-tiptap';
import { docGeneration } from '../page-write/doc-version';
import { serverSchema } from '../page-write/prelim-content';
import {
  ALL_NODES_DOC,
  authFrame,
  contentOf,
  deepJson,
  DOC_NAME,
  FakeSocket,
  MSG,
  RemoteClient,
  renderLikeABrowser,
  spliceVarString,
  SYNC,
  syncFrame,
} from './collab-ingress.testkit';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { checkAttribute, checkElement, checkFormat, INT_ATTRS, STRING_ATTRS } from './content-rules';
import { planLegacyRepair, repairLegacyValues, REPAIR_ORIGIN, type LegacyRepair } from './legacy-repair';
import { SocketLimitLog } from './socket-limit-log';
import { CollabUpdateGuard } from './update-guard';

/**
 * #781 lineage (ADR 0036 amendment): the load repair of legacy values (legacy-repair.ts). Stored content written before
 * #781 can hold values the guard's value rules refuse; honest editors copy or derive them into new structs (fixTables,
 * a split, a recreated element), which the guard refuses, so the page cannot be edited. The repair deletes those values
 * once per document lifetime, before any connection syncs, and writes no content, so a repair that is not persisted
 * (it runs with skipStoreHooks) is safe to repeat in every lifetime: a browser that synced an earlier lifetime echoes it
 * back without duplicating anything. Every frame here goes through the REAL guard.
 */
const schema = serverSchema();
type Doc = Y.Doc & { name: string };
type Conn = { readOnly: boolean; webSocket: { close: jest.Mock }; context: { user: { id: string } } };

/** A stored row's ydoc, built directly in Yjs (as pre-#781 content was: no rule applied). */
function stored(build: (f: Y.XmlFragment) => void): Uint8Array {
  const d = new Y.Doc();
  d.transact(() => build(d.getXmlFragment('default')));
  return Y.encodeStateAsUpdate(d);
}

/** One document lifetime: a fresh Y.Doc (fresh server client id) loaded from the row, as the persistence extension does. */
function lifetime(row: Uint8Array | Uint8Array[], repair = true): Doc {
  const d = new Y.Doc() as Doc;
  d.name = DOC_NAME;
  d.getXmlFragment('default');
  for (const u of Array.isArray(row) ? row : [row]) Y.applyUpdate(d, u);
  if (repair) repairLegacyValues(d);
  return d;
}

/** The real guard in front of `live`; `send` applies an accepted frame the way Hocuspocus does. */
function guarded(live: Doc) {
  const logs: string[] = [];
  const guard = new CollabUpdateGuard({ mode: 'enforce', logger: { warn: (m) => logs.push(m) }, limitLog: new SocketLimitLog({ warn: () => undefined }) });
  const conn = (id: string): Conn => ({ readOnly: false, webSocket: { close: jest.fn() }, context: { user: { id } } });
  const send = (c: Conn, update: Uint8Array, subtype: number = SYNC.Update): string => {
    try {
      guard.check({ connection: c, document: live, update: syncFrame(update, subtype), context: c.context });
    } catch (err: any) {
      return err.reason;
    }
    Y.applyUpdate(live, update, c);
    return 'applied';
  };
  return { guard, logs, conn, send };
}

const REFUSED = (rule: string) => `ccc:collab-update-refused:${rule}`;

function el(name: string, attrs: Record<string, unknown> = {}, ...children: Array<Y.XmlElement | Y.XmlText>): Y.XmlElement {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as never);
  if (children.length) e.insert(0, children);
  return e;
}
const para = (...children: Array<Y.XmlElement | Y.XmlText>) => el('paragraph', {}, ...children);
/** An XmlText built the way an editor builds it: the text, then each format(index, length, attributes) in order. */
function formatted(text: string, ...formats: Array<[number, number, Record<string, unknown>]>): Y.XmlText {
  const t = new Y.XmlText(text);
  for (const [at, length, attributes] of formats) t.format(at, length, attributes); // queued until the text integrates
  return t;
}
/** An XmlText of runs: [text, attributes?] each. */
function runs(...parts: Array<[string, Record<string, unknown>?]>): Y.XmlText {
  const t = new Y.XmlText();
  // A prelim XmlText takes its runs as a delta (formats are written when it integrates).
  t.applyDelta(parts.map(([insert, attributes]) => (attributes ? { insert, attributes } : { insert })));
  return t;
}
const cell = (colspan?: unknown, text = 'c') => el('tableCell', colspan === undefined ? {} : { colspan }, para(runs([text])));
const table = (rows: unknown[][]) => el('table', {}, ...rows.map((r) => el('tableRow', {}, ...r.map((c, i) => cell(c, `r${i}`)))));

/** First element named `name` (depth-first). */
function find(doc: Y.Doc, name: string): Y.XmlElement {
  const stack: unknown[] = doc.getXmlFragment('default').toArray().reverse();
  while (stack.length) {
    const e = stack.pop();
    if (!(e instanceof Y.XmlElement)) continue;
    if (e.nodeName === name) return e;
    stack.push(...e.toArray().reverse());
  }
  throw new Error(`no ${name}`);
}
const textOf = (e: Y.XmlElement): Y.XmlText => e.toArray().find((c) => c instanceof Y.XmlText) as Y.XmlText;

/** A text's runs as y-tiptap renders them: adjacent runs with equal marks merged (Yjs's toDelta splits at every format item). */
function runsOf(t: Y.XmlText): Array<{ insert: string; attributes?: Record<string, unknown> }> {
  const out: Array<{ insert: string; attributes?: Record<string, unknown> }> = [];
  for (const op of t.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>) {
    const last = out[out.length - 1];
    if (last && JSON.stringify(last.attributes ?? {}) === JSON.stringify(op.attributes ?? {})) last.insert += op.insert;
    else out.push({ ...op });
  }
  return out;
}

/** Every update `doc` emits while `fn` runs. */
function updatesOf(doc: Y.Doc, fn: () => void): Uint8Array[] {
  const out: Uint8Array[] = [];
  const on = (u: Uint8Array) => out.push(u);
  doc.on('update', on);
  try {
    fn();
  } finally {
    doc.off('update', on);
  }
  return out;
}

/** Content structs (text or elements) `doc` holds, visible, written by any of `clients`. */
function contentStructsBy(doc: Y.Doc, clients: number[]): number {
  let n = 0;
  for (const client of clients) {
    for (const s of doc.store.clients.get(client) ?? []) {
      if (s instanceof Y.Item && !s.deleted && (s.content instanceof Y.ContentString || s.content instanceof Y.ContentType)) n++;
    }
  }
  return n;
}

/** The ContentFormat structs of a V1 update, and whether it carries any text or element struct. */
function structsOf(update: Uint8Array): { formats: Array<{ key: string; value: unknown }>; content: number; all: number } {
  const { structs } = Y.decodeUpdate(update);
  const formats: Array<{ key: string; value: unknown }> = [];
  let content = 0;
  for (const s of structs) {
    if (!(s instanceof Y.Item)) continue;
    if (s.content instanceof Y.ContentFormat) formats.push({ key: s.content.key, value: s.content.value });
    if (s.content instanceof Y.ContentString || s.content instanceof Y.ContentType) content++;
  }
  return { formats, content, all: structs.length };
}

/** A browser: it loads lifetime `live` (sync) and renders it with y-tiptap, as every editor does. */
function browserOf(live: Y.Doc, clientID?: number): RemoteClient {
  return new RemoteClient(live, clientID);
}

/**
 * The browser's table plugin: prosemirror-tables' `fixTables` (tableEditing's appendTransaction) over the document
 * y-tiptap renders, written back through y-tiptap's `updateYFragment`. Returns the frame it would send, or null when
 * fixTables changes nothing (converged).
 */
function openWithTablePlugin(client: RemoteClient, against: Y.Doc): Uint8Array | null {
  const { doc, meta } = initProseMirrorDoc(client.fragment, schema);
  const tr = fixTables(EditorState.create({ doc }));
  if (!tr) return null;
  client.doc.transact(() => updateYFragment(client.doc, client.fragment, tr.doc, meta as never));
  return Y.encodeStateAsUpdate(client.doc, Y.encodeStateVector(against));
}

const spansOf = (doc: Y.Doc): unknown[][] =>
  (find(doc, 'table').toArray() as Y.XmlElement[]).map((row) => (row.toArray() as Y.XmlElement[]).map((c) => c.getAttribute('colspan')));

describe('#781 legacy repair: every value the guard\'s value rules refuse is removed, and nothing else', () => {
  const nodeStringAttrs = [...STRING_ATTRS].filter((e) => e.startsWith('node '));
  const deep17 = JSON.parse(deepJson(17));
  const hostileFor = (entry: string): unknown[] => {
    const [type, attr] = entry.slice('node '.length).split('.');
    const def = (schema.nodes[type].spec.attrs as Record<string, { default?: unknown }>)[attr].default;
    const range = INT_ATTRS.get(entry);
    // Every value rule: kind (a BigInt, a typed array, nested or as the item itself: lib0's readAny decodes both),
    // size (more than COLLAB_LIMITS.valueEntries entries) and depth, then string-ness and range.
    const anyRule = [10n, new Uint8Array(1), [new Uint8Array(1)], Array(10_001).fill(0), deep17];
    const base = range ? ['100%', '', 0, -1, 1.5, range[1] + 1, '2', true, {}, ...anyRule] : [0, 1.5, true, {}, [1], ...anyRule];
    return def === null || def === undefined ? base : [...base, null];
  };
  const swept = [...INT_ATTRS.keys(), ...nodeStringAttrs];
  const cases = swept.flatMap((entry) => hostileFor(entry).map((value) => [entry, value] as const));

  it('sweeps every INT_ATTRS entry and every node STRING_ATTRS entry (a new entry cannot be skipped silently)', () => {
    expect(new Set(cases.map(([e]) => e)).size).toBe(INT_ATTRS.size + nodeStringAttrs.length);
  });

  it.each(cases)('%s = %p: refused before, removed (schema default applies) after', (entry, value) => {
    const [type, attr] = entry.slice('node '.length).split('.');
    const doc = prosemirrorJSONToYDoc(schema, ALL_NODES_DOC, 'default') as Doc;
    const target = find(doc, type);
    doc.transact(() => target.setAttribute(attr, value as never));
    expect(checkAttribute(type, attr, [value], { yjs: true })).not.toBeNull(); // non-vacuity: a value the rules refuse
    expect(checkElement(target).ok).toBe(false);
    const report = repairLegacyValues(doc);
    expect(report).toMatchObject({ attrs: 1, marks: 0, spills: 0, skipped: 0 });
    expect(checkElement(target)).toEqual({ ok: true });
    expect(target.getAttributes()).not.toHaveProperty(attr);
    expect(renderLikeABrowser(doc)).toMatchObject({ deleted: false, threw: false });
  });

  // The forms a value takes in a stored row: the row encoded and decoded (lib0's readAny for an attribute's ContentAny,
  // which assigns keys, so a JSON `__proto__` key re-prototypes the object). Each is removed under its own rule; a rule
  // dropped from REPAIRABLE_RULES leaves its case unrepaired here.
  it.each([
    ['a BigInt', () => 10n, 'value-kind'],
    ['a typed array inside the value', () => [new Uint8Array(1)], 'value-kind'],
    ["an object with a JSON '__proto__' key", () => JSON.parse('{"__proto__":{"href":"x"}}'), 'value-kind'],
    ['an array of 10_001 entries', () => Array(10_001).fill(0), 'value-size'],
    ['a value 17 deep', () => deep17, 'value-depth'],
    ['a typed array as the item (ContentBinary)', () => new Uint8Array(1), 'attr-kind'],
  ])('a stored attribute value, %s, is removed under %s', (_n, value, rule) => {
    const row = stored((f) => f.insert(0, [el('paragraph', { textAlign: value() }, runs(['x']))]));
    const doc = lifetime(row, false);
    const p = find(doc, 'paragraph');
    expect(checkElement(p)).toMatchObject({ ok: false, violation: { rule } }); // non-vacuity: refused under that rule
    expect(repairLegacyValues(doc)).toEqual({ attrs: 1, marks: 0, spills: 0, skipped: 0, rules: { [rule]: 1 } });
    expect(checkElement(p)).toEqual({ ok: true });
    expect(p.getAttributes()).not.toHaveProperty('textAlign');
  });

  it('an attribute item that is not a JSON value (a nested map) is removed too (attr-kind)', () => {
    const doc = prosemirrorJSONToYDoc(schema, ALL_NODES_DOC, 'default') as Doc;
    const p = find(doc, 'paragraph');
    doc.transact(() => p.setAttribute('textAlign', new Y.Map() as never));
    expect(checkElement(p).ok).toBe(false);
    expect(repairLegacyValues(doc)).toMatchObject({ attrs: 1, rules: { 'attr-kind': 1 } });
    expect(checkElement(p)).toEqual({ ok: true });
  });

  it.each([
    ['link href a number', { link: { href: 123 } }, 'string-attr', 'v1'],
    ['highlight colorName an object', { highlight: { color: '#fff', colorName: {} } }, 'string-attr', 'v1'],
    ['textStyle with a 17-deep undeclared key', { textStyle: { color: '#1971c2', x: deep17 } }, 'value-depth', 'v1'],
    ['textStyle with an undeclared array of 10_001 entries', { textStyle: { color: '#1971c2', x: Array(10_001).fill(0) } }, 'value-size', 'v1'],
    // A V2 row: Yjs encodes a format value with lib0's writeAny there, and readAny decodes a BigInt and a typed array,
    // and assigns keys (a JSON `__proto__` key re-prototypes the value). A V1 row's JSON.parse keeps it an own key.
    ["link with a JSON '__proto__' key (V2 row)", { link: JSON.parse('{"__proto__":{"href":"x"}}') }, 'value-kind', 'v2'],
    ['link with a BigInt (V2 row)', { link: { href: 'x', n: 10n } }, 'value-kind', 'v2'],
    ['highlight with a typed array (V2 row)', { highlight: { color: '#fff', b: new Uint8Array(1) } }, 'value-kind', 'v2'],
  ] as Array<[string, Record<string, unknown>, string, 'v1' | 'v2']>)('a mark: %s is deleted; the text, other marks and comment marks are unchanged', (_n, bad, rule, enc) => {
    const build = (f: Y.XmlFragment) =>
      f.insert(0, [para(runs(['plain '], ['bad', { ...bad, bold: {} }], [' kept', { comment: { commentId: 'c1', resolved: false } }]))]);
    let doc: Doc;
    if (enc === 'v2') {
      const src = new Y.Doc();
      src.transact(() => build(src.getXmlFragment('default')));
      doc = new Y.Doc() as Doc;
      doc.name = DOC_NAME;
      doc.getXmlFragment('default');
      Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(src));
    } else {
      doc = lifetime(stored(build), false);
    }
    const p = find(doc, 'paragraph');
    // non-vacuity: the stored format item is refused under that rule
    const formatsOf = () => {
      const out: Array<string | undefined> = [];
      for (let i = textOf(p)._start; i; i = i.right) {
        if (!i.deleted && i.content instanceof Y.ContentFormat) out.push(checkFormat(i.content.key, i.content.value)?.rule);
      }
      return out;
    };
    expect(formatsOf()).toContain(rule);
    expect(checkElement(p).ok).toBe(false);
    const updates = updatesOf(doc, () => expect(repairLegacyValues(doc)).toEqual({ attrs: 0, marks: 1, spills: 0, skipped: 0, rules: { [rule]: 1 } }));
    expect(formatsOf()).not.toContain(rule);
    expect(checkElement(p)).toEqual({ ok: true });
    expect(textOf(p).toDelta()).toEqual([
      { insert: 'plain ' },
      { insert: 'bad', attributes: { bold: {} } },
      { insert: ' kept', attributes: { comment: { commentId: 'c1', resolved: false } } },
    ]);
    // Deletion only: the repair's update carries no struct at all.
    expect(updates).toHaveLength(1);
    expect(structsOf(updates[0]).all).toBe(0);
    expect(renderLikeABrowser(doc)).toMatchObject({ deleted: false, threw: false, text: 'plain bad kept' });
  });

  it('a clean document (every node and mark) runs no transaction: no update, no generation bump, an empty report', () => {
    const doc = prosemirrorJSONToYDoc(schema, ALL_NODES_DOC, 'default') as Doc;
    const gen = docGeneration(doc);
    let report: LegacyRepair | undefined;
    expect(updatesOf(doc, () => (report = repairLegacyValues(doc)))).toEqual([]);
    expect(docGeneration(doc)).toBe(gen);
    expect(report).toEqual({ attrs: 0, marks: 0, spills: 0, skipped: 0, rules: {} });
  });

  it('is idempotent: a second run in the same lifetime emits nothing', () => {
    const doc = lifetime(stored((f) => f.insert(0, [table([['100%', 1], [1, 1]]), para(runs(['x', { link: { href: 123 } }]))])));
    expect(updatesOf(doc, () => expect(repairLegacyValues(doc)).toMatchObject({ attrs: 0, marks: 0 }))).toEqual([]);
  });

  it('runs with the skip-store origin', () => {
    const doc = lifetime(stored((f) => f.insert(0, [table([['100%']])])), false);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
    repairLegacyValues(doc);
    expect(origins).toEqual([REPAIR_ORIGIN]);
    expect(REPAIR_ORIGIN).toEqual({ source: 'local', skipStoreHooks: true });
  });

  it('walks iteratively: a legacy value 3000 elements deep is repaired (no recursion)', () => {
    // Built one level per insert into the integrated parent (a prelim tree integrates recursively).
    const row = stored((f) => {
      let parent: Y.XmlFragment = f;
      for (let i = 0; i < 3000; i++) {
        const next = new Y.XmlElement('blockquote');
        parent.insert(0, [next]);
        parent = next;
      }
      parent.insert(0, [para(runs(['deep', { link: { href: 7 } }]))]);
    });
    const doc = lifetime(row, false);
    expect(repairLegacyValues(doc)).toMatchObject({ marks: 1 });
    expect(planLegacyRepair(doc).report).toMatchObject({ marks: 0 });
  });

  it('leaves structure legacy alone: an unknown node and an unknown mark are not value rules', () => {
    const doc = lifetime(stored((f) => f.insert(0, [el('bogusNode'), para(runs(['x', { evilMark: {} }]))])), false);
    expect(updatesOf(doc, () => expect(repairLegacyValues(doc)).toMatchObject({ attrs: 0, marks: 0, skipped: 0 }))).toEqual([]);
  });

  it('a deep legacy format value (the shadow could not encode it): after the repair live encodes, and the guard accepts edits', () => {
    const seed = prosemirrorJSONToYDoc(schema, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'victim text' }] }] }, 'default');
    const placeholder = '{"color":"PLACEHOLDER-781"}';
    const u = new RemoteClient(seed).edit(seed, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 3, { textStyle: { color: 'PLACEHOLDER-781' } }));
    const row = [Y.encodeStateAsUpdate(seed), spliceVarString(u, placeholder, deepJson(100_000))];
    const encodes = (d: Y.Doc) => {
      try {
        Y.encodeStateAsUpdate(d);
        return true;
      } catch {
        return false;
      }
    };
    const edit = (live: Doc) => {
      const c = new RemoteClient(new Y.Doc());
      c.sync(seed);
      return c.edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'x'));
    };
    const control = lifetime(row, false);
    // Control, where this runtime's JSON.stringify recurses (Node 22, CI): live cannot be encoded, so the guard's shadow
    // cannot be built and every frame is refused.
    if (!encodes(control)) {
      const cg = guarded(control);
      expect(cg.send(cg.conn('w'), edit(control))).toBe(REFUSED('shadow-unavailable'));
    }

    const live = lifetime(row);
    const formats: unknown[] = [];
    for (const structs of live.store.clients.values()) {
      for (const s of structs) if (s instanceof Y.Item && !s.deleted && s.content instanceof Y.ContentFormat) formats.push(s.content.value);
    }
    expect(formats.map((v) => checkFormat('textStyle', v))).toEqual(formats.map(() => null)); // the deep value is gone
    expect(encodes(live)).toBe(true);
    const g = guarded(live);
    expect(g.send(g.conn('w'), edit(live))).toBe('applied');
    expect(g.logs.filter((l) => l.startsWith('COLLAB_SHADOW_UNAVAILABLE'))).toEqual([]);
  });
});

describe('#781 legacy repair: an abutting mark run never spills over the repaired run', () => {
  // A link applied inside an existing link (format over format): Yjs leaves no mark end between aa and bb.
  const abutting = () => stored((f) => f.insert(0, [para(formatted('aabbcc', [0, 4, { link: { href: 'x' } }], [2, 2, { link: { href: 123 } }]))]));

  it('[link x]aa [link 123]bb [plain]cc: aa keeps x, bb and cc have no link; every new format passes the rules', () => {
    const doc = lifetime(abutting(), false);
    expect(runsOf(textOf(find(doc, 'paragraph')))).toEqual([
      { insert: 'aa', attributes: { link: { href: 'x' } } },
      { insert: 'bb', attributes: { link: { href: 123 } } },
      { insert: 'cc' },
    ]);
    const updates = updatesOf(doc, () => expect(repairLegacyValues(doc)).toMatchObject({ marks: 1, spills: 1 }));
    expect(runsOf(textOf(find(doc, 'paragraph')))).toEqual([{ insert: 'aa', attributes: { link: { href: 'x' } } }, { insert: 'bbcc' }]);
    const { formats, content } = structsOf(updates[0]);
    expect(content).toBe(0); // format structs only, never text
    expect(formats.length).toBeGreaterThan(0);
    for (const { key, value } of formats) expect(checkFormat(key, value)).toBeNull(); // never the refused value
    expect(checkElement(find(doc, 'paragraph'))).toEqual({ ok: true });
  });

  it('control: deleting the refused format alone lets the x link spill over bb', () => {
    const doc = lifetime(abutting(), false);
    const plan = planLegacyRepair(doc);
    doc.transact((tr) => plan.marks.forEach((item) => item.delete(tr)));
    expect(runsOf(textOf(find(doc, 'paragraph')))).toEqual([{ insert: 'aabb', attributes: { link: { href: 'x' } } }, { insert: 'cc' }]);
  });

  it('two refused runs of one mark in a row, beside a valid one, repair to one plain run', () => {
    const doc = lifetime(
      stored((f) => f.insert(0, [para(formatted('aab1b2cc', [0, 8, { link: { href: 'x' } }], [2, 2, { link: { href: 1 } }], [4, 2, { link: { href: 2 } }], [6, 2, { link: { href: 'y' } }]))])),
      false,
    );
    expect(runsOf(textOf(find(doc, 'paragraph')))).toEqual([
      { insert: 'aa', attributes: { link: { href: 'x' } } },
      { insert: 'b1', attributes: { link: { href: 1 } } },
      { insert: 'b2', attributes: { link: { href: 2 } } },
      { insert: 'cc', attributes: { link: { href: 'y' } } },
    ]);
    expect(repairLegacyValues(doc)).toMatchObject({ marks: 2 });
    expect(runsOf(textOf(find(doc, 'paragraph')))).toEqual([
      { insert: 'aa', attributes: { link: { href: 'x' } } },
      { insert: 'b1b2' },
      { insert: 'cc', attributes: { link: { href: 'y' } } },
    ]);
  });
});

describe('#781 legacy repair across lifetimes: a browser\'s echo of an earlier lifetime is accepted and duplicates nothing', () => {
  const fixtures: Array<[string, () => Uint8Array]> = [
    ['link href a number', () => stored((f) => f.insert(0, [para(runs(['see '], ['here', { link: { href: 123 } }]))]))],
    ['link href a number abutting a valid link (a spill format)', () => stored((f) => f.insert(0, [para(formatted('aabbcc', [0, 4, { link: { href: 'x' } }], [2, 2, { link: { href: 123 } }]))]))],
    ['highlight colorName an object', () => stored((f) => f.insert(0, [para(runs(['hl', { highlight: { color: '#fff', colorName: {} } }], [' text']))]))],
    ["a '100%' span", () => stored((f) => f.insert(0, [table([['100%', 1], [1, 1]])]))],
  ];

  /** Lifetime A repairs and a browser syncs it; the row is never stored; lifetime B loads the same row and repairs. */
  function twoLifetimes(row: Uint8Array, repair: (d: Doc) => void = (d) => repairLegacyValues(d)) {
    const a = lifetime(row, false);
    repair(a);
    const browser = browserOf(a, 4242);
    const b = lifetime(row, false);
    repair(b);
    return { a, b, browser };
  }

  it.each(fixtures)('%s: the Step2 echo and the remount echo are accepted; B equals one repair; no server text or elements', (_n, row) => {
    const { a, b, browser } = twoLifetimes(row());
    const g = guarded(b);
    const writer = g.conn('writer');
    const diff = Y.encodeStateAsUpdate(browser.doc, Y.encodeStateVector(b));
    expect(g.send(writer, diff, SYNC.Step2)).toBe('applied');
    expect(g.send(g.conn('writer'), Y.encodeStateAsUpdate(browser.doc))).toBe('applied'); // y-indexeddb remount echo
    expect(contentOf(b)).toEqual(contentOf(a));
    expect(renderLikeABrowser(b)).toMatchObject({ deleted: false, threw: false, text: renderLikeABrowser(a).text });
    expect(contentStructsBy(b, [a.clientID, b.clientID])).toBe(0);
    expect(contentStructsBy(browser.doc, [a.clientID])).toBe(0);
  });

  it("a '100%' span: the echo of an attribute repair is a pure delete set (zero structs, so no server id is ever bound)", () => {
    const { b, browser } = twoLifetimes(fixtures[3][1]());
    const diff = Y.encodeStateAsUpdate(browser.doc, Y.encodeStateVector(b));
    expect(structsOf(diff).all).toBe(0);
    expect(spansOf(b)).toEqual([[undefined, 1], [1, 1]]);
  });

  it('two writers who both synced lifetime A echo its spill formats in lifetime B: neither is refused foreign-client', () => {
    const row = fixtures[1][1]();
    const { a, b, browser } = twoLifetimes(row);
    const second = browserOf(a, 4343);
    const g = guarded(b);
    expect(g.send(g.conn('w1'), Y.encodeStateAsUpdate(browser.doc, Y.encodeStateVector(b)), SYNC.Step2)).toBe('applied');
    expect(g.send(g.conn('w2'), Y.encodeStateAsUpdate(second.doc, Y.encodeStateVector(b)), SYNC.Step2)).toBe('applied');
    expect(g.send(g.conn('w2'), Y.encodeStateAsUpdate(second.doc))).toBe('applied');
    expect(contentOf(b)).toEqual(contentOf(a));
  });

  it('control: a repair that re-inserts the run (delete + insert) duplicates the text across lifetimes, and the guard lets it through', () => {
    const reinsert = (d: Doc) => {
      d.transact(() => {
        const t = textOf(find(d, 'paragraph'));
        let at = 0;
        const delta = t.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>;
        for (const op of delta) {
          if (op.attributes?.link && checkFormat('link', op.attributes.link)) {
            const { link: _bad, ...rest } = op.attributes;
            t.delete(at, op.insert.length);
            t.insert(at, op.insert, rest);
          }
          at += op.insert.length;
        }
      }, REPAIR_ORIGIN);
    };
    const { a, b, browser } = twoLifetimes(fixtures[0][1](), reinsert);
    expect(renderLikeABrowser(a).text).toBe('see here');
    const g = guarded(b);
    expect(g.send(g.conn('writer'), Y.encodeStateAsUpdate(browser.doc, Y.encodeStateVector(b)), SYNC.Step2)).toBe('applied');
    expect(renderLikeABrowser(b).text).toBe('see herehere'); // the duplicate the delete-only repair exists to prevent
    expect(contentStructsBy(b, [a.clientID, b.clientID])).toBeGreaterThan(0);
  });
});

describe('#781 legacy repair: honest transforms of a repaired page are accepted (control: refused without the repair)', () => {
  const tableRow = (rows: unknown[][]) => stored((f) => f.insert(0, [para(runs(['before'])), table(rows)]));

  it.each([
    ["[['100%',1],[1,1]]", [['100%', 1], [1, 1]], REFUSED('number-attr')],
    ["accumulated zeros [['100%',0,0,1],[1,1,0,0,0,0]]", [['100%', 0, 0, 1], [1, 1, 0, 0, 0, 0]], REFUSED('number-attr')],
    // The legacy table is past the extent bound, so the guard's legacy exemption lets 4999 padding cells through.
    ['a 5000 span [[5000],[1]]', [[5000], [1]], 'applied'],
  ])('fixTables on open, %s: control %p; repaired, accepted once, then converged', (_n, rows, controlOutcome) => {
    // Control: the browser's table plugin derives new spans (colspan 0) or padding from the legacy span.
    const control = lifetime(tableRow(rows), false);
    const cg = guarded(control);
    const controlFrame = openWithTablePlugin(browserOf(control, 7001), control);
    expect(controlFrame).not.toBeNull();
    expect(cg.send(cg.conn('writer'), controlFrame!)).toBe(controlOutcome);
    if (controlOutcome === 'applied') expect(Math.max(...spansOf(control).map((r) => r.length))).toBe(5000);

    const live = lifetime(tableRow(rows));
    const g = guarded(live);
    const client = browserOf(live, 7002);
    const frame = openWithTablePlugin(client, live);
    if (frame) expect(g.send(g.conn('writer'), frame)).toBe('applied');
    // Converged: the next open (any browser) changes nothing, and the table is rectangular.
    expect(openWithTablePlugin(browserOf(live, 7003), live)).toBeNull();
    const pm = initProseMirrorDoc(browserOf(live, 7004).fragment, schema).doc;
    let width = 0;
    pm.descendants((n) => {
      if (n.type.name === 'table') width = TableMap.get(n).width;
      return n.type.name !== 'table';
    });
    expect(width).toBeLessThanOrEqual(6);
    expect(renderLikeABrowser(live)).toMatchObject({ deleted: false, threw: false });
  });

  /** A y-tiptap edit: the browser renders, changes the ProseMirror JSON, and writes it back. */
  function ytiptapEdit(live: Doc, change: (json: any) => void): Uint8Array {
    const client = browserOf(live, 7100);
    const { doc, meta } = initProseMirrorDoc(client.fragment, schema);
    const json = doc.toJSON();
    change(json);
    client.doc.transact(() => updateYFragment(client.doc, client.fragment, PMNode.fromJSON(schema, json), meta as never));
    return Y.encodeStateAsUpdate(client.doc, Y.encodeStateVector(live));
  }

  it('a split paragraph carrying a legacy link: control refused string-attr; repaired, accepted', () => {
    const row = stored((f) => f.insert(0, [para(runs(['hello world', { link: { href: 123 } }]))]));
    const split = (json: any) => {
      const [p] = json.content;
      const marks = p.content[0].marks;
      json.content = [
        { type: 'paragraph', content: [{ type: 'text', text: 'hello ', ...(marks ? { marks } : {}) }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'world', ...(marks ? { marks } : {}) }] },
      ];
    };
    const control = lifetime(row, false);
    expect(guarded(control).send(guarded(control).conn('w'), ytiptapEdit(control, split))).toBe(REFUSED('string-attr'));
    const live = lifetime(row);
    const g = guarded(live);
    expect(g.send(g.conn('w'), ytiptapEdit(live, split))).toBe('applied');
    expect(renderLikeABrowser(live).text).toBe('hello world');
  });

  it("a table recreated (dragged below a paragraph) with a legacy '100%' span: control refused number-attr; repaired, accepted", () => {
    const row = tableRow([['100%'], [1]]);
    const drag = (json: any) => {
      json.content = [json.content[1], json.content[0]];
    };
    const control = lifetime(row, false);
    expect(guarded(control).send(guarded(control).conn('w'), ytiptapEdit(control, drag))).toBe(REFUSED('number-attr'));
    const live = lifetime(row);
    const g = guarded(live);
    expect(g.send(g.conn('w'), ytiptapEdit(live, drag))).toBe('applied');
  });

  it('security non-regression: after the repair, a client writing colspan 0 or "100%" or a numeric href is still refused', () => {
    const live = lifetime(stored((f) => f.insert(0, [table([['100%', 1]]), para(runs(['x', { link: { href: 123 } }]))])));
    const g = guarded(live);
    for (const span of [0, '100%']) {
      const c = new RemoteClient(live);
      const frame = c.edit(live, () => (find(c.doc, 'tableCell') as Y.XmlElement).setAttribute('colspan', span as never));
      expect(g.send(g.conn(`w${span}`), frame)).toBe(REFUSED('number-attr'));
    }
    const c = new RemoteClient(live);
    const frame = c.edit(live, () => textOf(find(c.doc, 'paragraph')).format(0, 1, { link: { href: 123 } }));
    expect(g.send(g.conn('wl'), frame)).toBe(REFUSED('string-attr'));
  });
});

describe('#781 legacy repair wired as the guard extension\'s afterLoadDocument', () => {
  const PAGE = DOC_NAME.replace(/^page\./, '');
  const legacyRow = () => stored((f) => f.insert(0, [table([['100%', 1]]), para(runs(['x', { link: { href: 123 } }]))]));

  it('repairs the loaded document and logs counts and rule names only (never a value)', async () => {
    const lines: string[] = [];
    const ext = new CollabUpdateGuardExtension(undefined, { logger: { warn: (m) => lines.push(m) } });
    const doc = lifetime(legacyRow(), false);
    await expect(ext.afterLoadDocument({ document: doc, documentName: DOC_NAME } as never)).resolves.toBeUndefined();
    expect(planLegacyRepair(doc).report).toMatchObject({ attrs: 0, marks: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('COLLAB_LEGACY_REPAIRED ')).toBe(true);
    expect(JSON.parse(lines[0].slice('COLLAB_LEGACY_REPAIRED '.length))).toEqual({
      pageId: PAGE,
      attrs: 1,
      marks: 1,
      spills: 0,
      skipped: 0,
      rules: { 'number-attr': 1, 'string-attr': 1 },
    });
    expect(lines[0]).not.toContain('100%');
    expect(lines[0]).not.toContain('123');
  });

  it('a clean document logs nothing', async () => {
    const lines: string[] = [];
    const ext = new CollabUpdateGuardExtension(undefined, { logger: { warn: (m) => lines.push(m) } });
    await ext.afterLoadDocument({ document: prosemirrorJSONToYDoc(schema, ALL_NODES_DOC, 'default'), documentName: DOC_NAME } as never);
    expect(lines).toEqual([]);
  });

  it('never rejects: a failing repair resolves, leaves the document as loaded, and logs COLLAB_LEGACY_REPAIR_FAILED', async () => {
    const lines: string[] = [];
    const ext = new CollabUpdateGuardExtension(undefined, {
      logger: { warn: (m) => lines.push(m) },
      repair: () => {
        throw new Error('boom 100%');
      },
    });
    const doc = lifetime(legacyRow(), false);
    await expect(ext.afterLoadDocument({ document: doc, documentName: DOC_NAME } as never)).resolves.toBeUndefined();
    expect(planLegacyRepair(doc).report).toMatchObject({ attrs: 1, marks: 1 }); // as loaded
    expect(lines).toEqual([`COLLAB_LEGACY_REPAIR_FAILED ${JSON.stringify({ pageId: PAGE })}`]);
  });

  it('is rate-limited: a read-only page reloaded 100 times in a minute writes 30 lines', async () => {
    const lines: string[] = [];
    const ext = new CollabUpdateGuardExtension(undefined, { logger: { warn: (m) => lines.push(m) }, now: () => 1_000 });
    for (let i = 0; i < 100; i++) await ext.afterLoadDocument({ document: lifetime(legacyRow(), false), documentName: DOC_NAME } as never);
    expect(lines.filter((l) => l.startsWith('COLLAB_LEGACY_REPAIRED '))).toHaveLength(30);
  });

  it('runs the repair in a later macrotask turn than the load (never in the load apply\'s event-loop block)', async () => {
    const ext = new CollabUpdateGuardExtension(undefined, { logger: { warn: () => undefined } });
    const doc = lifetime(legacyRow(), false);
    const order: string[] = [];
    const done = ext.afterLoadDocument({ document: doc, documentName: DOC_NAME } as never).then(() => order.push('repaired'));
    // Every microtask the hook chain could run drains before a macrotask; the repair has not run yet.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(planLegacyRepair(doc).report).toMatchObject({ attrs: 1, marks: 1 });
    expect(order).toEqual([]);
    await done;
    expect(planLegacyRepair(doc).report).toMatchObject({ attrs: 0, marks: 0 });
  });
});

describe('#781 legacy repair through a REAL Hocuspocus 4.7.1: before any client syncs, and never a store', () => {
  const settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  const open: Hocuspocus[] = [];
  const sockets: FakeSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close(1000, 'test over');
    await settle();
    for (const h of open.splice(0)) h.closeConnections();
    jest.restoreAllMocks();
  });

  async function server(row: Uint8Array, opts: { repair?: boolean; step1?: boolean } = {}) {
    const logs: string[] = [];
    const stores: unknown[] = [];
    const guard = new CollabUpdateGuard({ logger: { warn: (m) => logs.push(m) } });
    const ext = new CollabUpdateGuardExtension(guard, {
      logger: { warn: (m) => logs.push(m) },
      ...(opts.repair === false ? { repair: () => ({ attrs: 0, marks: 0, spills: 0, skipped: 0, rules: {} }) } : {}),
    });
    const hp = new Hocuspocus({
      quiet: true,
      debounce: 5,
      maxDebounce: 10,
      extensions: [
        ext,
        { async onAuthenticate() { return { user: { id: 'writer' } }; } },
        { async onLoadDocument({ document }: { document: Y.Doc }) { Y.applyUpdate(document, row); } },
        // The persistence extension reads `lastContext.user.id`: a store the repair scheduled would have no user.
        { async onStoreDocument({ lastContext }: { lastContext: any }) { stores.push(lastContext?.user?.id ?? '<no user>'); } },
      ],
    } as never);
    open.push(hp);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const sock = new FakeSocket();
    sockets.push(sock);
    sock.connect(hp);
    // With `step1`, the client's Sync Step1 arrives in the same chunk as its auth, while the document is still loading.
    if (opts.step1) sock.deliver(authFrame('t'), syncFrame(Y.encodeStateVector(new Y.Doc()), SYNC.Step1));
    else sock.deliver(authFrame('t'));
    const deadline = Date.now() + 5_000;
    while (!hp.documents.get(DOC_NAME)?.getConnections().length) {
      if (Date.now() > deadline) throw new Error('not connected');
      await new Promise((r) => setTimeout(r, 5));
    }
    await settle();
    return { hp, sock, logs, stores, live: () => hp.documents.get(DOC_NAME)! };
  }

  const row = () => stored((f) => f.insert(0, [table([['100%', 0, 1], [1, 1, 1]]), para(runs(['see '], ['here', { link: { href: 123 } }]))]));

  it('the document a client first syncs is already repaired; no store runs for it; the guard\'s first-build audit sees no legacy value', async () => {
    const s = await server(row());
    const live = s.live();
    expect(planLegacyRepair(live).report).toMatchObject({ attrs: 0, marks: 0 });
    expect(s.logs.filter((l) => l.startsWith('COLLAB_LEGACY_REPAIRED'))).toHaveLength(1);
    // A writer's honest edit builds the guard's shadow (and runs its audit) from the repaired live document.
    const edit = new RemoteClient(live).edit(live, (f) => f.insert(f.length, [para(runs(['typed']))]));
    s.sock.deliver(syncFrame(edit));
    await settle();
    expect(s.sock.closeReasons()).toEqual([]);
    expect(s.logs.filter((l) => l.startsWith('COLLAB_STORED_CONTENT_INVALID'))).toEqual([]);
    await new Promise((r) => setTimeout(r, 40)); // past the debounce
    expect(s.stores).toEqual(['writer']); // the writer's edit stored, the repair with it; nothing stored without a user
  });

  /** The document the client receives: every Sync Step2/Update payload the server sent, applied to an empty replica. */
  function received(sock: FakeSocket): Y.Doc {
    const d = new Y.Doc();
    d.getXmlFragment('default');
    for (const data of sock.sent) {
      const dec = decoding.createDecoder(data);
      decoding.readVarString(dec);
      if (decoding.readVarUint(dec) !== MSG.Sync) continue;
      const subtype = decoding.readVarUint(dec);
      if (subtype === SYNC.Step2 || subtype === SYNC.Update) Y.applyUpdate(d, decoding.readVarUint8Array(dec));
    }
    return d;
  }

  it.each([true, false])(
    "the client's Step1, sent with its auth in one chunk, is answered with the repaired document (repair %p)",
    async (repair) => {
      const s = await server(row(), { repair, step1: true });
      const got = received(s.sock);
      expect(got.getXmlFragment('default').length).toBeGreaterThan(0); // non-vacuity: the Step2 arrived
      if (repair) expect(planLegacyRepair(got).report).toEqual({ attrs: 0, marks: 0, spills: 0, skipped: 0, rules: {} });
      else expect(planLegacyRepair(got).report).toMatchObject({ attrs: 2, marks: 1 }); // control: the stored values
    },
  );

  it('with no edit, nothing is stored (the repair is persisted only by a real store)', async () => {
    const s = await server(row());
    await new Promise((r) => setTimeout(r, 40));
    expect(s.stores).toEqual([]);
  });

  it('control: without the repair the audit reports the stored values as legacy-invalid', async () => {
    const s = await server(row(), { repair: false });
    const live = s.live();
    const edit = new RemoteClient(live).edit(live, (f) => f.insert(f.length, [para(runs(['typed']))]));
    s.sock.deliver(syncFrame(edit));
    await settle();
    expect(s.logs.filter((l) => l.startsWith('COLLAB_STORED_CONTENT_INVALID'))).toHaveLength(1);
  });
});
