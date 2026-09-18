import { isBlankProseMirror, shouldRefuseBlankClobber } from './blank-clobber-guard';

describe('isBlankProseMirror', () => {
  it('treats null / empty / a single empty paragraph as blank', () => {
    expect(isBlankProseMirror(null)).toBe(true);
    expect(isBlankProseMirror({ type: 'doc', content: [] })).toBe(true);
    expect(isBlankProseMirror({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
    expect(isBlankProseMirror({ type: 'doc', content: [{ type: 'paragraph', content: [] }] })).toBe(true);
    expect(
      isBlankProseMirror({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }] }),
    ).toBe(true);
  });

  it('treats real text as non-blank', () => {
    expect(
      isBlankProseMirror({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] }),
    ).toBe(false);
  });

  // Correctness reviewer #390: a text-only "blank" check mis-reads image-only / table-only / drawio pages.
  it('treats a node with no text but real content (image/table) as NON-blank', () => {
    expect(isBlankProseMirror({ type: 'doc', content: [{ type: 'image', attrs: { src: '/x.png' } }] })).toBe(false);
    expect(isBlankProseMirror({ type: 'doc', content: [{ type: 'table', content: [] }] })).toBe(false);
    expect(isBlankProseMirror({ type: 'doc', content: [{ type: 'drawio', attrs: {} }] })).toBe(false);
  });
});

describe('shouldRefuseBlankClobber (#390 null-ydoc defensive guard)', () => {
  const text = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
  const blank = { type: 'doc', content: [{ type: 'paragraph' }] };
  const image = { type: 'doc', content: [{ type: 'image', attrs: { src: '/x.png' } }] };

  it('refuses overwriting non-empty row content with a blank outgoing doc', () => {
    expect(shouldRefuseBlankClobber(text('real'), blank)).toBe(true);
  });

  it('refuses overwriting an image-only row with a blank doc (image-only is not blank)', () => {
    expect(shouldRefuseBlankClobber(image, blank)).toBe(true);
  });

  it('allows a genuine edit (non-blank → non-blank) and a write to an already-blank row', () => {
    expect(shouldRefuseBlankClobber(text('a'), text('b'))).toBe(false); // real edit proceeds
    expect(shouldRefuseBlankClobber(blank, blank)).toBe(false); // nothing to protect
    expect(shouldRefuseBlankClobber(blank, text('new'))).toBe(false); // filling a blank page
  });

  it('fails safe on unparseable row content (treats it as non-blank → refuses a blank overwrite)', () => {
    expect(shouldRefuseBlankClobber('not-prosemirror' as unknown, blank)).toBe(true);
  });
});
