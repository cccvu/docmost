/**
 * CCC typography compatibility trace (issue #135).
 *
 * Font size/family are attributes on the existing `textStyle` mark. The server
 * schema (`tiptapExtensions`) is the choke point that used to SILENTLY STRIP
 * unknown `textStyle` attributes — so before `CccFontSize`/`CccFontFamily` were
 * registered there, every schema-bound path (jsonToNode, ydoc rehydration,
 * duplicate, share, html) dropped these attrs. These specs pin that they now
 * survive, that the render path gates hostile values, that search text is
 * unaffected, and that Markdown degrades (the documented fidelity policy).
 *
 * Run in CI via the `docmost-authz` job's jest glob (`src/authz src/editor-compat`).
 */
import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  jsonToHtml,
  htmlToJson,
  jsonToText,
  jsonToNode,
  jsonToMarkdown,
} from '../collaboration/collaboration.util';
import { createYdocFromJson } from '../common/helpers/prosemirror/utils';

const textStyleDoc = (attrs: Record<string, unknown>, text = 'Styled') => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text, marks: [{ type: 'textStyle', attrs }] }],
    },
  ],
});

const findFirst = (json: any, type: string): any => {
  if (!json || typeof json !== 'object') return undefined;
  if (json.type === type) return json;
  if (Array.isArray(json.content)) {
    for (const c of json.content) {
      const f = findFirst(c, type);
      if (f) return f;
    }
  }
  return undefined;
};

const textStyleAttrs = (json: any): Record<string, any> | undefined =>
  findFirst(json, 'text')?.marks?.find((m: any) => m.type === 'textStyle')
    ?.attrs;

describe('typography schema round-trip (server)', () => {
  it('jsonToNode preserves fontSize + fontFamily on the textStyle mark', () => {
    const doc = textStyleDoc({
      color: null,
      fontSize: '20px',
      fontFamily: 'serif',
    });
    const node = jsonToNode(doc as any);
    const attrs = textStyleAttrs(node.toJSON());
    expect(attrs).toBeDefined();
    expect(attrs.fontSize).toBe('20px');
    expect(attrs.fontFamily).toBe('serif');
  });

  it('preserves font attrs through the ydoc round-trip (duplicate / rehydration)', () => {
    const doc = textStyleDoc({
      color: null,
      fontSize: '18px',
      fontFamily: 'monospace',
    });
    const buffer = createYdocFromJson(doc);
    expect(buffer).not.toBeNull();

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(buffer as Buffer));
    const back = TiptapTransformer.fromYdoc(ydoc, 'default');

    const attrs = textStyleAttrs(back);
    expect(attrs.fontSize).toBe('18px');
    expect(attrs.fontFamily).toBe('monospace');
  });

  it('jsonToHtml emits an allowed size and maps a family keyword to a stack', () => {
    const doc = textStyleDoc({
      color: null,
      fontSize: '20px',
      fontFamily: 'serif',
    });
    const html = jsonToHtml(doc);
    expect(html).toContain('font-size: 20px');
    expect(html.toLowerCase()).toContain('georgia');
  });

  it('render-path gate: a non-allowlisted size in JSON is NOT emitted as CSS', () => {
    // Simulates hostile / arbitrary API/MCP-authored content that bypasses
    // parseHTML by writing the mark attr directly.
    const doc = textStyleDoc({ color: null, fontSize: '9999px', fontFamily: null });
    const html = jsonToHtml(doc);
    expect(html).not.toContain('9999');
    expect(html).not.toContain('font-size');
  });

  it('render-path gate: a non-keyword family in JSON is NOT emitted as CSS', () => {
    // Same hostile bypass for fontFamily: only the "serif"/"monospace" keywords
    // map to a controlled stack; anything else must render to no CSS.
    const doc = textStyleDoc({
      color: null,
      fontSize: null,
      fontFamily: 'Comic Sans MS',
    });
    const html = jsonToHtml(doc);
    expect(html).not.toContain('Comic Sans');
    expect(html).not.toContain('font-family');
  });

  it('htmlToJson snaps an off-scale imported size to the nearest allowed step', () => {
    const json = htmlToJson('<p><span style="font-size: 15px">x</span></p>');
    expect(textStyleAttrs(json)?.fontSize).toBe('14px');
  });

  it('htmlToJson classifies an imported serif stack to the serif keyword', () => {
    const json = htmlToJson(
      '<p><span style="font-family: Georgia, \'Times New Roman\', serif">x</span></p>',
    );
    expect(textStyleAttrs(json)?.fontFamily).toBe('serif');
  });
});

describe('search + fidelity policy (server)', () => {
  it('text_content is byte-identical with or without font marks', () => {
    const withFont = textStyleDoc(
      { color: null, fontSize: '20px', fontFamily: 'serif' },
      'Hello world',
    );
    const plain = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
      ],
    };
    expect(jsonToText(withFont as any)).toBe(jsonToText(plain as any));
    expect(jsonToText(withFont as any)).toContain('Hello world');
  });

  it('Markdown degrades: font size/family produce no markup (lossy by policy)', () => {
    const doc = textStyleDoc(
      { color: null, fontSize: '20px', fontFamily: 'serif' },
      'Plain in markdown',
    );
    const md = jsonToMarkdown(doc);
    expect(md).toContain('Plain in markdown');
    expect(md).not.toMatch(/font-size|font-family/i);
  });
});

describe('legacy documents (server)', () => {
  it('a pre-existing color-only textStyle mark still round-trips', () => {
    const legacy = textStyleDoc({ color: '#E00000' }, 'Red legacy');
    const node = jsonToNode(legacy as any);
    const attrs = textStyleAttrs(node.toJSON());
    expect(attrs.color).toBe('#E00000');
    // New attrs default to null and do not carry a value on legacy content.
    expect(attrs.fontSize ?? null).toBeNull();
    expect(attrs.fontFamily ?? null).toBeNull();
    // Color still renders (unaffected by the typography change).
    expect(jsonToHtml(legacy).toLowerCase()).toContain('color: #e00000');
  });
});
