import type { Editor } from "@tiptap/react";
import type { MarkType, Node as PMNode } from "@tiptap/pm/model";

/** The literal text inserted when a Link is requested with no word under the caret. */
export const LINK_PLACEHOLDER = "link";

/** A doc range a caller may need to clean up (see `ensureLinkableSelection`). */
export interface PlaceholderRange {
  from: number;
  to: number;
}

/** Result of `ensureLinkableSelection`. */
export interface LinkableSelectionResult {
  /**
   * The range of a "link" placeholder inserted because the caret had no word
   * under it. Non-null ONLY when placeholder text was inserted; the caller must
   * remove this range if the link panel is dismissed without applying a link,
   * so cancelling never leaves stray "link" text behind (issue #135).
   */
  placeholder: PlaceholderRange | null;
}

/**
 * Establish a NON-EMPTY, linkable selection before opening the shared link
 * panel (issue #135). The upstream `EditorLinkMenu` only renders for a
 * non-empty text selection and links whatever text is selected, but a toolbar
 * button is usually clicked with a collapsed caret:
 *   - inside an existing link → select the whole link (edit / remove);
 *   - a real selection already exists → keep it;
 *   - caret inside a word → select that word (never part of a link: a word
 *     stops at a link's edge, at whitespace, and at any inline node);
 *   - no word, but the caret touches a link's edge → select that whole link
 *     (links are `inclusive: false`, so `isActive("link")` is false there);
 *   - caret in empty space → insert a "link" placeholder and select it.
 *
 * Returns the placeholder range (when one was inserted) so the caller can undo
 * it on a cancelled panel. The selection is set WITHOUT focusing the editor, so
 * the link menu's own effect (`editor.commands.focus()` when it opens) produces
 * the focus change / transaction that makes the panel appear.
 */
export function ensureLinkableSelection(
  editor: Editor,
): LinkableSelectionResult {
  if (editor.isActive("link")) {
    editor.chain().extendMarkRange("link").run();
    return { placeholder: null };
  }

  const { selection } = editor.state;
  if (!selection.empty) return { placeholder: null };

  const $from = selection.$from;
  const parentText = wordScanText($from.parent, editor.schema.marks.link);
  const offset = $from.parentOffset;
  const base = $from.start();
  const isWordChar = (ch: string | undefined) => !!ch && !/\s/.test(ch);

  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(parentText[start - 1])) start--;
  while (end < parentText.length && isWordChar(parentText[end])) end++;

  if (end > start) {
    editor
      .chain()
      .setTextSelection({ from: base + start, to: base + end })
      .run();
    return { placeholder: null };
  }

  // No word, but the caret sits at a link's edge: edit that link
  // (`extendMarkRange` looks at the node after the caret, then before it).
  const linkType = editor.schema.marks.link;
  if (
    linkType &&
    [$from.nodeBefore, $from.nodeAfter].some(
      (node) => node?.isText && linkType.isInSet(node.marks),
    )
  ) {
    editor.chain().extendMarkRange("link").run();
    return { placeholder: null };
  }

  // No word under the caret: insert a placeholder anchor and select it.
  const at = selection.from;
  editor
    .chain()
    .insertContent(LINK_PLACEHOLDER)
    .setTextSelection({ from: at, to: at + LINK_PLACEHOLDER.length })
    .run();
  return { placeholder: { from: at, to: at + LINK_PLACEHOLDER.length } };
}

/**
 * The parent textblock's content as a string indexed 1:1 by `parentOffset`
 * (#145), for the word scan above. `Node.textContent` cannot be used: an inline
 * leaf (hard break, mention, status, inline math) takes one doc position but
 * contributes no text, so every leaf before the caret would shift the range.
 * Here each position that is not plain, unlinked text becomes "\n", which the
 * scan treats as a boundary: an inline node, and linked text (so a word never
 * partially overlaps an existing link).
 */
function wordScanText(parent: PMNode, linkType: MarkType | undefined): string {
  let text = "";
  parent.forEach((child) => {
    const plain = child.isText && !(linkType && linkType.isInSet(child.marks));
    text += plain ? child.text! : "\n".repeat(child.nodeSize);
  });
  return text;
}

/**
 * Whether a pending link placeholder should be removed on a cancelled panel.
 *
 * The caller tracks the placeholder range across document changes (mapping it
 * through every transaction, local AND remote-collab), then asks this before
 * deleting. It returns true ONLY when the range is in-bounds, still holds
 * exactly the placeholder text, and carries no link mark — i.e. the user
 * dismissed the panel without applying a link. This is the safety gate on a
 * DESTRUCTIVE `deleteRange`: a stale or rewritten range (e.g. a concurrent
 * remote edit consumed or shifted the text) returns false, so cleanup can
 * never delete the wrong content or throw on an out-of-range position.
 */
export function shouldRemovePlaceholder(
  editor: Editor,
  range: PlaceholderRange,
): boolean {
  const { from, to } = range;
  const size = editor.state.doc.content.size;
  if (from < 0 || to > size || from >= to) return false;
  if (editor.state.doc.textBetween(from, to) !== LINK_PLACEHOLDER) return false;

  const linkType = editor.schema.marks.link;
  if (!linkType) return true;
  let linked = false;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (node.isText && node.marks.some((m) => m.type === linkType)) {
      linked = true;
    }
  });
  return !linked;
}
