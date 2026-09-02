import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { CccFontSize, CccFontFamily } from "@docmost/editor-ext";
import { collectTextStyleAttr } from "./selection-attr";

// The mainExtensions barrel throws under jsdom (localStorage); build a minimal
// editor with just the pieces the textStyle attr reader touches.
function makeEditor(content = "<p>hello world</p>") {
  return new Editor({
    extensions: [StarterKit, TextStyle, CccFontSize, CccFontFamily],
    content,
  });
}

let editor: Editor;
afterEach(() => editor?.destroy());

describe("collectTextStyleAttr", () => {
  it("returns null when nothing in the selection carries the attr", () => {
    editor = makeEditor();
    editor.chain().selectAll().run();
    expect(collectTextStyleAttr(editor, "fontSize")).toBeNull();
  });

  it("returns the single value spanning a uniformly-styled range", () => {
    editor = makeEditor();
    editor.chain().selectAll().setFontSize("18px").run();
    expect(collectTextStyleAttr(editor, "fontSize")).toBe("18px");
  });

  it('returns "mixed" when the range spans more than one value', () => {
    editor = makeEditor();
    // "hello" = [1,6), " " = [6,7), "world" = [7,12)
    editor.chain().setTextSelection({ from: 1, to: 6 }).setFontSize("18px").run();
    editor.chain().setTextSelection({ from: 7, to: 12 }).setFontSize("20px").run();
    editor.chain().selectAll().run();
    expect(collectTextStyleAttr(editor, "fontSize")).toBe("mixed");
  });

  it("reads the stored/active value under a collapsed caret", () => {
    editor = makeEditor();
    editor.chain().selectAll().setFontFamily("serif").run();
    editor.chain().setTextSelection(3).run(); // caret inside "hello"
    expect(collectTextStyleAttr(editor, "fontFamily")).toBe("serif");
  });
});
