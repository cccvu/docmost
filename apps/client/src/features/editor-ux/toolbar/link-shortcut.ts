import { TextSelection, type EditorState } from "@tiptap/pm/state";

/**
 * CCC editor-UX (#145): what Mod-K does inside the page editor.
 *
 * Returns true when Mod-K should open the shared link panel (the one the
 * toolbar Link button and the bubble-menu link button open), and false when it
 * should open search as it always has. Link panel ONLY when all hold:
 *   - the editor is editable (a read-only viewer keeps search);
 *   - the selection is a `TextSelection` (a `NodeSelection` such as an image
 *     or a drag-handle block, a table `CellSelection` and `AllSelection` keep
 *     search — even when the selected node holds text);
 *   - the schema has a link mark, and the selection holds at least one
 *     non-whitespace character the link mark can be applied to: text whose
 *     parent allows the mark (not a code block) and which carries no mark that
 *     excludes it (not inline code).
 *
 * An empty caret keeps search (it holds no text). A whitespace-only selection
 * keeps search too: there is nothing visible to link.
 * The panel's own `shouldShow` needs a non-empty text selection, which every
 * `true` here satisfies.
 */
export function modKOpensLinkPanel(
  state: EditorState,
  editable: boolean,
): boolean {
  if (!editable) return false;
  const { selection, schema } = state;
  if (!(selection instanceof TextSelection)) return false;
  const link = schema.marks.link;
  if (!link) return false;

  const { from, to } = selection;
  let linkable = false;
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (linkable) return false;
    if (!node.isText || !parent?.type.allowsMarkType(link)) return;
    if (node.marks.some((m) => m.type !== link && m.type.excludes(link))) {
      return;
    }
    const text = node.text!.slice(Math.max(from, pos) - pos, to - pos);
    if (/\S/.test(text)) linkable = true;
  });
  return linkable;
}
