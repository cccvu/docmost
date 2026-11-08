// #731 gate: a content write built as Yjs preliminary types (prelim-content.ts) is the SAME Yjs content as the
// `TiptapTransformer.toYdoc` build it replaced — over the real server schema, the real conversion, the repo's own
// Markdown at page scale, every node and mark type, and seeded fuzz. No mocks: real yjs, real y-prosemirror, real
// tiptap schema. A y-prosemirror, tiptap or yjs bump that changes either side turns this red.
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { isDeepStrictEqual } from 'node:util';
import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { markdownToHtml } from '@docmost/editor-ext';
import {
  htmlToJson,
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from '../../collaboration/collaboration.util';
import { buildPrelimContent, serverSchema } from './prelim-content';
import { insertAsOwnClient, prepareContentOperation } from './replace-update';
import { stableHash } from './stable-hash';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: Json[] };
type YNode = Y.XmlElement | Y.XmlText;

/** The reference: the pre-#731 replace build, exactly (toYdoc + encode). */
const referenceUpdate = (json: unknown) => {
  const built = TiptapTransformer.toYdoc(json as never, 'default', tiptapExtensions);
  return { update: Y.encodeStateAsUpdate(built), clientID: built.clientID };
};

/** What a write puts in a document: `elements` inserted in ONE transaction, as applyContentOperation does. */
const insertInto = (doc: Y.Doc, elements: YNode[], at = 0) =>
  doc.transact(() => {
    if (elements.length > 0) doc.getXmlFragment('default').insert(at, elements);
  });

const decoded = (update: Uint8Array) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, update);
  return d;
};

/** The Yjs tree: node names, element attributes, and each text's delta WITH its formatting attributes. */
const shape = (t: Y.XmlFragment | YNode): unknown =>
  t instanceof Y.XmlText
    ? { delta: t.toDelta() }
    : t instanceof Y.XmlElement
      ? { name: t.nodeName, attrs: t.getAttributes(), children: t.toArray().map((c) => shape(c as YNode)) }
      : { children: t.toArray().map((c) => shape(c as YNode)) };

const fromYdoc = (d: Y.Doc) => TiptapTransformer.fromYdoc(d, 'default');

/** Everything the parity gate compares between two documents; `[]` when they hold the same content. */
function differences(a: Y.Doc, b: Y.Doc): string[] {
  const out: string[] = [];
  if (!isDeepStrictEqual(shape(a.getXmlFragment('default')), shape(b.getXmlFragment('default')))) out.push('tree');
  const ja = fromYdoc(a);
  const jb = fromYdoc(b);
  if (!isDeepStrictEqual(ja, jb)) out.push('fromYdoc');
  if (stableHash(ja) !== stableHash(jb)) out.push('digest');
  return out;
}

/** The full gate for one document's JSON; returns the failures (an empty list = parity). */
function parityFailures(json: unknown): string[] {
  const fails: string[] = [];
  let ref: ReturnType<typeof referenceUpdate> | undefined;
  let refErr: unknown;
  try {
    ref = referenceUpdate(json);
  } catch (e) {
    refErr = e;
  }
  let elements: YNode[] | undefined;
  let mineErr: unknown;
  try {
    elements = buildPrelimContent(json);
  } catch (e) {
    mineErr = e;
  }
  // Every fixture must build: a document both sides reject proves nothing here (rejections have their own case).
  if (!ref || !elements) return [`rejected (ref ${String(refErr)}, mine ${String(mineErr)})`];

  // 1. A fresh document with the reference's clientID: the encoded update is byte-identical.
  const fresh = new Y.Doc();
  fresh.clientID = ref.clientID;
  insertInto(fresh, elements);
  if (!Buffer.from(Y.encodeStateAsUpdate(fresh)).equals(Buffer.from(ref.update))) fails.push('update bytes');

  // 2. A LIVE replace (delete + one insert vs delete + applyUpdate, as before #731) over existing content: the
  //    same tree, JSON and digest — and the new document reloads (encode → decode) to the same JSON and digest.
  const seed = TiptapTransformer.toYdoc(
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before' }] }] } as never,
    'default',
    tiptapExtensions,
  );
  const live = (apply: (d: Y.Doc) => void) => {
    const d = decoded(Y.encodeStateAsUpdate(seed));
    d.transact(() => {
      const f = d.getXmlFragment('default');
      f.delete(0, f.length);
      apply(d);
    });
    return d;
  };
  const before = live((d) => Y.applyUpdate(d, ref.update));
  const after = live((d) => insertAsOwnClient(d, d.getXmlFragment('default'), buildPrelimContent(json)));
  fails.push(...differences(before, after).map((d) => `live ${d}`));
  // …and, as the update did, no new top-level node names a right origin (each would be ~6 more bytes, kept forever).
  for (let item = after.getXmlFragment('default')._start; item; item = item.right) {
    if (!item.deleted && item.rightOrigin !== null) {
      fails.push('live right origin');
      break;
    }
  }
  fails.push(...differences(after, decoded(Y.encodeStateAsUpdate(after))).map((d) => `reload ${d}`));

  // 3. An APPEND of the same content after existing content holds what the reference build holds for those nodes.
  const appended = decoded(Y.encodeStateAsUpdate(seed));
  insertInto(appended, buildPrelimContent(json), appended.getXmlFragment('default').length);
  const refDoc = decoded(ref.update);
  const tail = appended.getXmlFragment('default').toArray().slice(1);
  if (!isDeepStrictEqual(tail.map((t) => shape(t as YNode)), refDoc.getXmlFragment('default').toArray().map((t) => shape(t as YNode)))) {
    fails.push('append tree');
  }
  const expectAppended = { type: 'doc', content: [...fromYdoc(seed).content, ...fromYdoc(refDoc).content] };
  if (!isDeepStrictEqual(fromYdoc(appended), expectAppended)) fails.push('append fromYdoc');
  fails.push(...differences(appended, decoded(Y.encodeStateAsUpdate(appended))).map((d) => `append reload ${d}`));
  return fails;
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────

const REPO = resolve(__dirname, '../../../../..');

/** The fork's own Markdown, repeated to page scale (≈ the A1 legit fixture: ~990 KB, ~40k nodes). */
function repoMarkdown(targetBytes: number): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (['node_modules', '.git', 'dist', 'build', 'ee'].includes(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md')) files.push(full);
    }
  };
  walk(REPO);
  const corpus = files.map((f) => readFileSync(f, 'utf8')).join('\n\n');
  let out = '';
  while (out.length < targetBytes) out += corpus + '\n\n';
  return out.slice(0, targetBytes);
}

const countNodes = (j: Json): number => 1 + (j.content || []).reduce((n, c) => n + countNodes(c), 0);

/** A seeded PRNG (mulberry32), so a failure reproduces from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)] };
}

/** Random HTML exercising the server schema's blocks and marks (nested, adjacent, with attributes). */
function fuzzHtml(seed: number): string {
  const r = rng(seed);
  const word = () => r.pick(['alpha', 'beta', 'γάμμα', 'delta 😀', 'é', 'x  y', 'tab\tend', '<&>']);
  const inline = (depth: number): string => {
    const parts: string[] = [];
    const n = 1 + r.int(5);
    for (let i = 0; i < n; i++) {
      const w = word();
      const wraps = [
        (s: string) => `<strong>${s}</strong>`,
        (s: string) => `<em>${s}</em>`,
        (s: string) => `<u>${s}</u>`,
        (s: string) => `<s>${s}</s>`,
        (s: string) => `<code>${s}</code>`,
        (s: string) => `<sup>${s}</sup>`,
        (s: string) => `<sub>${s}</sub>`,
        (s: string) => `<a href="https://example.com/${r.int(9)}">${s}</a>`,
        (s: string) => `<mark data-color="#fef08a">${s}</mark>`,
        (s: string) => `<span style="color: #958df1">${s}</span>`,
        (s: string) => `<span style="font-size: 20px; font-family: serif">${s}</span>`,
        (s: string) => `${s}<br>`,
        (s: string) => s,
      ];
      let s = w;
      if (depth < 3 && r.next() < 0.3) s = inline(depth + 1);
      const k = r.int(3);
      for (let j = 0; j < k; j++) s = r.pick(wraps)(s);
      parts.push(s);
    }
    return parts.join(r.pick([' ', '', '. ']));
  };
  const block = (depth: number): string => {
    const kinds = [
      () => `<p>${inline(0)}</p>`,
      () => `<p style="text-align: center">${inline(0)}</p>`,
      () => `<h${1 + r.int(6)}>${inline(0)}</h${1}>`,
      () => `<blockquote>${block(depth + 1)}</blockquote>`,
      () => `<pre><code class="language-ts">${word()}\n${word()}\n</code></pre>`,
      () => `<ul>${[0, 1, 2].map(() => `<li><p>${inline(0)}</p>${depth < 2 && r.next() < 0.3 ? `<ul><li><p>${inline(0)}</p></li></ul>` : ''}</li>`).join('')}</ul>`,
      () => `<ol start="${1 + r.int(5)}"><li><p>${inline(0)}</p></li><li><p>${inline(0)}</p></li></ol>`,
      () => `<ul data-type="taskList"><li data-type="taskItem" data-checked="${r.next() < 0.5}"><p>${inline(0)}</p></li></ul>`,
      () => `<table><tr><th><p>${word()}</p></th><th><p>${word()}</p></th></tr><tr><td colspan="2"><p>${inline(0)}</p></td></tr></table>`,
      () => `<hr>`,
      () => `<details><summary>${word()}</summary><div data-type="detailsContent"><p>${inline(0)}</p></div></details>`,
      () => `<div data-type="callout" data-callout-type="warning"><p>${inline(0)}</p></div>`,
      () => `<p><span data-type="mention" data-id="m${r.int(9)}" data-label="${word()}" data-entity-type="user" data-entity-id="u${r.int(9)}">@x</span> ${word()}</p>`,
      () => `<p>${word()}<span data-type="mathInline" data-katex="true">x^${r.int(9)}</span></p>`,
      () => `<img src="/files/${r.int(9)}.png" alt="${word()}" width="${100 + r.int(200)}">`,
    ];
    return depth > 3 ? `<p>${word()}</p>` : r.pick(kinds)();
  };
  return Array.from({ length: 5 + r.int(20) }, () => block(0)).join('\n');
}

/** API-authored JSON shapes the parser never produces: missing attrs, adjacent text runs, explicit nulls, odd values. */
function fuzzJson(seed: number): Json {
  const r = rng(seed);
  const markSets: Json[][] = [
    [],
    [{ type: 'bold' }],
    [{ type: 'bold' }, { type: 'italic' }],
    [{ type: 'link', attrs: { href: `https://e.com/${r.int(9)}` } }],
    [{ type: 'link', attrs: { href: 'https://e.com/x', target: null } }, { type: 'code' }],
    [{ type: 'textStyle', attrs: { color: '#f00', fontSize: '18px' } }],
    [{ type: 'highlight', attrs: { color: '#ff0' } }],
    [{ type: 'comment', attrs: { commentId: `c${r.int(9)}`, resolved: r.next() < 0.5 } }],
  ];
  const text = (): Json[] =>
    Array.from({ length: 1 + r.int(6) }, () => ({ type: 'text', text: r.pick(['a', 'bb', 'c c', ' ', 'z']), marks: r.pick(markSets) })).map(
      (t) => (t.marks && t.marks.length ? t : { type: 'text', text: t.text }),
    );
  const para = (): Json => {
    const p: Json = { type: 'paragraph', content: text() };
    const v = r.int(4);
    if (v === 1) p.attrs = { id: `p${r.int(99)}` };
    if (v === 2) p.attrs = { id: null, textAlign: 'right', indent: 2 };
    if (v === 3) p.attrs = { unknownAttr: { nested: [1, 'two', { three: 3.5 }] } };
    return p;
  };
  const nodes = (): Json => {
    const k = r.int(6);
    if (k === 0) return { type: 'heading', attrs: { level: 1 + r.int(6) }, content: text() };
    if (k === 1) return { type: 'bulletList', content: [{ type: 'listItem', content: [para()] }] };
    if (k === 2) return { type: 'codeBlock', attrs: { language: r.pick([null, 'js', 'plain']) }, content: [{ type: 'text', text: 'let x = 1\n' }] };
    if (k === 3) return { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth: [120], colspan: 1 }, content: [para()] }] }] };
    if (k === 4) return { type: 'paragraph' };
    return para();
  };
  return { type: 'doc', content: Array.from({ length: 1 + r.int(12) }, nodes) };
}

/** Every node type of the server schema, filled to validity, and every mark type over text. */
function schemaSweep(): Json[] {
  const schema = serverSchema();
  const docs: Json[] = [];
  for (const type of Object.values(schema.nodes)) {
    if (type.name === 'doc' || type.name === 'text') continue;
    const node = type.createAndFill();
    if (!node) continue;
    const doc = schema.nodes.doc.createAndFill(null, type.isInline ? schema.nodes.paragraph.create(null, node) : node);
    if (doc) docs.push(doc.toJSON());
  }
  for (const mark of Object.values(schema.marks)) {
    docs.push({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain ' },
            { type: 'text', text: 'marked', marks: [mark.create().toJSON()] },
            { type: 'text', text: ' plain' },
          ],
        },
      ],
    });
  }
  return docs;
}

const digestVectors = (): unknown[] =>
  (JSON.parse(readFileSync(join(__dirname, 'content-digest-vectors.json'), 'utf8')).vectors as Array<{ value: unknown }>)
    .map((v) => v.value)
    .filter((v) => v && typeof v === 'object' && (v as Json).type === 'doc');

// ── The gate ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('#731 a content write built as preliminary Yjs types equals the toYdoc build', () => {
  it('the server schema has no self-overlapping mark (the one y-prosemirror case the build refuses)', () => {
    const schema = serverSchema();
    const overlapping = Object.values(schema.marks).filter((m) => !m.excludes(m)).map((m) => m.name);
    expect(Object.keys(schema.marks).length).toBeGreaterThan(5); // anti-vacuity
    expect(overlapping).toEqual([]);
  });

  it('the repo Markdown at page scale, through the real conversion (~40k nodes)', async () => {
    const json = htmlToJson(await markdownToHtml(repoMarkdown(990_000))) as Json;
    expect(countNodes(json)).toBeGreaterThan(30_000);
    const types = new Set<string>();
    const marks = new Set<string>();
    const visit = (j: Json) => (types.add(j.type), j.marks?.forEach((m) => marks.add(m.type)), j.content?.forEach(visit));
    visit(json);
    expect(types.size).toBeGreaterThan(10); // headings, lists, tables, code blocks … — not just paragraphs
    expect(marks.size).toBeGreaterThanOrEqual(3);
    expect(parityFailures(json)).toEqual([]);
  }, 120_000);

  it('every node type and every mark type of the server schema', () => {
    const docs = schemaSweep();
    expect(docs.length).toBeGreaterThan(40);
    const failures = docs.map((d, i) => ({ i, type: d.content?.[0]?.type, f: parityFailures(d) })).filter((x) => x.f.length);
    expect(failures).toEqual([]);
  });

  it('the existing spec fixtures (content-digest-vectors.json)', () => {
    const docs = digestVectors();
    expect(docs.length).toBeGreaterThanOrEqual(3);
    for (const d of docs) expect(parityFailures(d)).toEqual([]);
  });

  it('seeded fuzz: parsed HTML (200 seeds) and API-authored JSON (300 seeds)', async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const json = htmlToJson(fuzzHtml(seed));
      const f = parityFailures(json);
      if (f.length) failures.push(`html seed ${seed}: ${f.join(', ')}`);
    }
    for (let seed = 1; seed <= 300; seed++) {
      const f = parityFailures(fuzzJson(seed));
      if (f.length) failures.push(`json seed ${seed}: ${f.join(', ')}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('one JSON value shared by two nodes is stored as two values, as a decoded document holds it', () => {
    // A worker reply (structured clone) or a schema default can hand the same object to several nodes; the live
    // document must not keep the sharing, or its digest (`stableHash` collapses a repeated object) differs from the
    // same page reloaded.
    const colwidth = [120];
    const cell = { type: 'tableCell', attrs: { colwidth }, content: [{ type: 'paragraph' }] };
    const json = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell, { ...cell }] }] }] };
    expect(parityFailures(json)).toEqual([]);
  });

  it('a lone surrogate (half an emoji) is stored as U+FFFD, as a decoded document holds it — never raw', () => {
    // A raw lone surrogate in the LIVE document puts one in its `fromYdoc` JSON, which Postgres jsonb refuses on every
    // store until the page unloads (#731 review). Yjs's encoder writes U+FFFD for text and attribute values, so the
    // reference build never held one there; compare against it exactly. Byte-level parity alone cannot see this: the
    // encoder repairs the string on the way out. `parityFailures`' live comparison (in-memory vs decoded) does.
    const lone = ['\ud83d', 'a\ude00b', 'x\ud83d', '\ude00\ud83d'];
    const allWellFormed = (v: unknown): boolean =>
      typeof v === 'string'
        ? (v as string & { isWellFormed(): boolean }).isWellFormed()
        : Array.isArray(v)
          ? v.every(allWellFormed)
          : v !== null && typeof v === 'object'
            ? Object.entries(v).every(([k, x]) => allWellFormed(k) && allWellFormed(x))
            : true;
    const liveJson = (json: unknown) => {
      const d = new Y.Doc();
      insertInto(d, buildPrelimContent(json));
      return fromYdoc(d);
    };
    for (const t of lone) {
      // Text (one Y.XmlText run, with and without formatting) and element attribute values.
      const json = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: `p ${t}` }, { type: 'text', text: t, marks: [{ type: 'bold' }] }] },
          { type: 'codeBlock', attrs: { language: t }, content: [{ type: 'text', text: t }] },
          { type: 'heading', attrs: { level: 2, id: `h${t}` }, content: [{ type: 'text', text: 'h' }] },
        ],
      };
      expect([t, parityFailures(json)]).toEqual([t, []]);
      expect(allWellFormed(liveJson(json))).toBe(true);
    }
    // A FORMAT value (a mark's attributes) is written as escaped JSON, so the reference round trip KEEPS a lone
    // surrogate there — the same poison. The build normalizes it: what it holds is the reference build of the
    // well-formed input.
    const linked = (href: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'l', marks: [{ type: 'link', attrs: { href } }] }] }],
    });
    expect(allWellFormed(fromYdoc(decoded(referenceUpdate(linked('https://e.com/\ud83d')).update)))).toBe(false); // the old poison
    expect(allWellFormed(liveJson(linked('https://e.com/\ud83d')))).toBe(true);
    expect(liveJson(linked('https://e.com/\ud83d'))).toEqual(fromYdoc(decoded(referenceUpdate(linked('https://e.com/�')).update)));
    expect(parityFailures(linked('https://e.com/�'))).toEqual([]);
  });

  it('replace, append and prepend all build through it (one definition of the content a write inserts)', () => {
    const json = htmlToJson('<p>a <strong>b</strong> <a href="https://e.com">c</a></p><ul><li><p>d</p></li></ul>') as Json;
    const ref = decoded(referenceUpdate(json).update);
    for (const op of ['replace', 'append', 'prepend']) {
      const prepared = prepareContentOperation(json, op);
      const d = new Y.Doc();
      insertInto(d, prepared.elements);
      expect([op, differences(ref, d)]).toEqual([op, []]);
    }
    expect(prepareContentOperation(null, 'append').elements).toEqual([]); // an append of nothing inserts nothing
    expect(() => prepareContentOperation(null, 'replace')).toThrow();
  });

  it('insertAsOwnClient: a replace\'s structs get ONE fresh client id, and the document\'s own id is back afterwards', () => {
    const d = decoded(referenceUpdate(htmlToJson('<p>old</p>')).update);
    const own = d.clientID;
    const before = new Set(d.store.clients.keys());
    d.transact(() => {
      insertAsOwnClient(d, d.getXmlFragment('default'), buildPrelimContent(htmlToJson('<p>a <em>b</em></p><p>c</p>')));
      expect(d.clientID).toBe(own); // restored inside the transaction: later writes in it (the #429 key) use it
      d.getMap('ledger').set('k', 1);
    });
    const added = [...d.store.clients.keys()].filter((c) => !before.has(c));
    expect(added).toHaveLength(2); // the replace's client, and the document's own (the map write)
    expect(added).toContain(own);
    expect(d.clientID).toBe(own);
    // A throw while inserting (an already-integrated type) still restores the id.
    const used = buildPrelimContent(htmlToJson('<p>x</p>'));
    d.transact(() => insertAsOwnClient(d, d.getXmlFragment('default'), used));
    expect(() => d.transact(() => insertAsOwnClient(d, d.getXmlFragment('default'), used))).toThrow();
    expect(d.clientID).toBe(own);
    insertAsOwnClient(d, d.getXmlFragment('default'), []); // nothing to insert: no id is spent
    expect(d.clientID).toBe(own);
  });

  it('rejects what toYdoc rejects, before touching anything', () => {
    for (const bad of [
      null,
      { type: 'doc', content: [{ type: 'noSuchNode' }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'noSuchMark' }] }] }] },
    ]) {
      expect(() => referenceUpdate(bad)).toThrow();
      expect(() => buildPrelimContent(bad)).toThrow();
    }
  });

  it('anti-vacuity: the gate tells the pre-#731 append builder (prosemirrorNodeToYElement) apart', () => {
    // That builder kept one Y.XmlText per text node, `true` for a mark without attributes, and no schema defaults.
    const json = htmlToJson('<p>plain <strong>bold</strong> <a href="https://e.com">link</a></p>') as Json;
    const ref = decoded(referenceUpdate(json).update);
    const old = new Y.Doc();
    insertInto(old, (json.content || []).map((n) => prosemirrorNodeToYElement(n)));
    expect(differences(ref, old)).toEqual(expect.arrayContaining(['tree', 'fromYdoc']));
    // …and a build that shares ProseMirror's attrs objects (no decoded-value copies) is told apart by the digest.
    const shared = TiptapTransformer.toYdoc(
      { type: 'doc', content: [1, 2].map(() => ({ type: 'paragraph', content: [{ type: 'text', text: 'b', marks: [{ type: 'bold' }] }] })) } as never,
      'default',
      tiptapExtensions,
    );
    expect(differences(decoded(Y.encodeStateAsUpdate(shared)), shared)).toContain('digest');
  });
});
