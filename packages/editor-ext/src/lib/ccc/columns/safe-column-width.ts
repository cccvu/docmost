/**
 * CCC render gate for a column's width (#145).
 *
 * Upstream `Column` interpolates the stored `width` attribute straight into
 * inline CSS (`flex: ${width}`). Content authored as JSON (the /v1 API, MCP)
 * or over Yjs never passes `parseHTML` (which only yields `parseFloat`
 * numbers), so a string such as `1; background-image:url(https://…)` became a
 * second CSS declaration in the live editor, share pages and HTML exports.
 *
 * Only a finite, positive number renders: a JSON number, or a string holding
 * nothing but a plain decimal (how an attribute may round-trip as text).
 * Zero, negatives, NaN, Infinity and anything else render no width at all,
 * which is upstream's behaviour for an unset width (`if (!width) return {}`).
 */
const DECIMAL = /^\s*\d+(?:\.\d+)?\s*$/;

/** The width as a finite positive number when it is safe to render, else null. */
export function safeColumnWidth(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && DECIMAL.test(value)
        ? Number(value)
        : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
