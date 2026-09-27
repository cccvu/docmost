/**
 * #626: `addUniqueIds` must give exactly what upstream `addUniqueIdsToDoc` gives, without its O(n²) cost.
 *
 * Equivalence is checked with a deterministic `generateID` that records the node type, its position and the call
 * order, so the same ids mean the same nodes, visited in the same order at the same positions.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`src/authz src/service-bridge src/editor-compat …`).
 */
import { addUniqueIdsToDoc, UniqueID } from '@docmost/editor-ext';
import type { Extensions, JSONContent } from '@tiptap/core';
import { tiptapExtensions } from '../collaboration/collaboration.util';
import { generateJSON } from '../common/helpers/prosemirror/html';
import { addUniqueIds } from './unique-ids';

const ID_TYPES = ['heading', 'paragraph', 'transclusionSource'];

/** The server's extensions, with `generateID` swapped for a counter that names the node and its position. */
const deterministic = (): Extensions => {
  let n = 0;
  return tiptapExtensions.map((ext) =>
    ext.name === 'uniqueID'
      ? UniqueID.configure({ types: ID_TYPES, generateID: ({ node, pos }) => `${node.type.name}@${pos}#${n++}` })
      : ext,
  );
};

const RICH_HTML = [
  '<h1>Title</h1>',
  '<p>Intro with <b>bold</b> and <a href="https://example.com">a link</a>.</p>',
  '<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li><li><p>two</p></li></ul>',
  '<ol><li><p>first</p></li></ol>',
  '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li></ul>',
  '<table><tr><th><p>h</p></th><th><p>h2</p></th></tr><tr><td><p>c1</p></td><td><p>c2</p></td></tr></table>',
  '<blockquote><p>quoted</p><h3>quoted heading</h3></blockquote>',
  '<div data-type="callout" data-callout-type="info"><p>callout</p></div>',
  '<details><summary>s</summary><div data-type="detailsContent"><p>hidden</p></div></details>',
  '<div data-type="transclusionSource"><p>shared</p></div>',
  '<pre><code>code</code></pre>',
  '<hr>',
  '<p></p>',
].join('');

describe('#626 addUniqueIds matches upstream addUniqueIdsToDoc', () => {
  const cases: Array<[string, JSONContent]> = [
    ['a rich document (lists, tables, task lists, callouts, details, transclusion)', generateJSON(RICH_HTML, tiptapExtensions)],
    ['an empty doc', { type: 'doc', content: [] }],
    ['a doc with nothing that takes an id', generateJSON('<pre><code>x</code></pre><hr>', tiptapExtensions)],
  ];

  it.each(cases)('%s', (_name, doc) => {
    const upstream = addUniqueIdsToDoc(structuredClone(doc), deterministic());
    const ours = addUniqueIds(structuredClone(doc), deterministic());
    expect(ours).toEqual(upstream);
  });

  it('gives an id to every heading, paragraph and transclusion source, including nested ones', () => {
    const out = addUniqueIds(generateJSON(RICH_HTML, tiptapExtensions), deterministic());
    const missing: string[] = [];
    const walk = (n: JSONContent) => {
      if (ID_TYPES.includes(n.type ?? '') && !n.attrs?.id) missing.push(n.type!);
      n.content?.forEach(walk);
    };
    walk(out);
    expect(missing).toEqual([]);
    expect(JSON.stringify(out)).toContain('"id":"transclusionSource@');
  });

  it('keeps an id a node already has, exactly as upstream does', () => {
    const doc = generateJSON('<h2>kept</h2><p>new</p><ul><li><p>kept too</p></li></ul>', tiptapExtensions);
    doc.content[0].attrs.id = 'existing-heading';
    doc.content[2].content[0].content[0].attrs.id = 'existing-nested';
    const ours = addUniqueIds(structuredClone(doc), deterministic());
    expect(ours).toEqual(addUniqueIdsToDoc(structuredClone(doc), deterministic()));
    expect(ours.content![0].attrs!.id).toBe('existing-heading');
    expect(ours.content![2].content![0].content![0].attrs!.id).toBe('existing-nested');
  });

  it('does not change its input', () => {
    const doc = generateJSON('<p>a</p><p>b</p>', tiptapExtensions);
    const before = structuredClone(doc);
    addUniqueIds(doc, tiptapExtensions);
    expect(doc).toEqual(before);
  });

  it('refuses extensions without UniqueID, like upstream', () => {
    const without = tiptapExtensions.filter((ext) => ext.name !== 'uniqueID');
    expect(() => addUniqueIds({ type: 'doc', content: [] }, without)).toThrow(
      'UniqueID extension not found in the extensions array',
    );
  });
});

describe('#626 addUniqueIds is linear', () => {
  it('50,000 sibling paragraphs get distinct ids in well under the old cost (upstream: minutes, or out of memory)', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: Array.from({ length: 50_000 }, () => ({ type: 'paragraph', content: [{ type: 'text', text: 'x' }] })),
    };
    const started = Date.now();
    const out = addUniqueIds(doc, tiptapExtensions);
    // Upstream copies the 50k-entry sibling array once per paragraph (2.5 billion copies) and keeps every copy.
    expect(Date.now() - started).toBeLessThan(5_000);
    const ids = new Set(out.content!.map((p) => p.attrs!.id));
    expect(ids.size).toBe(50_000);
    expect(ids.has(undefined)).toBe(false);
  });
});
