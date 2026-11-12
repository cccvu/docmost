// #390 — orchestration pins for the reconcile-before-store seam inside PersistenceExtension.onStoreDocument.
// The module pulls the tiptap/yjs graph (lib0 ESM) jest cannot parse, plus a large DI graph, so the heavy
// value-imports are stubbed; the CRDT correctness itself is proven with REAL yjs in reconcile-store.spec.ts
// and the guard logic in blank-clobber-guard.spec.ts. This spec pins the ORCHESTRATION invariants the #390
// fix depends on:
//   1. the row's ydoc is read under the SAME withLock findById (one locked read) — TOCTOU,
//   2. the reconcile runs BEFORE the write payload is serialized — TOCTOU,
//   3. the write payload is serialized INSIDE the FOR UPDATE transaction — TOCTOU (moving it out but after
//      the reconcile would stay green on #2 alone yet reopen the window). #840: the one exception is a snapshot taken
//      BEFORE the lock whose bytes provably hold the locked row (the row is the bytes the document covered then);
//      any other row is serialized again inside, after the reconcile,
//   4. a failed store is RECORDED (never re-thrown) and a successful one CLEARS the flag,
//   5. a failed store does not fire the post-store side effects,
//   6. the two alarm call-sites fire (logStaleReconcile on merge, logStoreFailure on failure) — dropping
//      either keeps data-loss protection working while silently killing the shipped monitoring.tf alarms,
//   7. the null-ydoc guard refuses a blank clobber but lets a genuine edit through.
const fromYdoc = jest.fn(() => ({ type: 'doc', content: [{ type: 'paragraph' }] }));
jest.mock('@hocuspocus/transformer', () => ({
  TiptapTransformer: { fromYdoc: (...a: unknown[]) => fromYdoc(...(a as [])) },
}));
jest.mock('yjs', () => ({ encodeStateAsUpdate: () => new Uint8Array([1, 2, 3]) }));

const getPageId = jest.fn((..._a: unknown[]) => 'page-1');
const jsonToText = jest.fn((..._a: unknown[]) => 'text');
jest.mock('../../collaboration/collaboration.util', () => ({
  getPageId: (...a: unknown[]) => getPageId(...(a as [])),
  jsonToText: (...a: unknown[]) => jsonToText(...(a as [])),
  tiptapExtensions: [],
}));
// Captured (lazy arrow refs, like fromYdoc above) so a test can drive the mention side effect: by default
// they return [] (mention effect early-returns), overridden in the #345 mention-isolation case.
const extractMentions = jest.fn((..._a: unknown[]) => [] as unknown[]);
const extractUserMentions = jest.fn((..._a: unknown[]) => [] as unknown[]);
jest.mock('../../common/helpers/prosemirror/utils', () => ({
  extractMentions: (...a: unknown[]) => extractMentions(...(a as [])),
  extractUserMentions: (...a: unknown[]) => extractUserMentions(...(a as [])),
}));
// Track whether we are inside the executeTx callback when the write payload is serialized (TOCTOU pin #3).
const mockTx = { inside: false, serializeSawInside: undefined as boolean | undefined };
jest.mock('@docmost/db/utils', () => ({
  executeTx: async (_db: unknown, cb: (trx: unknown) => Promise<unknown>) => {
    mockTx.inside = true;
    try {
      return await cb({});
    } finally {
      mockTx.inside = false;
    }
  },
}));

const reconcileRowIntoDoc = jest.fn(() => ({ merged: false }));
const markRowCovered = jest.fn();
// #840: the reconcile memo read with the pre-lock snapshot (null: the document covers no known row bytes).
const coveredRowDigest = jest.fn((..._a: unknown[]) => null as string | null);
jest.mock('./reconcile-store', () => ({
  reconcileRowIntoDoc: (...a: unknown[]) => reconcileRowIntoDoc(...(a as [])),
  markRowCovered: (...a: unknown[]) => markRowCovered(...(a as [])),
  coveredRowDigest: (...a: unknown[]) => coveredRowDigest(...(a as [])),
}));
const recordStoreFailure = jest.fn();
const clearStoreFailure = jest.fn();
// #731: the one-store-per-write skip (its logic is unit-tested in store-failure-registry.spec.ts and end to end,
// with real Hocuspocus, in content-write-passes.spec.ts); here only the seam's call sites and their order.
const isStoreCurrent = jest.fn((..._a: unknown[]) => false);
const markStoredAt = jest.fn();
const storeGenerationOf = jest.fn((..._a: unknown[]) => 7 as number | undefined);
jest.mock('./store-failure-registry', () => ({
  recordStoreFailure: (...a: unknown[]) => recordStoreFailure(...(a as [])),
  clearStoreFailure: (...a: unknown[]) => clearStoreFailure(...(a as [])),
  hasStoreFailure: jest.fn(() => false),
  isStoreCurrent: (...a: unknown[]) => isStoreCurrent(...(a as [])),
  markStoredAt: (...a: unknown[]) => markStoredAt(...(a as [])),
  storeGenerationOf: (...a: unknown[]) => storeGenerationOf(...(a as [])),
}));
const logStaleReconcile = jest.fn();
const logStoreFailure = jest.fn();
const logPostStoreFailure = jest.fn();
jest.mock('./collab-drift-log', () => ({
  logStaleReconcile: (...a: unknown[]) => logStaleReconcile(...(a as [])),
  logStoreFailure: (...a: unknown[]) => logStoreFailure(...(a as [])),
  logPostStoreFailure: (...a: unknown[]) => logPostStoreFailure(...(a as [])),
}));
// #840: the order check and the heal row (heal-image.spec.ts, heal-image.pg.spec.ts) need real yjs; here every store
// is order-stable and drops no heal row. The snapshot's placement is real: heal-image's prepareStore and
// storeSnapshotUnderLock, minus the order check, over the real persistence-steps (snapshotForStore, snapshotHoldsRow).
jest.mock('./heal-image', () => {
  const steps = jest.requireActual('./persistence-steps');
  const stable = { stable: true, why: null, structs: 0, ms: 0, source: null, image: null };
  const take = (doc: unknown, underLock: boolean) => ({
    coveredRow: underLock ? null : steps.coveredRowAtSnapshot(doc),
    snapshot: steps.snapshotForStore(doc),
    order: stable,
    underLock,
  });
  return {
  prepareStore: async (doc: unknown) => take(doc, false),
  storeSnapshotUnderLock: async (doc: unknown, _page: string, prepared: { coveredRow: string | null }, row: Uint8Array | null) =>
    steps.snapshotHoldsRow(prepared.coveredRow, row) ? prepared : take(doc, true),
  persistOrderState: async () => ({ unstable: false, reloadFailed: false, imaged: false, ydocWritten: false, structs: 0, ms: 0 }),
  afterOrderStore: () => undefined,
  loadStableYdoc: async () => undefined,
  noteLoadedBytes: () => undefined,
  };
});
// blank-clobber-guard is left REAL (pure JSON, no heavy imports) so the null-ydoc tests exercise its
// actual structural classifier.

import { createHash } from 'node:crypto';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';

const digestOf = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');

describe('PersistenceExtension.onStoreDocument reconcile seam (#390)', () => {
  const document = { broadcastStateless: jest.fn() };
  const context = { user: { id: 'u1' } };
  const text = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });

  const build = (page: unknown, updateImpl?: () => Promise<unknown>) => {
    const findById = jest.fn(async () => page);
    const updatePage = jest.fn(updateImpl ?? (async () => undefined));
    const pageRepo = { findById, updatePage } as any;
    const queue = { add: jest.fn(async () => undefined) } as any;
    const collabHistory = { addContributors: jest.fn(async () => undefined) } as any;
    const transclusion = {
      syncPageTransclusions: jest.fn(async () => undefined),
      syncPageReferences: jest.fn(async () => undefined),
    } as any;
    const ext = new PersistenceExtension(pageRepo, {} as any, queue, queue, queue, collabHistory, transclusion);
    return { ext, findById, updatePage };
  };

  const run = (ext: PersistenceExtension) =>
    ext.onStoreDocument({ documentName: 'page.1', document, lastContext: context } as any);

  beforeEach(() => {
    jest.clearAllMocks();
    fromYdoc.mockImplementation(() => {
      mockTx.serializeSawInside = mockTx.inside; // record whether serialize ran inside the txn
      return { type: 'doc', content: [{ type: 'paragraph' }] };
    });
    jsonToText.mockReturnValue('text');
    reconcileRowIntoDoc.mockReturnValue({ merged: false });
    isStoreCurrent.mockReturnValue(false);
    storeGenerationOf.mockReturnValue(7);
    coveredRowDigest.mockReturnValue(null);
    mockTx.inside = false;
    mockTx.serializeSawInside = undefined;
  });

  it('reads the row ydoc under the SAME withLock findById (one locked read) — TOCTOU', async () => {
    const { ext, findById } = build({ id: 'page-1', slugId: 's', content: { type: 'doc', content: [] }, ydoc: Buffer.from([9]) });
    await run(ext);
    expect(findById).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledWith(
      'page-1',
      expect.objectContaining({ withLock: true, includeContent: true, includeYdoc: true }),
    );
  });

  it('reconciles the row into the doc BEFORE serializing, and serializes INSIDE the FOR UPDATE txn — TOCTOU', async () => {
    const order: string[] = [];
    reconcileRowIntoDoc.mockImplementation(() => {
      order.push('reconcile');
      return { merged: true };
    });
    fromYdoc.mockImplementation(() => {
      order.push('serialize');
      mockTx.serializeSawInside = mockTx.inside;
      return { type: 'doc', content: [{ type: 'paragraph' }] };
    });
    const { ext } = build({ id: 'page-1', slugId: 's', content: { type: 'doc', content: [] }, ydoc: Buffer.from([9]) });

    await run(ext);

    expect(reconcileRowIntoDoc).toHaveBeenCalledWith(document, expect.anything());
    // #840: the pre-lock snapshot does not cover this row, so the payload is serialized again after the reconcile.
    expect(order).toEqual(['serialize', 'reconcile', 'serialize']);
    expect(mockTx.serializeSawInside).toBe(true); // the last serialize (the one written) ran inside executeTx
  });

  it('#840: a snapshot taken before the lock is written only when the locked row is the bytes the document covered then', async () => {
    const row = Buffer.from([9]);
    const order: string[] = [];
    reconcileRowIntoDoc.mockImplementation(() => (order.push('reconcile'), { merged: false }));
    fromYdoc.mockImplementation(() => (order.push(mockTx.inside ? 'serialize:in-tx' : 'serialize:before-lock'), { type: 'doc', content: [{ type: 'paragraph' }] }));
    coveredRowDigest.mockReturnValue(digestOf(row));
    const covered = build({ id: 'page-1', slugId: 's', content: { type: 'doc', content: [] }, ydoc: row });
    await run(covered.ext);
    expect(order).toEqual(['serialize:before-lock', 'reconcile']); // one snapshot, outside the lock, and it is written
    expect(covered.updatePage).toHaveBeenCalledTimes(1);

    order.length = 0; // another node wrote the row: the snapshot is taken again under the lock, after the reconcile
    const moved = build({ id: 'page-1', slugId: 's', content: { type: 'doc', content: [] }, ydoc: Buffer.from([8]) });
    await run(moved.ext);
    expect(order).toEqual(['serialize:before-lock', 'reconcile', 'serialize:in-tx']);
    coveredRowDigest.mockReturnValue(null);
  });

  it('emits COLLAB_STALE_RECONCILE (logStaleReconcile) when the reconcile merges', async () => {
    reconcileRowIntoDoc.mockReturnValue({ merged: true });
    const { ext } = build({ id: 'page-1', slugId: 's', content: { type: 'doc', content: [] }, ydoc: Buffer.from([9]) });
    await run(ext);
    expect(logStaleReconcile).toHaveBeenCalledTimes(1);
  });

  it('CLEARS the store-failure flag after a successful store', async () => {
    const { ext } = build({ id: 'page-1', slugId: 's', content: { type: 'doc', content: [] }, ydoc: Buffer.from([9]) });
    await run(ext);
    expect(clearStoreFailure).toHaveBeenCalledWith(document);
    expect(recordStoreFailure).not.toHaveBeenCalled();
  });

  it('RECORDS a store failure (never re-throws), emits COLLAB_STORE_FAILED, and skips post-store side effects', async () => {
    const { ext } = build(
      { id: 'page-1', slugId: 's', content: { type: 'doc', content: [] }, ydoc: Buffer.from([9]) },
      async () => {
        throw new Error('db down');
      },
    );

    await expect(run(ext)).resolves.toBeUndefined(); // never throws
    expect(recordStoreFailure).toHaveBeenCalledWith(document);
    expect(logStoreFailure).toHaveBeenCalledTimes(1);
    expect(clearStoreFailure).not.toHaveBeenCalled();
    expect(document.broadcastStateless).not.toHaveBeenCalled(); // side effects skipped for a failed write
  });

  it('null-ydoc: refuses to overwrite non-empty row content with a blank resident doc (and alarms)', async () => {
    fromYdoc.mockReturnValue({ type: 'doc', content: [{ type: 'paragraph' }] }); // outgoing = blank
    const { ext, updatePage } = build({ id: 'page-1', slugId: 's', content: text('real row text'), ydoc: null });

    await run(ext);

    expect(reconcileRowIntoDoc).not.toHaveBeenCalled(); // no ydoc lineage to diff
    expect(updatePage).not.toHaveBeenCalled(); // refused → row preserved
    expect(logStaleReconcile).toHaveBeenCalledTimes(1);
  });

  it('null-ydoc: allows a GENUINE (non-blank) edit through', async () => {
    fromYdoc.mockReturnValue(text('a real new edit')); // outgoing = non-blank
    const { ext, updatePage } = build({ id: 'page-1', slugId: 's', content: text('old'), ydoc: null });

    await run(ext);

    expect(updatePage).toHaveBeenCalledTimes(1); // genuine edit persists
    expect(logStaleReconcile).not.toHaveBeenCalled();
  });
});

// #731 — one store per write. The skip and the generation mark are the only additions to the #390 seam; these pin
// WHERE they sit (the conditions the ADR 0031 amendment rests on). The logic itself: store-failure-registry.spec.ts;
// end to end with real Hocuspocus: content-write-passes.spec.ts.
describe('PersistenceExtension.onStoreDocument one-store-per-write seam (#731)', () => {
  const document = { broadcastStateless: jest.fn() };
  const context = { user: { id: 'u1' } };
  const ROW = { id: 'page-1', slugId: 's', content: { type: 'doc', content: [] }, ydoc: Buffer.from([9]), creatorId: 'c1' };

  const build = (page: unknown, updateImpl?: () => Promise<unknown>) => {
    const findById = jest.fn(async () => page);
    const updatePage = jest.fn(updateImpl ?? (async () => undefined));
    const collabHistory = { addContributors: jest.fn(async () => undefined) } as any;
    const queue = { add: jest.fn(async () => undefined) } as any;
    const transclusion = { syncPageTransclusions: jest.fn(async () => undefined), syncPageReferences: jest.fn(async () => undefined) } as any;
    const ext = new PersistenceExtension({ findById, updatePage } as any, {} as any, queue, queue, queue, collabHistory, transclusion);
    return { ext, findById, updatePage, collabHistory };
  };
  const run = (ext: PersistenceExtension) => ext.onStoreDocument({ documentName: 'page.1', document, lastContext: context } as any);

  beforeEach(() => {
    jest.clearAllMocks();
    fromYdoc.mockReturnValue({ type: 'doc', content: [{ type: 'paragraph' }] }); // ≠ ROW.content: a write
    reconcileRowIntoDoc.mockReturnValue({ merged: false });
    isStoreCurrent.mockReturnValue(false);
    storeGenerationOf.mockReturnValue(7);
  });

  it('a current document skips the whole store: no row read, no write, contributors kept for the next store', async () => {
    const { ext, findById, updatePage, collabHistory } = build(ROW);
    await ext.onChange({ documentName: 'page.1', context: { user: { id: 'human' } }, transactionOrigin: { source: 'connection', connection: {} } } as any);
    isStoreCurrent.mockReturnValueOnce(true);
    await expect(run(ext)).resolves.toBeUndefined();
    expect(isStoreCurrent).toHaveBeenCalledWith(document);
    expect(findById).not.toHaveBeenCalled();
    expect(updatePage).not.toHaveBeenCalled();
    expect(markStoredAt).not.toHaveBeenCalled();
    expect(clearStoreFailure).not.toHaveBeenCalled();
    // The next (real) store still credits the contributor the skip did not consume.
    await run(ext);
    expect(updatePage).toHaveBeenCalledTimes(1);
    expect((updatePage.mock.calls[0] as any)[0].contributorIds).toContain('human');
    expect(collabHistory.addContributors).toHaveBeenCalledWith('page-1', ['human']);
  });

  it('reads the generation in the same run as the serialization it records: before the lock, or after the reconcile inside it', async () => {
    const order: string[] = [];
    reconcileRowIntoDoc.mockImplementation(() => (order.push('reconcile'), { merged: false }));
    storeGenerationOf.mockImplementation(() => (order.push(mockTx.inside ? 'generation:in-tx' : 'generation:outside'), 7));
    fromYdoc.mockImplementation(() => (order.push('serialize'), { type: 'doc', content: [{ type: 'paragraph' }] }));
    const { ext } = build(ROW); // #840: a row the pre-lock snapshot does not cover: serialized again under the lock
    await run(ext);
    expect(order).toEqual(['generation:outside', 'serialize', 'reconcile', 'generation:in-tx', 'serialize']);
  });

  it('a committed WRITE marks the generation and seeds the reconcile memo with the bytes it wrote', async () => {
    const { ext, updatePage } = build(ROW);
    await run(ext);
    expect(markStoredAt).toHaveBeenCalledTimes(1);
    expect(markStoredAt).toHaveBeenCalledWith(document, 7);
    expect(markRowCovered).toHaveBeenCalledTimes(1);
    expect(markRowCovered).toHaveBeenCalledWith(document, (updatePage.mock.calls[0] as any)[0].ydoc);
    // …after the commit: the clear and the mark follow the transaction, never inside it.
    expect(clearStoreFailure.mock.invocationCallOrder[0]).toBeLessThan(markStoredAt.mock.invocationCallOrder[0]);
  });

  it('a deep-equal no-op marks the generation (the row already holds it) but seeds nothing', async () => {
    fromYdoc.mockReturnValue(ROW.content);
    const { ext, updatePage } = build(ROW);
    await run(ext);
    expect(updatePage).not.toHaveBeenCalled();
    expect(markStoredAt).toHaveBeenCalledWith(document, 7);
    expect(markRowCovered).not.toHaveBeenCalled();
  });

  it('page not found: forgets (never marks)', async () => {
    const { ext } = build(undefined);
    await run(ext);
    expect(markStoredAt).toHaveBeenCalledWith(document, undefined);
    expect(markRowCovered).not.toHaveBeenCalled();
  });

  it('a refused blank clobber: forgets (never marks)', async () => {
    fromYdoc.mockReturnValue({ type: 'doc', content: [{ type: 'paragraph' }] });
    const { ext, updatePage } = build({ ...ROW, ydoc: null, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'real' }] }] } });
    await run(ext);
    expect(updatePage).not.toHaveBeenCalled();
    expect(markStoredAt).toHaveBeenCalledWith(document, undefined);
  });

  it('a FAILED store records the failure and marks nothing (the next store — disconnect()\'s — runs in full)', async () => {
    const { ext } = build(ROW, async () => {
      throw new Error('db down');
    });
    await expect(run(ext)).resolves.toBeUndefined();
    expect(recordStoreFailure).toHaveBeenCalledWith(document);
    expect(markStoredAt).not.toHaveBeenCalled();
    expect(markRowCovered).not.toHaveBeenCalled();
  });
});

// #345 defect 2 — the post-commit side effects run AFTER the row commits and are best-effort. A throw there
// must NEVER reject onStoreDocument: Hocuspocus's debouncer leaves a rejected store resident and wedges ALL
// future persistence for the document (silent data loss), and returns a false 503 on the settle/flush path.
// These pin the "never rejects" property (which is exactly what denies the debouncer its poison) with DISTINCT
// queue mocks so per-effect isolation is observable.
describe('PersistenceExtension.onStoreDocument post-store side-effect isolation (#345)', () => {
  const document = { broadcastStateless: jest.fn() };
  const context = { user: { id: 'u1' } };
  const page = {
    id: 'page-1',
    slugId: 's',
    content: { type: 'doc', content: [] },
    ydoc: Buffer.from([9]),
    workspaceId: 'w1',
    spaceId: 'sp1',
    creatorId: 'c1',
    createdAt: new Date('2020-01-01').toISOString(),
  };

  const build = () => {
    const findById = jest.fn(async () => page);
    const updatePage = jest.fn(async () => undefined);
    const pageRepo = { findById, updatePage } as any;
    const aiQueue = { add: jest.fn(async () => undefined) } as any;
    const historyQueue = { add: jest.fn(async () => undefined) } as any;
    const notificationQueue = { add: jest.fn(async () => undefined) } as any;
    const collabHistory = { addContributors: jest.fn(async () => undefined) } as any;
    const transclusion = {
      syncPageTransclusions: jest.fn(async () => undefined),
      syncPageReferences: jest.fn(async () => undefined),
    } as any;
    // constructor order: pageRepo, db, aiQueue, historyQueue, notificationQueue, collabHistory, transclusion
    const ext = new PersistenceExtension(
      pageRepo,
      {} as any,
      aiQueue,
      historyQueue,
      notificationQueue,
      collabHistory,
      transclusion,
    );
    return {
      ext,
      updatePage,
      aiQueue,
      historyQueue,
      notificationQueue,
      collabHistory,
      transclusion,
    };
  };

  const run = (ext: PersistenceExtension) =>
    ext.onStoreDocument({ documentName: 'page.1', document, lastContext: context } as any);

  beforeEach(() => {
    jest.clearAllMocks();
    // Serialized doc must DIFFER from page.content so the write proceeds (not the isDeepStrictEqual no-op).
    fromYdoc.mockReturnValue({
      type: 'doc',
      content: [{ type: 'paragraph' }, { type: 'paragraph' }],
    });
    jsonToText.mockReturnValue('text');
    reconcileRowIntoDoc.mockReturnValue({ merged: false });
    isStoreCurrent.mockReturnValue(false);
    extractMentions.mockReturnValue([]);
    extractUserMentions.mockReturnValue([]);
  });

  it('a throwing post-commit side effect does NOT reject onStoreDocument (denies the debouncer its poison)', async () => {
    const { ext, aiQueue } = build();
    aiQueue.add.mockRejectedValueOnce(new Error('redis blip'));
    await expect(run(ext)).resolves.toBeUndefined();
    // The row committed BEFORE the side effect threw — the store itself succeeded.
    expect(clearStoreFailure).toHaveBeenCalledWith(document);
    expect(recordStoreFailure).not.toHaveBeenCalled();
    // The swallowed failure is surfaced via the alarm token (COLLAB_POST_STORE_FAILED), named by side effect.
    expect(logPostStoreFailure).toHaveBeenCalledTimes(1);
    expect(logPostStoreFailure.mock.calls[0][1]).toBe('ai-queue');
  });

  it('one failing post-commit side effect does not skip the others', async () => {
    const { ext, aiQueue, historyQueue, collabHistory } = build();
    collabHistory.addContributors.mockRejectedValueOnce(new Error('db blip'));
    await expect(run(ext)).resolves.toBeUndefined();
    expect(aiQueue.add).toHaveBeenCalledTimes(1); // ran despite the earlier failure
    expect(historyQueue.add).toHaveBeenCalledTimes(1); // ran despite the earlier failure
    expect(logPostStoreFailure).toHaveBeenCalledTimes(1);
    expect(logPostStoreFailure.mock.calls[0][1]).toBe('contributors');
  });

  it('a throwing broadcast does not reject the hook', async () => {
    const { ext } = build();
    document.broadcastStateless.mockImplementationOnce(() => {
      throw new Error('socket gone');
    });
    await expect(run(ext)).resolves.toBeUndefined();
    expect(logPostStoreFailure).toHaveBeenCalledTimes(1);
    expect(logPostStoreFailure.mock.calls[0][1]).toBe('broadcast');
  });

  // #429 review: pin the three effects the original isolation block did not cover per-effect.

  it('a throwing history enqueue is isolated and alarmed (label "history")', async () => {
    const { ext, historyQueue } = build();
    historyQueue.add.mockRejectedValueOnce(new Error('history queue down'));
    await expect(run(ext)).resolves.toBeUndefined();
    expect(clearStoreFailure).toHaveBeenCalledWith(document); // the row still committed
    expect(logPostStoreFailure).toHaveBeenCalledTimes(1);
    expect(logPostStoreFailure.mock.calls[0][1]).toBe('history');
  });

  it('a throwing mention→notificationQueue enqueue is isolated and alarmed (label "mention-notification")', async () => {
    // Drive the mention branch past its early return, then make the enqueue throw.
    extractMentions.mockReturnValue([
      { id: 'm1', entityId: 'u2', creatorId: 'c1' },
    ]);
    extractUserMentions.mockReturnValue([
      { id: 'm1', entityId: 'u2', creatorId: 'c1' },
    ]);
    const { ext, notificationQueue } = build();
    notificationQueue.add.mockRejectedValueOnce(new Error('notif queue down'));
    await expect(run(ext)).resolves.toBeUndefined();
    expect(logPostStoreFailure).toHaveBeenCalledTimes(1);
    expect(logPostStoreFailure.mock.calls[0][1]).toBe('mention-notification');
  });

  it('a failing transclusion sync is isolated — the hook resolves, other effects still run, outer backstop never fires', async () => {
    // syncTransclusion self-isolates (its own per-call try/catch), so a rejected syncPageTransclusions is
    // swallowed there and never rejects the hook. The meaningful protection: it does not skip the other
    // concurrent effects, and it never reaches the whole-block backstop ('post-store-block').
    const { ext, transclusion, aiQueue, historyQueue } = build();
    transclusion.syncPageTransclusions.mockRejectedValueOnce(
      new Error('transclusion sync down'),
    );
    await expect(run(ext)).resolves.toBeUndefined();
    expect(clearStoreFailure).toHaveBeenCalledWith(document); // row committed
    expect(aiQueue.add).toHaveBeenCalledTimes(1); // sibling effects unaffected
    expect(historyQueue.add).toHaveBeenCalledTimes(1);
    expect(
      logPostStoreFailure.mock.calls.map((c) => c[1]),
    ).not.toContain('post-store-block'); // the outer backstop did not fire
  });

  it('all post-commit side effects run (concurrently) on a normal store', async () => {
    const { ext, aiQueue, historyQueue, collabHistory, transclusion } = build();
    await expect(run(ext)).resolves.toBeUndefined();
    expect(document.broadcastStateless).toHaveBeenCalledTimes(1);
    expect(transclusion.syncPageTransclusions).toHaveBeenCalledTimes(1);
    expect(collabHistory.addContributors).toHaveBeenCalledTimes(1);
    expect(aiQueue.add).toHaveBeenCalledTimes(1);
    expect(historyQueue.add).toHaveBeenCalledTimes(1);
    expect(logPostStoreFailure).not.toHaveBeenCalled();
  });
});
