import * as Y from 'yjs';
import {
  WRITE_IDEM_MAP,
  isDuplicateWriteKey,
  recordWriteKey,
  scopedWriteKey,
} from './write-idem';

/**
 * #429 — the pure idempotency-ledger primitive. These lock the invariants the commit-boundary dedup relies
 * on: a duplicate check never mutates the doc (so a duplicate is a benign no-op store), the record rides a
 * top-level Y.Map that never touches the `'default'` content fragment (so it cannot rotate the version
 * anchor), and the ledger stays bounded by age AND a hard size cap.
 */
describe('write-idem (#429 bounded idempotency ledger)', () => {
  const NOW = 1_000_000_000_000; // fixed clock (injected — no real Date.now)

  it('is not a duplicate on first sight, and is after recording', () => {
    const doc = new Y.Doc();
    expect(isDuplicateWriteKey(doc, 'k1')).toBe(false);
    recordWriteKey(doc, 'k1', NOW);
    expect(isDuplicateWriteKey(doc, 'k1')).toBe(true);
    // A different key is independent.
    expect(isDuplicateWriteKey(doc, 'k2')).toBe(false);
  });

  it('isDuplicateWriteKey is a PURE read — it never mutates the doc', () => {
    const doc = new Y.Doc();
    recordWriteKey(doc, 'k1', NOW);
    const before = Y.encodeStateAsUpdate(doc);
    for (let i = 0; i < 5; i++) {
      expect(isDuplicateWriteKey(doc, 'k1')).toBe(true); // repeated checks
      expect(isDuplicateWriteKey(doc, 'absent')).toBe(false);
    }
    expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(Buffer.from(before));
  });

  it('recording a key does NOT touch the "default" content fragment (version anchor unaffected)', () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const p = new Y.XmlElement('paragraph');
    fragment.insert(0, [p]);
    const contentBefore = fragment.toJSON();

    recordWriteKey(doc, 'k1', NOW);

    expect(fragment.toJSON()).toEqual(contentBefore); // content unchanged
    expect(doc.getMap(WRITE_IDEM_MAP).has('k1')).toBe(true); // key rides its own top-level map
  });

  it('prunes entries older than the retention window on the next record', () => {
    const doc = new Y.Doc();
    const retentionMs = 3_600_000; // ~1h
    recordWriteKey(doc, 'old', NOW, retentionMs);
    // A later record past the window prunes the stale entry.
    recordWriteKey(doc, 'fresh', NOW + retentionMs + 1, retentionMs);
    expect(isDuplicateWriteKey(doc, 'old')).toBe(false); // pruned
    expect(isDuplicateWriteKey(doc, 'fresh')).toBe(true);
  });

  it('evicts oldest first beyond the hard size cap', () => {
    const doc = new Y.Doc();
    const retentionMs = 3_600_000;
    const maxEntries = 3;
    recordWriteKey(doc, 'a', NOW + 1, retentionMs, maxEntries);
    recordWriteKey(doc, 'b', NOW + 2, retentionMs, maxEntries);
    recordWriteKey(doc, 'c', NOW + 3, retentionMs, maxEntries);
    // Adding a 4th (cap 3) evicts the oldest ('a').
    recordWriteKey(doc, 'd', NOW + 4, retentionMs, maxEntries);
    expect(isDuplicateWriteKey(doc, 'a')).toBe(false); // evicted (oldest)
    expect(isDuplicateWriteKey(doc, 'b')).toBe(true);
    expect(isDuplicateWriteKey(doc, 'c')).toBe(true);
    expect(isDuplicateWriteKey(doc, 'd')).toBe(true);
    expect(doc.getMap(WRITE_IDEM_MAP).size).toBe(maxEntries);
  });

  it('the recorded key survives a ydoc encode/decode round-trip (durability boundary, proof §8)', () => {
    const doc = new Y.Doc();
    recordWriteKey(doc, 'k1', NOW);
    // Simulate persist to pages.ydoc + reload (onLoadDocument: Y.applyUpdate(newDoc, storedState)).
    const stored = Y.encodeStateAsUpdate(doc);
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, stored);
    expect(isDuplicateWriteKey(reloaded, 'k1')).toBe(true); // dedup holds after reload
  });
});

/**
 * #429 security review (S1) — the ledger key is NAMESPACED by the acting user, so a caller-chosen key can
 * only ever dedup a retry from the SAME identity, never suppress a different user's genuine write.
 */
describe('scopedWriteKey (#429 per-user ledger scoping, S1)', () => {
  const NOW = 1_000_000_000_000;

  it('a shared key under two different users does NOT collide (no cross-user suppression)', () => {
    const doc = new Y.Doc();
    // User A records the key first.
    recordWriteKey(doc, scopedWriteKey('user-a', 'SHARED'), NOW);
    // User B's write with the SAME caller key is NOT seen as a duplicate.
    expect(isDuplicateWriteKey(doc, scopedWriteKey('user-b', 'SHARED'))).toBe(false);
    // A's own retry still dedups.
    expect(isDuplicateWriteKey(doc, scopedWriteKey('user-a', 'SHARED'))).toBe(true);
  });

  it('is injective — distinct (userId, key) pairs never map to the same entry', () => {
    // The NUL separator cannot occur in a UUID id, so no two distinct pairs hash the same input. Compared by
    // ENTRY (two ScopedWriteKey objects are never the same reference, so comparing them would be vacuous).
    const e = (u: string, k: string) => scopedWriteKey(u, k).entry;
    expect(e('u1', 'k')).toBe(e('u1', 'k')); // deterministic: a same-user retry finds its entry
    expect(e('u1', 'k')).not.toBe(e('u1', '\u0000k')); // hypothetical, still distinct
    expect(e('u1', 'a')).not.toBe(e('u', '1a')); // the "u1:a" vs "u:1a" ambiguity, closed
  });
});

/**
 * #781 lineage (ledger-userid-exposure): every top-level root of the live doc syncs to every viewer and their
 * IndexedDB, and a Y.Map delete keeps its key string in the tombstone forever. So the ledger records a digest
 * of (user, key), never either one. The raw composite `${userId}\u0000${key}` written below is the PRE-FIX
 * format, spelled out here on purpose (the module never exports a builder for it): an independent pin of what
 * old replicas recorded, and the control that proves each "does not contain" assertion can fail.
 */
describe('scopedWriteKey — ledger entries disclose neither the writer nor the key', () => {
  const NOW = 1_000_000_000_000;
  const UID = '0193a000-0000-7000-8000-000000000001';
  const KEY = 'attachment-embed:0193b000-0000-7000-8000-0000000000aa';
  const legacy = (u: string, k: string) => `${u}\u0000${k}`;
  const bytes = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc));

  it('golden vector: the h1 derivation is pinned (a change silently ends in-window dedup across a deploy)', () => {
    expect(scopedWriteKey('0193a000-0000-7000-8000-000000000001', 'v2:abc').entry).toBe(
      'h1:zHuB--sCVbqjBxuAlaxf7f_LO0TWqHTOI1BA0Fac8ow',
    );
  });

  it('an entry is h1: + a full 256-bit base64url digest, containing neither the user id nor the key', () => {
    const k = scopedWriteKey(UID, KEY);
    expect(k.entry).toMatch(/^h1:[A-Za-z0-9_-]{43}$/);
    expect(k.entry).not.toContain(UID);
    expect(k.entry).not.toContain('attachment-embed');
    // Every string rendering of the key is the digest too (a log line or template literal cannot leak it).
    expect(String(k)).toBe(k.entry);
    expect(`${k}`).toBe(k.entry);
    expect(JSON.stringify(k)).not.toContain(UID);
    expect(JSON.stringify(k)).not.toContain('attachment-embed');
    // Control: the pre-fix form carries both, so the assertions above are not vacuous.
    expect(legacy(UID, KEY)).toContain(UID);
    expect(legacy(UID, KEY)).toContain('attachment-embed');
  });

  // The property that matters is the BYTES every browser syncs and keeps, tombstones included: record an entry,
  // let a later record age-prune it (a Y.Map delete), and the encoded state must hold neither id nor key.
  it.each([
    ['the h1 entry (treatment)', (u: string, k: string): Parameters<typeof recordWriteKey>[1] => scopedWriteKey(u, k), false],
    ['the pre-fix raw entry (control)', legacy, true],
  ] as const)('the encoded doc state, tombstones included, after recording and pruning %s', (_n, build, leaks) => {
    const doc = new Y.Doc();
    const retentionMs = 1_000;
    recordWriteKey(doc, build(UID, KEY), NOW, retentionMs);
    expect(bytes(doc).includes(UID)).toBe(leaks); // live entry
    recordWriteKey(doc, scopedWriteKey('0193a000-0000-7000-8000-000000000002', 'v2:other'), NOW + retentionMs + 1, retentionMs);
    expect(doc.getMap(WRITE_IDEM_MAP).size).toBe(1); // the first entry was pruned: only its tombstone remains
    expect(bytes(doc).includes(UID)).toBe(leaks);
    expect(bytes(doc).includes('attachment-embed')).toBe(leaks);
    const reloaded = new Y.Doc(); // what a browser's IndexedDB or pages.ydoc reload holds
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
    expect(bytes(reloaded).includes(UID)).toBe(leaks);
  });

  it('records ONLY the h1 entry: the legacy raw form is never written', () => {
    const doc = new Y.Doc();
    recordWriteKey(doc, scopedWriteKey(UID, KEY), NOW);
    expect([...doc.getMap(WRITE_IDEM_MAP).keys()]).toEqual([scopedWriteKey(UID, KEY).entry]);
  });

  it('dual read: an entry a pre-fix replica recorded raw still dedups the same user, and only that user (S1)', () => {
    const doc = new Y.Doc();
    recordWriteKey(doc, legacy('user-a', 'K'), NOW); // seeded exactly as an old replica wrote it
    expect(isDuplicateWriteKey(doc, scopedWriteKey('user-a', 'K'))).toBe(true);
    expect(isDuplicateWriteKey(doc, scopedWriteKey('user-b', 'K'))).toBe(false);
    expect(isDuplicateWriteKey(doc, scopedWriteKey('user-a', 'K2'))).toBe(false);
    // `.entry` alone is the WRONG idiom in production: it skips the legacy read (documented on ScopedWriteKey).
    expect(isDuplicateWriteKey(doc, scopedWriteKey('user-a', 'K').entry)).toBe(false);
  });

  it('the dual read is PURE: no transaction, no byte changes', () => {
    const doc = new Y.Doc();
    recordWriteKey(doc, legacy('user-a', 'K'), NOW);
    recordWriteKey(doc, scopedWriteKey('user-a', 'K2'), NOW);
    const before = bytes(doc);
    const txns = jest.fn();
    doc.on('afterTransaction', txns);
    for (const k of ['K', 'K2', 'absent']) isDuplicateWriteKey(doc, scopedWriteKey('user-a', k));
    expect(txns).not.toHaveBeenCalled();
    expect(bytes(doc)).toEqual(before);
  });

  // The accepted rollback / new→old overlap window, made explicit: an OLD replica's check (raw only) does not see
  // what a new replica recorded. Flipping this deliberately is the expand/contract alternative (ADR 0019).
  it('mixed fleet: an old-replica check does not see an h1 entry (the documented rollback window)', () => {
    const doc = new Y.Doc();
    recordWriteKey(doc, scopedWriteKey('user-a', 'K'), NOW);
    expect(isDuplicateWriteKey(doc, legacy('user-a', 'K'))).toBe(false); // old code: ledger.has(raw)
    expect(isDuplicateWriteKey(doc, scopedWriteKey('user-a', 'K'))).toBe(true);
  });

  it('prune and cap treat raw and h1 entries alike (mixed ledgers age out and evict oldest-first)', () => {
    const doc = new Y.Doc();
    const retentionMs = 1_000;
    const maxEntries = 3;
    recordWriteKey(doc, legacy('user-a', 'OLD'), NOW, retentionMs, maxEntries);
    recordWriteKey(doc, scopedWriteKey('user-a', 'OLD-H1'), NOW, retentionMs, maxEntries);
    // Past the window: both forms age out together.
    recordWriteKey(doc, legacy('user-a', 'R1'), NOW + retentionMs + 1, retentionMs, maxEntries);
    expect(isDuplicateWriteKey(doc, scopedWriteKey('user-a', 'OLD'))).toBe(false);
    expect(isDuplicateWriteKey(doc, scopedWriteKey('user-a', 'OLD-H1'))).toBe(false);
    recordWriteKey(doc, scopedWriteKey('user-a', 'H1'), NOW + retentionMs + 2, retentionMs, maxEntries);
    recordWriteKey(doc, legacy('user-a', 'R2'), NOW + retentionMs + 3, retentionMs, maxEntries);
    // Cap 3, a 4th entry evicts the oldest across both forms (the raw R1).
    recordWriteKey(doc, scopedWriteKey('user-a', 'H2'), NOW + retentionMs + 4, retentionMs, maxEntries);
    expect(isDuplicateWriteKey(doc, scopedWriteKey('user-a', 'R1'))).toBe(false);
    for (const k of ['H1', 'R2', 'H2']) expect(isDuplicateWriteKey(doc, scopedWriteKey('user-a', k))).toBe(true);
    expect(doc.getMap(WRITE_IDEM_MAP).size).toBe(maxEntries);
  });
});
