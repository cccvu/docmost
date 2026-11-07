import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import type { Node as PMNode } from "@tiptap/pm/model";
import { CccFontSize, SearchAndReplace } from "@docmost/editor-ext";

// #145: search-and-replace collected the replaced range's marks in a
// Set<Mark>, which dedupes by object identity only, so a replacement across a
// textStyle boundary got TWO textStyle marks — a schema-invalid mark set that
// y-prosemirror then collapses differently for peers (silent formatting loss).

function makeEditor(content: string) {
  return new Editor({
    extensions: [StarterKit, TextStyle, Color, CccFontSize, SearchAndReplace],
    content,
  });
}

function replaceAllIn(editor: Editor, search: string, replacement: string) {
  editor.commands.setSearchTerm(search);
  editor.commands.setReplaceTerm(replacement);
  expect(editor.storage.searchAndReplace.results.length).toBeGreaterThan(0);
  editor.commands.replaceAll();
}

function replaceOneIn(editor: Editor, search: string, replacement: string) {
  editor.commands.setSearchTerm(search);
  editor.commands.setReplaceTerm(replacement);
  expect(editor.storage.searchAndReplace.results.length).toBeGreaterThan(0);
  editor.commands.replace();
}

function textNodeWith(doc: PMNode, text: string): PMNode {
  let found: PMNode | undefined;
  doc.descendants((n) => {
    if (n.isText && n.text?.includes(text)) found = n;
  });
  if (!found) throw new Error(`no text node containing ${text}`);
  return found;
}

function expectValidMarks(editor: Editor, replaced: string) {
  const node = textNodeWith(editor.state.doc, replaced);
  expect(node.marks.filter((m) => m.type.name === "textStyle")).toHaveLength(1);
  expect(() => editor.state.doc.check()).not.toThrow();
  return node;
}

let editor: Editor;
afterEach(async () => {
  // `replace` schedules a setTimeout that reads editor.storage: let it run
  // before the editor is torn down.
  await new Promise((resolve) => setTimeout(resolve, 0));
  editor?.destroy();
});

const COLOR_SIZE =
  '<p><span style="color: #E00000">ab</span><span style="font-size: 20px">cd</span></p>';
const SAME_COLOR_SPLIT_BY_BOLD =
  '<p><span style="color: #E00000">ab</span><strong><span style="color: #E00000">cd</span></strong></p>';

describe.each([
  ["replaceAll", replaceAllIn],
  ["replace", replaceOneIn],
] as const)("search-and-replace %s mark union", (_name, run) => {
  it("yields one textStyle across a color/size boundary", () => {
    editor = makeEditor(COLOR_SIZE);
    run(editor, "bc", "XY");
    const node = expectValidMarks(editor, "XY");
    // Mark.addToSet: the later same-type mark replaces the earlier one — what
    // the Yjs/persisted copy already kept.
    const ts = node.marks.find((m) => m.type.name === "textStyle");
    expect(ts?.attrs.fontSize).toBe("20px");
  });

  it("dedupes equal marks and keeps the union of mark types", () => {
    editor = makeEditor(SAME_COLOR_SPLIT_BY_BOLD);
    run(editor, "bc", "XY");
    const node = expectValidMarks(editor, "XY");
    expect(node.marks.map((m) => m.type.name).sort()).toEqual([
      "bold",
      "textStyle",
    ]);
    expect(
      node.marks.find((m) => m.type.name === "textStyle")?.attrs.color,
    ).toBe("#E00000");
  });
});
