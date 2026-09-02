import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Link } from "@tiptap/extension-link";
import {
  ensureLinkableSelection,
  shouldRemovePlaceholder,
  LINK_PLACEHOLDER,
} from "./link-selection";

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
  it("selects the word under a collapsed caret (no placeholder inserted)", () => {
    editor = makeEditor("<p>The quick brown fox</p>");
    // caret inside "quick" (doc pos: 1=start of paragraph text; "The " = 4 chars)
    editor.commands.setTextSelection(7); // within "quick"
    const { placeholder } = ensureLinkableSelection(editor);
    expect(selectedText(editor)).toBe("quick");
    // No placeholder inserted → nothing for the caller to clean up. This
    // invariant guards the destructive cancel-cleanup: a non-null here would
    // let it delete a real word on cancel.
    expect(placeholder).toBeNull();
  });

  it("keeps an existing non-empty selection (no placeholder inserted)", () => {
    editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 }); // "hello"
    const { placeholder } = ensureLinkableSelection(editor);
    expect(selectedText(editor)).toBe("hello");
    expect(placeholder).toBeNull();
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
    expect(placeholder).toEqual({ from: 1, to: 1 + LINK_PLACEHOLDER.length });
    expect(selectedText(editor)).toBe("link");
  });
});

describe("shouldRemovePlaceholder (destructive cancel-cleanup gate)", () => {
  const range = { from: 1, to: 1 + LINK_PLACEHOLDER.length };

  it("approves removing an intact, unlinked placeholder", () => {
    editor = makeEditor("<p>link</p>");
    expect(shouldRemovePlaceholder(editor, range)).toBe(true);
  });

  it("refuses when a link was applied to the range (keep the linked text)", () => {
    editor = makeEditor('<p><a href="https://example.com">link</a></p>');
    expect(shouldRemovePlaceholder(editor, range)).toBe(false);
  });

  it("refuses when the range no longer holds the placeholder text (rewritten)", () => {
    // Simulates a concurrent edit that changed the tracked span's content.
    editor = makeEditor("<p>hello</p>");
    expect(shouldRemovePlaceholder(editor, range)).toBe(false);
  });

  it("refuses an out-of-range span instead of throwing (stale collab range)", () => {
    editor = makeEditor("<p>link</p>");
    expect(shouldRemovePlaceholder(editor, { from: 1, to: 999 })).toBe(false);
    expect(shouldRemovePlaceholder(editor, { from: 3, to: 3 })).toBe(false);
  });
});
