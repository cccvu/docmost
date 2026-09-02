import type { Editor } from "@tiptap/react";

/**
 * Read a `textStyle` mark attribute across the current selection:
 *   - collapsed caret → the stored/active value (or null);
 *   - a range with one distinct value → that value (or null);
 *   - a range with more than one distinct value → "mixed".
 * Used by the font size/family toolbar menus to label the active value.
 */
export function collectTextStyleAttr(
  editor: Editor,
  attr: "fontSize" | "fontFamily",
): string | null | "mixed" {
  const { from, to, empty } = editor.state.selection;

  if (empty) {
    return (editor.getAttributes("textStyle")?.[attr] as string) ?? null;
  }

  const seen = new Set<string | null>();
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "textStyle");
    seen.add((mark?.attrs?.[attr] as string) ?? null);
  });

  if (seen.size === 0) return null;
  if (seen.size === 1) return [...seen][0];
  return "mixed";
}
