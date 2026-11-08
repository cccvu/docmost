// #145: the same render-gate class as CccColor/CccHighlight. Upstream TableCell/TableHeader interpolated
// `backgroundColor` into `background-color: …` and Column interpolated `width` into `flex: …`, so a JSON,
// API or Yjs-authored value (which never passes parseHTML) could open a second CSS declaration. Both now
// render only a safe value: a single CSS colour token (safeCssColor) and a finite positive number.
//
// jsdom caveat: the mainExtensions barrel throws under jsdom, so this builds a minimal schema. The cell
// content expression names upstream nodes this schema lacks, so the test narrows it to `paragraph+`; the
// attributes under test (and their renderHTML) are inherited unchanged.
import { describe, it, expect } from "vitest";
import {
  generateHTML,
  generateJSON,
  getSchema,
  type JSONContent,
} from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import {
  Column,
  Columns,
  TableCell,
  TableHeader,
  TableRow,
} from "@docmost/editor-ext";
import { TABLE_COLORS } from "@/features/editor/components/table/table-background-color";

const extensions = [
  StarterKit,
  Table,
  TableRow,
  TableCell.extend({ content: "paragraph+" }),
  TableHeader.extend({ content: "paragraph+" }),
  Columns,
  Column,
];
const schema = getSchema(extensions);
const para: JSONContent = {
  type: "paragraph",
  content: [{ type: "text", text: "x" }],
};

const table = (backgroundColor: unknown): JSONContent => ({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { backgroundColor },
              content: [para],
            },
            { type: "tableCell", attrs: { backgroundColor }, content: [para] },
          ],
        },
      ],
    },
  ],
});

const columns = (width: unknown): JSONContent => ({
  type: "doc",
  content: [
    {
      type: "columns",
      content: [
        { type: "column", attrs: { width }, content: [para] },
        { type: "column", content: [para] },
      ],
    },
  ],
});

/** The raw attrs renderHTML produced for every node of `type` (before any DOM normalization). */
function rawAttrs(doc: JSONContent, type: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  schema.nodeFromJSON(doc).descendants((node) => {
    if (node.type.name !== type) return;
    const spec = node.type.spec.toDOM?.(node) as unknown as [
      string,
      Record<string, unknown>,
    ];
    out.push(spec[1] ?? {});
  });
  return out;
}

const HOSTILE_COLORS = [
  "red; background:url(https://x)",
  "url(https://x)",
  "rgb(0,0,0); position: fixed",
  '"red"',
  "red !important",
  "",
  42,
  { a: 1 },
];

const HOSTILE_WIDTHS = [
  "1; background-image:url(https://x)",
  "1 1 0%",
  "calc(100% - 1px)",
  "",
  -1,
  0,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  { a: 1 },
  true,
];

describe("table cell / header background render gate (#145)", () => {
  // Every swatch the table colour menus offer (TABLE_COLORS feeds all three menus), plus the forms a
  // browser's element.style reports when cell HTML is pasted or imported.
  const LEGIT = [
    ...TABLE_COLORS.map((c) => c.color).filter(Boolean),
    "rgb(180, 213, 255)",
    "var(--mantine-color-blue-1)",
  ];

  it("covers the real menu swatches", () => {
    expect(LEGIT.length).toBeGreaterThanOrEqual(7);
  });

  it.each(LEGIT)("renders %j on both cell types", (value) => {
    for (const type of ["tableCell", "tableHeader"]) {
      const [attrs] = rawAttrs(table(value), type);
      expect(attrs.style).toBe(`background-color: ${value}`);
      expect(attrs["data-background-color"]).toBe(value);
    }
  });

  it.each(HOSTILE_COLORS)(
    "emits no style or data attribute for %j",
    (value) => {
      for (const type of ["tableCell", "tableHeader"]) {
        const [attrs] = rawAttrs(table(value), type);
        expect(attrs.style).toBeUndefined();
        expect(attrs["data-background-color"]).toBeUndefined();
      }
      const html = generateHTML(table(value), extensions);
      expect(html).not.toContain("url(");
      expect(html).not.toContain("background-color");
    },
  );
});

describe("column width render gate (#145)", () => {
  it.each([1, 2.5, 33.333, "2", "0.5"])("renders width %j as flex", (value) => {
    const [attrs] = rawAttrs(columns(value), "column");
    expect(attrs.style).toBe(`flex: ${Number(value)}`);
    expect(attrs["data-width"]).toBe(Number(value));
  });

  it.each(HOSTILE_WIDTHS)("emits no flex for %j", (value) => {
    const [attrs] = rawAttrs(columns(value), "column");
    expect(attrs.style).toBeUndefined();
    expect(attrs["data-width"]).toBeUndefined();
    expect(generateHTML(columns(value), extensions)).not.toContain("flex");
  });

  it("round-trips a parsed data-width and a pasted cell background", () => {
    const html =
      '<div data-type="columns"><div data-type="column" data-width="40"><p>x</p></div><div data-type="column"><p>y</p></div></div>' +
      '<table><tbody><tr><td style="background-color: #b4d5ff"><p>z</p></td></tr></tbody></table>';
    const out = generateHTML(generateJSON(html, extensions), extensions);
    expect(out).toContain('data-width="40"');
    expect(out).toContain("flex: 40");
    // jsdom's element.style reports the parsed colour as rgb(); the gate accepts that form.
    expect(out).toMatch(/data-background-color="rgb\(180, 213, 255\)"/);
  });
});
