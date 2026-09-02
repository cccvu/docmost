import type { Editor } from "@tiptap/react";

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
 *   - caret inside a word → select that word;
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
  const parentText = $from.parent.textContent;
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
