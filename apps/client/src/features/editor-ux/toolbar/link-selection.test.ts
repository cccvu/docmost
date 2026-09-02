import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { ensureLinkableSelection } from "./link-selection";

function makeEditor(content: string) {
  return new Editor({ extensions: [StarterKit], content });
}

let editor: Editor;
afterEach(() => editor?.destroy());

const selectedText = (e: Editor) => {
  const { from, to } = e.state.selection;
  return e.state.doc.textBetween(from, to);
};

describe("ensureLinkableSelection", () => {
  it("selects the word under a collapsed caret", () => {
    editor = makeEditor("<p>The quick brown fox</p>");
    // caret inside "quick" (doc pos: 1=start of paragraph text; "The " = 4 chars)
    editor.commands.setTextSelection(7); // within "quick"
    ensureLinkableSelection(editor);
    expect(selectedText(editor)).toBe("quick");
  });

  it("keeps an existing non-empty selection", () => {
    editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 }); // "hello"
    ensureLinkableSelection(editor);
    expect(selectedText(editor)).toBe("hello");
  });

  it("inserts a placeholder when the caret is in an empty paragraph", () => {
    editor = makeEditor("<p></p>");
    editor.commands.setTextSelection(1);
    ensureLinkableSelection(editor);
    expect(selectedText(editor)).toBe("link");
  });

  it("does not focus the editor (the link menu handles focus)", () => {
    editor = makeEditor("<p>alpha beta</p>");
    editor.commands.setTextSelection(3); // within "alpha"
    ensureLinkableSelection(editor);
    expect(editor.isFocused).toBe(false);
    expect(selectedText(editor)).toBe("alpha");
  });
});
