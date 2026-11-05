// #407: CustomCodeBlock + the fork's empty lowlight + CodeHighlightLoader in a real (minimal) Tiptap
// editor. The grammar chunk is the REAL module, held behind a gate so each test decides when the lazy
// import lands. jsdom caveat: the mainExtensions barrel throws under jsdom (localStorage), so the editor
// carries only what highlighting touches.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { undoDepth } from "@tiptap/pm/history";

const gate = vi.hoisted(() => ({
  release: () => {},
  promise: Promise.resolve(),
  reset() {
    this.promise = new Promise<void>((r) => (this.release = r));
  },
}));
vi.mock("./grammars", async (importOriginal) => {
  await gate.promise;
  return importOriginal();
});

// Fresh module graph per test (the load memo is module state); everything the editor is built from is
// imported AFTER the reset so the extension classes and the store all come from the same graph.
async function load() {
  const [
    { Editor },
    { StarterKit },
    { CustomCodeBlock, TrailingNode },
    store,
    loader,
    hook,
  ] = await Promise.all([
    import("@tiptap/core"),
    import("@tiptap/starter-kit"),
    import("@docmost/editor-ext"),
    import("./lowlight"),
    import("./code-highlight-loader"),
    import("./use-code-languages"),
  ]);
  const makeEditor = (content: object) =>
    new Editor({
      element: document.createElement("div"),
      extensions: [
        // As in extensions.ts: the fork's TrailingNode (appends only on a local doc change), not StarterKit's
        // (which would append on the refresh transaction itself).
        StarterKit.configure({ codeBlock: false, trailingNode: false }),
        TrailingNode,
        // No React renderer under a plain Editor: the node view falls back to the schema's toDOM.
        CustomCodeBlock.configure({ view: null, lowlight: store.lowlight }),
        loader.CodeHighlightLoader,
      ],
      content,
    });
  return { makeEditor, store, useCodeLanguages: hook.useCodeLanguages };
}

const codeDoc = (language: string | null, text: string) => ({
  type: "doc",
  content: [
    {
      type: "codeBlock",
      attrs: { language },
      content: [{ type: "text", text }],
    },
  ],
});

const hljsSpans = (editor: { view: { dom: HTMLElement } }) =>
  editor.view.dom.querySelectorAll('code span[class*="hljs-"]');

const editors: { destroy(): void }[] = [];
beforeEach(() => {
  vi.resetModules();
  gate.reset();
});
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
});

// Generous timeout: the first test pays the cold transform of tiptap + every grammar in the fresh graph.
describe("CodeHighlightLoader (#407)", { timeout: 30_000 }, () => {
  it("renders plain code until the grammars land, then decorates explicit and auto-detected blocks", async () => {
    const { makeEditor, store } = await load();
    const explicit = makeEditor(codeDoc("javascript", "const answer = 42;"));
    const auto = makeEditor(
      codeDoc(null, "def greet(name):\n    return f'hello {name}'\n"),
    );
    editors.push(explicit, auto);
    const jsonBefore = [explicit.getJSON(), auto.getJSON()];

    expect(hljsSpans(explicit)).toHaveLength(0);
    expect(hljsSpans(auto)).toHaveLength(0);

    gate.release();
    await store.loadCodeGrammars();

    expect(hljsSpans(explicit).length).toBeGreaterThan(0);
    expect(explicit.view.dom.querySelector(".hljs-keyword")?.textContent).toBe(
      "const",
    );
    expect(hljsSpans(auto).length).toBeGreaterThan(0);
    // Meta-only refresh: the document is untouched and nothing reached the undo history.
    expect([explicit.getJSON(), auto.getJSON()]).toEqual(jsonBefore);
    expect(undoDepth(explicit.state)).toBe(0);
    expect(undoDepth(auto.state)).toBe(0);
  });

  it("does not dispatch into an editor destroyed before the load lands", async () => {
    const { makeEditor, store } = await load();
    const gone = makeEditor(codeDoc("javascript", "let x = 1;"));
    const dispatch = vi.spyOn(gone.view, "dispatch");
    gone.destroy();

    gate.release();
    await store.loadCodeGrammars();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("an editor mounted after the load is decorated at init", async () => {
    const { makeEditor, store } = await load();
    gate.release();
    await store.loadCodeGrammars();

    const editor = makeEditor(codeDoc("javascript", "const later = true;"));
    editors.push(editor);
    expect(hljsSpans(editor).length).toBeGreaterThan(0);
  });

  it("useCodeLanguages re-renders with the registered languages when the load completes", async () => {
    const { store, useCodeLanguages } = await load();
    const { result } = renderHook(() => useCodeLanguages());
    expect(result.current).toEqual([]);

    gate.release();
    await act(() => store.loadCodeGrammars());
    expect(result.current).toContain("javascript");
    expect(result.current).toContain("abap");
    expect(result.current).toContain("mermaid");
    expect(result.current).toEqual([...result.current].sort());
  });
});
