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
    // The NUL separator cannot occur in a UUID id or an HTTP header value, so no two distinct pairs collide.
    expect(scopedWriteKey('u1', 'k')).not.toBe(scopedWriteKey('u1', '\u0000k')); // hypothetical, still distinct
    expect(scopedWriteKey('u1', 'a')).not.toBe(scopedWriteKey('u', '1a')); // the "u1:a" vs "u:1a" ambiguity, closed
  });
});
