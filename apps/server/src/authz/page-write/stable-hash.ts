import { createHash } from 'crypto';

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
