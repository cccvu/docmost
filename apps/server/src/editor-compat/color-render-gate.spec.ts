/**
 * CCC colour render gate (#145), server schema.
 *
 * Stock Tiptap `Color` / `Highlight` interpolated the stored attribute into
 * inline CSS, so JSON written through /v1 or MCP (which never passes
 * `parseHTML`) could carry `red; background:url(https://…)` into every HTML
 * render: share pages, exports, `format=html` reads. The server schema now
 * registers `CccColor` / `CccHighlight` (matched pair with the client schema),
 * which emit the style only for a safe single CSS colour token.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`src/editor-compat`).
 */
import { jsonToHtml, htmlToJson } from '../collaboration/collaboration.util';

const docWith = (marks: unknown[]) => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Styled', marks }],
    },
  ],
});
const colored = (color: unknown) =>
  docWith([{ type: 'textStyle', attrs: { color } }]);
const highlighted = (color: unknown) =>
  docWith([{ type: 'highlight', attrs: { color } }]);

const findMarks = (json: any): any[] => {
  if (!json || typeof json !== 'object') return [];
  if (json.type === 'text') return json.marks ?? [];
  return (json.content ?? []).flatMap(findMarks);
};

const HOSTILE = [
  'red; background:url(https://attacker.example/x)',
  'red;background-image:url(https://attacker.example/x)',
  'url(https://attacker.example/x)',
  'rgb(0,0,0); position: fixed; inset: 0',
  'var(--a); color: red',
  'expression(alert(1))',
  '"red"',
  '#ff0000;',
];

const LEGIT = [
  '#E00000', // a TEXT_COLORS swatch
  '#faf594', // a HIGHLIGHT_COLORS swatch
  '#fff',
  'red',
  'rgb(255, 0, 0)',
  'hsla(210deg 50% 40% / 0.3)',
  'var(--mantine-color-red-6)',
];

describe('colour render gate (server jsonToHtml)', () => {
  it.each(HOSTILE)('text colour %j emits no style', (value) => {
    const html = jsonToHtml(colored(value));
    expect(html).toContain('Styled');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('url(');
  });

  it.each(HOSTILE)('highlight %j emits no style or data-color', (value) => {
    const html = jsonToHtml(highlighted(value));
    expect(html).toContain('<mark>Styled</mark>');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('data-color=');
    expect(html).not.toContain('url(');
  });

  it.each(LEGIT)('text colour %j renders and round-trips', (value) => {
    const html = jsonToHtml(colored(value));
    expect(html).toContain(`style="color: ${value}`);
    const back = findMarks(htmlToJson(html)).find(
      (m) => m.type === 'textStyle',
    );
    expect(back?.attrs?.color).toBe(value);
  });

  it.each(LEGIT)('highlight %j renders and round-trips', (value) => {
    const html = jsonToHtml(highlighted(value));
    expect(html).toContain(`data-color="${value}"`);
    expect(html).toContain(`background-color: ${value}; color: inherit`);
    const back = findMarks(htmlToJson(html)).find(
      (m) => m.type === 'highlight',
    );
    expect(back?.attrs?.color).toBe(value);
  });
});

// The same class of sink in upstream nodes (#145): TableCell/TableHeader interpolated `backgroundColor`
// into `background-color: …`, Column interpolated `width` into `flex: …`. Both render only a safe value.
const cellPara = {
  type: 'paragraph',
  content: [{ type: 'text', text: 'Cell' }],
};
const tableWith = (backgroundColor: unknown) => ({
  type: 'doc',
  content: [
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              attrs: { backgroundColor },
              content: [cellPara],
            },
            {
              type: 'tableCell',
              attrs: { backgroundColor },
              content: [cellPara],
            },
          ],
        },
      ],
    },
  ],
});
const columnsWith = (width: unknown) => ({
  type: 'doc',
  content: [
    {
      type: 'columns',
      content: [
        { type: 'column', attrs: { width }, content: [cellPara] },
        { type: 'column', content: [cellPara] },
      ],
    },
  ],
});

describe('table background and column width render gates (server jsonToHtml)', () => {
  it.each(HOSTILE)('cell background %j emits no style', (value) => {
    const html = jsonToHtml(tableWith(value));
    expect(html).toContain('Cell');
    expect(html).not.toContain('background-color');
    expect(html).not.toContain('data-background-color=');
    expect(html).not.toContain('url(');
  });

  it.each(['#b4d5ff', 'rgb(180, 213, 255)', 'var(--mantine-color-blue-1)'])(
    'cell background %j renders on th and td and round-trips',
    (value) => {
      const html = jsonToHtml(tableWith(value));
      expect(html.match(/style="background-color: [^"]+"/g)).toEqual([
        `style="background-color: ${value};"`,
        `style="background-color: ${value};"`,
      ]);
      expect(JSON.stringify(htmlToJson(html))).toContain(
        `"backgroundColor":"${value}"`,
      );
    },
  );

  it.each([
    '1; background-image:url(https://attacker.example/x)',
    'calc(1px)',
    -1,
    'NaN',
    { a: 1 },
  ])('column width %j emits no flex', (value) => {
    const html = jsonToHtml(columnsWith(value));
    expect(html).toContain('Cell');
    expect(html).not.toContain('flex');
    expect(html).not.toContain('data-width=');
    expect(html).not.toContain('url(');
  });

  it.each([40, 2.5, '60'])('column width %j renders as flex', (value) => {
    const html = jsonToHtml(columnsWith(value));
    expect(html).toContain(`data-width="${Number(value)}"`);
    // The server DOM expands the `flex` shorthand.
    expect(html).toContain(`flex-grow: ${Number(value)};`);
  });
});
