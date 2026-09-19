// #345 defect 5 (+ two same-class adjacent bugs) — reactive editor extensions must NOT rewrite content that
// arrived over the collaboration sync (API/MCP/another client). Each mutator (TrailingNode, AutoJoiner,
// Indent) is guarded to act only on a LOCAL doc change, mirroring UniqueID's `!isChangeOrigin(t)` filter.
// A remote/sync transaction is simulated by setting the ySync meta that `isChangeOrigin` reads.
//
// jsdom caveat (see typography-extension.test.ts): the mainExtensions barrel throws under jsdom (localStorage),
// so each test builds a MINIMAL editor with only the extension under test.
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { TrailingNode, Indent } from "@docmost/editor-ext";
import AutoJoiner from "./autojoiner";

const guard = (t: any) => !isChangeOrigin(t);

// Mark a transaction as a collaboration change-origin (remote sync) transaction — exactly what
// `isChangeOrigin` detects (`!!tr.getMeta(ySyncPluginKey)`).
function markRemote(tr: any) {
  tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
  return tr;
}

describe("TrailingNode change-origin guard (#345)", () => {
  let editor: Editor;
  afterEach(() => editor?.destroy());

  const make = () =>
    new Editor({
      extensions: [
        StarterKit.configure({ trailingNode: false }),
        TrailingNode.configure({ filterTransaction: guard }),
      ],
      content: "<p>hello</p>",
    });

  // Insert a heading (a non-paragraph node) at the very end of the doc.
  const appendHeading = (remote: boolean) => {
    const { state } = editor;
    const heading = state.schema.nodes.heading.create(
      { level: 1 },
      state.schema.text("H"),
    );
    const tr = state.tr.insert(state.doc.content.size, heading);
    editor.view.dispatch(remote ? markRemote(tr) : tr);
  };

  it("does NOT append a trailing paragraph for a remote (change-origin) change", () => {
    editor = make();
    appendHeading(true);
    expect(editor.state.doc.lastChild?.type.name).toBe("heading");
  });

  it("DOES append a trailing paragraph for a local change", () => {
    editor = make();
    appendHeading(false);
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
  });
});

describe("AutoJoiner change-origin guard (#345)", () => {
  let editor: Editor;
  afterEach(() => editor?.destroy());

  const make = () =>
    new Editor({
      extensions: [
        StarterKit.configure({ trailingNode: false }),
        AutoJoiner.configure({ elementsToJoin: [] }),
      ],
      // one bullet list; the test inserts a second, adjacent one.
      content: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "a" }] },
                ],
              },
            ],
          },
        ],
      },
    });

  const countLists = () => {
    let n = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "bulletList") n++;
    });
    return n;
  };

  const insertAdjacentList = (remote: boolean) => {
    const { state } = editor;
    const para = state.schema.nodes.paragraph.create(null, state.schema.text("b"));
    const li = state.schema.nodes.listItem.create(null, para);
    const list = state.schema.nodes.bulletList.create(null, li);
    const tr = state.tr.insert(state.doc.content.size, list);
    editor.view.dispatch(remote ? markRemote(tr) : tr);
  };

  it("does NOT merge adjacent lists for a remote (change-origin) change", () => {
    editor = make();
    insertAdjacentList(true);
    expect(countLists()).toBe(2); // two lists remain — not auto-joined
  });

  it("DOES merge adjacent lists for a local change", () => {
    editor = make();
    insertAdjacentList(false);
    expect(countLists()).toBe(1); // merged into one
  });
});

describe("Indent normalizer change-origin guard (#345)", () => {
  let editor: Editor;
  afterEach(() => editor?.destroy());

  const make = () =>
    new Editor({
      extensions: [
        StarterKit.configure({ trailingNode: false }),
        Indent.configure({ filterTransaction: guard }),
      ],
      // a paragraph inside a listItem (a non-indentable ancestor) — an illegal indent there is normalized.
      content: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "x" }] },
                ],
              },
            ],
          },
        ],
      },
    });

  const paragraphPos = () => {
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.type.name === "paragraph" && pos < 0) pos = p;
    });
    return pos;
  };
  const paragraphIndent = () => {
    let indent: number | undefined;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "paragraph" && indent === undefined)
        indent = node.attrs.indent;
    });
    return indent;
  };

  const setIllegalIndent = (remote: boolean) => {
    const { state } = editor;
    const pos = paragraphPos();
    const node = state.doc.nodeAt(pos)!;
    const tr = state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      indent: 2,
    });
    editor.view.dispatch(remote ? markRemote(tr) : tr);
  };

  it("does NOT normalize an illegal indent for a remote (change-origin) change", () => {
    editor = make();
    setIllegalIndent(true);
    expect(paragraphIndent()).toBe(2); // left as-authored elsewhere
  });

  it("DOES normalize an illegal indent for a local change", () => {
    editor = make();
    setIllegalIndent(false);
    expect(paragraphIndent()).toBe(0); // reset to min
  });
});
