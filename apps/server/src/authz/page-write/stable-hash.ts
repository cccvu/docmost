import { createHash } from 'crypto';
import { STORE_SAFE_MAX_DEPTH } from './store-safe-json';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Deterministic JSON: object keys sorted recursively, so key ORDER can never change the output. Cycles
 * collapse to null.
 *
 * BOTH SIDES OF THE CONDITIONAL WRITE HASH HERE. The settle hands the caller a digest of the live document
 * and the conditional write compares the caller's digest against the live document again — so this is the
 * only implementation involved, and there is deliberately no cross-service hashing contract to drift.
 *
 * That is not an accident of convenience: content authored through the API is stored verbatim, while
 * `TiptapTransformer.fromYdoc` fills in ProseMirror's default attributes (e.g. `attrs: {indent: 0}`). A
 * digest derived from the `pages` row therefore cannot equal one derived from a resident document until a
 * store has rewritten the row — a caller comparing the two would 412 forever. The digest must always be
 * issued by, and checked against, the same serialization.
 *
 * `content-digest-vectors.json` beside this file pins the transform so an accidental change (or an upstream
 * bump that alters serialization) shows up as a red test rather than a round of surprise 412s.
 *
 * Depth bound (#781, ADR 0036): a value nested deeper than `STORE_SAFE_MAX_DEPTH` (the root is depth 0) is written as
 * `null`, exactly as `storeSafeJson` projects it, so the walk recurses at most that deep. A legacy row or version
 * nested 100k deep (an HTTP JSON write before the ingress rules) then hashes instead of throwing RangeError on the
 * conditional write's snapshot and on every page ETag. Inside the bound the output is unchanged, byte for byte, so the
 * golden vectors here and the platform's ETag over every real page still match (stable-hash.depth.spec.ts).
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown, depth: number): unknown => {
    if (depth > STORE_SAFE_MAX_DEPTH) return v === undefined ? undefined : null;
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => norm(x, depth + 1));
    const rec = v as Record<string, unknown>;
    return Object.keys(rec)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = norm(rec[k], depth + 1);
        return acc;
      }, {});
  };
  return JSON.stringify(norm(value, 0) ?? null);
}

/** The content digest used as the conditional write's expected version. See the contract note above. */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
