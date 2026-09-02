/**
 * CCC editor-UX (issue #135): pasted-HTML sanitizer.
 *
 * ProseMirror runs `transformPastedHTML` over its OWN clipboard HTML as well as
 * external HTML. Its own clipboard serialization carries inline `style="…"`
 * (text color, font size, etc.) alongside a `data-pm-slice` marker, so stripping
 * styles indiscriminately loses formatting on an INTERNAL copy/paste (the bug
 * reproduced in the #135 audit: red text pasted as plain).
 *
 * Policy:
 *   - ProseMirror's own clipboard slice (`data-pm-slice`) → preserve verbatim,
 *     so supported in-app formatting survives copy/paste;
 *   - everything else (Word, web pages, …) → keep stripping inline styles, the
 *     unchanged house style for external content.
 *
 * A user who wants to drop formatting can still paste-as-plain-text
 * (Ctrl/Cmd+Shift+V), which delivers `text/plain` and never reaches this path.
 */
export function cleanPastedHtml(html: string): string {
  if (typeof html !== "string" || html.length === 0) return html;
  if (html.includes("data-pm-slice")) return html;
  return html.replace(/\s+style="[^"]*"/gi, "");
}
