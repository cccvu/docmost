/**
 * #390 — the null-ydoc defensive guard, extracted from the persistence hook so the upstream seam stays a
 * call-through and the decision is unit-testable (review: architecture asymmetry — its ydoc-present sibling
 * `reconcileRowIntoDoc` was already extracted).
 *
 * When a row has content but NO `ydoc` (a legacy row predating the column — verified absent from every live
 * content-write path, which all co-write `ydoc`), there is no shared CRDT lineage to reconcile against. The
 * one clobber shape still worth refusing is the #390 one: overwriting a row that holds real content with a
 * BLANK resident document. A genuine (non-blank) edit still proceeds.
 *
 * "Blank" is a STRUCTURAL predicate over ProseMirror JSON, not a text check: an image-only / table-only /
 * drawio page has no text but is NOT blank (review: correctness — a `jsonToText` check mis-read those in both
 * directions). Pure JSON inspection, no tiptap import, so it stays trivially testable.
 */
function isEmptyNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return true;
  const type = (node as { type?: unknown }).type;
  // Only a paragraph (or the doc root) can be "empty"; any other node type (image, table, drawio, heading,
  // list, code block, …) is real content.
  if (type !== 'paragraph' && type !== 'doc') return false;
  const kids = (node as { content?: unknown }).content;
  if (!Array.isArray(kids) || kids.length === 0) return true;
  return kids.every((k) => {
    if (k && typeof k === 'object' && (k as { type?: unknown }).type === 'text') {
      const t = (k as { text?: unknown }).text;
      return typeof t !== 'string' || t.trim() === '';
    }
    return isEmptyNode(k);
  });
}

/**
 * True when the ProseMirror JSON carries no meaningful content (empty, or only empty paragraphs).
 * `null`/`undefined` is blank (an unset row). A non-null value that is NOT recognizable ProseMirror JSON
 * (e.g. a bare string) is treated as NON-blank — fail safe: never let an unrecognized row be blank-clobbered.
 */
export function isBlankProseMirror(json: unknown): boolean {
  if (json == null) return true;
  if (typeof json !== 'object') return false;
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) return false; // a non-null object that isn't a PM doc → assume content
  if (content.length === 0) return true;
  return content.every(isEmptyNode);
}

/**
 * True when persisting `outgoing` over `row` would blank a page that currently holds real content and there
 * is no ydoc lineage to reconcile — i.e. the #390 clobber shape on a null-ydoc row. Fails safe: unparseable
 * row content is treated as non-blank, so a blank overwrite of it is refused rather than allowed.
 */
export function shouldRefuseBlankClobber(row: unknown, outgoing: unknown): boolean {
  return !isBlankProseMirror(row) && isBlankProseMirror(outgoing);
}
