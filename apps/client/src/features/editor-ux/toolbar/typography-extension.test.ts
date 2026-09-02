import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { CccFontSize, CccFontFamily } from "@docmost/editor-ext";

// The mainExtensions barrel throws under jsdom (localStorage); build a minimal
// editor with just the pieces the typography commands touch.
function makeEditor() {
  return new Editor({
    extensions: [StarterKit, TextStyle, CccFontSize, CccFontFamily],
    content: "<p>hello world</p>",
  });
}

let editor: Editor;
afterEach(() => editor?.destroy());

describe("CccFontSize command", () => {
  it("applies an allowlisted size to the selection", () => {
    editor = makeEditor();
    editor.chain().selectAll().setFontSize("20px").run();
    expect(editor.getHTML()).toContain("font-size: 20px");
  });

  it("normalizes an off-scale size to the nearest allowed step", () => {
    editor = makeEditor();
    editor.chain().selectAll().setFontSize("15px").run();
    expect(editor.getHTML()).toContain("font-size: 14px");
  });

  it("unsetFontSize removes the attribute", () => {
    editor = makeEditor();
    editor.chain().selectAll().setFontSize("18px").run();
    editor.chain().selectAll().unsetFontSize().run();
    expect(editor.getHTML()).not.toContain("font-size");
  });

  it("render gate: a raw non-allowlisted attr is not emitted as CSS", () => {
    editor = makeEditor();
    // Bypass the command's normalization to simulate hostile JSON/API content.
    editor.chain().selectAll().setMark("textStyle", { fontSize: "9999px" }).run();
    expect(editor.getHTML()).not.toContain("9999");
    expect(editor.getHTML()).not.toContain("font-size");
  });
});

describe("CccFontFamily command", () => {
  it("maps the serif keyword to a controlled stack", () => {
    editor = makeEditor();
    editor.chain().selectAll().setFontFamily("serif").run();
    expect(editor.getHTML().toLowerCase()).toContain("georgia");
  });

  it("rejects an arbitrary family (stored as null → no CSS)", () => {
    editor = makeEditor();
    editor.chain().selectAll().setFontFamily("Comic Sans MS").run();
    expect(editor.getHTML()).not.toContain("font-family");
  });

  it("render gate: a raw non-keyword family attr is not emitted as CSS", () => {
    editor = makeEditor();
    // Bypass the command's normalization to simulate hostile JSON/API content
    // written straight to the mark attr (the render-path security gate, mirror
    // of the fontSize raw-attr test above).
    editor
      .chain()
      .selectAll()
      .setMark("textStyle", { fontFamily: "Comic Sans MS" })
      .run();
    expect(editor.getHTML()).not.toContain("font-family");
    expect(editor.getHTML()).not.toContain("Comic Sans");
  });

  it("unsetFontFamily removes the attribute", () => {
    editor = makeEditor();
    editor.chain().selectAll().setFontFamily("monospace").run();
    editor.chain().selectAll().unsetFontFamily().run();
    expect(editor.getHTML()).not.toContain("font-family");
  });
});
