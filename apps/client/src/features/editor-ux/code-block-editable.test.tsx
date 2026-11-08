// #407 follow-up: the code block view (language picker, mermaid source visibility) follows the editor's editable state. Pages open in
// Read mode and switch with `editor.setEditable()`, which re-renders no ReactNodeView, so a picker that
// read `editor.isEditable` at render time stayed disabled after switching to Edit until something inside
// that block changed. Rendered for real: a minimal Tiptap editor (the mainExtensions barrel throws under
// jsdom) with CustomCodeBlock({ view: CodeBlockView }) inside EditorContent.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import {
  Editor,
  EditorContent,
  useEditor,
  useEditorState,
} from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { CustomCodeBlock } from "@docmost/editor-ext";
import { lowlight } from "@/features/editor-ux/code-highlight/lowlight";
import CodeBlockView from "@/features/editor/components/code-block/code-block-view";
import { useEditorEditable } from "./use-editor-editable";

// The diagram renderer (mermaid) is not under test; only the source <pre>'s visibility is.
vi.mock("@/features/editor/components/code-block/mermaid-view.tsx", () => ({
  default: () => null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Mantine's Select (Combobox/Popover) needs matchMedia + ResizeObserver in jsdom.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(cleanup);

const codeDoc = (language: string) => ({
  type: "doc",
  content: [
    {
      type: "codeBlock",
      attrs: { language },
      content: [{ type: "text", text: "graph TD; A-->B" }],
    },
  ],
});

// Mounts the editor in Read mode (as pages open) and returns it with a DOM query that first lets the
// node view's portal render.
async function mount(language: string, editable: boolean) {
  let editor: Editor | null = null;
  function Harness() {
    const e = useEditor({
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        // As in extensions.ts: editor-ext wraps the view in ReactNodeViewRenderer.
        CustomCodeBlock.configure({ view: CodeBlockView, lowlight }),
      ],
      content: codeDoc(language),
      editable,
      immediatelyRender: true,
    });
    // Captured in an effect, not during render (react-hooks/globals); render() runs effects inside act().
    useEffect(() => {
      editor = e;
    }, [e]);
    return (
      <MantineProvider>
        <EditorContent editor={e} />
      </MantineProvider>
    );
  }
  const { container } = render(<Harness />);
  const query = async <T extends Element>(selector: string) => {
    await act(async () => {});
    const el = container.querySelector<T>(selector);
    expect(el).not.toBeNull();
    return el!;
  };
  await query(".codeBlock");
  return { editor: editor! as Editor, query };
}

describe("CodeBlockView follows setEditable (#407 follow-up)", () => {
  it("language picker: enabled after setEditable(true), disabled after setEditable(false), block untouched", async () => {
    const { editor, query } = await mount("javascript", false);
    const picker = () => query<HTMLInputElement>(".codeBlock input");

    expect((await picker()).disabled).toBe(true);
    const before = editor.getJSON();

    await act(async () => editor.setEditable(true));
    expect((await picker()).disabled).toBe(false);

    await act(async () => editor.setEditable(false));
    expect((await picker()).disabled).toBe(true);

    // Nothing inside the block changed: only the editable flag drove the re-render.
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  it("mermaid source: a selected block's source hides on setEditable(false), shows again on setEditable(true)", async () => {
    const { editor, query } = await mount("mermaid", true);
    const pre = () => query<HTMLPreElement>(".codeBlock pre");

    // Selected while editable: the source is shown.
    await act(async () => editor.commands.setTextSelection(3));
    expect((await pre()).hidden).toBe(false);

    await act(async () => editor.setEditable(false));
    expect((await pre()).hidden).toBe(true);

    await act(async () => editor.setEditable(true));
    expect((await pre()).hidden).toBe(false);
    editor.destroy();
  });
});

describe("useEditorEditable", () => {
  it("re-renders on setEditable, where @tiptap/react's useEditorState does not", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit],
      editable: false,
    });
    const ours = renderHook(() => useEditorEditable(editor));
    const tiptap = renderHook(() =>
      useEditorState({ editor, selector: (ctx) => ctx.editor.isEditable }),
    );
    expect(ours.result.current).toBe(false);

    act(() => editor.setEditable(true));
    expect(ours.result.current).toBe(true);
    // useEditorState subscribes to 'transaction' only; setEditable emits 'update' with no transaction
    // (@tiptap/core 3.27.1), so the selector is never re-run. Pinned so an upgrade that changes this
    // is noticed (the hook could then be replaced by useEditorState).
    expect(tiptap.result.current).toBe(false);

    act(() => editor.setEditable(false));
    expect(ours.result.current).toBe(false);
    editor.destroy();
  });
});
