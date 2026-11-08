import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { CccFontSize, CccFontFamily } from "@docmost/editor-ext";

// #145: setFontFamily with a value outside the allowlist (or null) must not
// leave an all-null textStyle mark behind (an empty <span>, split text nodes,
// a null-attr entry in Yjs) — the same contract setFontSize already keeps.

function makeEditor() {
  return new Editor({
    extensions: [StarterKit, TextStyle, CccFontSize, CccFontFamily],
    content: "<p>hello world</p>",
  });
}

function textStyleMarks(editor: Editor) {
  const found: unknown[] = [];
  editor.state.doc.descendants((n) => {
    n.marks.forEach((m) => {
      if (m.type.name === "textStyle") found.push(m.attrs);
    });
  });
  return found;
}

let editor: Editor;
afterEach(() => editor?.destroy());

describe("typography commands leave no empty textStyle mark", () => {
  it.each([["Comic Sans MS"], [""], [null]])(
    "setFontFamily(%j) on plain text",
    (value) => {
      editor = makeEditor();
      editor
        .chain()
        .selectAll()
        .setFontFamily(value as unknown as string)
        .run();
      expect(textStyleMarks(editor)).toEqual([]);
      expect(editor.getHTML()).toBe("<p>hello world</p>");
    },
  );

  it("setFontFamily(invalid) clears a family but keeps another textStyle attr", () => {
    editor = makeEditor();
    editor.chain().selectAll().setFontSize("20px").setFontFamily("serif").run();
    editor.chain().selectAll().setFontFamily("Comic Sans MS").run();
    expect(textStyleMarks(editor)).toEqual([
      { fontSize: "20px", fontFamily: null },
    ]);
  });

  it("setFontSize(invalid) on plain text (the existing contract)", () => {
    editor = makeEditor();
    editor.chain().selectAll().setFontSize("bogus").run();
    expect(textStyleMarks(editor)).toEqual([]);
  });
});
