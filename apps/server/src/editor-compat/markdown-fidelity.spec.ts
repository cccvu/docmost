/**
 * CCC #145 — Markdown round-trip fidelity. Fork-owned.
 *
 * Every Markdown reader (REST/MCP `format=markdown`, the native/MCP export, Copy as Markdown, the clipboard) goes
 * through editor-ext `htmlToMarkdown`, and every Markdown writer (REST/MCP writes, import, paste) through
 * `markdownToHtml`. These pin, through the real server paths (`jsonToMarkdown`, `htmlToJson`), that:
 *  - a table's `<colgroup>` no longer invents an empty header row (string AND DOM-node input);
 *  - `==text==` reads back as a highlight, and ordinary `==` in text and code does not;
 *  - underline stays lossy on Markdown (ADR 0012 §4);
 *  - a task item keeps its links, code and nested tasks, tight;
 *  - `<details>` converts its children without a new jsdom per child, with the same output as before;
 *  - a literal `<br>` in code survives, while a multi-paragraph table cell still exports on one line.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`src/editor-compat`).
 */
import { createRequire } from 'node:module';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { htmlToMarkdown, markdownToHtml } from '@docmost/editor-ext';
import { htmlToJson, jsonToHtml, jsonToMarkdown } from '../collaboration/collaboration.util';
import { htmlToMarkdownReleasingDom } from './html-to-markdown';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: Json[] };

const text = (t: string, marks?: Json[]): Json => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: Json[]): Json => ({ type: 'paragraph', content });
const doc = (...content: Json[]): Json => ({ type: 'doc', content });
const md = (markdown: string): string => markdownToHtml(markdown) as string;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
/** Heap after a full GC, without yielding to the event loop (see html-to-markdown.spec.ts). */
function heapAfterGc(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

/** Every node of a type in a ProseMirror JSON tree. */
function findAll(node: Json, type: string, out: Json[] = []): Json[] {
  if (node.type === type) out.push(node);
  for (const child of node.content ?? []) findAll(child, type, out);
  return out;
}
const marksOf = (node: Json): string[] => findAll(node, 'text').flatMap((t) => (t.marks ?? []).map((m) => m.type));

/** The jsdom that Turndown (through editor-ext) uses, as html-to-markdown.ts resolves it. */
function turndownJsdom(): new (html: string) => {
  window: { document: { getElementById(id: string): any; querySelectorAll(s: string): ArrayLike<unknown> }; close(): void };
} {
  const fromEditorExt = createRequire(require.resolve('@docmost/editor-ext'));
  const fromTurndown = createRequire(fromEditorExt.resolve('@joplin/turndown/package.json'));
  return fromTurndown('jsdom').JSDOM;
}

describe('colgroup — no phantom header row (#145)', () => {
  const cell = (type: 'tableHeader' | 'tableCell', t: string): Json => ({ type, content: [para(text(t))] });
  const headerTable = doc({
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('tableHeader', 'H1'), cell('tableHeader', 'H2')] },
      { type: 'tableRow', content: [cell('tableCell', 'a'), cell('tableCell', 'b')] },
    ],
  });
  const expected = '| H1  | H2  |\n| --- | --- |\n| a   | b   |';

  it('the HTML really carries a <colgroup> before the <tbody> (the trigger)', () => {
    expect(jsonToHtml(headerTable)).toMatch(/<colgroup>.*<\/colgroup><tbody>/);
  });

  it('jsonToMarkdown (REST/MCP format=markdown, a DOM-node input) keeps the real header', () => {
    expect(jsonToMarkdown(headerTable)).toBe(expected);
  });

  it('htmlToMarkdown on a string (Copy as Markdown, clipboard) keeps the real header, same as the DOM path', () => {
    const html = jsonToHtml(headerTable);
    expect(htmlToMarkdown(html)).toBe(expected);
    expect(htmlToMarkdownReleasingDom(html)).toBe(htmlToMarkdown(html));
  });

  it('round-trips: the header row comes back as tableHeader cells', () => {
    const back = htmlToJson(md(jsonToMarkdown(headerTable))) as Json;
    const rows = findAll(back, 'tableRow');
    expect(rows).toHaveLength(2);
    expect(rows[0].content?.map((c) => c.type)).toEqual(['tableHeader', 'tableHeader']);
    expect(rows[1].content?.map((c) => c.type)).toEqual(['tableCell', 'tableCell']);
  });

  it('a DOM node it does not own is not mutated (it strips a clone)', () => {
    const JSDOM = turndownJsdom();
    const dom = new JSDOM(`<div id="r">${jsonToHtml(headerTable)}</div>`);
    try {
      const root = dom.window.document.getElementById('r');
      expect(htmlToMarkdown(root)).toBe(expected);
      expect(dom.window.document.querySelectorAll('colgroup')).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });
});

describe('==highlight== re-import (#145)', () => {
  it.each([
    ['==hi==', '<mark>hi</mark>'],
    ['say ==hi== there', 'say <mark>hi</mark> there'],
    ['(==hi==)', '(<mark>hi</mark>)'],
    ['==two words==', '<mark>two words</mark>'],
    ['==**b** [l](https://e.org/x)==', '<mark><strong>b</strong> <a href="https://e.org/x">l</a></mark>'],
    ['**==b==**', '<strong><mark>b</mark></strong>'],
    ['==a `b==` c==', '<mark>a <code>b==</code> c</mark>'],
    ['==x== and ==y==', '<mark>x</mark> and <mark>y</mark>'],
    ['==a \\== b==', '<mark>a == b</mark>'], // an escaped `==` does not close
    ['==a`==`` b', '<mark>a`</mark>`` b'], // a longer backtick run does not close a shorter one
    ['==a ==b==', '==a <mark>b</mark>'], // the closer search stops at the next opener
  ])('%s highlights', (input, html) => {
    expect(md(input)).toBe(`<p>${html}</p>\n`);
  });

  it('inside a table cell', () => {
    expect(md('| h |\n| --- |\n| ==z== |')).toContain('<td><mark>z</mark></td>');
  });

  it.each([
    'a == b',
    'if a==b and c==d',
    'a==b==',
    'foo==bar==baz',
    '==x==y',
    '== x ==',
    '==x ==',
    '===',
    '====',
    'a === b === c',
    '===x===',
    '==x===',
    '\\==x==',
    '`a==b==c`',
    '`==x==`',
    '```\n==x==\n```',
    'para\n\n    ==x== indented code',
  ])('%j does not highlight', (input) => {
    expect(md(input)).not.toContain('<mark');
  });

  // Review of PR 754: the reader was quadratic (every unclosed opener rescanned to the end of the paragraph), so
  // ~120 KB of Markdown held the one shared conversion worker past its 7 s deadline. A wall-clock budget flakes on a
  // loaded runner, so each input is measured against work done in the same moment: stock marked on the same input
  // (marked has its own cost on code-span-heavy text) plus our reader on a benign input of the same length and
  // shape (every highlight closes). Linear, the input stays within a small multiple of that; quadratic, it was 30–1000x.
  const stockMarked = new (createRequire(require.resolve('@docmost/editor-ext'))('marked').Marked)();
  const fastest = (convert: (s: string) => unknown, input: string): number =>
    Math.min(
      ...[0, 1].map(() => {
        const started = performance.now();
        convert(input);
        return performance.now() - started;
      }),
    );
  it.each([
    ['==a ', 30_000],
    ['(==a ', 24_000],
    ['a==b `c` ', 20_000],
    ['a == b `c` ', 12_000],
    ['==a `', 20_000],
    // Larger: reading the previous token's growing `raw` copied the whole run per `==`, quadratic past ~300 KB.
    ['==a ', 120_000],
    ['a==b ', 100_000],
  ])('%j × %i stays linear', (unit, times) => {
    const input = unit.repeat(times);
    const benign = '==x== '.repeat(Math.ceil(input.length / 6));
    const reference = fastest((s) => stockMarked.parse(s), input) + fastest(md, benign);
    expect(fastest(md, input)).toBeLessThan(4 * reference + 20);
  }, 60_000);

  it('round-trips through the real paths; the colour is lossy (ADR 0012 §4)', () => {
    const colored = doc(para(text('a '), text('hi', [{ type: 'highlight', attrs: { color: '#ffd43b' } }]), text(' b')));
    const markdown = jsonToMarkdown(colored);
    expect(markdown).toBe('a ==hi== b');
    const back = htmlToJson(md(markdown)) as Json;
    const hi = findAll(back, 'text').find((t) => t.text === 'hi');
    expect(hi?.marks?.map((m) => m.type)).toEqual(['highlight']);
    expect(hi?.marks?.[0].attrs?.color || null).toBeNull(); // no colour comes back (null or '')
  });
});

describe('underline stays lossy on Markdown (ADR 0012 §4, owner decision #145)', () => {
  it('<u>x</u> exports as plain x — no HTML-in-Markdown', () => {
    expect(htmlToMarkdown('<p><u>x</u></p>')).toBe('x');
    const markdown = jsonToMarkdown(doc(para(text('under', [{ type: 'underline' }]))));
    expect(markdown).toBe('under');
    expect(markdown).not.toContain('<u>');
  });
});

describe('task lists keep their content (#145)', () => {
  const task = (checked: boolean, ...content: Json[]): Json => ({ type: 'taskItem', attrs: { checked }, content });
  const taskList = (...items: Json[]): Json => ({ type: 'taskList', content: items });
  const linked = doc(
    taskList(
      task(
        false,
        para(
          text('see '),
          text('doc', [{ type: 'link', attrs: { href: 'https://e.org/doc' } }]),
          text(' '),
          text('x', [{ type: 'code' }]),
          text(' '),
          text('b', [{ type: 'bold' }]),
        ),
        taskList(task(true, para(text('child'))), task(false, para(text('child 2')))),
      ),
      task(true, para(text('second'))),
    ),
  );
  const expected = '- [ ] see [doc](https://e.org/doc) `x` **b**\n  - [x] child\n  - [ ] child 2\n- [x] second';

  it('exports links, code, marks and nested tasks, as a tight list', () => {
    expect(jsonToMarkdown(linked)).toBe(expected);
    expect(htmlToMarkdown(jsonToHtml(linked))).toBe(expected);
  });

  it('round-trips: nested taskList, checked state, link and code survive markdownToHtml → htmlToJson', () => {
    const back = htmlToJson(md(jsonToMarkdown(linked))) as Json;
    const lists = findAll(back, 'taskList');
    expect(lists).toHaveLength(2);
    const items = findAll(back, 'taskItem');
    expect(items.map((i) => i.attrs?.checked)).toEqual([false, true, false, true]);
    expect(findAll(lists[1], 'text').map((t) => t.text)).toEqual(['child', 'child 2']);
    expect(marksOf(items[0])).toEqual(expect.arrayContaining(['link', 'code', 'bold']));
    expect(jsonToMarkdown(back)).toBe(expected); // stable on a second trip
  });

  it('plain items are unchanged from before (the existing export shape)', () => {
    const html =
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>done</p></div></li>' +
      '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>todo</p></div></li></ul>';
    expect(htmlToMarkdown(html)).toBe('- [x] done\n- [ ] todo');
  });

  it('a two-paragraph item keeps both paragraphs, and a code block in an item keeps its blank line', () => {
    const multi = doc(
      taskList(
        task(false, para(text('p1')), para(text('p2'))),
        task(false, { type: 'codeBlock', content: [text('a\n\n- b')] }),
      ),
    );
    const markdown = jsonToMarkdown(multi);
    expect(markdown).toBe('- [ ] p1\n\n  p2\n- [ ] ```\n  a\n\n  - b\n  ```');
    const back = htmlToJson(md(markdown)) as Json;
    expect(findAll(back, 'paragraph').map((p) => findAll(p, 'text').map((t) => t.text).join(''))).toEqual(
      expect.arrayContaining(['p1', 'p2']),
    );
  });
});

describe('<details> converts its children as DOM nodes (#145)', () => {
  // The exact output before #145 (captured from the string-based rule): this change must not move a byte.
  const GOLDEN: Array<[string, string, string]> = [
    [
      'snippet',
      '<details><summary>More</summary><div data-type="detailsContent"><p>hidden</p></div></details>',
      '<details>\n<summary>More</summary>\n\nhidden\n\n</details>',
    ],
    [
      'nested',
      '<details open=""><summary data-type="detailsSummary">Outer <strong>b</strong></summary><div data-type="detailsContent"><p>one</p>' +
        '<details><summary data-type="detailsSummary">Inner</summary><div data-type="detailsContent"><p>deep <em>e</em></p><ul><li><p>x</p></li></ul></div></details>' +
        '<p>two</p></div></details>',
      '<details>\n<summary>Outer **b**</summary>\n\none\n\n<details>\n<summary>Inner</summary>\n\ndeep _e_\n\n- x\n\n</details>\n\ntwo\n\n</details>',
    ],
    [
      'text nodes and whitespace',
      '<details>  <summary>S  with   space</summary>\n text <p>p1</p><pre><code>a\n  b</code></pre> tail </details>',
      '<details>\n<summary>S with space</summary>\n\n textp1```\na\n  b\n```tail\n\n</details>',
    ],
    ['no summary', '<details><p>only</p></details>', '<details>\n\n\nonly\n\n</details>'],
    [
      'in a list',
      '<ul><li><p>a</p><details><summary>s</summary><div data-type="detailsContent"><p>c</p><p>d</p></div></details></li></ul>',
      '- a\n  <details>\n  <summary>s</summary>\n  \n  c\n  \n  d\n  \n  </details>',
    ],
  ];

  it.each(GOLDEN)('%s: same output as before, on both the string and the DOM-node path', (_name, html, expected) => {
    expect(htmlToMarkdown(html)).toBe(expected);
    expect(htmlToMarkdownReleasingDom(html)).toBe(expected);
  });

  it('never hands Turndown a string (= a new, unclosed jsdom in Node) while converting a details-heavy page', () => {
    const fromEditorExt = createRequire(require.resolve('@docmost/editor-ext'));
    const Turndown = fromEditorExt('@joplin/turndown') as { prototype: { turndown: (input: unknown) => string } };
    const inputs: unknown[] = [];
    const real = Turndown.prototype.turndown;
    const spy = jest.spyOn(Turndown.prototype, 'turndown').mockImplementation(function (this: unknown, input: unknown) {
      inputs.push(input);
      return real.call(this, input);
    });
    const toggle = (i: number) =>
      `<details><summary data-type="detailsSummary">T${i}</summary><div data-type="detailsContent"><p>a${i}</p><p>b${i}</p></div></details>`;
    let out: string;
    try {
      out = htmlToMarkdownReleasingDom(Array.from({ length: 10 }, (_, i) => toggle(i)).join(''));
    } finally {
      spy.mockRestore();
    }
    expect(out).toContain('<summary>T9</summary>');
    expect(inputs.length).toBe(1 + 10 * 2); // the root, then each toggle's summary and content
    expect(inputs.filter((i) => typeof i === 'string')).toEqual([]);
  });
});

describe('the #145 rules keep #699 (no DOM kept after the conversion returns)', () => {
  it('a page of toggles, task lists and header tables keeps no DOM, where htmlToMarkdown keeps one (control)', () => {
    // The rules this change touched: details (summary + children), task items, the colgroup strip. Each used to (or
    // could) keep the jsdom alive: a string handed to Turndown (a new JSDOM) or a selector query (nwsapi).
    const p = (i: number) => `<p>word ${i} the of and <strong>bold</strong> <a href="https://e.org/${i}">link</a> text text</p>`;
    const block = (i: number) =>
      i % 3 === 0
        ? `<details><summary data-type="detailsSummary">S ${i}</summary><div data-type="detailsContent">${p(i)}${p(i)}</div></details>`
        : i % 3 === 1
          ? `<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox"></label><div>${p(i)}</div></li></ul>`
          : `<table><colgroup><col><col></colgroup><tbody><tr><th>${p(i)}</th><th>x</th></tr><tr><td>${p(i)}</td><td>y</td></tr></tbody></table>`;
    const html = Array.from({ length: 900 }, (_, i) => block(i)).join('');
    const runs = 4;

    let before = heapAfterGc();
    for (let i = 0; i < runs; i++) htmlToMarkdownReleasingDom(html);
    const ours = heapAfterGc() - before;

    before = heapAfterGc();
    for (let i = 0; i < runs; i++) htmlToMarkdown(html);
    const upstream = heapAfterGc() - before;

    expect(upstream).toBeGreaterThan(runs * html.length * 20);
    expect(ours).toBeLessThan(upstream / 10);
  }, 120_000);
});

describe('literal <br> survives outside table rows (#145)', () => {
  it('a code block and inline code keep a literal <br>', () => {
    const page = doc(
      { type: 'codeBlock', attrs: { language: 'html' }, content: [text('line<br>\n<br/>')] },
      para(text('use '), text('<br>', [{ type: 'code' }]), text(' tags')),
    );
    expect(jsonToMarkdown(page)).toBe('```html\nline<br>\n<br/>\n```\n\nuse `<br>` tags');
  });

  it('a table row that only LOOKS like one inside a fence is left alone', () => {
    const page = doc({ type: 'codeBlock', content: [text('| a<br>b |')] });
    expect(jsonToMarkdown(page)).toBe('```\n| a<br>b |\n```');
  });

  it('a multi-paragraph table cell still exports on one line', () => {
    const page = doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [para(text('H'))] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('p1')), para(text('p2'))] }] },
      ],
    });
    const markdown = jsonToMarkdown(page);
    expect(markdown).not.toContain('<br>');
    expect(markdown.split('\n')).toEqual(['| H   |', '| --- |', '| p1  p2 |']);
  });
});
