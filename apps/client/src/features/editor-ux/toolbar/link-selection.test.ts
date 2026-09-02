import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Link } from "@tiptap/extension-link";
import { ensureLinkableSelection } from "./link-selection";

function makeEditor(content: string) {
  return new Editor({ extensions: [StarterKit, Link], content });
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

  it("selects the whole link when the caret sits inside an existing link", () => {
    editor = makeEditor(
      '<p>see <a href="https://example.com">the link</a> here</p>',
    );
    // "see " = [1,5), "the link" = [5,13); put the caret inside the link text.
    editor.commands.setTextSelection(6);
    expect(editor.isActive("link")).toBe(true);
    const { placeholder } = ensureLinkableSelection(editor);
    expect(selectedText(editor)).toBe("the link");
    expect(placeholder).toBeNull();
  });

  it("reports the placeholder range so the caller can undo a cancelled link", () => {
    editor = makeEditor("<p></p>");
    editor.commands.setTextSelection(1);
    const { placeholder } = ensureLinkableSelection(editor);
    expect(placeholder).toEqual({ from: 1, to: 1 + "link".length });
    expect(selectedText(editor)).toBe("link");
  });
});
