/**
 * CCC #145 — turn the GFM plugin's `<br>` cell breaks into spaces, in table rows only. Fork-owned.
 *
 * The GFM table plugin joins a multi-line cell with `<br>` so the row stays on one line; upstream then replaced EVERY
 * `<br>` in the output with a space, which also erased a literal `<br>` shown in a code block or in inline code (an
 * HTML snippet in a technical page). This keeps upstream's intent and scope: only lines that are GFM table rows
 * (`| … |`), and never inside a fenced code block. A literal `<br>` inside inline code IN a table cell still becomes
 * a space: there it cannot be told apart from the plugin's break marker.
 */

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

export function collapseTableCellBreaks(markdown: string): string {
  if (!markdown.includes("<br>")) return markdown;
  let fence: string | null = null; // the opening fence run while inside a fenced code block
  return markdown
    .split("\n")
    .map((line) => {
      const run = FENCE_RE.exec(line)?.[1];
      if (fence) {
        // A closing fence: the same character, at least as long, nothing after it.
        if (run && run[0] === fence[0] && run.length >= fence.length && line.trim() === run) fence = null;
        return line;
      }
      if (run) {
        fence = run;
        return line;
      }
      return TABLE_ROW_RE.test(line) ? line.replaceAll("<br>", " ") : line;
    })
    .join("\n");
}
