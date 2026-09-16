import { readFileSync } from 'fs';
import { join } from 'path';
import { stableHash, stableStringify } from './stable-hash';

/**
 * The conditional page write's digest (#282, ADR 0019).
 *
 * The settle issues a digest of the live document and the conditional write re-derives one from the live
 * document, so this is the only implementation in play — there is no cross-service contract to drift. What
 * these vectors protect is the transform itself: if it changes (a refactor here, or an upstream bump that
 * alters how documents serialize), in-flight digests stop matching and callers see a round of surprise
 * 412s. A red test is a better way to find that out.
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
