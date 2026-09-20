/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Bounded idempotency for `/v1` content writes (issue #429, builds on ADR 0019 / #282). A non-idempotent
 * `append`/`prepend` that the fork COMMITS but the platform then 504s (or a client/agent retries) would
 * otherwise apply the content twice. The fix records a caller-supplied `Idempotency-Key` in a top-level
 * `Y.Map` on the LIVE document, INSIDE the same `connection.transact(fn)` that applies the content — so the
 * check, the record and the mutation are ONE atomic CRDT operation.
 *
 * Why in the Y.Doc (and not a table / the platform): it makes the key and the content a single mutation,
 * persisted together in `pages.ydoc` (`Y.encodeStateAsUpdate`) or lost together, and it makes concurrency
 * correctness intrinsic to the single resident doc — two same-key writes serialize on the doc's synchronous
 * transaction (JS single-threaded; RedisSync routes both to the one owner), exactly the guarantee the #282
 * conditional-update CAS already relies on. No dependence on the platform, correct even standalone.
 *
 * The ledger is a TOP-LEVEL type, NOT the `'default'` fragment, so a recorded key never enters the content
 * JSON (`TiptapTransformer.fromYdoc(doc, 'default')`) or the version anchor / ETag — recording a key does
 * not rotate `expectedContentHash`. It is pruned by age AND a hard size cap so the ydoc stays bounded.
 *
 * GUARANTEE: bounded idempotency over the retention window (default ~1h), NOT unconditional exactly-once —
 * a same-key retry within the window is a no-op; beyond it (key pruned) or with a different key it is not
 * deduplicated. See ADR 0019 and issue #429.
 *
 * The check (`isDuplicateWriteKey`) is a PURE read: a duplicate must not mutate the doc, so the connection's
 * closing no-op store hits persistence.extension's `isDeepStrictEqual` short-circuit and touches nothing.
 * The record (`recordWriteKey`) runs only when content is actually applied, so a key is durable exactly when
 * it matters (the deep-equal skip drops a content-neutral write, which has nothing to dedup anyway, #429).
 */
import * as Y from 'yjs';

/** Top-level Y.Map name for the idempotency-key ledger. Deliberately not the `'default'` fragment. */
export const WRITE_IDEM_MAP = '__ccc_write_idem';

/** Retention window (ms) for a recorded key — the LOWER bound on how long a retry is deduplicated.
 *  Env-tunable; default ~1h. Read once at load (mirrors service-bridge/authz-change-feed.service.ts). */
export const WRITE_IDEM_RETENTION_MS = ((): number => {
  const n = Number.parseInt(process.env.PAGE_WRITE_IDEMPOTENCY_RETENTION_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 3_600_000;
})();

/** Hard cap on ledger entries per page (bloat guard, evict-oldest-first). Env-tunable; default 512. */
export const WRITE_IDEM_MAX_ENTRIES = ((): number => {
  const n = Number.parseInt(process.env.PAGE_WRITE_IDEMPOTENCY_MAX_ENTRIES ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 512;
})();

/**
 * Namespace a caller-chosen idempotency key by the ACTING USER's id before it enters the per-page ledger
 * (#429 security review, S1). The key comes from the client (the `/v1` `Idempotency-Key` header) and the
 * ledger is shared per page, so WITHOUT this scoping two different users could pick the same string and user
 * B's genuine write would be silently swallowed as a "duplicate" of user A's — a cross-user lost update that
 * returns 200, exactly the class ADR 0019 / #282 exist to prevent. Scoping per identity mirrors the platform
 * interceptor's per-subject record (`v1:idem:${subject}:…`), so dedup only ever applies WITHIN one identity
 * while a same-user retry still dedups. The separator is a NUL, which cannot occur in a UUID user id nor in an
 * HTTP header value, so distinct `(userId, key)` pairs never collide onto one entry (the composite is only
 * ever compared whole, never parsed back).
 */
export function scopedWriteKey(userId: string, key: string): string {
  return `${userId}\u0000${key}`;
}

/**
 * Is this (already user-scoped, see scopedWriteKey) idempotency key recorded on the live document? PURE —
 * never mutates the doc (see the file header: a duplicate must leave the doc untouched so the closing store
 * is a genuine no-op). Call inside the transaction, BEFORE applying content; on `true` the caller returns a
 * no-op outcome without mutating.
 */
export function isDuplicateWriteKey(doc: Y.Doc, key: string): boolean {
  return doc.getMap(WRITE_IDEM_MAP).has(key);
}

/**
 * Record `key` in the live document's dedup ledger with timestamp `nowMs`, pruning first by age then by a
 * hard size cap (evict oldest). Call inside the transaction, ONLY on a write that actually applies content,
 * so the key and the content commit as one atomic CRDT mutation. `nowMs`/bounds are injected so this is
 * unit-testable without a real clock.
 */
export function recordWriteKey(
  doc: Y.Doc,
  key: string,
  nowMs: number,
  retentionMs: number = WRITE_IDEM_RETENTION_MS,
  maxEntries: number = WRITE_IDEM_MAX_ENTRIES,
): void {
  const ledger = doc.getMap<number>(WRITE_IDEM_MAP);
  // Age-based prune: drop entries older than the window (a non-number value is corrupt → drop it too).
  for (const [k, ts] of [...ledger.entries()]) {
    if (typeof ts !== 'number' || nowMs - ts > retentionMs) ledger.delete(k);
  }
  // Size cap: evict oldest first, leaving room for the key we are about to add.
  const over = ledger.size - (maxEntries - 1);
  if (over > 0) {
    const oldest = [...ledger.entries()].sort(
      (a, b) => (a[1] as number) - (b[1] as number),
    );
    for (let i = 0; i < over && i < oldest.length; i++) ledger.delete(oldest[i][0]);
  }
  ledger.set(key, nowMs);
}
