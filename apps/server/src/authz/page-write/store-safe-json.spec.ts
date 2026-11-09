// #773: the collab store's JSON normalizer. Every string and key Postgres cannot store (a lone surrogate in jsonb,
// U+0000 in jsonb and text) becomes U+FFFD; everything else, and every clean input, comes back untouched — the SAME
// reference, so a clean page allocates nothing — and the input is never written to (it can be Yjs's own objects).
import { isDeepStrictEqual } from 'node:util';
import { STORE_SAFE_MAX_DEPTH, storeSafeJson, storeSafeString } from './store-safe-json';
import { stableHash } from './stable-hash';

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

  it('leaves JSON primitives, null and byte arrays untouched', () => {
    for (const v of [0, 1.5, -1, true, false, null]) expect(storeSafeJson(v)).toBe(v);
    const bytes = new Uint8Array([0, 0xd8]);
    expect(storeSafeJson(bytes)).toBe(bytes);
    const mixed = { n: 1, b: false, z: null, s: `\0`, bytes };
    const out = storeSafeJson(mixed);
    expect(out).toEqual({ n: 1, b: false, z: null, s: R, bytes });
    expect(out.bytes).toBe(bytes);
  });

  // The shape is attacker-controlled too (#773 security review): the walk writes what JSON.stringify writes.
  describe('follows what JSON.stringify writes, whatever the shape', () => {
    it('calls toJSON once and walks its result (a Y type attribute value, a Date)', () => {
      const yMapLike = { toJSON: () => ({ a: `x\0`, nested: { toJSON: () => 'kept as an object' } }) };
      class YMapLike {
        toJSON() {
          return { a: `x${HIGH}` };
        }
      }
      const date = new Date(0);
      const out = storeSafeJson({ m: yMapLike, c: new YMapLike(), d: date, t: { toJSON: () => `t\0` } });
      // toJSON is called once per value, as JSON.stringify does: a `toJSON` inside its result is a nested value's own.
      expect(out).toEqual({ m: { a: `x${R}`, nested: 'kept as an object' }, c: { a: `x${R}` }, d: date.toJSON(), t: `t${R}` });
      expect(storable(out)).toBe(true);
    });

    it('walks an object re-prototyped by a `__proto__` assignment, and copies it into a plain object', () => {
      const attrs: Record<string, unknown> = {};
      attrs['__proto__'] = { inherited: `\0` }; // what Yjs getAttributes / lib0 readAny do with a `__proto__` key
      attrs.textAlign = `center\0`;
      expect(Object.getPrototypeOf(attrs)).not.toBe(Object.prototype);
      const out = storeSafeJson({ attrs }).attrs;
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(Object.keys(out)).toEqual(['textAlign']); // an inherited key is not written, as in JSON.stringify
      expect(out).toEqual({ textAlign: `center${R}` });
    });

    it('copies any non-plain object (even a clean one) into a plain object of its own keys', () => {
      class Attr {
        a = 'clean';
        [HIGH] = `v${LOW}`;
      }
      const clean = new (class {
        a = 'clean';
      })();
      expect(storeSafeJson(clean)).not.toBe(clean);
      expect(Object.getPrototypeOf(storeSafeJson(clean))).toBe(Object.prototype);
      expect(storeSafeJson({ x: new Attr() })).toEqual({ x: { a: 'clean', [R]: `v${R}` } });
      expect(storeSafeJson(new Map([['k', `\0`]]))).toEqual({}); // a Map has no own keys: JSON writes {}
    });

    it('turns a BigInt into its decimal string (JSON.stringify throws on one)', () => {
      expect(() => JSON.stringify({ n: BigInt(10) })).toThrow(/BigInt/);
      expect(storeSafeJson({ n: BigInt(10), m: [BigInt(-2)] })).toEqual({ n: '10', m: ['-2'] });
      expect(storeSafeJson(BigInt(7))).toBe('7');
    });

    it('drops undefined, functions and symbols from objects, and writes null for them and for non-finite numbers in arrays', () => {
      const fn = () => 1;
      const out = storeSafeJson({ u: undefined, f: fn, s: Symbol('s'), keep: 1, a: [undefined, fn, NaN, Infinity, -0, 2] });
      expect(Object.keys(out)).toEqual(['keep', 'a']);
      expect(out).toEqual({ keep: 1, a: [null, null, null, null, 0, 2] });
      expect(Object.is(out.a[4], 0)).toBe(true);
      expect(storeSafeJson({ n: NaN, i: -Infinity })).toEqual({ n: null, i: null });
      // eslint-disable-next-line no-sparse-arrays
      expect(storeSafeJson([1, , 3])).toEqual([1, null, 3]);
    });

    it('its result is a plain JSON value: it survives a JSON round trip unchanged, and stringifies as the input does', () => {
      const date = new Date(0);
      const reproto: Record<string, unknown> = {};
      reproto['__proto__'] = { hidden: 1 };
      reproto.v = 'ok';
      const corpus: unknown[] = [
        { type: 'doc', content: [{ type: 'text', text: EMOJI, marks: [{ type: 'bold' }] }] },
        { a: undefined, b: [undefined, NaN], c: date, d: { toJSON: () => ({ e: 1 }) }, f: reproto, g: -0 },
        [Infinity, null, 'x', { y: [true, false] }],
        new Map([['k', 'v']]),
      ];
      for (const input of corpus) {
        const out = storeSafeJson(input);
        expect(JSON.parse(JSON.stringify(out))).toStrictEqual(out); // nothing JSON would drop or rewrite is left
        expect(JSON.stringify(out)).toBe(JSON.stringify(input)); // and it writes what the input writes
      }
    });
  });
});

// #781 (ADR 0036): a crafted collab client can nest a value (a format value, an attribute) far deeper than any page
// needs. The recursive walks after the store's `fromYdoc` (this one, `isDeepStrictEqual` in the no-op check, the
// digest's `stableStringify`) threw RangeError at about 10k levels, and the page could never be stored again. A value
// nested deeper than STORE_SAFE_MAX_DEPTH now projects as null, so everything downstream walks at most that deep.
describe('storeSafeJson depth bound (#781)', () => {
  /** `leaf` inside `n` arrays: the leaf sits at depth `n` (the root value is depth 0). Built without recursion. */
  const nestArrays = (n: number, leaf: unknown): unknown => {
    let v = leaf;
    for (let i = 0; i < n; i++) v = [v];
    return v;
  };
  /** A ProseMirror-shaped chain `levels` nodes deep (each node adds 2 levels: the node and its `content` array). */
  const nestNodes = (levels: number): Record<string, unknown> => {
    let v: Record<string, unknown> = { type: 'text', text: 'bottom' };
    for (let i = 0; i < levels; i++) v = { type: 'paragraph', content: [v] };
    return v;
  };
  /** The value `n` arrays down. */
  const descend = (v: unknown, n: number): unknown => {
    for (let i = 0; i < n; i++) v = (v as unknown[])[0];
    return v;
  };

  it('is 512', () => {
    expect(STORE_SAFE_MAX_DEPTH).toBe(512);
  });

  it('a 100k-deep input: no RangeError in storeSafeJson, nor in isDeepStrictEqual or stableHash on its output', () => {
    const deep = nestNodes(100_000);
    let out: unknown;
    expect(() => (out = storeSafeJson(deep))).not.toThrow();
    expect(() => isDeepStrictEqual(out, storeSafeJson(nestNodes(100_000)))).not.toThrow();
    expect(isDeepStrictEqual(out, storeSafeJson(nestNodes(100_000)))).toBe(true);
    expect(() => stableHash(out)).not.toThrow();
    expect(() => JSON.stringify(out)).not.toThrow();
    // The no-op check compares the projection with the stored row: a legacy row holding the deep value compares
    // unequal (the walk stops where the projection holds null), never a RangeError.
    expect(() => isDeepStrictEqual(out, deep)).not.toThrow();
    expect(isDeepStrictEqual(out, deep)).toBe(false);
  });

  it('keeps every value at depth ≤ 512 and the same reference for a clean input exactly that deep', () => {
    const atMax = nestArrays(STORE_SAFE_MAX_DEPTH, 'leaf');
    expect(storeSafeJson(atMax)).toBe(atMax);
  });

  it('writes null for a value nested deeper than 512, copying only the path to it', () => {
    const over = nestArrays(STORE_SAFE_MAX_DEPTH + 1, 'leaf') as unknown[];
    const out = storeSafeJson(over) as unknown[];
    expect(out).not.toBe(over);
    expect(descend(out, STORE_SAFE_MAX_DEPTH)).toEqual([null]);
    expect(descend(over, STORE_SAFE_MAX_DEPTH + 1)).toBe('leaf'); // the input is untouched
    // An object member deeper than the bound is null too (not dropped), and a shallow sibling keeps its reference.
    const sibling = { ok: true };
    // `tooDeep` sits at depth 1, so its object at depth 512 and that object's `k` value at 513.
    const tooDeep = nestArrays(STORE_SAFE_MAX_DEPTH - 1, { k: { x: 1 } });
    const obj = { sibling, tooDeep };
    const outObj = storeSafeJson(obj) as typeof obj;
    expect(outObj.sibling).toBe(sibling);
    expect(descend(outObj.tooDeep, STORE_SAFE_MAX_DEPTH - 2)).toEqual([{ k: null }]);
  });

  it('honest page depth is far inside the bound: a 200-node-deep page comes back as the same reference', () => {
    const page = { type: 'doc', content: [nestNodes(200)] }; // 402 levels: deeper than the collab guard allows
    expect(storeSafeJson(page)).toBe(page);
  });

  it('a toJSON that overflows the stack (RangeError) projects as null; any other throw still propagates', () => {
    const overflow = (n: number): number => overflow(n + 1) + 1;
    const input = { a: { toJSON: () => overflow(0) }, b: 'kept' };
    expect(storeSafeJson(input)).toEqual({ a: null, b: 'kept' });
    expect(storeSafeJson([{ toJSON: () => { throw new RangeError('Maximum call stack size exceeded'); } }])).toEqual([null]);
    const boom = new TypeError('boom');
    expect(() => storeSafeJson({ a: { toJSON: () => { throw boom; } } })).toThrow(boom);
  });
});
