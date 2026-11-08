// #145: the blank-page placeholder decorates the first block ONLY while the document is empty, editable and
// unfocused (the upstream Placeholder covers the focused case), and it hides/reappears as focus changes.
// (The focus/blur recompute is pinned as behaviour: tiptap core's FocusEvents plugin already dispatches a
// meta transaction on focus/blur, so the extension's own onFocus/onBlur dispatch is belt-and-braces.)
import { describe, it, expect, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { EmptyDocPlaceholder } from "./empty-doc-placeholder";

// The i18n singleton initialises i18next-http-backend; the key is enough here.
vi.mock("@/i18n.ts", () => ({ default: { t: (key: string) => key } }));

const KEY = 'Write anything. Enter "/" for commands';

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
  document.body.innerHTML = "";
});

function makeEditor(content = "", editable = true) {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [StarterKit, EmptyDocPlaceholder],
    content,
    editable,
  });
  return editor;
}

const placeholder = (e: Editor) =>
  e.view.dom.querySelector<HTMLElement>(".is-editor-empty[data-placeholder]");

describe("EmptyDocPlaceholder", () => {
  it("decorates the first block of an empty, editable, unfocused document", () => {
    const e = makeEditor();
    const el = placeholder(e);
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-placeholder")).toBe(KEY);
    expect(el).toBe(e.view.dom.firstElementChild);
  });

  it("does not decorate a document with content", () => {
    expect(placeholder(makeEditor("<p>hi</p>"))).toBeNull();
  });

  it("does not decorate a read-only document", () => {
    expect(placeholder(makeEditor("", false))).toBeNull();
  });

  it("is removed when the editor becomes read-only and restored when editable again", () => {
    const e = makeEditor();
    e.setEditable(false);
    expect(placeholder(e)).toBeNull();
    e.setEditable(true);
    expect(placeholder(e)).not.toBeNull();
  });

  it("hides on focus and reappears on blur", () => {
    const e = makeEditor();
    e.view.dom.dispatchEvent(new FocusEvent("focus"));
    expect(e.isFocused).toBe(true);
    expect(placeholder(e)).toBeNull();

    e.view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(e.isFocused).toBe(false);
    expect(placeholder(e)).not.toBeNull();
  });

  it("disappears once text is typed and returns when it is deleted", () => {
    const e = makeEditor();
    e.commands.insertContent("x");
    // Typing normally implies focus; blur so only the emptiness guard is under test.
    e.view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(placeholder(e)).toBeNull();

    e.commands.clearContent(true);
    e.view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(placeholder(e)).not.toBeNull();
  });
});
