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
 *   - everything else (Word, web pages, …) → strip every inline `style`
 *     attribute, the unchanged house style for external content.
 *
 * #145: the strip is a DOM pass, not a regex over the raw string. A regex
 * missed Word's single-quoted `style='…'` and unquoted `style=color:red`, and it
 * deleted literal ` style="…"` TEXT from pasted code samples (browsers do not
 * escape quotes in text nodes). The markup is parsed into a `<template>` of a
 * DOMParser document: neither has a browsing context, so nothing in it runs or
 * loads (the same inertness as ProseMirror's own detached parse), and template
 * parsing keeps table fragments (`<tr>…`) that ProseMirror wraps itself.
 *
 * A user who wants to drop formatting can still paste-as-plain-text
 * (Ctrl/Cmd+Shift+V), which delivers `text/plain` and never reaches this path.
 */
export function cleanPastedHtml(html: unknown): string {
  if (typeof html !== "string" || html === "") return "";
  // The marker is trivially spoofable: any clipboard source (a web page, a
  // crafted document) can include `data-pm-slice`, even as text, to keep its
  // inline styles. That is acceptable ONLY because a preserved style still
  // passes the schema gates: parseHTML snaps font size/family to the allowlist,
  // getStyleProperty reads a single declaration, and renderHTML re-validates
  // every value before it reaches the DOM (CccFontSize/CccFontFamily/CccColor/
  // CccHighlight). Never treat this marker as a trust signal for anything
  // beyond style preservation.
  if (html.includes("data-pm-slice")) return html;
  const template = new DOMParser()
    .parseFromString("", "text/html")
    .createElement("template");
  template.innerHTML = html;
  template.content
    .querySelectorAll("[style]")
    .forEach((el) => el.removeAttribute("style"));
  return template.innerHTML;
}
