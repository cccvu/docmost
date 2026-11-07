import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Heading } from "@docmost/editor-ext";
import { getActiveHeadingLevel } from "./active-heading";

// The mainExtensions barrel throws under jsdom (localStorage); build a minimal
// editor with the editor-ext Heading (all six levels, as registered in the app).
function makeEditor(content: string) {
  return new Editor({
    extensions: [StarterKit.configure({ heading: false }), Heading],
    content,
  });
}

// Put the caret inside the first text node whose content is `text`.
function caretIn(e: Editor, text: string) {
  let pos = -1;
  e.state.doc.descendants((node, p) => {
    if (pos === -1 && node.isText && node.text === text) pos = p + 1;
  });
  if (pos === -1) throw new Error(`text not found: ${text}`);
  e.commands.setTextSelection(pos);
}

let editor: Editor;
afterEach(() => editor?.destroy());

const DOC = "<h2>two</h2><h4>four</h4><h5>five</h5><h6>six</h6><p>para</p>";

describe("getActiveHeadingLevel", () => {
  it.each([
    ["two", 2],
    ["four", 4],
    ["five", 5],
    ["six", 6],
  ])("caret in %s → level %i", (text, level) => {
    editor = makeEditor(DOC);
    caretIn(editor, text);
    expect(getActiveHeadingLevel(editor)).toBe(level);
  });

  it("caret in a paragraph → null", () => {
    editor = makeEditor(DOC);
    caretIn(editor, "para");
    expect(getActiveHeadingLevel(editor)).toBeNull();
  });

  it("a range across two heading levels → null (no single level to name)", () => {
    editor = makeEditor(DOC);
    editor.commands.setTextSelection({ from: 2, to: 9 }); // "two" … "four"
    expect(editor.isActive("heading")).toBe(true);
    expect(getActiveHeadingLevel(editor)).toBeNull();
  });

  it("a range inside one heading → its level", () => {
    editor = makeEditor(DOC);
    caretIn(editor, "four");
    const { from } = editor.state.selection;
    editor.commands.setTextSelection({ from, to: from + 3 });
    expect(getActiveHeadingLevel(editor)).toBe(4);
  });

  it("no editor → null", () => {
    expect(getActiveHeadingLevel(null)).toBeNull();
    expect(getActiveHeadingLevel(undefined)).toBeNull();
  });
});
