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
 *
 * WHAT AN ENTRY IS (#781 lineage, ledger-userid-exposure): a one-way digest of (acting user, caller key),
 * `h1:` + base64url(sha256(`ccc-write-idem/v1` NUL userId NUL key)), never the user id or the key. Every
 * top-level root of the live doc syncs to EVERY connection (read-only viewers included) and y-indexeddb keeps
 * it unencrypted in their browsers, and a Y.Map delete keeps its key string in the tombstone forever, so a
 * plaintext entry would publish, permanently, which Docmost user wrote through the API and when (and the raw
 * caller key, e.g. `attachment-embed:<attachmentId>`). The digest is pseudonymous, not unlinkable: a viewer
 * who knows a user id AND can guess that user's key (a predictable caller key, `attachment-embed:<id>`) can
 * confirm the pair, which reveals only what page history / `lastUpdatedById` already show that reader; MCP
 * keys are random per call. Timestamps and entry counts are still visible. Historical raw entries recorded
 * before this change stay in `pages.ydoc` and every IndexedDB copy as tombstones: removing them would mean
 * rewriting each doc's Yjs history, which a stale IndexedDB copy would then re-merge.
 *
 * LEGACY DUAL READ (one release): replicas before this change recorded the raw composite `userId NUL key`. The
 * check reads that form too (`ScopedWriteKey` carries it privately; nothing exported can build or record it),
 * so a retry first applied by an old replica still dedups after the roll. The reverse is NOT covered: an old
 * replica (rolling overlap or a rollback) reads only raw entries, so a keyed write that a new replica applied
 * and 504'd (outcome unknown; the platform's Redis claim is released on any error, so this ledger is the only
 * dedup) can apply twice if its same-key retry runs on the old-image owner within the window. MCP is not
 * exposed (a fresh key per call never dedups anyway); a `/v1` integrator reusing a stable `Idempotency-Key`,
 * or a retried attachment auto-embed, is. Remove the legacy read once rollback below this release is ruled out.
 */
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { readRootMapEntries } from './reconcile-store';

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

/** Domain separator of the `h1:` ledger entry. Changing it (or the derivation) silently ends dedup of every
 *  in-window retry across the deploy that ships it, so the golden vector in write-idem.spec.ts pins it. */
const LEDGER_DOMAIN_H1 = 'ccc-write-idem/v1';

/**
 * A caller key namespaced by the ACTING USER (#429 security review, S1), as the ledger stores it. The key comes
 * from the client (the `/v1` `Idempotency-Key` header) and the ledger is shared per page, so WITHOUT this
 * scoping two different users could pick the same string and user B's genuine write would be silently
 * swallowed as a "duplicate" of user A's: a cross-user lost update that returns 200, exactly the class
 * ADR 0019 / #282 exist to prevent. Scoping per identity mirrors the platform interceptor's per-subject record
 * (`v1:idem:${subject}:…`), so dedup only ever applies WITHIN one identity while a same-user retry still dedups.
 *
 * `entry` is the only form ever RECORDED: the `h1:` digest (see the file header for why never the id or key).
 * The NUL separators are unambiguous because a UUID user id cannot contain NUL, so distinct `(userId, key)`
 * pairs hash distinct inputs (the input is UTF-8, which is lossless: the golden vectors in write-idem.spec.ts
 * pin it with non-ASCII keys). The pre-digest raw composite is held privately and only ever READ, by
 * `isDuplicateWriteKey`, which accepts only a `ScopedWriteKey` (`.entry` would skip the legacy read and does
 * not type-check there).
 */
export class ScopedWriteKey {
  readonly #legacyEntry: string;

  private constructor(
    /** The ledger entry this write records and checks: `h1:` + 43 base64url chars. */
    readonly entry: string,
    legacyEntry: string,
  ) {
    this.#legacyEntry = legacyEntry;
  }

  static of(userId: string, key: string): ScopedWriteKey {
    const entry =
      'h1:' +
      createHash('sha256')
        .update(`${LEDGER_DOMAIN_H1}\u0000${userId}\u0000${key}`, 'utf8')
        .digest('base64url');
    // READ-ONLY legacy form (fork 137d3fc0, 2026-09-20, until this change). Never recorded: see the file header.
    return new ScopedWriteKey(entry, `${userId}\u0000${key}`);
  }

  /** PURE. Is this write recorded in `ledger`, in the current form or the legacy raw one? */
  isRecordedIn(ledger: Y.Map<unknown>): boolean {
    return ledger.has(this.entry) || ledger.has(this.#legacyEntry);
  }

  /** A log line or template literal gets the digest, never the user id or the key. */
  toString(): string {
    return this.entry;
  }
}

/** The ledger key for (acting user, caller key): see `ScopedWriteKey`. Synchronous, so the check, the content
 *  and the record stay one synchronous CRDT transaction. */
export function scopedWriteKey(userId: string, key: string): ScopedWriteKey {
  return ScopedWriteKey.of(userId, key);
}

/**
 * Is this idempotency key recorded on the live document? PURE: never mutates the doc (see the file header: a
 * duplicate must leave the doc untouched so the closing store is a genuine no-op). Call inside the transaction,
 * BEFORE applying content; on `true` the caller returns a no-op outcome without mutating.
 *
 * Takes a `ScopedWriteKey` only (never a string, `.entry` included), so every check also reads the legacy raw
 * entry and is scoped to the acting user (S1). Specs that need a raw entry seed the map directly.
 */
export function isDuplicateWriteKey(doc: Y.Doc, key: ScopedWriteKey): boolean {
  return key.isRecordedIn(doc.getMap(WRITE_IDEM_MAP));
}

/**
 * Record `key` in the live document's dedup ledger with timestamp `nowMs`, pruning first by age then by a
 * hard size cap (evict oldest). Call inside the transaction, ONLY on a write that actually applies content,
 * so the key and the content commit as one atomic CRDT mutation. `nowMs`/bounds are injected so this is
 * unit-testable without a real clock.
 */
export function recordWriteKey(
  doc: Y.Doc,
  key: ScopedWriteKey,
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
  // The digest only, never the legacy raw form. A `ScopedWriteKey`-only signature means no caller can record a
  // raw or unscoped entry through here (write-idem.fitness.spec.ts keeps every other writer of the root out).
  ledger.set(key.entry, nowMs);
}

// --- #827 compaction: the ledger read out of a page and carried, verbatim, into its rebuilt lineage

declare const storedLedgerKey: unique symbol;
/** A key exactly as a ledger holds it (an `h1:` digest, or a legacy raw entry a replica before it recorded). Made
 *  only by reading a ledger here, so `carryLedgerOver` can write back nothing a ledger did not already hold. */
export type StoredLedgerKey = string & { readonly [storedLedgerKey]: true };
/** One number-valued ledger entry (anything else is corrupt and would be pruned at the next record anyway). */
export interface LedgerEntry {
  readonly key: StoredLedgerKey;
  readonly ts: number;
}

/** The live document's ledger. Pure: never creates the root. */
export function ledgerOfDoc(doc: Y.Doc): LedgerEntry[] {
  if (!doc.share.has(WRITE_IDEM_MAP)) return [];
  const out: LedgerEntry[] = [];
  for (const [key, ts] of doc.getMap<unknown>(WRITE_IDEM_MAP).entries()) {
    if (typeof ts === 'number' && Number.isFinite(ts)) out.push({ key: key as StoredLedgerKey, ts });
  }
  return out;
}

/**
 * A stored row's ledger, from its decoded structs and delete set (reconcile-store.ts `readRootMapEntries`: nothing is
 * integrated, so it works on a row too costly to load). `unresolved`: live entries whose key the bytes could not name.
 */
export function ledgerOfDecoded(
  structs: Parameters<typeof readRootMapEntries>[0],
  ds: Parameters<typeof readRootMapEntries>[1],
): { ledger: LedgerEntry[]; unresolved: number } {
  const { entries, unresolved } = readRootMapEntries(structs, ds, WRITE_IDEM_MAP);
  const ledger: LedgerEntry[] = [];
  for (const [key, { value }] of entries) {
    if (typeof value === 'number' && Number.isFinite(value)) ledger.push({ key: key as StoredLedgerKey, ts: value });
  }
  return { ledger, unresolved };
}

/**
 * Write `entries` (read from the page by `ledgerOfDoc` / `ledgerOfDecoded`) into a document compaction built, as they
 * were: a write applied before the compaction still dedups after it. Only entries a ledger already held can be
 * passed (`StoredLedgerKey`), so this records no new key and no raw form that was not already there.
 */
export function carryLedgerOver(doc: Y.Doc, entries: readonly LedgerEntry[]): void {
  if (entries.length === 0) return;
  const ledger = doc.getMap<number>(WRITE_IDEM_MAP);
  for (const { key, ts } of entries) ledger.set(key, ts);
}
