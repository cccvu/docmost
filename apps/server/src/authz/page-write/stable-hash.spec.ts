import { readFileSync } from 'fs';
import { join } from 'path';
import { stableHash, stableStringify } from './stable-hash';

/**
 * CROSS-SERVICE CONTRACT test (#282, ADR 0017).
 *
 * The conditional page write compares a digest the PLATFORM computes over the `pages` row against one
 * computed HERE over the live Y.Doc. The two normalizations are deliberately duplicated across the
 * service boundary, so nothing but a shared fixture keeps them honest: if either side drifts, EVERY
 * conditional content write would 412 in production. The platform's contract spec asserts the same file
 * out of this submodule, so a drift on either side reds a test instead.
 */
const VECTORS = JSON.parse(
  readFileSync(join(__dirname, 'content-digest-vectors.json'), 'utf8'),
) as {
  algorithm: string;
  vectors: { name: string; value: unknown; digest: string }[];
};

describe('stable-hash — the shared content-digest contract', () => {
  it('carries a non-trivial set of vectors (a gutted fixture must not pass vacuously)', () => {
    expect(VECTORS.vectors.length).toBeGreaterThanOrEqual(10);
  });

  it.each(VECTORS.vectors.map((v) => [v.name, v] as const))(
    'matches the shared vector: %s',
    (_name, vector) => {
      expect(stableHash(vector.value)).toBe(vector.digest);
    },
  );

  // The property the contract rests on: JSON key order is an artifact of serialization, and the row and
  // the live document reach us through different paths (jsonb round-trip vs in-memory), so the digest
  // must not depend on it.
  it('is independent of key order at every depth', () => {
    const a = {
      type: 'doc',
      attrs: { id: 'x', align: null },
      content: [{ b: 1, a: 2 }],
    };
    const b = {
      content: [{ a: 2, b: 1 }],
      attrs: { align: null, id: 'x' },
      type: 'doc',
    };
    expect(stableHash(a)).toBe(stableHash(b));
  });

  // …but it MUST still distinguish real differences, or it would not be a version check at all.
  it('distinguishes a present-but-null attribute from an absent one', () => {
    expect(stableHash({ type: 'p', attrs: { id: null } })).not.toBe(
      stableHash({ type: 'p' }),
    );
  });

  it('distinguishes different text', () => {
    expect(stableHash({ text: 'a' })).not.toBe(stableHash({ text: 'b' }));
  });

  it('distinguishes array order (document order is meaningful)', () => {
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  });

  it('collapses cycles rather than throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => stableHash(cyclic)).not.toThrow();
  });

  it('serializes undefined and null identically to the platform (both → "null")', () => {
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify(null)).toBe('null');
  });
});
