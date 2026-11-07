import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
import { LinkExtension } from "@docmost/editor-ext";
import { modKOpensLinkPanel } from "./link-shortcut";

function makeEditor(content: string, editable = true) {
  return new Editor({
    extensions: [StarterKit.configure({ link: false }), LinkExtension, Image],
    content,
    editable,
  });
}

let editor: Editor;
afterEach(() => editor?.destroy());

const decide = (e: Editor) => modKOpensLinkPanel(e.state, e.isEditable);

// Truth table: Mod-K opens the link panel ONLY for a non-empty text selection
// that holds visible, linkable text in an editable editor; everything else
// keeps today's behaviour (search).
describe("modKOpensLinkPanel", () => {
  it("text selection in an editable editor → link panel", () => {
    editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(decide(editor)).toBe(true);
  });

  it("selection inside an existing link → link panel (edit it)", () => {
    editor = makeEditor('<p><a href="https://e.com">hello</a> world</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(decide(editor)).toBe(true);
  });

  it("selection spanning two paragraphs → link panel", () => {
    editor = makeEditor("<p>hello</p><p>world</p>");
    editor.commands.setTextSelection({ from: 3, to: 10 });
    expect(decide(editor)).toBe(true);
  });

  it("empty caret → search", () => {
    editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection(3);
    expect(decide(editor)).toBe(false);
  });

  it("read-only editor → search", () => {
    editor = makeEditor("<p>hello world</p>", false);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(decide(editor)).toBe(false);
  });

  it("the editable flag passed in decides, not the selection alone", () => {
    editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(modKOpensLinkPanel(editor.state, false)).toBe(false);
  });

  it("NodeSelection (e.g. an image) → search", () => {
    editor = makeEditor('<p>a</p><img src="https://e.com/x.png"><p>b</p>');
    let imagePos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "image") imagePos = pos;
    });
    expect(imagePos).toBeGreaterThan(-1);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        NodeSelection.create(editor.state.doc, imagePos),
      ),
    );
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(decide(editor)).toBe(false);
  });

  it("NodeSelection of a block that holds text → search", () => {
    editor = makeEditor("<blockquote><p>quoted text</p></blockquote>");
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)),
    );
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(selectedText(editor)).toBe("quoted text");
    expect(decide(editor)).toBe(false);
  });

  it("selection inside a code block (link mark not allowed) → search", () => {
    editor = makeEditor("<pre><code>const x = 1;</code></pre>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(selectedText(editor)).toBe("const");
    expect(decide(editor)).toBe(false);
  });

  it("selection inside inline code (code excludes link) → search", () => {
    editor = makeEditor("<p>run <code>npm test</code> now</p>");
    // "run " = [1,5), "npm test" = [5,13)
    editor.commands.setTextSelection({ from: 5, to: 13 });
    expect(selectedText(editor)).toBe("npm test");
    expect(decide(editor)).toBe(false);
  });

  // Decision: a whitespace-only selection has nothing visible to link (the
  // link would be invisible), so it keeps search.
  it("whitespace-only selection → search", () => {
    editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 6, to: 7 }); // the space
    expect(selectedText(editor)).toBe(" ");
    expect(decide(editor)).toBe(false);
  });

  it("whitespace plus a word → link panel", () => {
    editor = makeEditor("<p>hello world</p>");
    editor.commands.setTextSelection({ from: 6, to: 12 }); // " world"
    expect(decide(editor)).toBe(true);
  });

  it("schema without a link mark → search", () => {
    editor = new Editor({
      extensions: [StarterKit.configure({ link: false })],
      content: "<p>hello world</p>",
    });
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(decide(editor)).toBe(false);
  });
});

function selectedText(e: Editor) {
  const { from, to } = e.state.selection;
  return e.state.doc.textBetween(from, to);
}
