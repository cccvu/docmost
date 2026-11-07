/**
 * CCC render-gate fitness function (#145, review of PR 754). Fork-owned.
 *
 * Stored editor JSON is not normalized on ingest (/v1, MCP and Yjs keep attribute values exactly as authored), so the
 * render path is the only CSS gate (ADR 0012 amendment, AGENTS.md). The per-extension specs pin each gate; this one
 * pins the RULE across the whole server schema (`tiptapExtensions`, what share pages, exports and `format=html` reads
 * render with): it sets every attribute of every node and mark, one at a time, to a hostile value and asserts that no
 * rendered `style` attribute carries it. A new extension, or an upstream merge that adds an attribute rendering
 * author input into inline CSS, turns this red. Anti-vacuity: the same harness flags the stock extensions the gates
 * replaced.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`src/editor-compat`).
 */
import { getSchema, type Extensions } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { TextAlign } from '@tiptap/extension-text-align';
import {
  Table,
  TableCell as StockTableCell,
  TableHeader as StockTableHeader,
  TableRow as StockTableRow,
} from '@tiptap/extension-table';
import { generateHTML } from '../common/helpers/prosemirror/html';
import { tiptapExtensions } from '../collaboration/collaboration.util';

const MARKER = 'attacker.example';
const HOSTILE: unknown[] = [
  `x; background-image:url(https://${MARKER}/a)`,
  // The trailing custom property swallows a suffix the renderer appends (`px`), as a real payload would.
  `1px; background-image:url(https://${MARKER}/b); --ccc-tail:`,
  [`x; background-image:url(https://${MARKER}/c)`],
  [`1px; background-image:url(https://${MARKER}/d); --ccc-tail:`],
];

/** Attributes a node needs before its renderHTML renders at all. */
const BASE_ATTRS: Record<string, Record<string, unknown>> = {
  youtube: { src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
};

/**
 * Pre-existing upstream renderHTML crashes on a NON-STRING value (it calls a string method on it). A crash renders
 * nothing, so it is no CSS sink; it is pinned so a new crash (which would hide that attribute from this spec) is seen.
 */
const KNOWN_THROWS = new Set([
  'node tableCell.backgroundColorName',
  'node tableHeader.backgroundColorName',
  'node audio.src',
  'node pdf.src',
  'node attachment.url',
  'node embed.src',
  'node youtube.src',
  'node status.text',
  'mark link.href',
  'mark highlight.colorName',
]);

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: Json[] };

const para: Json = { type: 'paragraph' };

/** A document that renders `node` where its renderer runs (cells and rows inside a table). */
function placeNode(node: Json): Json {
  if (node.type === 'tableCell' || node.type === 'tableHeader') {
    return { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ ...node, content: [para] }] }] }] };
  }
  if (node.type === 'tableRow') {
    return { type: 'doc', content: [{ type: 'table', content: [{ ...node, content: [{ type: 'tableCell', content: [para] }] }] }] };
  }
  return { type: 'doc', content: [node] };
}

interface Sweep {
  /** `<kind> <type>.<attr>` whose rendered style carried the hostile value. */
  sinks: string[];
  /** `<kind> <type>.<attr>` whose renderHTML threw. */
  threw: string[];
  rendered: number;
}

function sweep(extensions: Extensions): Sweep {
  const schema = getSchema(extensions);
  const sinks = new Set<string>();
  const threw = new Set<string>();
  let rendered = 0;
  const run = (label: string, doc: Json) => {
    let html: string;
    try {
      html = generateHTML(doc as any, extensions);
    } catch {
      threw.add(label);
      return;
    }
    rendered++;
    for (const [, style] of html.matchAll(/style="([^"]*)"/g)) {
      if (style.includes(MARKER)) sinks.add(label);
    }
  };
  for (const [name, type] of Object.entries(schema.nodes)) {
    if (name === 'text' || name === 'doc') continue;
    for (const attr of Object.keys(type.spec.attrs ?? {})) {
      for (const value of HOSTILE) {
        run(`node ${name}.${attr}`, placeNode({ type: name, attrs: { ...BASE_ATTRS[name], [attr]: value } }));
      }
    }
  }
  for (const [name, type] of Object.entries(schema.marks)) {
    for (const attr of Object.keys(type.spec.attrs ?? {})) {
      for (const value of HOSTILE) {
        run(`mark ${name}.${attr}`, {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: name, attrs: { [attr]: value } }] }] }],
        });
      }
    }
  }
  return { sinks: [...sinks].sort(), threw: [...threw].sort(), rendered };
}

describe('render gate across the whole server schema (#145)', () => {
  const result = sweep(tiptapExtensions);

  it('no attribute of any node or mark renders a hostile value into inline CSS', () => {
    expect(result.sinks).toEqual([]);
  });

  it('every attribute was actually rendered, apart from the pinned upstream crashes', () => {
    // A new crash hides an attribute from this spec: render it (BASE_ATTRS) or pin it here with its reason.
    expect(result.threw.filter((label) => !KNOWN_THROWS.has(label))).toEqual([]);
    expect(result.rendered).toBeGreaterThan(400);
  });

  it('anti-vacuity: the harness flags the stock extensions the gates replaced', () => {
    const stock = sweep([
      StarterKit,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Table,
      StockTableRow,
      StockTableCell,
      StockTableHeader,
    ]);
    expect(stock.sinks).toEqual(
      expect.arrayContaining([
        'node paragraph.textAlign',
        'node heading.textAlign',
        'node tableCell.align',
        'node tableHeader.align',
        'node tableCell.colwidth',
      ]),
    );
  });
});

describe('the alignment and column-width gates keep legitimate values (#145)', () => {
  const cellDoc = (attrs: Record<string, unknown>): Json => placeNode({ type: 'tableCell', attrs });

  it.each(['left', 'center', 'right', 'justify'])('paragraph and heading textAlign %j render', (textAlign) => {
    const html = generateHTML(
      { type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign } }, { type: 'heading', attrs: { level: 2, textAlign } }] } as any,
      tiptapExtensions,
    );
    expect(html.match(new RegExp(`style="text-align: ${textAlign};?"`, 'g'))).toHaveLength(2);
  });

  it.each(['left', 'center', 'right'])('table cell align %j renders', (align) => {
    expect(generateHTML(cellDoc({ align }) as any, tiptapExtensions)).toMatch(new RegExp(`<td[^>]*style="text-align: ${align};?"`));
  });

  it('numeric colwidths size the table as before; an unsafe entry counts as unset', () => {
    expect(generateHTML(cellDoc({ colspan: 2, colwidth: [100, 150] }) as any, tiptapExtensions)).toContain('<table style="width: 250px;"');
    expect(generateHTML(cellDoc({ colspan: 2, colwidth: [100, 'x; color: red'] }) as any, tiptapExtensions)).toMatch(/<table style="min-width: \d+px;"/);
  });
});
