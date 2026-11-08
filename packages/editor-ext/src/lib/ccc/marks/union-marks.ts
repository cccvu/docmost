import { Mark, type Node as PMNode } from "@tiptap/pm/model";

/**
 * CCC (#145): the union of the marks on every text node in [from, to], as a
 * VALID mark set.
 *
 * Upstream search-and-replace collected these marks in a `Set<Mark>`, which
 * dedupes by object identity only. Attribute-bearing marks are not singletons,
 * so a replacement across a `textStyle` boundary (red | 20px), or across one
 * colour run split by bold, got two `textStyle` marks: a schema-invalid set
 * (`Node.check()` throws) that y-prosemirror collapses to the last one for
 * peers and on reload, while the local editor keeps both.
 *
 * `Mark.addToSet` drops an equal mark and replaces a mark its type excludes
 * (`textStyle` excludes itself), so the later same-type mark wins — the value
 * the synced copy already kept — while distinct mark types (bold, italic, …)
 * still union, as upstream intended.
 */
export function unionMarksBetween(
  doc: PMNode,
  from: number,
  to: number,
): readonly Mark[] {
  let marks: readonly Mark[] = Mark.none;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      node.marks.forEach((mark) => {
        marks = mark.addToSet(marks);
      });
    }
  });
  return marks;
}
