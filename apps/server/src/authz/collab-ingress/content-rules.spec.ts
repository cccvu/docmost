// PageService's module graph pulls the collab WebSocket stack (lib0 ESM) jest cannot parse; the parse never touches it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { HttpException } from '@nestjs/common';
import { htmlToJson, jsonToNode } from '../../collaboration/collaboration.util';
import { PageService } from '../../core/page/services/page.service';
import { Node as PMNode } from '@tiptap/pm/model';
import { buildPrelimContent, serverSchema } from '../page-write/prelim-content';
import { ALL_NODES_DOC } from './collab-ingress.testkit';
import {
  assertCollabSafeContent,
  checkFormat,
  checkAttribute,
  checkValue,
  COLLAB_LIMITS,
  STRING_ATTRS,
} from './content-rules';

/**
 * #781, the HTTP twin of the collab update guard (ADR 0036). `/v1`, MCP, imports and the conditional write store JSON
 * that only went through `Node.fromJSON`, which checks no structure and no attribute types; every browser that opened
 * the page then silently deleted what the schema forbids (y-tiptap's delete-on-error), or crashed on a non-string URL.
 * Each case has a CONTROL arm (what the pre-#781 parse accepted) and a TREATMENT arm (the refusal, with its code).
 */
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, marks?: unknown[]) => (marks ? { type: 'text', text, marks } : { type: 'text', text });

/** What `parseProsemirrorContent` did before #781 for a JSON write: `jsonToNode` must not throw. */
const accepted = (json: unknown) => () => jsonToNode(json as never);
const parse = (json: unknown) => PageService.prototype.parseProsemirrorContent.call(null, json, 'json');

async function refusal(run: () => unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await run();
  } catch (err) {
    if (err instanceof HttpException) return { status: err.getStatus(), body: err.getResponse() as Record<string, unknown> };
    throw err;
  }
  throw new Error('expected a refusal, the content was accepted');
}

/** A document placing a node with `attrs` where the schema allows it. */
function withNode(type: string, attrs: Record<string, unknown>): unknown {
  if (type === 'tableCell' || type === 'tableHeader') {
    return doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type, attrs, content: [p(t('x'))] }] }] });
  }
  if (type === 'mention' || type === 'mathInline' || type === 'status') return doc(p({ type, attrs }));
  if (type === 'callout') return doc({ type, attrs, content: [p(t('x'))] });
  return doc({ type, attrs });
}
const withMark = (type: string, attrs: Record<string, unknown>) => doc(p(t('x', [{ type, attrs }])));

describe('#781 STRING_ATTRS over HTTP JSON: a non-string URL/label is refused before it is stored', () => {
  const entries = [...STRING_ATTRS].map((e) => {
    const [kind, rest] = e.split(' ');
    const [type, attr] = rest.split('.');
    return { e, kind, type, attr };
  });

  it('is not vacuous: covers the link mark and the media nodes the browsers crash on', () => {
    expect(entries.length).toBeGreaterThanOrEqual(18);
    expect(STRING_ATTRS.has('mark link.href')).toBe(true);
    expect(STRING_ATTRS.has('node image.src')).toBe(true);
  });

  it.each(entries)('$e: control accepts an object value; the guard answers 400 content_not_allowed', async ({ kind, type, attr }) => {
    for (const bad of [{ x: 1 }, 7, ['a']]) {
      const json = kind === 'mark' ? withMark(type, { [attr]: bad }) : withNode(type, { [attr]: bad });
      expect(accepted(json)).not.toThrow(); // control: what used to be stored
      const r = await refusal(() => parse(json));
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ code: 'content_not_allowed', rule: 'string-attr' });
    }
    // A string, null and an absent value stay accepted.
    for (const ok of ['https://example.com/x', null]) {
      const json = kind === 'mark' ? withMark(type, { [attr]: ok }) : withNode(type, { [attr]: ok });
      await expect(parse(json)).resolves.toBeDefined();
    }
  });
});

describe('#781 review: table spans and __proto__ over HTTP JSON', () => {
  it('a colspan past the HTML limit (or not an integer) is refused number-attr; an honest span and null are accepted', async () => {
    for (const type of ['tableCell', 'tableHeader']) {
      for (const bad of [1e9, 1001, -1, 1.5, '5']) {
        const json = withNode(type, { colspan: bad });
        expect(accepted(json)).not.toThrow(); // control: stored, and every viewer builds one column per unit
        const r = await refusal(() => parse(json));
        expect(r).toMatchObject({ status: 400, body: { code: 'content_not_allowed', rule: 'number-attr', node: type, attribute: 'colspan' } });
      }
      expect((await refusal(() => parse(withNode(type, { rowspan: 70_000 })))).body).toMatchObject({ rule: 'number-attr', attribute: 'rowspan' });
      for (const ok of [1, 3, 1000, null]) await expect(parse(withNode(type, { colspan: ok, rowspan: ok }))).resolves.toBeDefined();
    }
  });

  it('a root that is not a doc (a bare paragraph stores a root XmlText no browser opens) is refused on both paths', async () => {
    for (const json of [p(t('x')), { type: 'blockquote', content: [p(t('x'))] }]) {
      expect((await refusal(() => parse(json))).body).toMatchObject({ code: 'content_not_allowed', rule: 'schema' });
      expect((await refusal(() => buildPrelimContent(json))).body).toMatchObject({ code: 'content_not_allowed', rule: 'schema' });
    }
    await expect(parse(doc(p(t('x'))))).resolves.toBeDefined();
  });

  it('a JSON attrs key "__proto__" (an own property after JSON.parse) is refused attr-kind', async () => {
    const json = JSON.parse('{"type":"doc","content":[{"type":"image","attrs":{"src":"/x.png","__proto__":{"src":{"evil":1}}}}]}');
    const r = await refusal(() => parse(json));
    expect(r).toMatchObject({ status: 400, body: { code: 'content_not_allowed', rule: 'attr-kind' } });
    expect(checkAttribute('image', '__proto__', ['x'])).toMatchObject({ rule: 'attr-kind', node: 'image' });
  });
});

describe('#781 structure over HTTP JSON: what y-tiptap would delete on every peer is refused (its rule, not Node.check())', () => {
  const cases: Array<[string, unknown]> = [
    ['bold in a codeBlock', doc({ type: 'codeBlock', content: [t('x', [{ type: 'bold' }])] })],
    ['a paragraph in a paragraph', doc(p(p(t('x'))))],
    ['a listItem whose first child is a bulletList', doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('x'))] }] }] }] })],
    ['a second detailsSummary', doc({ type: 'details', content: [{ type: 'detailsSummary', content: [t('a')] }, { type: 'detailsSummary', content: [t('b')] }, { type: 'detailsContent', content: [p()] }] })],
    ['an image (block) inside a paragraph', doc(p({ type: 'image', attrs: { src: '/x.png' } }))],
  ];
  it.each(cases)('%s: control accepts; the guard answers 400 content_not_allowed (rule schema)', async (_name, json) => {
    expect(accepted(json)).not.toThrow();
    const r = await refusal(() => parse(json));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'content_not_allowed', rule: 'schema' });
  });

  it('the conditional/replace write path (buildPrelimContent) refuses the same content', async () => {
    for (const [, json] of cases) {
      const r = await refusal(() => buildPrelimContent(json));
      expect(r).toMatchObject({ status: 400, body: { code: 'content_not_allowed' } });
    }
  });
});

describe('#781 depth and values over HTTP JSON', () => {
  const nested = (depth: number): unknown => {
    let node: unknown = p(t('deep'));
    for (let i = 0; i < depth; i++) node = { type: 'blockquote', content: [node] };
    return doc(node);
  };

  it(`element depth beyond ${COLLAB_LIMITS.elementDepth} is 422 content_too_complex (ADR 0031's refusal), the honest maximum passes`, async () => {
    expect(accepted(nested(300))).not.toThrow(); // control
    const r = await refusal(() => parse(nested(300)));
    expect(r).toMatchObject({ status: 422, body: { code: 'content_too_complex' } });
    await expect(parse(nested(COLLAB_LIMITS.elementDepth - 3))).resolves.toBeDefined();
  });

  it('a deeply nested attribute or mark value is 400 (value-depth); 100k deep does not overflow the walk', async () => {
    const deepValue = JSON.parse('{"a":'.repeat(100_000) + '1' + '}'.repeat(100_000));
    for (const json of [
      doc({ type: 'image', attrs: { src: '/x.png', alt: deepValue } }),
      doc(p(t('x', [{ type: 'textStyle', attrs: { color: deepValue } }]))),
    ]) {
      const r = await refusal(() => parse(json));
      expect(r).toMatchObject({ status: 400, body: { code: 'content_not_allowed', rule: 'value-depth' } });
    }
  });

  it('the refusal names schema ids only, never a value', async () => {
    const r = await refusal(() => parse(withMark('link', { href: { secret: 'TOKEN-123' } })));
    expect(JSON.stringify(r.body)).not.toContain('TOKEN-123');
  });
});

describe('#781 false positives over HTTP: honest content stays accepted', () => {
  it('a document holding every node and mark passes (and `.check()`s)', async () => {
    await expect(parse(ALL_NODES_DOC)).resolves.toBe(ALL_NODES_DOC);
    expect(() => buildPrelimContent(ALL_NODES_DOC)).not.toThrow();
  });

  it('HTML-derived content passes (lists, tables with marks, headings with links, details, columns)', async () => {
    const html =
      '<h2><a href="https://e.x">link <strong>bold</strong></a></h2><ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>' +
      '<table><tr><th><p><em>h</em></p></th></tr><tr><td><p><code>c</code></p></td></tr></table>' +
      '<pre><code>x = 1</code></pre><blockquote><p>q</p></blockquote><ol><li><p>1</p></li></ol>';
    await expect(parse(htmlToJson(html))).resolves.toBeDefined();
  });

  it('mutually exclusive marks on one text (code beside bold, as concurrent edits leave them) are accepted: y-tiptap deletes nothing for them', async () => {
    const json = doc(p(t('both', [{ type: 'code' }, { type: 'bold' }])), { type: 'heading', attrs: { level: 2 }, content: [t('h', [{ type: 'link', attrs: { href: '/x' } }, { type: 'code' }])] });
    expect(() => PMNode.fromJSON(serverSchema(), json).check()).toThrow(/Invalid collection of marks/); // the rule NOT applied
    await expect(parse(json)).resolves.toBe(json);
    expect(() => buildPrelimContent(json)).not.toThrow();
  });

  it('an emptied container (a list with no items, as concurrent deletes leave one) is accepted: y-tiptap drops it, losing nothing', async () => {
    const json = doc({ type: 'bulletList' }, { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell' }] }] }, p(t('kept')));
    await expect(parse(json)).resolves.toBe(json);
    expect(() => buildPrelimContent(json)).not.toThrow();
  });

  it('an unknown node type keeps the pre-#781 behaviour on the parse path (stripped by jsonToNode, not refused)', async () => {
    await expect(parse(doc(p(t('x')), { type: 'mysteryNode' }))).resolves.toBeDefined();
  });
});

describe('#781 checkValue / checkFormat (shared by the collab guard)', () => {
  const deep = (n: number): unknown => {
    let v: unknown = 1;
    for (let i = 0; i < n; i++) v = { a: v };
    return v;
  };
  it('depth: the honest maximum and the bound pass, one deeper is value-depth', () => {
    expect(checkValue(deep(2))).toBeNull();
    expect(checkValue(deep(COLLAB_LIMITS.valueDepth))).toBeNull();
    expect(checkValue(deep(COLLAB_LIMITS.valueDepth + 1))).toBe('value-depth');
  });
  it('size, binary, bigint and a re-prototyped object are refused', () => {
    expect(checkValue(new Array(COLLAB_LIMITS.valueEntries + 1).fill(1))).toBe('value-size');
    expect(checkValue(new Uint8Array(3))).toBe('value-kind');
    expect(checkValue(BigInt(1))).toBe('value-kind');
    expect(checkValue(Object.setPrototypeOf({ a: 1 }, { href: { x: 1 } }))).toBe('value-kind');
    expect(checkValue({ a: [1, 'x', null, undefined, true, { b: 2.5 }] })).toBeNull();
  });
  it('format keys: a null value ends any mark; unknown and hashed self-excluding marks are refused', () => {
    expect(checkFormat('evilMark', null)).toBeNull();
    expect(checkFormat('bold', null)).toBeNull();
    expect(checkFormat('evilMark', {})).toMatchObject({ rule: 'unknown-mark' });
    expect(checkFormat('evilMark--ABCDEFGH', {})).toMatchObject({ rule: 'unknown-mark' });
    expect(checkFormat('__proto__', { bold: {} })).toMatchObject({ rule: 'unknown-mark' });
    expect(checkFormat('bold--ABCDEFGH', {})).toMatchObject({ rule: 'hashed-mark', mark: 'bold' });
    expect(checkFormat('bold', {})).toBeNull();
    expect(checkFormat('bold', true)).toBeNull(); // a non-object mark value is harmless (computeAttrs reads defaults)
    expect(checkFormat('link', { href: { x: 1 } })).toMatchObject({ rule: 'string-attr', mark: 'link', key: 'href' });
  });
});
