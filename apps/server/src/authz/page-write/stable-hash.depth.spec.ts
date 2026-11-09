import { pageEtagOpaque } from './page-etag';
import { stableHash, stableStringify } from './stable-hash';
import { STORE_SAFE_MAX_DEPTH, storeSafeJson } from './store-safe-json';

/**
 * #781 (ADR 0036): a legacy row whose content nests a value far deeper than any page needs (an HTTP JSON write before
 * the ingress rules, or a pre-#781 collab write) must not throw RangeError where the stored or live content is hashed:
 * the conditional write's snapshot (`stableHash` over the row and the newest version), the page ETag every conditional
 * page operation compares (`pageEtagOpaque`), and the live digest. `stableStringify` bounds its own recursion at the
 * store's depth bound, projecting deeper values as `null` exactly as `storeSafeJson` does, so a hash of a row and a
 * hash of what the store would write agree, and everything inside the bound hashes byte-for-byte as before (the golden
 * vectors beside this file are unchanged).
 */
const deep = (depth: number): unknown => JSON.parse('{"a":'.repeat(depth) + '"leaf"' + '}'.repeat(depth));
const row = (depth: number) => ({
  type: 'doc',
  content: [{ type: 'paragraph', attrs: { textAlign: deep(depth) }, content: [{ type: 'text', text: 'x' }] }],
});

/** The pre-#781 algorithm (and the platform's), unbounded: the control arm. */
function unboundedStableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const rec = v as Record<string, unknown>;
    return Object.keys(rec).sort().reduce<Record<string, unknown>>((acc, k) => ((acc[k] = norm(rec[k])), acc), {});
  };
  return JSON.stringify(norm(value) ?? null);
}

describe('#781 hashing stored content never overflows the stack', () => {
  it('control: the unbounded walk throws on a 100k-deep row', () => {
    expect(() => unboundedStableStringify(row(100_000))).toThrow(/Maximum call stack/);
  });

  it('stableStringify / stableHash of a 100k-deep row: no throw, and equal to the hash of the store\'s projection', () => {
    const r = row(100_000);
    expect(() => stableHash(r)).not.toThrow();
    expect(stableStringify(r)).toBe(stableStringify(storeSafeJson(r)));
    expect(stableHash(r)).toBe(stableHash(row(100_000))); // deterministic
  });

  it('inside the bound the output is byte-for-byte the unbounded one (no contract change for a real page)', () => {
    for (const depth of [0, 1, 50, STORE_SAFE_MAX_DEPTH - 10]) {
      expect(stableStringify(row(depth))).toBe(unboundedStableStringify(row(depth)));
    }
  });

  it('the page ETag of a 100k-deep row is computed (conditional page operations answer 412/200, never 500)', () => {
    const material = { updatedAt: new Date('2026-01-01T00:00:00Z'), lastUpdatedById: 'u1', content: row(100_000) };
    expect(pageEtagOpaque(material)).toMatch(/^[0-9a-f]{64}$/);
    expect(pageEtagOpaque(material)).toBe(pageEtagOpaque({ ...material, content: row(100_000) }));
  });
});
