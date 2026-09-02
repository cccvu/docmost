import type { Editor } from "@tiptap/react";

const PLACEHOLDER = "link";

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
 * The selection is set WITHOUT focusing the editor, so the link menu's own
 * effect (`editor.commands.focus()` when it opens) produces the focus change /
 * transaction that makes the panel appear.
 */
export function ensureLinkableSelection(editor: Editor): void {
  if (editor.isActive("link")) {
    editor.chain().extendMarkRange("link").run();
    return;
  }

  const { selection } = editor.state;
  if (!selection.empty) return;

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
    return;
  }

  // No word under the caret: insert a placeholder anchor and select it.
  const at = selection.from;
  editor
    .chain()
    .insertContent(PLACEHOLDER)
    .setTextSelection({ from: at, to: at + PLACEHOLDER.length })
    .run();
}
