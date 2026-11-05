import { htmlToMarkdown } from '@docmost/editor-ext';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { jsonToHtml } from '../collaboration/collaboration.util';
import { htmlToMarkdownReleasingDom } from './html-to-markdown';

/**
 * #699 — `htmlToMarkdownReleasingDom` is `htmlToMarkdown` without the leaked jsdom window. Fork-owned.
 * Output parity over the shapes the export produces, and the memory property with an anti-vacuity control.
 */

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
/**
 * Heap after a full GC, WITHOUT yielding to the event loop: an unclosed jsdom window is released only at a later
 * macrotask turn, and the export converts page after page with only microtask awaits in between (zipPages).
 */
function heapAfterGc(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

const MiB = 1024 * 1024;

const SNIPPETS: Record<string, string> = {
  headings: '<h1>Title</h1><h2>Sub <em>it</em></h2><h3>Three</h3>',
  marks: '<p><strong><em>bi</em></strong> <s>gone</s> <code>x = 1</code> <mark>hi</mark> <a href="https://e.org/a?b=1">link</a></p>',
  whitespace: '<p>  lots   of\n\n   space  </p><p>a<br>b<br/>c</p>',
  entities: '<p>&lt;tag&gt; &amp; &quot;q&quot; &#39;s&#39; [brackets] *stars* _under_ \\back</p>',
  lists: '<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li><li><p>two</p></li></ul><ol start="3"><li><p>three</p></li><li><p>four</p></li></ol>',
  tasks:
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>done</p></div></li>' +
    '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>todo</p></div></li></ul>',
  table:
    '<table><tbody><tr><th><p>H1</p></th><th><p>H2</p></th></tr><tr><td><p>a | pipe</p></td><td><p>b</p></td></tr></tbody></table>',
  code: '<pre><code class="language-typescript">const a = 1;\n  if (a) {\n    return `x`;\n  }</code></pre>',
  quote: '<blockquote><p>quoted</p><p>twice</p></blockquote><hr>',
  callout: '<div data-type="callout" data-callout-type="warning"><p>careful</p></div>',
  details: '<details><summary>More</summary><div data-type="detailsContent"><p>hidden</p></div></details>',
  math: '<p>inline <span data-type="mathInline" data-katex="true">x^2</span></p><div data-type="mathBlock" data-katex="true">E=mc^2</div>',
  media:
    '<img src="/api/files/0000/a b.png" alt="alt [x]" width="100"><video src="/api/files/v/clip.mp4"></video>' +
    '<iframe src="https://www.youtube.com/embed/x" data-type="embed"></iframe>',
};

/** A deterministic realistic page, through the real ProseMirror → HTML path the export uses. */
function realisticDoc(blocks: number, seed = 7): unknown {
  const words = 'the of and to in is that for it as was with be by on not this are or from at which but have an they'.split(' ');
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const w = () => words[Math.floor(rnd() * words.length)];
  const text = (n: number) => Array.from({ length: n }, w).join(' ');
  const para = () => ({
    type: 'paragraph',
    content: [
      { type: 'text', text: text(12) + ' ' },
      { type: 'text', text: text(2), marks: [{ type: 'bold' }] },
      { type: 'text', text: ' ' + text(6), marks: rnd() < 0.3 ? [{ type: 'link', attrs: { href: `https://e.org/${w()}` } }] : [] },
    ],
  });
  const content: unknown[] = [];
  for (let i = 0; i < blocks; i++) {
    const r = rnd();
    if (r < 0.6) content.push(para());
    else if (r < 0.75) content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: text(4) }] });
    else if (r < 0.9) content.push({ type: 'bulletList', content: [1, 2, 3].map(() => ({ type: 'listItem', content: [para()] })) });
    else
      content.push({
        type: 'table',
        content: [1, 2].map(() => ({ type: 'tableRow', content: [1, 2, 3].map(() => ({ type: 'tableCell', content: [para()] })) })),
      });
  }
  return { type: 'doc', content };
}

describe('htmlToMarkdownReleasingDom (#699)', () => {
  it.each(Object.entries(SNIPPETS))('same Markdown as htmlToMarkdown: %s', (_name, html) => {
    expect(htmlToMarkdownReleasingDom(html)).toBe(htmlToMarkdown(html));
  });

  it('same Markdown as htmlToMarkdown on realistic pages from the real ProseMirror → HTML path', () => {
    for (const seed of [1, 2, 3]) {
      const html = jsonToHtml(realisticDoc(200, seed));
      expect(htmlToMarkdownReleasingDom(html)).toBe(htmlToMarkdown(html));
    }
  });

  it('keeps no DOM after it returns, where htmlToMarkdown keeps one per call until the event loop turns (control)', () => {
    const html = jsonToHtml(realisticDoc(1500)); // ~0.3 MiB of HTML
    const runs = 4;
    expect(html.length).toBeGreaterThan(MiB / 5);

    let before = heapAfterGc();
    for (let i = 0; i < runs; i++) htmlToMarkdownReleasingDom(html);
    const ours = heapAfterGc() - before;

    before = heapAfterGc();
    for (let i = 0; i < runs; i++) htmlToMarkdown(html);
    const upstream = heapAfterGc() - before;

    console.log(
      `#699 markdown: ${runs} × ${(html.length / MiB).toFixed(2)} MiB HTML — retained ${(ours / MiB).toFixed(1)} MiB ` +
        `(releasing) vs ${(upstream / MiB).toFixed(1)} MiB (htmlToMarkdown)`,
    );
    expect(upstream).toBeGreaterThan(runs * html.length * 20); // the leak this replaces: ~150× the HTML per call
    expect(ours).toBeLessThan(upstream / 10);
  }, 120_000);
});
