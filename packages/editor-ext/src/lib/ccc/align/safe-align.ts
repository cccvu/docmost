/**
 * CCC render gate for text alignment (#145, review of PR 754).
 *
 * Stock Tiptap `TextAlign` (paragraph/heading `textAlign`) and the table cell/header `align` attribute check their
 * value only in `parseHTML`, then interpolate the stored attribute into `text-align: …`. Content written as JSON (the
 * /v1 API, MCP) or over Yjs never passes `parseHTML`, so `left; background-image:url(https://…)` became a second CSS
 * declaration in the live editor, share pages, exports and `format=html` reads. Only a listed keyword renders now;
 * anything else renders no alignment, which is what an unset value renders.
 */
export const TEXT_ALIGNMENTS = ["left", "center", "right", "justify"] as const;

/** Table cells: the values Tiptap's own cell parser accepts. */
export const CELL_ALIGNMENTS = ["left", "center", "right"] as const;

/** The value when it is one of `allowed`, else null. */
export function safeTextAlign(
  value: unknown,
  allowed: readonly string[] = TEXT_ALIGNMENTS,
): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}
