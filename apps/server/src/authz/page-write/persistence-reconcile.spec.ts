// #390 — orchestration pins for the reconcile-before-store seam inside PersistenceExtension.onStoreDocument.
// The module pulls the tiptap/yjs graph (lib0 ESM) jest cannot parse, plus a large DI graph, so the heavy
// value-imports are stubbed; the CRDT correctness itself is proven with REAL yjs in reconcile-store.spec.ts
// and the guard logic in blank-clobber-guard.spec.ts. This spec pins the ORCHESTRATION invariants the #390
// fix depends on:
//   1. the row's ydoc is read under the SAME withLock findById (one locked read) — TOCTOU,
//   2. the reconcile runs BEFORE the write payload is serialized — TOCTOU,
//   3. the write payload is serialized INSIDE the FOR UPDATE transaction — TOCTOU (moving it out but after
//      the reconcile would stay green on #2 alone yet reopen the window),
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
jest.mock('../../common/helpers/prosemirror/utils', () => ({
  extractMentions: jest.fn(() => []),
  extractUserMentions: jest.fn(() => []),
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
jest.mock('./reconcile-store', () => ({
  reconcileRowIntoDoc: (...a: unknown[]) => reconcileRowIntoDoc(...(a as [])),
}));
const recordStoreFailure = jest.fn();
const clearStoreFailure = jest.fn();
jest.mock('./store-failure-registry', () => ({
  recordStoreFailure: (...a: unknown[]) => recordStoreFailure(...(a as [])),
  clearStoreFailure: (...a: unknown[]) => clearStoreFailure(...(a as [])),
  hasStoreFailure: jest.fn(() => false),
}));
const logStaleReconcile = jest.fn();
const logStoreFailure = jest.fn();
jest.mock('./collab-drift-log', () => ({
  logStaleReconcile: (...a: unknown[]) => logStaleReconcile(...(a as [])),
  logStoreFailure: (...a: unknown[]) => logStoreFailure(...(a as [])),
}));
// blank-clobber-guard is left REAL (pure JSON, no heavy imports) so the null-ydoc tests exercise its
// actual structural classifier.

import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';

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
    ext.onStoreDocument({ documentName: 'page.1', document, context } as any);

  beforeEach(() => {
    jest.clearAllMocks();
    fromYdoc.mockImplementation(() => {
      mockTx.serializeSawInside = mockTx.inside; // record whether serialize ran inside the txn
      return { type: 'doc', content: [{ type: 'paragraph' }] };
    });
    jsonToText.mockReturnValue('text');
    reconcileRowIntoDoc.mockReturnValue({ merged: false });
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
    expect(order.indexOf('reconcile')).toBeLessThan(order.indexOf('serialize'));
    expect(mockTx.serializeSawInside).toBe(true); // serialize ran while inside executeTx (under the row lock)
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
