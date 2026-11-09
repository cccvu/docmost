/**
 * CCC parse clamp for table cell spans (#781, ADR 0036).
 *
 * Tiptap's TableCell/TableHeader declare `colspan`/`rowspan` with no `parseHTML`, so a pasted or imported
 * `colspan="100%"`, `""` or `"5000"` became the string or number as written. The collab update guard and its HTTP twin
 * (server `content-rules.ts` `INT_ATTRS`) refuse a span that is not an integer within HTML's own limits, because the
 * table view and prosemirror-tables loop once per unit; so an honest paste of such HTML would lock its author's editor.
 * This parses a span as a browser does: an integer, 1 when it is missing, not a number or below 1, clamped to the limit.
 */
export const CELL_SPAN_LIMITS = Object.freeze({ colspan: 1000, rowspan: 65534 });

/** `null` when the attribute is absent (the default applies), else the clamped integer. */
export function parseCellSpan(raw: string | null, max: number): number | null {
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, max);
}

/** Table cell/header attributes with `colspan`/`rowspan` parsed through `parseCellSpan`. */
export function withSafeCellSpans<T extends Record<string, any>>(attributes: T | undefined): T {
  const out = { ...(attributes ?? {}) } as Record<string, any>;
  for (const key of ["colspan", "rowspan"] as const) {
    if (out[key]) {
      out[key] = {
        ...out[key],
        parseHTML: (element: HTMLElement) => parseCellSpan(element.getAttribute(key), CELL_SPAN_LIMITS[key]),
      };
    }
  }
  return out as T;
}
