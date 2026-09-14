import { createHash } from 'crypto';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Deterministic JSON: object keys sorted recursively, so key ORDER can never change the output. Cycles
 * collapse to null.
 *
 * ⚠️ CROSS-SERVICE CONTRACT. This is a deliberate byte-for-byte mirror of the platform's
 * `services/platform/src/v1/stable-stringify.ts`. The conditional page write (#282, ADR 0017) compares a
 * digest the PLATFORM computes over the `pages` row against one computed HERE over the live Y.Doc; if the
 * two normalizations ever diverge, every conditional content write 412s. The duplication is intentional —
 * the two deployables must not couple their release cycles across the AGPL boundary for a pure transform —
 * and it is pinned from both sides by `content-digest-vectors.json` in this directory, which the platform's
 * contract spec reads out of this submodule. Change one side and that test reds.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const rec = v as Record<string, unknown>;
    return Object.keys(rec)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = norm(rec[k]);
        return acc;
      }, {});
  };
  return JSON.stringify(norm(value) ?? null);
}

/** The content digest used as the conditional write's expected version. See the contract note above. */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
