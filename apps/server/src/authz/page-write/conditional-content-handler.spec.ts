// The handler module pulls the tiptap/yjs graph (lib0 ESM) that jest cannot parse. Stub the heavy
// value-imports; `@hocuspocus/server` is type-only here and is elided by ts-jest. TiptapTransformer is
// stubbed with a controllable serializer so we can drive the digest comparison deterministically.
const fromYdoc = jest.fn();
const toYdoc = jest.fn((..._a: unknown[]) => ({}) as unknown);
jest.mock('@hocuspocus/transformer', () => ({
  TiptapTransformer: {
    fromYdoc: (...a: unknown[]) => fromYdoc(...a),
    toYdoc: (...a: unknown[]) => toYdoc(...a),
  },
}));
jest.mock('yjs', () => ({
  applyUpdate: jest.fn(),
  encodeStateAsUpdate: jest.fn(() => new Uint8Array()),
}));
jest.mock('../../collaboration/collaboration.util', () => ({
  prosemirrorNodeToYElement: jest.fn((n: unknown) => n),
  tiptapExtensions: [],
}));
jest.mock('../../collaboration/yjs.util', () => ({
  setYjsMark: jest.fn(),
  updateYjsMarkAttribute: jest.fn(),
}));
// #731: a content operation's new nodes are built as Yjs preliminary types (prelim-content.ts, parity-pinned against
// toYdoc in prelim-content.parity.spec.ts). Stubbed: the stand-in "types" are the top-level JSON nodes themselves.
const buildPrelimContent = jest.fn((json: unknown) => ((json as { content?: unknown[] } | null)?.content ?? []) as unknown[]);
jest.mock('./prelim-content', () => ({
  buildPrelimContent: (...a: unknown[]) => buildPrelimContent(...(a as [unknown])),
}));

import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { stableHash } from './stable-hash';
import { scopedWriteKey } from './write-idem';

/**
 * #716: the fake documents need the Y.Doc surface the handler now uses — `transact` (ONE Yjs transaction around a
 * write's whole callback) and `on('afterTransaction')` (doc-version.ts's generation counter, which the memoized
 * digest is keyed on). `transact` fires the listeners at its end exactly as Yjs does; `remoteEdit` stands for a
 * transaction from anywhere else (a websocket frame, a delete-only edit, a remote update).
 */
function ydocLike<T extends object>(d: T) {
  const listeners: Array<() => void> = [];
  const fire = () => listeners.forEach((l) => l());
  return Object.assign(d, {
    clientID: 1, // #731: a replace inserts under an id of its own (insertAsOwnClient), then restores this one
    store: { clients: new Map() },
    on: jest.fn((evt: string, fn: () => void) => {
      if (evt === 'afterTransaction') listeners.push(fn);
    }),
    transact: jest.fn((f: () => void) => {
      try {
        f();
      } finally {
        fire();
      }
    }),
    remoteEdit: fire,
  });
}

/**
 * Compare-and-swap content write (#282, ADR 0019).
 *
 * The guarantee: the version check and the mutation happen in the SAME synchronous transaction callback,
 * so a websocket frame — a person typing — cannot land between them. These tests pin that; that a refusal
 * is inert in the strong sense (it never opens a direct connection, because opening one would persist the
 * human's live text under the API caller's identity); that the digest's ABSENCE — not residency — is what
 * waives the check; and that every non-applied outcome is reported as non-applied.
 */
describe('CollaborationHandler.conditionalUpdatePageContent (#282)', () => {
  const DOC = 'page.22222222-2222-4222-8222-222222222222';
  const LIVE = { type: 'doc', content: [{ type: 'paragraph' }] };
  const USER = { id: 'user-1' };

  /** A fragment that records the operations performed on it, so we can assert nothing ran on a refusal. */
  const makeFragment = (ops: string[]) => ({
    length: 1,
    delete: jest.fn(() => ops.push('delete')),
    insert: jest.fn(() => ops.push('insert')),
  });

  const build = (opts: { resident: boolean }) => {
    const ops: string[] = [];
    const fragment = makeFragment(ops);
    const doc = ydocLike({ getXmlFragment: jest.fn(() => fragment) });
    const reads: string[] = [];
    const backing = new Map<string, unknown>();
    if (opts.resident) backing.set(DOC, doc);
    const documents = {
      get: (name: string) => (reads.push('get'), backing.get(name)),
      has: (name: string) => (reads.push('has'), backing.has(name)),
    };

    const connection = {
      transact: jest.fn(async (fn: (d: unknown) => void) => {
        ops.push('transact');
        fn(doc);
      }),
      disconnect: jest.fn(async () => undefined),
    };
    const hocuspocus = {
      documents,
      openDirectConnection: jest.fn(async () => connection),
    };
    const handler = new CollaborationHandler().getHandlers(
      hocuspocus as never,
    ).conditionalUpdatePageContent;
    return { handler, ops, connection, hocuspocus, doc, reads };
  };

  beforeEach(() => {
    fromYdoc.mockReset();
    fromYdoc.mockReturnValue(LIVE);
  });

  const payload = (expectedContentHash: string, operation = 'replace') => ({
    prosemirrorJson: { type: 'doc', content: [] },
    operation,
    user: USER as never,
    expectedContentHash,
  });

  it('applies the write when the live document still matches the expected digest', async () => {
    const { handler, ops } = build({ resident: true });
    await expect(handler(DOC, payload(stableHash(LIVE)))).resolves.toEqual({
      applied: true,
    });
    expect(ops).toContain('delete'); // the replace actually ran
  });

  // THE guarantee. A stale digest means someone edited the document after the caller read it.
  it('refuses the write when the live document no longer matches', async () => {
    const { handler } = build({ resident: true });
    await expect(
      handler(DOC, payload(stableHash({ different: true }))),
    ).resolves.toEqual({
      applied: false,
      reason: 'precondition',
    });
  });

  // A refusal must be inert in the STRONG sense: it must not even open a direct connection.
  // `DirectConnection.transact()` and `.disconnect()` each run an immediate store, and on a refusal that
  // store is NOT a no-op — the live document has moved past the settled row by construction, so it would
  // write the human's in-flight text under the API caller's context: `lastUpdatedById` reassigned to the
  // service account, `updatedAt` rotated, a `page.updated` broadcast in the caller's name, the
  // history/AI/mention jobs fired, and the human's own pending store cancelled. Asserting only "the Y
  // fragment was untouched" cannot see any of that, which is why this asserts on the connection.
  it('opens no connection and mutates nothing when it refuses', async () => {
    const { handler, ops, doc, hocuspocus } = build({ resident: true });
    await handler(DOC, payload(stableHash({ different: true })));
    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    expect(ops).toEqual([]);
    expect(doc.getXmlFragment).not.toHaveBeenCalled();
  });

  // The atomicity argument, made testable: the comparison must happen INSIDE the transaction callback, not
  // before it. A check outside transact() would reintroduce exactly the race this endpoint exists to close.
  it('compares INSIDE the transaction, before the mutation', async () => {
    const order: string[] = [];
    fromYdoc.mockImplementation(() => {
      order.push('compare');
      return LIVE;
    });
    const doc = ydocLike({
      getXmlFragment: jest.fn(() => ({
        length: 0,
        delete: jest.fn(),
        insert: jest.fn(() => order.push('mutate')),
      })),
    });
    const connection = {
      transact: jest.fn(async (fn: (d: unknown) => void) => {
        order.push('transact:start');
        // #716: the digest is memoized per document state, so the in-transaction compare only re-walks the
        // document when a transaction ran since the pre-check — as one does here (an edit that landed while the
        // connection was opening: exactly the race the in-transaction compare exists for).
        doc.remoteEdit();
        fn(doc);
        order.push('transact:end');
      }),
      disconnect: jest.fn(async () => undefined),
    };
    const hocuspocus = {
      documents: new Map([[DOC, doc]]),
      openDirectConnection: jest.fn(async () => connection),
    };
    const handler = new CollaborationHandler().getHandlers(
      hocuspocus as never,
    ).conditionalUpdatePageContent;

    await handler(DOC, payload(stableHash(LIVE), 'append'));
    // The first 'compare' is the cheap pre-check against the resident document (which only ever refuses
    // early, never applies). The load-bearing one is the second: inside the transaction, before the
    // mutation — a check outside `transact()` would reintroduce exactly the race this closes. (Without the
    // edit in between, the second compare reuses the first's digest: see the #716 block below.)
    expect(order).toEqual([
      'compare',
      'transact:start',
      'compare',
      'mutate',
      'transact:end',
    ]);
  });

  // The ABSENCE of a digest — not residency — is what waives the check. The settle omits the digest only
  // when it found no resident document, which means nobody had the page open, so there was no unpersisted
  // delta and the caller's row-based check was already authoritative. Comparing anyway would 412 forever
  // on API-created pages, whose stored content is verbatim while this serialization normalizes it.
  it('applies unconditionally when the caller supplies NO digest, even for a resident document', async () => {
    const { handler, ops } = build({ resident: true });
    await expect(
      handler(DOC, {
        prosemirrorJson: { type: 'doc', content: [] },
        operation: 'replace',
        user: USER as never,
        expectedContentHash: undefined,
      }),
    ).resolves.toEqual({ applied: true });
    expect(ops).toContain('delete');
    expect(fromYdoc).not.toHaveBeenCalled(); // no digest ⇒ nothing to serialize or compare
  });

  // The settle-then-unload race, which the previous `wasResident` term silently waived: a digest can only
  // exist because the document WAS resident when the settle ran, so finding it gone now means it stored
  // and unloaded inside our own request window — the concurrent-edit case, not a reason to skip the check.
  // The connection reloads it from the row, and the compare must still run.
  it('still compares when the document unloaded between the settle and the apply', async () => {
    const { handler, ops } = build({ resident: false });
    await expect(
      handler(DOC, payload(stableHash({ someone: 'typed since' }))),
    ).resolves.toEqual({ applied: false, reason: 'precondition' });
    expect(ops).not.toContain('delete');
  });

  // The resident document is read BEFORE the connection is opened — opening it would load the document
  // and defeat the early refusal, putting the mis-attributing store back on the refusal path.
  it('reads the resident document before opening a connection', async () => {
    const { handler, reads, hocuspocus } = build({ resident: true });
    const order: string[] = [];
    const openSpy = hocuspocus.openDirectConnection;
    (hocuspocus as { openDirectConnection: unknown }).openDirectConnection =
      jest.fn(async (...a: unknown[]) => {
        order.push('open');
        return (openSpy as (...x: unknown[]) => unknown)(...a);
      });
    await handler(DOC, payload(stableHash(LIVE)));
    expect(reads[0]).toBe('get');
    expect(order).toEqual(['open']);
  });

  // The fail-closed default. If `transact` resolves without ever invoking the callback, no write happened
  // — and reporting `applied: true` there would hand the caller a 200 with a fresh ETag for content that
  // was never stored: the inverse of the lost update this exists to prevent, and just as invisible.
  it('reports NOT applied when the transaction never runs the callback', async () => {
    const connection = {
      transact: jest.fn(async () => undefined), // resolves without calling fn
      disconnect: jest.fn(async () => undefined),
    };
    const hocuspocus = {
      documents: { get: jest.fn(() => undefined), has: jest.fn(() => false) },
      openDirectConnection: jest.fn(async () => connection),
    };
    const handler = new CollaborationHandler().getHandlers(
      hocuspocus as never,
    ).conditionalUpdatePageContent;

    await expect(handler(DOC, payload('x'))).resolves.toEqual({
      applied: false,
      reason: 'unknown',
    });
  });

  // Cross-node, a throwing custom-event handler never publishes its RedisSync reply and hangs the caller
  // until the custom-event TTL. It must report instead — and "error" must NOT read as applied.
  it('reports an error outcome instead of throwing when the transaction fails', async () => {
    const hocuspocus = {
      // Not resident, so the cheap pre-check waives and we actually reach the connection that throws.
      documents: { get: jest.fn(() => undefined), has: jest.fn(() => false) },
      openDirectConnection: jest.fn(async () => {
        throw new Error('collab node exploded');
      }),
    };
    const handler = new CollaborationHandler().getHandlers(
      hocuspocus as never,
    ).conditionalUpdatePageContent;

    await expect(handler(DOC, payload('x'))).resolves.toEqual({
      applied: false,
      reason: 'error',
    });
  });

  // When a connection IS opened (the mid-request race: the document was not resident at the pre-check but
  // the in-transaction compare then refuses), it must still be released.
  it('always disconnects when it opened a connection, even on a refusal', async () => {
    const { handler, connection } = build({ resident: false });
    await handler(DOC, payload(stableHash({ different: true })));
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });
});

/**
 * Build-before-delete for a content `replace` (#342).
 *
 * `applyContentOperation` used to empty the Yjs fragment and THEN build the new document from the request
 * body. When that build throws (content that passed `jsonToNode` but that `TiptapTransformer.toYdoc`
 * rejects), the empty fragment is what the connection's closing `disconnect()` store persists — the page
 * is silently WIPED while the request also fails. The fix builds first, so a conversion failure aborts
 * before any mutation and the original content survives. Exercised through the ordinary `updatePageContent`
 * handler, which shares the same `applyContentOperation`.
 */
describe('CollaborationHandler.updatePageContent — build-before-delete (#342)', () => {
  const DOC = 'page.33333333-3333-4333-8333-333333333333';
  const USER = { id: 'user-1' };

  const build = () => {
    const ops: string[] = [];
    const fragment = {
      length: 3,
      delete: jest.fn(() => ops.push('delete')),
      insert: jest.fn(() => ops.push('insert')),
    };
    const doc = ydocLike({ getXmlFragment: jest.fn(() => fragment) });
    const connection = {
      transact: jest.fn(async (fn: (d: unknown) => void) => fn(doc)),
      disconnect: jest.fn(async () => undefined),
    };
    const hocuspocus = { openDirectConnection: jest.fn(async () => connection) };
    const handler = new CollaborationHandler().getHandlers(
      hocuspocus as never,
    ).updatePageContent;
    return { handler, fragment, connection, ops, hocuspocus };
  };

  const payload = () => ({
    prosemirrorJson: { type: 'doc', content: [] },
    operation: 'replace',
    user: USER as never,
  });

  beforeEach(() => {
    buildPrelimContent.mockClear();
  });

  it('does NOT delete the fragment when building the new document throws (page not wiped)', async () => {
    buildPrelimContent.mockImplementationOnce(() => {
      throw new Error('unconvertible content');
    });
    const { handler, fragment, connection, hocuspocus } = build();

    await expect(handler(DOC, payload())).rejects.toThrow('unconvertible content');

    // The fragment is intact — nothing was deleted.
    expect(fragment.delete).not.toHaveBeenCalled();
    // #716: stronger than before — the update is built BEFORE the connection opens, so a build failure opens no
    // connection at all: no store runs, nothing is persisted or reattributed (previously: opened, then released).
    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    expect(connection.transact).not.toHaveBeenCalled();
  });

  it('deletes then applies when the build succeeds (the normal replace still works)', async () => {
    const { handler, ops } = build();
    await handler(DOC, payload());
    // Build succeeded, so the swap runs: delete the old fragment, then apply the new state.
    expect(ops).toContain('delete');
  });

  it('#716 R4: applied but its stores failed to persist it → throws 500 write_outcome_unknown, never a quiet 200', async () => {
    const reg = await import('./store-failure-registry');
    const { handler, connection } = build();
    connection.transact.mockImplementation(async (fn: (d: unknown) => void) => {
      const doc = ydocLike({ getXmlFragment: jest.fn(() => ({ length: 0, delete: jest.fn(), insert: jest.fn() })) });
      fn(doc);
      reg.recordStoreFailure(doc); // the persistence extension swallowed a DB error and recorded it
    });
    const err = await handler(DOC, { ...payload(), operation: 'append' }).catch((e) => e);
    expect(err?.getStatus?.()).toBe(500);
    expect(err.getResponse()).toMatchObject({ code: 'write_outcome_unknown' });
  });

  it('#716: a store that succeeded (or no failure recorded) resolves normally', async () => {
    const { handler } = build();
    await expect(handler(DOC, { ...payload(), operation: 'append' })).resolves.toBeUndefined();
  });
});

/**
 * Bounded idempotency for keyed content writes (#429, ADR 0019).
 *
 * The regression #429 exists for: a non-idempotent `append`/`prepend` that the fork COMMITS but the platform
 * then 504s must not double-apply on a client/agent retry. The fix records the caller's key on the LIVE doc
 * INSIDE the same transaction as the content, and a repeat within the window is a no-op that mutates nothing
 * (so the closing store deep-equal-skips). Ledger mechanics/pruning are unit-tested in write-idem.spec.ts;
 * these pin the HANDLER wiring: check-before-apply, record-on-apply, duplicate → `reason:'duplicate'`.
 */
describe('CollaborationHandler.conditionalUpdatePageContent — idempotency (#429)', () => {
  const DOC = 'page.44444444-4444-4444-8444-444444444444';
  const USER = { id: 'user-1' };

  // The ledger is shared across invocations to simulate the ONE resident Y.Doc a page's writes serialize on
  // (a native Map stands in for the top-level Y.Map: write-idem uses only .has/.set/.delete/.size/.entries).
  const build = () => {
    const ledger = new Map<string, number>();
    const opsLog: string[][] = [];
    const openDirectConnection = jest.fn(async () => {
      const ops: string[] = [];
      opsLog.push(ops);
      const fragment = {
        length: 1,
        delete: jest.fn(() => ops.push('delete')),
        insert: jest.fn(() => ops.push('insert')),
      };
      const doc = ydocLike({
        getXmlFragment: jest.fn(() => fragment),
        getMap: jest.fn(() => ledger),
      });
      return {
        transact: jest.fn(async (fn: (d: unknown) => void) => {
          ops.push('transact');
          fn(doc);
        }),
        disconnect: jest.fn(async () => undefined),
      };
    });
    const hocuspocus = {
      documents: { get: jest.fn(() => undefined), has: jest.fn(() => false) },
      openDirectConnection,
    };
    const handler = new CollaborationHandler().getHandlers(
      hocuspocus as never,
    ).conditionalUpdatePageContent;
    return { handler, ledger, opsLog };
  };

  // Append, NO expectedContentHash — the exact vulnerable path (a keyed append with no If-Match).
  const payload = (idempotencyKey?: string, operation = 'append') => ({
    prosemirrorJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    operation,
    user: USER as never,
    idempotencyKey,
  });

  // The ledger key is namespaced by the acting user (scopedWriteKey), so assertions look it up scoped.
  const scoped = (key: string) => scopedWriteKey(USER.id, key);

  it('applies and records the (user-scoped) key on first sight', async () => {
    const { handler, ledger, opsLog } = build();
    await expect(handler(DOC, payload('K1'))).resolves.toEqual({ applied: true });
    expect(ledger.has(scoped('K1'))).toBe(true);
    expect(opsLog[0]).toContain('insert'); // the append actually ran
  });

  // THE regression: a retry with the same key does not re-apply.
  it('is a no-op DUPLICATE on a same-key retry — content not applied twice', async () => {
    const { handler, ledger, opsLog } = build();
    await handler(DOC, payload('K1')); // first — applies
    await expect(handler(DOC, payload('K1'))).resolves.toEqual({
      applied: false,
      reason: 'duplicate',
    });
    expect(ledger.size).toBe(1); // key recorded once
    expect(opsLog[1]).not.toContain('insert'); // the retry mutated nothing (benign no-op store)
  });

  it('applies independently for a DIFFERENT key on the same page', async () => {
    const { handler, ledger } = build();
    await handler(DOC, payload('K1'));
    await expect(handler(DOC, payload('K2'))).resolves.toEqual({ applied: true });
    expect(ledger.has(scoped('K1'))).toBe(true);
    expect(ledger.has(scoped('K2'))).toBe(true);
  });

  // #429 security review (S1): the ledger is per-page but the key is caller-chosen, so it MUST be scoped by
  // identity — otherwise user B's genuine write with a key user A already used is silently swallowed as a
  // duplicate (a cross-user lost update returning success). Two users, same key string, both must apply.
  it('scopes per user — a different user with the SAME key still applies (no cross-user suppression)', async () => {
    const { handler, ledger, opsLog } = build();
    await handler(DOC, payload('SHARED')); // user-1 applies + records
    const userB = { id: 'user-2' } as never;
    await expect(
      handler(DOC, { ...payload('SHARED'), user: userB }),
    ).resolves.toEqual({ applied: true }); // NOT suppressed
    expect(opsLog[1]).toContain('insert'); // user-2's write actually ran
    expect(ledger.has(scopedWriteKey('user-1', 'SHARED'))).toBe(true);
    expect(ledger.has(scopedWriteKey('user-2', 'SHARED'))).toBe(true);
  });

  it('leaves unkeyed writes unchanged (no key ⇒ no ledger entry, always applies)', async () => {
    const { handler, ledger, opsLog } = build();
    await expect(handler(DOC, payload(undefined))).resolves.toEqual({ applied: true });
    await expect(handler(DOC, payload(undefined))).resolves.toEqual({ applied: true });
    expect(ledger.size).toBe(0);
    expect(opsLog[0]).toContain('insert');
    expect(opsLog[1]).toContain('insert'); // both applied — no dedup without a key
  });
});

/**
 * #429 testing review (T1) — the ORDER of the two in-transaction guards is load-bearing and was untested:
 *   (a) dedup runs BEFORE the CAS, so a retry of a committed keyed write dedups instead of 412-ing on the
 *       digest its OWN first apply moved; and
 *   (b) the key is recorded ONLY on an actual apply (after the CAS), so a write that FAILS the precondition
 *       does not poison the ledger and silently swallow the caller's corrected retry (a lost update).
 * Swapping the blocks, or hoisting recordWriteKey above the precondition return, would leave the rest of the
 * suite green — these pin it. The platform routes a keyed write WITH an If-Match through exactly this path.
 */
describe('CollaborationHandler.conditionalUpdatePageContent — key × CAS ordering (#429)', () => {
  const DOC = 'page.55555555-5555-4555-8555-555555555555';
  const USER = { id: 'user-1' };
  const LIVE = { type: 'doc', content: [{ type: 'paragraph' }] };

  // Shared ledger across invocations = the one resident Y.Doc a page's writes serialize on. NOT resident at
  // the pre-check (documents.get → undefined) so we always reach the transaction where dedup + the
  // authoritative in-tx CAS run; `fromYdoc` is mocked to LIVE so `stableHash(fromYdoc(doc))` is deterministic.
  const build = () => {
    const ledger = new Map<string, number>();
    const opsLog: string[][] = [];
    const openDirectConnection = jest.fn(async () => {
      const ops: string[] = [];
      opsLog.push(ops);
      const fragment = {
        length: 1,
        delete: jest.fn(() => ops.push('delete')),
        insert: jest.fn(() => ops.push('insert')),
      };
      const doc = ydocLike({
        getXmlFragment: jest.fn(() => fragment),
        getMap: jest.fn(() => ledger),
      });
      return {
        transact: jest.fn(async (fn: (d: unknown) => void) => {
          ops.push('transact');
          fn(doc);
        }),
        disconnect: jest.fn(async () => undefined),
      };
    });
    const hocuspocus = {
      documents: { get: jest.fn(() => undefined), has: jest.fn(() => false) },
      openDirectConnection,
    };
    const handler = new CollaborationHandler().getHandlers(
      hocuspocus as never,
    ).conditionalUpdatePageContent;
    return { handler, ledger, opsLog };
  };

  beforeEach(() => {
    fromYdoc.mockReset();
    fromYdoc.mockReturnValue(LIVE);
  });

  const keyed = (idempotencyKey: string, expectedContentHash: string) => ({
    prosemirrorJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    operation: 'append',
    user: USER as never,
    expectedContentHash,
    idempotencyKey,
  });

  // (a) dedup BEFORE the CAS: a retry of a committed keyed conditional write must dedup, NOT 412 — its own
  // first apply moved the content, so the digest it carried no longer matches. If the CAS ran first this
  // would return `precondition`; it must return `duplicate`.
  it('dedups a same-key retry even when the digest no longer matches (dedup precedes the CAS)', async () => {
    const { handler, ledger } = build();
    await expect(handler(DOC, keyed('K1', stableHash(LIVE)))).resolves.toEqual({
      applied: true,
    });
    await expect(
      handler(DOC, keyed('K1', stableHash({ moved: 'since' }))),
    ).resolves.toEqual({ applied: false, reason: 'duplicate' });
    expect(ledger.size).toBe(1);
  });

  // (b) record ONLY on apply (after the CAS): a keyed write that fails the precondition must NOT record its
  // key, or the caller's corrected retry is silently swallowed as a duplicate — a lost update.
  it('does NOT record the key when the CAS refuses, so a corrected retry still applies', async () => {
    const { handler, ledger, opsLog } = build();
    // First: digest mismatch on first sight → precondition, key NOT recorded, nothing mutated.
    await expect(
      handler(DOC, keyed('K1', stableHash({ different: true }))),
    ).resolves.toEqual({ applied: false, reason: 'precondition' });
    expect(ledger.has(scopedWriteKey('user-1', 'K1'))).toBe(false);
    expect(opsLog[0]).not.toContain('insert');
    // The corrected retry (matching digest now) APPLIES — proof the key was not poisoned by the refusal.
    await expect(handler(DOC, keyed('K1', stableHash(LIVE)))).resolves.toEqual({
      applied: true,
    });
    expect(ledger.has(scopedWriteKey('user-1', 'K1'))).toBe(true);
  });
});

/**
 * #716 main thread + outcome-unknown. Phase 1 is three semantics-preserving changes, each pinned here:
 *   - a replace's update is built BEFORE the pre-check (pure function of the request), then one tick is yielded;
 *     a build failure opens nothing;
 *   - nothing yields between the pre-check and the transaction (that would widen the #282 window);
 *   - the live digest is memoized per document state: an unchanged document is walked once; any transaction in
 *     between (a delete-only or remote edit) forces the authoritative in-transaction compare to re-walk it;
 * plus the outcomes: `applied_unconfirmed` once the mutation began and something then failed, and the page cap's
 * `too_large` evaluated after the dedup and the CAS. Deterministic: promise/macrotask handoffs, no timers.
 */
describe('CollaborationHandler.conditionalUpdatePageContent — #716', () => {
  const DOC = 'page.66666666-6666-4666-8666-666666666666';
  const LIVE = { type: 'doc', content: [{ type: 'paragraph' }] };
  const USER = { id: 'user-1' };

  const build = (
    opts: {
      resident?: boolean;
      /** Runs inside connection.transact, before the callback (a remote edit, …). */
      before?: (doc: ReturnType<typeof ydocLike>) => void;
      /** Runs inside connection.transact, after the callback (its store). */
      after?: (doc: ReturnType<typeof ydocLike>) => void;
      disconnectThrows?: boolean;
      insertThrows?: boolean;
    } = {},
  ) => {
    const ops: string[] = [];
    const ledger = new Map<string, number>();
    const fragment = {
      length: 1,
      delete: jest.fn(() => ops.push('delete')),
      insert: jest.fn(() => {
        if (opts.insertThrows) throw new Error('integrate failed');
        ops.push('insert');
      }),
    };
    const doc = ydocLike({ getXmlFragment: jest.fn(() => fragment), getMap: jest.fn(() => ledger) });
    const connection = {
      transact: jest.fn(async (fn: (d: unknown) => void) => {
        opts.before?.(doc);
        fn(doc);
        opts.after?.(doc);
      }),
      disconnect: jest.fn(async () => {
        if (opts.disconnectThrows) throw new Error('store hook threw');
      }),
    };
    const hocuspocus = {
      documents: new Map(opts.resident === false ? [] : [[DOC, doc]]),
      openDirectConnection: jest.fn(async () => (ops.push('open'), connection)),
    };
    const handler = new CollaborationHandler().getHandlers(hocuspocus as never).conditionalUpdatePageContent;
    return { handler, ops, doc, connection, hocuspocus, ledger };
  };
  const req = (over: Record<string, unknown> = {}) => ({
    prosemirrorJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    operation: 'append',
    user: USER as never,
    ...over,
  });

  beforeEach(() => {
    fromYdoc.mockReset();
    fromYdoc.mockReturnValue(LIVE);
    buildPrelimContent.mockClear();
  });

  describe('the digest memo (doc-version.ts)', () => {
    it('an unchanged document is walked ONCE for the pre-check and the in-transaction compare', async () => {
      const { handler, ops } = build();
      await expect(handler(DOC, req({ expectedContentHash: stableHash(LIVE) }))).resolves.toEqual({ applied: true });
      expect(fromYdoc).toHaveBeenCalledTimes(1);
      expect(ops).toContain('insert');
    });

    it('CAS atomicity: a remote delete-only update between the pre-check and the CAS → 412, nothing mutated', async () => {
      const { handler, ops, ledger } = build({
        before: (doc) => {
          // A delete-only edit: content changes, the state vector does not. It runs in a Yjs transaction, so the
          // generation bumps and the in-transaction compare re-walks the document.
          fromYdoc.mockReturnValue({ type: 'doc', content: [] });
          doc.remoteEdit();
        },
      });
      await expect(
        handler(DOC, req({ expectedContentHash: stableHash(LIVE), idempotencyKey: 'K' })),
      ).resolves.toEqual({ applied: false, reason: 'precondition' });
      expect(fromYdoc).toHaveBeenCalledTimes(2); // pre-check + the forced re-walk
      expect(ops).not.toContain('insert');
      expect(ops).not.toContain('delete');
      expect(ledger.size).toBe(0); // a refused write records no key
    });

    it('the settle digest is reused by the following write when nothing changed in between', async () => {
      const { doc } = build();
      const flush = new CollaborationHandler().getHandlers({
        documents: new Map([
          [DOC, Object.assign(doc, { saveMutex: { runExclusive: async () => undefined, isLocked: () => false } })],
        ]),
        debouncer: { isDebounced: () => false, isCurrentlyExecuting: () => false },
      } as never).flushPageContent;
      const settled = await flush(DOC, { withDigest: true });
      expect(settled).toEqual({ flushed: true, contentDigest: stableHash(LIVE) });
      const { liveContentDigest } = await import('./doc-version');
      expect(liveContentDigest(doc as never)).toBe(stableHash(LIVE));
      expect(fromYdoc).toHaveBeenCalledTimes(1);
    });
  });

  describe('replace: built before the pre-check, one tick, nothing between the pre-check and the transaction', () => {
    it('builds, yields one macrotask, then pre-checks and opens', async () => {
      const order: string[] = [];
      buildPrelimContent.mockImplementationOnce(() => {
        order.push('build');
        setImmediate(() => order.push('tick')); // queued during the build: runs in the yield after it
        return [];
      });
      fromYdoc.mockImplementation(() => (order.push('compare'), LIVE));
      const { handler, hocuspocus } = build();
      const open = hocuspocus.openDirectConnection;
      hocuspocus.openDirectConnection = jest.fn(async () => (order.push('open'), open()));
      await expect(
        handler(DOC, req({ operation: 'replace', expectedContentHash: stableHash(LIVE) })),
      ).resolves.toEqual({ applied: true });
      expect(order).toEqual(['build', 'tick', 'compare', 'open']);
    });

    it('a build failure opens no connection, runs no store, mutates nothing → error (retryable, nothing applied)', async () => {
      buildPrelimContent.mockImplementationOnce(() => {
        throw new Error('unconvertible content');
      });
      const { handler, hocuspocus, ops } = build();
      await expect(handler(DOC, req({ operation: 'replace' }))).resolves.toEqual({ applied: false, reason: 'error' });
      expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
      expect(ops).toEqual([]);
    });

    it('no macrotask runs between the resident pre-check and the transaction callback', async () => {
      // #731 F4: the first walk (the warm-up) is followed by a yield; an edit landing in it makes the pre-check walk
      // again, and the tick that walk queues must come after the mutation.
      const order: string[] = [];
      const { handler, doc } = build();
      let first = true;
      fromYdoc.mockImplementation(() => {
        order.push('compare');
        if (first) {
          first = false;
          setImmediate(() => (order.push('edit'), doc.remoteEdit()));
        } else setImmediate(() => order.push('tick'));
        return LIVE;
      });
      (doc.getXmlFragment as jest.Mock).mockImplementation(() => ({
        length: 0,
        delete: jest.fn(),
        insert: jest.fn(() => order.push('mutate')),
      }));
      await expect(handler(DOC, req({ expectedContentHash: stableHash(LIVE) }))).resolves.toEqual({ applied: true });
      await new Promise((r) => setImmediate(r));
      expect(order).toEqual(['compare', 'edit', 'compare', 'mutate', 'tick']);
    });

    it('#731 F4: a cold digest is warmed, then a loop turn, then the pre-check (a memo hit) and the transaction', async () => {
      const order: string[] = [];
      const { handler, doc, hocuspocus } = build();
      const get = hocuspocus.documents.get.bind(hocuspocus.documents);
      hocuspocus.documents.get = ((name: string) => (order.push('get'), get(name))) as never;
      fromYdoc.mockImplementation(() => {
        order.push('walk');
        setImmediate(() => order.push('tick'));
        return LIVE;
      });
      const open = hocuspocus.openDirectConnection;
      hocuspocus.openDirectConnection = jest.fn(async () => (order.push('open'), open()));
      (doc.transact as jest.Mock).mockImplementation((f: () => void) => {
        order.push('transaction');
        try {
          f();
        } finally {
          doc.remoteEdit();
        }
      });
      await expect(handler(DOC, req({ expectedContentHash: stableHash(LIVE) }))).resolves.toEqual({ applied: true });
      // warm (walk) → yield (tick) → pre-check (memo hit: no walk) → open → transaction (CAS: memo hit).
      expect(order).toEqual(['get', 'walk', 'tick', 'get', 'open', 'transaction']);
    });

    it('#731 F4: a digest the memo already holds (the settle\'s) is not walked again by the warm-up', async () => {
      const { handler, doc } = build();
      const { liveContentDigest } = await import('./doc-version');
      expect(liveContentDigest(doc as never)).toBe(stableHash(LIVE)); // the settle's digest
      fromYdoc.mockClear();
      await expect(handler(DOC, req({ expectedContentHash: stableHash(LIVE) }))).resolves.toEqual({ applied: true });
      expect(fromYdoc).not.toHaveBeenCalled(); // warm-up, pre-check and CAS all hit (warmLiveContentDigest → false: no yield)
    });

    it('applies the pre-built content (nothing is built again inside the transaction): delete, then ONE insert', async () => {
      const { handler, ops, doc } = build();
      await handler(DOC, req({ operation: 'replace' }));
      expect(buildPrelimContent).toHaveBeenCalledTimes(1);
      expect(toYdoc).not.toHaveBeenCalled(); // #731: no second Y.Doc is built, encoded or applied
      expect(ops).toEqual(['open', 'delete', 'insert']);
      expect(((doc.getXmlFragment as jest.Mock)() as { insert: jest.Mock }).insert).toHaveBeenCalledWith(0, [{ type: 'paragraph' }]);
    });

    it('the whole callback runs inside ONE doc.transact', async () => {
      const { handler, doc, ops } = build();
      let inside = false;
      (doc.transact as jest.Mock).mockImplementation((f: () => void) => {
        inside = true;
        try {
          f();
        } finally {
          inside = false;
        }
      });
      (doc.getXmlFragment as jest.Mock).mockImplementation(() => ({
        length: 1,
        delete: jest.fn(() => ops.push(inside ? 'delete:in-tx' : 'delete:outside')),
        insert: jest.fn(),
      }));
      await handler(DOC, req({ operation: 'replace' }));
      expect(doc.transact).toHaveBeenCalledTimes(1);
      expect(ops).toContain('delete:in-tx');
      expect(ops).not.toContain('delete:outside');
    });
  });

  describe('applied_unconfirmed (O2/R4): once the mutation began, a failure is never a retryable error', () => {
    it("disconnect()'s store throws after the apply → applied_unconfirmed", async () => {
      const { handler, ops } = build({ disconnectThrows: true });
      await expect(handler(DOC, req())).resolves.toEqual({ applied: false, reason: 'applied_unconfirmed' });
      expect(ops).toContain('insert');
    });

    it("transact()'s store throws after the callback applied → applied_unconfirmed", async () => {
      const { handler } = build({
        after: () => {
          throw new Error('store failed');
        },
      });
      await expect(handler(DOC, req())).resolves.toEqual({ applied: false, reason: 'applied_unconfirmed' });
    });

    it('the mutation itself throws part-way → applied_unconfirmed (the live document may hold part of it)', async () => {
      const { handler } = build({ insertThrows: true });
      await expect(handler(DOC, req())).resolves.toEqual({ applied: false, reason: 'applied_unconfirmed' });
    });

    it('the stores swallowed a DB failure (hasStoreFailure) after the apply → applied_unconfirmed, not a 200', async () => {
      const { recordStoreFailure } = await import('./store-failure-registry');
      const { handler } = build({ after: (doc) => recordStoreFailure(doc) });
      await expect(handler(DOC, req())).resolves.toEqual({ applied: false, reason: 'applied_unconfirmed' });
    });

    it('a later successful store (the disconnect retry) clears it → applied', async () => {
      const reg = await import('./store-failure-registry');
      const { handler, connection, doc } = build({ after: (d) => reg.recordStoreFailure(d) });
      connection.disconnect.mockImplementation(async () => reg.clearStoreFailure(doc));
      await expect(handler(DOC, req())).resolves.toEqual({ applied: true });
    });

    it('an append whose nodes cannot be built fails BEFORE opening: a plain error, never applied_unconfirmed', async () => {
      buildPrelimContent.mockImplementationOnce(() => {
        throw new Error('unknown node type');
      });
      const { handler, ops, hocuspocus } = build();
      await expect(handler(DOC, req({ idempotencyKey: 'K' }))).resolves.toEqual({ applied: false, reason: 'error' });
      expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
      expect(ops).toEqual([]);
    });

    it('a failure BEFORE the mutation stays a plain error (nothing applied: safe to retry)', async () => {
      const { handler, hocuspocus } = build({ resident: false });
      hocuspocus.openDirectConnection.mockImplementation(async () => {
        throw new Error('collab node exploded');
      });
      await expect(handler(DOC, req())).resolves.toEqual({ applied: false, reason: 'error' });
    });

    it('a store failure on a refused or duplicate write is not reported as applied_unconfirmed', async () => {
      const { recordStoreFailure } = await import('./store-failure-registry');
      const { handler } = build({ resident: false, after: (doc) => recordStoreFailure(doc) });
      await expect(handler(DOC, req({ expectedContentHash: stableHash({ other: 1 }) }))).resolves.toEqual({
        applied: false,
        reason: 'precondition',
      });
    });
  });

  describe('the page cap (refuseOverCap): after the dedup and the CAS, before any mutation', () => {
    it('refuses an append with too_large, mutating nothing and recording no key', async () => {
      const { handler, ops, ledger } = build();
      await expect(handler(DOC, req({ refuseOverCap: true, idempotencyKey: 'K' }))).resolves.toEqual({
        applied: false,
        reason: 'too_large',
      });
      expect(ops).not.toContain('insert');
      expect(ledger.size).toBe(0);
    });

    it('resident: decided on the live document WITHOUT opening a connection (no stores, nothing reattributed)', async () => {
      buildPrelimContent.mockClear();
      const { handler, ops, hocuspocus } = build();
      await expect(handler(DOC, req({ refuseOverCap: true, idempotencyKey: 'K', prosemirrorJson: undefined }))).resolves.toEqual({
        applied: false,
        reason: 'too_large',
      });
      expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
      expect(ops).toEqual([]);
      expect(buildPrelimContent).not.toHaveBeenCalled(); // nothing built for content never applied
    });

    it('resident: an applied retry is duplicate, a stale digest is precondition — both without opening', async () => {
      const { handler, hocuspocus } = build();
      await expect(handler(DOC, req({ idempotencyKey: 'K' }))).resolves.toEqual({ applied: true });
      hocuspocus.openDirectConnection.mockClear();
      await expect(handler(DOC, req({ idempotencyKey: 'K', refuseOverCap: true }))).resolves.toEqual({
        applied: false,
        reason: 'duplicate',
      });
      await expect(
        handler(DOC, req({ idempotencyKey: 'K2', refuseOverCap: true, expectedContentHash: stableHash({ other: 1 }) })),
      ).resolves.toEqual({ applied: false, reason: 'precondition' });
      await expect(
        handler(DOC, req({ idempotencyKey: 'K2', refuseOverCap: true, expectedContentHash: stableHash(LIVE) })),
      ).resolves.toEqual({ applied: false, reason: 'too_large' });
      expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    });

    it('not resident: the connection loads it and the same order applies inside the transaction', async () => {
      const { handler, ops } = build({ resident: false });
      await expect(handler(DOC, req({ refuseOverCap: true, prosemirrorJson: undefined }))).resolves.toEqual({
        applied: false,
        reason: 'too_large',
      });
      expect(ops).toContain('open');
      expect(ops).not.toContain('insert');
    });

    it('a retry of an append that ALREADY applied answers duplicate, not too_large (the dedup wins)', async () => {
      const { handler, ledger } = build();
      await expect(handler(DOC, req({ idempotencyKey: 'K' }))).resolves.toEqual({ applied: true });
      expect(ledger.size).toBe(1);
      await expect(handler(DOC, req({ idempotencyKey: 'K', refuseOverCap: true }))).resolves.toEqual({
        applied: false,
        reason: 'duplicate',
      });
    });

    it('a stale write answers precondition, not too_large (the CAS wins)', async () => {
      const { handler } = build({ resident: false });
      await expect(
        handler(DOC, req({ refuseOverCap: true, expectedContentHash: stableHash({ other: 1 }) })),
      ).resolves.toEqual({ applied: false, reason: 'precondition' });
    });
  });
});
