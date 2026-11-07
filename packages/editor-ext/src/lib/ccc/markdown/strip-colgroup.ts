/**
 * CCC #145 — drop tables' `<colgroup>` before Turndown sees the HTML. Fork-owned.
 *
 * Tiptap renders a table as `<table><colgroup>…</colgroup><tbody>…</tbody></table>`. The GFM plugin decides whether a
 * row is the header with `isFirstTbody()`, which needs the `<tbody>` to have no previous sibling, so the `<colgroup>`
 * turns a real header row into a body row and an empty `|     |` header is invented above it (and a Markdown
 * read-modify-write then demotes the real header for good). Column widths have no Markdown form, so nothing is lost.
 *
 * `htmlToMarkdown` takes a string (the SPA: Copy as Markdown, the clipboard) or a DOM node (the engine's
 * `htmlToMarkdownReleasingDom`, which hands Turndown its parsed root so the jsdom window can be closed, #699), so this
 * handles both. A node that holds a `<colgroup>` is cloned first, because Turndown never mutates its input: on the
 * engine path the root's `cloneNode` returns the root itself (no second DOM), so the strip happens in place there.
 *
 * `getElementsByTagName`, never `querySelector(All)`: in jsdom a selector query (nwsapi) keeps the whole document
 * reachable until the event loop turns, even after `window.close()`, which would undo #699's release (measured: ~22 MiB
 * kept per 0.2 MiB page; html-to-markdown.spec.ts's heap tests go red). A DocumentFragment (no `getElementsByTagName`)
 * is passed through unstripped; no caller passes one.
 */

const COLGROUP_RE = /<colgroup[^>]*>[\s\S]*?<\/colgroup>/gi;

interface NodeLike {
  cloneNode(deep?: boolean): unknown;
  getElementsByTagName?(name: string): ArrayLike<{ remove(): void }>;
}

export function stripTableColgroups<T>(input: T): T {
  if (typeof input === "string") return input.replace(COLGROUP_RE, "") as T;
  const node = input as unknown as NodeLike;
  if (!node || typeof node.getElementsByTagName !== "function" || node.getElementsByTagName("colgroup").length === 0) {
    return input;
  }
  const root = node.cloneNode(true) as NodeLike;
  Array.from(root.getElementsByTagName("colgroup")).forEach((el) => el.remove()); // a live list: copy it first
  return root as unknown as T;
}
