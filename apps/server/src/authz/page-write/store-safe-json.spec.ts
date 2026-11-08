// #773: the collab store's JSON normalizer. Every string and key Postgres cannot store (a lone surrogate in jsonb,
// U+0000 in jsonb and text) becomes U+FFFD; everything else, and every clean input, comes back untouched — the SAME
// reference, so a clean page allocates nothing — and the input is never written to (it can be Yjs's own objects).
import { storeSafeJson, storeSafeString } from './store-safe-json';

const R = '\uFFFD';
const HIGH = '\ud83d';
const LOW = '\ude00';
const EMOJI = '\ud83d\ude00'; // a paired surrogate (U+1F600)

/** Every string and key well-formed and NUL-free (what Postgres jsonb and text accept). */
const storable = (v: unknown): boolean => {
  const ok = (s: string) => (s as string & { isWellFormed(): boolean }).isWellFormed() && !s.includes('\0');
  if (typeof v === 'string') return ok(v);
  if (Array.isArray(v)) return v.every(storable);
  if (v && typeof v === 'object') return Object.entries(v).every(([k, x]) => ok(k) && storable(x));
  return true;
};

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
};

describe('storeSafeString (#773)', () => {
  it.each([
    ['a lone high surrogate', `x${HIGH}`, `x${R}`],
    ['a lone low surrogate', `${LOW}y`, `${R}y`],
    ['a reversed pair', `${LOW}${HIGH}`, `${R}${R}`],
    ['NUL', `a\0b\0`, `a${R}b${R}`],
    ['a lone surrogate and NUL together', `${HIGH}\0`, `${R}${R}`],
  ])('replaces %s with U+FFFD', (_name, input, expected) => {
    expect(storeSafeString(input)).toBe(expected);
  });

  it('keeps a paired surrogate (an emoji), other control characters and the empty string as they are', () => {
    for (const s of [EMOJI, `a${EMOJI}b`, '\u0001\t\n\u001f', '']) expect(storeSafeString(s)).toBe(s);
  });
});

describe('storeSafeJson (#773)', () => {
  it('normalizes values and keys at every depth, in arrays and objects', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `a\0b`, marks: [{ type: 'link', attrs: { href: `x${HIGH}` } }] },
            { type: 'text', text: EMOJI, marks: [{ type: 'textStyle', attrs: { [HIGH]: 'v', [`k\0`]: [LOW, 1] } }] },
          ],
        },
      ],
    };
    const out = storeSafeJson(input);
    expect(storable(out)).toBe(true);
    expect(out).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `a${R}b`, marks: [{ type: 'link', attrs: { href: `x${R}` } }] },
            { type: 'text', text: EMOJI, marks: [{ type: 'textStyle', attrs: { [R]: 'v', [`k${R}`]: [R, 1] } }] },
          ],
        },
      ],
    });
  });

  it('returns the SAME reference for a clean input, at every depth', () => {
    const clean = { type: 'doc', content: [{ type: 'text', text: EMOJI, marks: [{ type: 'bold', attrs: { a: [1, 'b'] } }] }] };
    expect(storeSafeJson(clean)).toBe(clean);
    const arr = ['a', EMOJI, [1, { b: null }]];
    expect(storeSafeJson(arr)).toBe(arr);
    expect(storeSafeJson('plain')).toBe('plain');
  });

  it('copies only the branches it changes: a clean sibling keeps its reference', () => {
    const cleanSibling = { type: 'paragraph', content: [{ type: 'text', text: 'ok' }] };
    const input = { type: 'doc', content: [cleanSibling, { type: 'text', text: HIGH }] };
    const out = storeSafeJson(input);
    expect(out).not.toBe(input);
    expect(out.content).not.toBe(input.content);
    expect(out.content[0]).toBe(cleanSibling);
  });

  it('never mutates its input (deeply frozen, so a write throws in strict mode)', () => {
    const input = deepFreeze({
      type: 'doc',
      attrs: { [HIGH]: `\0` },
      content: [{ type: 'text', text: `${LOW}`, marks: [{ type: 'link', attrs: { href: `x${HIGH}`, n: { [`\0`]: HIGH } } }] }],
    });
    const before = JSON.stringify(input);
    const out = storeSafeJson(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(storable(out)).toBe(true);
    expect(out.content[0].marks[0].attrs).toEqual({ href: `x${R}`, n: { [R]: R } });
  });

  it('when two keys normalize to the same name, the later one wins', () => {
    expect(storeSafeJson({ [HIGH]: 1, [LOW]: 2 })).toEqual({ [R]: 2 });
    expect(storeSafeJson({ [R]: 'clean-first', [`\0`]: 'poisoned-second' })).toEqual({ [R]: 'poisoned-second' });
    expect(storeSafeJson({ [`\0`]: 'poisoned-first', [R]: 'clean-second' })).toEqual({ [R]: 'clean-second' });
  });

  it('keeps a `__proto__` key as an own property and keeps the input object prototype', () => {
    const parsed = JSON.parse('{"__proto__": {"x": 1}, "a": "\\u0000"}');
    const out = storeSafeJson(parsed);
    expect(Object.keys(out)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.a).toBe(R);
    const bare = Object.assign(Object.create(null), { a: HIGH });
    expect(Object.getPrototypeOf(storeSafeJson(bare))).toBeNull();
  });

  it('leaves non-string primitives, null and non-JSON objects untouched', () => {
    for (const v of [0, 1.5, -0, true, false, null, undefined]) expect(storeSafeJson(v)).toBe(v);
    const bytes = new Uint8Array([0, 0xd8]);
    expect(storeSafeJson(bytes)).toBe(bytes);
    const mixed = { n: 1, b: false, z: null, s: `\0` };
    expect(storeSafeJson(mixed)).toEqual({ n: 1, b: false, z: null, s: R });
  });
});
