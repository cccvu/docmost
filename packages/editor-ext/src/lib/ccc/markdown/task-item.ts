/**
 * CCC #145 — the Markdown body of a task item, built from Turndown's converted content. Fork-owned.
 *
 * Upstream's task-item rule printed the item's `textContent`, so links, inline code, marks and nested task items were
 * flattened into one plain line (`- [ ] see doc xchild`) and lost on every Markdown read, export and read-modify-write.
 * This uses the converted Markdown instead, normalized like upstream's `orderedListItem`: no leading or trailing
 * newlines, continuation lines indented two spaces under the marker.
 *
 * A task item's blocks sit in a `<div>`, not directly in the `<li>`, so Turndown's list rule surrounds a nested list
 * with blank lines (a "loose" list). The blank lines right before a nested list line are dropped so the item stays
 * tight (`- [ ] parent\n  - [x] child`), as a nested list in a plain item already is. Other blank lines (between two
 * paragraphs of one item) are kept, and nothing inside a fenced code block is touched.
 */

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const LIST_LINE_RE = /^(?:[-+*]|\d+[.)]) /;

export function taskItemMarkdown(content: string): string {
  const lines = content.replace(/^\n+/, "").replace(/\n+$/, "").split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const run = FENCE_RE.exec(line)?.[1];
    if (fence) {
      if (run && run[0] === fence[0] && run.length >= fence.length && line.trim() === run) fence = null;
    } else if (run) {
      fence = run;
    } else if (LIST_LINE_RE.test(line)) {
      while (out.length > 0 && out[out.length - 1] === "") out.pop();
    }
    out.push(line);
  }
  return out.map((line, i) => (i === 0 || line === "" ? line : `  ${line}`)).join("\n");
}
