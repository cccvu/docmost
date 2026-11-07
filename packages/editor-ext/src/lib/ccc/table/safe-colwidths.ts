import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { safeColumnWidth } from "../columns/safe-column-width";

/**
 * CCC render gate for table column widths (#145, review of PR 754).
 *
 * Tiptap's table `renderHTML` sums the first row's `colwidth` entries with `+=` into the table's `width: …px`. A
 * string entry written as JSON (the /v1 API, MCP) or over Yjs turns that sum into string concatenation, so
 * `["1px; background-image:url(https://…); --x:"]` became extra CSS declarations on the `<table>`. The table renders
 * from a copy whose first-row widths are numbers: a number stays, a plain decimal string becomes its number, and
 * anything else becomes 0 (an unset width). The stored document is untouched.
 */
const isSafeColwidth = (value: unknown): boolean =>
  value == null ||
  (Array.isArray(value) && value.every((w) => w == null || typeof w === "number"));

const toSafeColwidth = (value: unknown): number[] | null =>
  Array.isArray(value)
    ? value.map((w) => (typeof w === "number" ? w : (safeColumnWidth(w) ?? 0)))
    : null;

/** The table itself when every first-row width is safe to render, else a copy whose first-row widths are numbers. */
export function withSafeColwidths(table: PMNode): PMNode {
  const row = table.firstChild;
  if (!row) return table;
  let changed = false;
  const cells: PMNode[] = [];
  row.forEach((cell) => {
    if (isSafeColwidth(cell.attrs.colwidth)) {
      cells.push(cell);
      return;
    }
    changed = true;
    cells.push(
      cell.type.create(
        { ...cell.attrs, colwidth: toSafeColwidth(cell.attrs.colwidth) },
        cell.content,
        cell.marks,
      ),
    );
  });
  if (!changed) return table;
  return table.copy(table.content.replaceChild(0, row.copy(Fragment.from(cells))));
}
