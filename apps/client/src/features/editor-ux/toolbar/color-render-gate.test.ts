// #145: stock Tiptap `Color`/`Highlight` interpolate the stored attribute into
// inline CSS, so a JSON/API/Yjs-authored value like
// `red; background:url(https://x)` became a second declaration in the DOM.
// CccColor/CccHighlight render the style only for a safe CSS colour token.
//
// jsdom caveat (see typography-extension.test.ts): the mainExtensions barrel
// throws under jsdom, so each test builds a minimal editor.
import { describe, it, expect, afterEach } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import {
  CccColor,
  CccHighlight,
  Highlight,
  safeCssColor,
} from "@docmost/editor-ext";
// Source text only (never evaluated): the swatches the colour picker offers,
// and the client schema wiring.
import colorSelectorSource from "@/features/editor/components/bubble-menu/color-selector.tsx?raw";
import extensionsSource from "@/features/editor/extensions/extensions.ts?raw";

const docWith = (marks: JSONContent["marks"]): JSONContent => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "x", marks }] },
  ],
});
const colored = (color: unknown) =>
  docWith([{ type: "textStyle", attrs: { color } }]);
const highlighted = (color: unknown) =>
  docWith([{ type: "highlight", attrs: { color, colorName: "red" } }]);

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

function makeEditor(gated: boolean, content: JSONContent): Editor {
  const editor = new Editor({
    extensions: gated
      ? [
          StarterKit,
          TextStyle,
          CccColor,
          CccHighlight.configure({ multicolor: true }),
        ]
      : [
          StarterKit,
          TextStyle,
          Color,
          Highlight.configure({ multicolor: true }),
        ],
    content,
  });
  editors.push(editor);
  return editor;
}

/** Serialized DOM (jsdom normalizes colours, e.g. `#2563EB` → `rgb(…)`). */
function render(gated: boolean, content: JSONContent): string {
  return makeEditor(gated, content).getHTML();
}

/** The raw `toDOM` output of the first text node's marks — the exact strings
 *  renderHTML produced, before any DOM normalization. */
function markSpecs(gated: boolean, content: JSONContent): unknown[] {
  const editor = makeEditor(gated, content);
  const text = editor.state.doc.firstChild?.firstChild;
  return (text?.marks ?? []).map((m) => m.type.spec.toDOM?.(m, true));
}

// Every non-empty `color: "…"` literal in the picker (TEXT_COLORS + HIGHLIGHT_COLORS).
const SWATCHES = [...colorSelectorSource.matchAll(/color:\s*"([^"]+)"/g)].map(
  (m) => m[1],
);

const LEGIT = [
  ...SWATCHES,
  "#fff",
  "#ffff",
  "#E00000",
  "#e0000080",
  "red",
  "transparent",
  "currentColor",
  "rgb(255, 0, 0)",
  "rgba(255, 0, 0, 0.5)",
  "rgb(255 0 0 / 50%)",
  "hsl(210, 50%, 40%)",
  "hsla(210deg 50% 40% / 0.3)",
  "var(--mantine-color-red-6)",
];

const HOSTILE = [
  "red; background:url(https://x)",
  "red;background-image:url(https://x)",
  "url(https://x)",
  "red url(https://x)",
  "rgb(0,0,0); position: fixed",
  "rgb(0,0,0) url(x)",
  "rgb(var(--a))",
  "var(--a); color: red",
  "expression(alert(1))",
  '"red"',
  "red !important",
  "red\;",
  "#ff0000;",
  "#ff000",
  "inherit:x",
  "",
  42,
  { toString: () => "red" },
];

describe("safeCssColor", () => {
  it("finds the picker swatches in the source (guards the extraction)", () => {
    expect(SWATCHES.length).toBeGreaterThanOrEqual(18);
  });

  it.each(LEGIT)("accepts %j", (value) => {
    expect(safeCssColor(value)).toBe(value);
  });

  it.each(HOSTILE.map((v) => [v]))("rejects %j", (value) => {
    expect(safeCssColor(value)).toBeNull();
  });
});

describe("CccColor / CccHighlight render gate", () => {
  it.each(LEGIT)("renders %j identically to the stock extensions", (value) => {
    expect(markSpecs(true, colored(value))).toEqual(
      markSpecs(false, colored(value)),
    );
    expect(markSpecs(true, highlighted(value))).toEqual(
      markSpecs(false, highlighted(value)),
    );
    expect(JSON.stringify(markSpecs(true, colored(value)))).toContain(
      `color: ${value}`,
    );
    expect(JSON.stringify(markSpecs(true, highlighted(value)))).toContain(
      `background-color: ${value}; color: inherit`,
    );
    expect(render(true, colored(value))).toBe(render(false, colored(value)));
  });

  it.each(HOSTILE.filter((v) => typeof v === "string" && v).map((v) => [v]))(
    "emits no style for hostile %j",
    (value) => {
      const text = render(true, colored(value));
      expect(text).not.toContain("style=");
      expect(text).not.toContain("url(");
      const mark = render(true, highlighted(value));
      expect(mark).not.toContain("style=");
      expect(mark).not.toContain("data-color=");
      expect(mark).not.toContain("url(");
      // The mark itself survives; only the unsafe CSS is withheld.
      expect(mark).toContain('<mark data-highlight-color-name="red">x</mark>');
    },
  );

  it("keeps the stock commands (setColor / toggleHighlight)", () => {
    const editor = new Editor({
      extensions: [
        StarterKit,
        TextStyle,
        CccColor,
        CccHighlight.configure({ multicolor: true }),
      ],
      content: "<p>x</p>",
    });
    editors.push(editor);
    editor
      .chain()
      .selectAll()
      .setColor("#2563EB")
      .toggleHighlight({ color: "#faf594" })
      .run();
    const marks = editor.state.doc.firstChild?.firstChild?.marks ?? [];
    expect(marks.map((m) => [m.type.name, m.attrs.color]).sort()).toEqual([
      ["highlight", "#faf594"],
      ["textStyle", "#2563EB"],
    ]);
    expect(editor.getHTML()).toContain('data-color="#faf594"');
    expect(editor.getHTML()).toContain("color: rgb(37, 99, 235)");
  });

  it("is what the client schema registers (not the stock extensions)", () => {
    expect(extensionsSource).toMatch(/^\s*CccColor,$/m);
    expect(extensionsSource).toMatch(/^\s*CccHighlight\.configure\(\{/m);
    expect(extensionsSource).not.toMatch(/^\s*Color,$/m);
    expect(extensionsSource).not.toMatch(/^\s*Highlight\.configure\(/m);
  });
});
