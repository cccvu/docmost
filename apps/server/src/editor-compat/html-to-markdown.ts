/**
 * #699 — HTML → Markdown without leaking a DOM per call. Fork-owned.
 *
 * `htmlToMarkdown` (packages/editor-ext) runs Turndown, which in Node parses its input with `new JSDOM(html)` and
 * never closes the window (@joplin/turndown lib/turndown.cjs.js:1272-1275). An unclosed window stays reachable until a
 * later turn of the event loop. The export converts page after page with only microtask awaits in between
 * (`ExportService.zipPages`; since #716 the export runs it in the conversion worker), so every page's DOM stayed alive until the whole export had been converted: measured on
 * Node 24, ~125–190× the HTML per call for content with inline marks (a 0.93 MiB page kept ~180 MiB), and a loop of
 * five such pages exhausted a 1 GiB heap (a process abort). With a macrotask between calls it survives, at ~0.7–0.8 GiB.
 *
 * This parses the same wrapper Turndown builds itself (`<x-turndown id="turndown-root">…</x-turndown>`), hands
 * Turndown the root ELEMENT, and closes the window when the conversion returns. Turndown deep-clones a node it is
 * given (`root = input.cloneNode(true)` in RootNode, lib/turndown.cjs.js:1282-1294 of @joplin/turndown 4.0.82, pinned
 * exactly in the root package.json — re-check these lines on any bump), which would hold a second DOM as large as the
 * first at the peak (measured +102 MiB on a 0.70 MiB page), so the root's `cloneNode` returns the root itself
 * (html-to-markdown.spec.ts pins that Turndown calls it exactly once, deep, so a bump that stops cloning, or clones
 * another way, goes red): Turndown then
 * works on the one DOM, exactly as it does on the document it parses from a string, and nothing else reads it. The output is the same (pinned by html-to-markdown.spec.ts against `htmlToMarkdown`). jsdom
 * is loaded through the exact Turndown that editor-ext uses, so no new dependency and no second jsdom version.
 */
import { createRequire } from 'node:module';
import { htmlToMarkdown } from '@docmost/editor-ext';

type JsdomCtor = new (html: string) => {
  window: { document: { getElementById(id: string): unknown }; close(): void };
};

let JSDOM: JsdomCtor | null = null;

function jsdom(): JsdomCtor {
  if (!JSDOM) {
    const fromEditorExt = createRequire(require.resolve('@docmost/editor-ext'));
    const fromTurndown = createRequire(fromEditorExt.resolve('@joplin/turndown/package.json'));
    JSDOM = (fromTurndown('jsdom') as { JSDOM: JsdomCtor }).JSDOM;
  }
  return JSDOM;
}

/** `htmlToMarkdown(html)`, with the DOM it parses released when it returns. */
export function htmlToMarkdownReleasingDom(html: string): string {
  const Dom = jsdom();
  const dom = new Dom(`<x-turndown id="turndown-root">${html}</x-turndown>`);
  try {
    const root = dom.window.document.getElementById('turndown-root') as { cloneNode: (deep?: boolean) => unknown };
    root.cloneNode = () => root; // no second DOM (above)
    // Turndown takes a DOM node as well as a string; editor-ext's signature names only the string.
    return htmlToMarkdown(root as unknown as string);
  } finally {
    dom.window.close();
  }
}
