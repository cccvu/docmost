import type { Editor } from "@tiptap/core";

/**
 * The heading level the whole selection sits in, or null (not a heading, or a
 * range spanning more than one level). The block-type menus use it to label
 * H4–H6, which the schema allows (shortcuts, paste, import) but the menus
 * offer no item for — without it they read "Normal text" / "Multiple".
 */
export function getActiveHeadingLevel(
  editor: Editor | null | undefined,
): number | null {
  if (!editor) return null;
  const level = editor.getAttributes("heading")?.level;
  // isActive with the level checks the WHOLE selection is that level;
  // getAttributes alone reports the last heading in a mixed range.
  return typeof level === "number" && editor.isActive("heading", { level })
    ? level
    : null;
}
