import { describe, it, expect, afterEach } from "vitest";
import { Editor, Node } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { LinkExtension } from "@docmost/editor-ext";
import {
  ensureLinkableSelection,
  shouldRemovePlaceholder,
  LINK_PLACEHOLDER,
} from "./link-selection";

// A minimal inline atom: one doc position, no text — the shape of a mention,
// status or inline-math node (none of which set `leafText`).
const InlineAtom = Node.create({
  name: "inlineAtom",
  group: "inline",
  inline: true,
  atom: true,
  parseHTML: () => [{ tag: "span[data-atom]" }],
  renderHTML: () => ["span", { "data-atom": "" }],
});

// The production link mark (`inclusive: false`), not StarterKit's bundled one,
// so link-boundary behaviour matches the real editor.
function makeEditor(content: string | object) {
  return new Editor({
    extensions: [
      StarterKit.configure({ link: false }),
      LinkExtension,
      InlineAtom,
    ],
    content,
  });
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

describe("ensureLinkableSelection: word bounds (#145)", () => {
  // Each case: content, caret position, expected selected range + text. Every
  // word case must also report NO placeholder — a non-null there would let the
  // cancel-cleanup delete real text.
  const pick = (content: string | object, caret: number) => {
    editor = makeEditor(content);
    editor.commands.setTextSelection(caret);
    const { placeholder } = ensureLinkableSelection(editor);
    const { from, to } = editor.state.selection;
    return { from, to, text: selectedText(editor), placeholder };
  };

  // "foo bar": f1 o2 o3 ␠4 b5 a6 r7, end 8.
  it.each([
    ["caret mid-word", 2, "foo"],
    ["caret at word start (paragraph start)", 1, "foo"],
    ["caret at word end, before a space (left bias)", 4, "foo"],
    ["caret after a space, at the next word's start", 5, "bar"],
    ["caret at paragraph end", 8, "bar"],
  ])("%s", (_name, caret, expected) => {
    const r = pick("<p>foo bar</p>", caret);
    expect(r.text).toBe(expected);
    expect(r.placeholder).toBeNull();
  });

  // HTML parsing collapses runs of whitespace, so these use JSON content.
  const para = (text: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

  it("inserts a placeholder (no word) when the caret is between two spaces", () => {
    // "foo␠␠bar": the caret at 5 sits between the two spaces.
    const r = pick(para("foo  bar"), 5);
    expect(r.placeholder).toEqual({ from: 5, to: 5 + LINK_PLACEHOLDER.length });
    expect(r.text).toBe(LINK_PLACEHOLDER);
    expect(editor.state.doc.textContent).toBe("foo link bar");
  });

  it("inserts a placeholder after a trailing space", () => {
    const r = pick(para("foo "), 5);
    expect(r.placeholder).toEqual({ from: 5, to: 5 + LINK_PLACEHOLDER.length });
  });

  // Punctuation is part of the word (only whitespace bounds it) — kept on
  // purpose so a URL-like token is linked whole. Pinned so a change is deliberate.
  it.each([
    ["trailing punctuation", "<p>the end.</p>", 9, "end."],
    ["wrapping punctuation", "<p>(see) it</p>", 3, "(see)"],
    ["a URL-like token", "<p>go https://x.com/a now</p>", 8, "https://x.com/a"],
    ["NBSP is a boundary", "<p>foo\u00a0bar</p>", 2, "foo"],
  ])("%s", (_name, content, caret, expected) => {
    const r = pick(content, caret);
    expect(r.text).toBe(expected);
    expect(r.placeholder).toBeNull();
  });

  // "foo<br>bar baz": f1 o2 o3 br4 b5 a6 r7 ␠8 b9 a10 z11. textContent drops the
  // break ("foobar baz"), so indexing it by parentOffset shifts the range.
  it("selects the word after a hard break (not shifted by the break)", () => {
    const r = pick("<p>foo<br>bar baz</p>", 10);
    expect(r).toMatchObject({
      from: 9,
      to: 12,
      text: "baz",
      placeholder: null,
    });
  });

  it("treats a hard break as a word boundary", () => {
    const right = pick("<p>foo<br>bar baz</p>", 6);
    expect(right).toMatchObject({ from: 5, to: 8, text: "bar" });
    editor.destroy();
    const left = pick("<p>foo<br>bar baz</p>", 2);
    expect(left).toMatchObject({ from: 1, to: 4, text: "foo" });
  });

  it("selects the word right after a hard break with the caret at its start", () => {
    const r = pick("<p>foo<br>bar</p>", 5);
    expect(r).toMatchObject({ from: 5, to: 8, text: "bar" });
  });

  // atom1 ␠2 h3 e4 l5 l6 o7 ␠8 w9 o10 r11 l12 d13
  it("selects the word after an inline atom (not shifted by the atom)", () => {
    const r = pick("<p><span data-atom></span> hello world</p>", 11);
    expect(r).toMatchObject({
      from: 9,
      to: 14,
      text: "world",
      placeholder: null,
    });
  });

  it("does not pull an adjacent inline atom into the word", () => {
    // atom1 f2 o3 o4 ␠5 …
    const r = pick("<p><span data-atom></span>foo bar</p>", 3);
    expect(r).toMatchObject({ from: 2, to: 5, text: "foo", placeholder: null });
  });

  // Links are `inclusive: false`, so at a link's edge `isActive("link")` is
  // false. A word under the caret never partially overlaps a link; with no
  // word, a caret touching a link selects that whole link (edit/remove).
  it("selects the plain word right after a link, not across the link edge", () => {
    // link "link" = [1,5), "text" = [5,9)
    const r = pick('<p><a href="https://e.com">link</a>text</p>', 5);
    expect(r).toMatchObject({
      from: 5,
      to: 9,
      text: "text",
      placeholder: null,
    });
  });

  it("keeps a word that touches a link to its unlinked part", () => {
    // link "link" = [1,5), "ab c" = [5,9); caret inside "ab"
    const r = pick('<p><a href="https://e.com">link</a>ab c</p>', 6);
    expect(r).toMatchObject({ from: 5, to: 7, text: "ab", placeholder: null });
  });

  it.each([
    [
      "at the end of a link that ends the paragraph",
      '<p><a href="https://e.com">the link</a></p>',
      9,
    ],
    [
      "at the end of a link followed by a space",
      '<p><a href="https://e.com">the link</a> after</p>',
      9,
    ],
    [
      "at the start of a link preceded by a space",
      '<p>foo <a href="https://e.com">the link</a></p>',
      5,
    ],
    [
      "at the start of a link that starts the paragraph",
      '<p><a href="https://e.com">the link</a> x</p>',
      1,
    ],
  ])("selects the whole link with the caret %s", (_name, content, caret) => {
    const r = pick(content, caret);
    expect(r.text).toBe("the link");
    expect(r.placeholder).toBeNull();
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
