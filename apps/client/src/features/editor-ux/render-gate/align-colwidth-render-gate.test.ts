// #145 (review of PR 754): the same render-gate class as CccColor and the cell background. Stock TextAlign
// (paragraph/heading `textAlign`) and the table cell/header `align` attribute interpolated the stored value into
// `text-align: …`, and the table summed its first-row `colwidth` entries into `width: …px` with `+=`, so a JSON,
// API or Yjs-authored string (which never passes parseHTML) could open a second CSS declaration. Now only a listed
// alignment renders, and the table renders from numeric widths. The server schema is swept attribute by attribute in
// `apps/server/src/editor-compat/render-gate.fitness.spec.ts`; this pins the client side.
//
// jsdom caveat (as in table-column-render-gate.test.ts): the mainExtensions barrel throws under jsdom, so this builds
// a minimal schema and pins the barrel's registration by source.
import { describe, it, expect } from "vitest";
import { generateHTML, type JSONContent } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import {
  CccTextAlign,
  CustomTable,
  TableCell,
  TableHeader,
  TableRow,
} from "@docmost/editor-ext";
import extensionsSource from "@/features/editor/extensions/extensions.ts?raw";

const extensions = [
  StarterKit,
  CccTextAlign.configure({ types: ["heading", "paragraph"] }),
  CustomTable,
  TableRow,
  TableCell.extend({ content: "paragraph+" }),
  TableHeader.extend({ content: "paragraph+" }),
];

const HOSTILE = [
  "left; background-image:url(https://x)",
  "center;position:fixed",
  "inherit",
  "start",
  "",
  42,
  ["left"],
];

const para = (textAlign?: unknown): JSONContent => ({
  type: "paragraph",
  attrs: textAlign === undefined ? undefined : { textAlign },
  content: [{ type: "text", text: "x" }],
});

const table = (cell: Record<string, unknown>): JSONContent => ({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", attrs: cell, content: [para()] },
            { type: "tableCell", attrs: cell, content: [para()] },
          ],
        },
      ],
    },
  ],
});

const html = (doc: JSONContent) => generateHTML(doc, extensions);

describe("text alignment render gate (#145)", () => {
  it.each(["left", "center", "right", "justify"])("renders %j", (value) => {
    expect(html({ type: "doc", content: [para(value)] })).toContain(
      `style="text-align: ${value}`,
    );
  });

  it.each(HOSTILE)("emits no style for paragraph/heading %j", (value) => {
    const out = html({
      type: "doc",
      content: [
        para(value),
        {
          type: "heading",
          attrs: { level: 2, textAlign: value },
          content: [{ type: "text", text: "h" }],
        },
      ],
    });
    expect(out).not.toContain("style=");
  });

  it("is what the client schema registers (not the stock extension)", () => {
    expect(extensionsSource).toMatch(/^\s*CccTextAlign\.configure\(\{/m);
    expect(extensionsSource).not.toMatch(/^\s*TextAlign\.configure\(/m);
    expect(extensionsSource).not.toContain(`from "@tiptap/extension-text-align"`);
  });
});

describe("table cell / header align render gate (#145)", () => {
  it.each(["left", "center", "right"])("renders %j on both cell types", (value) => {
    const out = html(table({ align: value }));
    expect(out.match(new RegExp(`style="text-align: ${value}`, "g"))).toHaveLength(2);
  });

  it.each([...HOSTILE, "justify"])("emits no text-align for %j", (value) => {
    expect(html(table({ align: value }))).not.toContain("text-align");
  });
});

describe("table colwidth render gate (#145)", () => {
  const tableStyle = (colwidth: unknown) =>
    /<table style="([^"]*)"/.exec(html(table({ colwidth })))?.[1];

  it("numeric widths render the same width as before", () => {
    expect(tableStyle([100])).toBe("width: 200px;");
  });

  it("a plain decimal string renders as its number", () => {
    expect(tableStyle(["100"])).toBe("width: 200px;");
  });

  it.each([
    ["1px; background-image:url(https://x); --tail:"],
    "1px; background-image:url(https://x); --tail:",
    [{ a: 1 }],
  ])("a hostile colwidth %j renders no extra declaration", (colwidth) => {
    const style = tableStyle(colwidth) ?? "";
    expect(style).not.toContain("url(");
    expect(style).not.toContain("background");
    expect(style).toMatch(/^(min-)?width: \d+px;?$/);
  });
});
