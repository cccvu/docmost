// #390 — orchestration pins for the reconcile-before-store seam inside PersistenceExtension.onStoreDocument.
// The module pulls the tiptap/yjs graph (lib0 ESM) jest cannot parse, plus a large DI graph, so the heavy
// value-imports are stubbed; the CRDT correctness itself is proven with REAL yjs in reconcile-store.spec.ts.
// This spec pins the ORCHESTRATION invariants the #390 fix depends on:
//   1. the row's ydoc is read under the SAME withLock findById (one locked read) — TOCTOU,
//   2. the reconcile runs BEFORE the write payload is serialized — TOCTOU,
//   3. a failed store is RECORDED (never re-thrown) and a successful one CLEARS the flag,
//   4. a failed store does not fire the post-store side effects,
//   5. the null-ydoc branch refuses to overwrite non-empty row content with a blank doc.
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
jest.mock('@docmost/db/utils', () => ({
  // run the callback with a stub trx; the real FOR UPDATE lock is exercised in an integration test, not here
  executeTx: (_db: unknown, cb: (trx: unknown) => Promise<unknown>) => cb({}),
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

import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';

describe('PersistenceExtension.onStoreDocument reconcile seam (#390)', () => {
  const document = { broadcastStateless: jest.fn() };
  const context = { user: { id: 'u1' } };

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
    const ext = new PersistenceExtension(
      pageRepo,
      {} as any,
      queue,
      queue,
      queue,
      collabHistory,
      transclusion,
    );
    return { ext, findById, updatePage };
  };

  const run = (ext: PersistenceExtension) =>
    ext.onStoreDocument({
      documentName: 'page.1',
      document,
      context,
    } as any);

  beforeEach(() => {
    jest.clearAllMocks();
    fromYdoc.mockReturnValue({ type: 'doc', content: [{ type: 'paragraph' }] });
    jsonToText.mockReturnValue('text');
    reconcileRowIntoDoc.mockReturnValue({ merged: false });
  });

  it('reads the row ydoc under the SAME withLock findById (one locked read) — TOCTOU', async () => {
    const { ext, findById } = build({
      id: 'page-1',
      slugId: 's',
      content: { type: 'doc', content: [] },
      ydoc: Buffer.from([9]),
    });
    await run(ext);

    expect(findById).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledWith(
      'page-1',
      expect.objectContaining({
        withLock: true,
        includeContent: true,
        includeYdoc: true,
      }),
    );
  });

  it('reconciles the row into the doc BEFORE serializing the write payload — TOCTOU', async () => {
    const order: string[] = [];
    reconcileRowIntoDoc.mockImplementation(() => {
      order.push('reconcile');
      return { merged: true };
    });
    fromYdoc.mockImplementation(() => {
      order.push('serialize');
      return { type: 'doc', content: [{ type: 'paragraph' }] };
    });
    const { ext } = build({
      id: 'page-1',
      slugId: 's',
      content: { type: 'doc', content: [] },
      ydoc: Buffer.from([9]),
    });

    await run(ext);

    expect(reconcileRowIntoDoc).toHaveBeenCalledWith(document, expect.anything());
    expect(order[0]).toBe('reconcile');
    expect(order).toContain('serialize');
    expect(order.indexOf('reconcile')).toBeLessThan(order.indexOf('serialize'));
  });

  it('CLEARS the store-failure flag after a successful store', async () => {
    const { ext } = build({
      id: 'page-1',
      slugId: 's',
      content: { type: 'doc', content: [] }, // differs from fromYdoc → a real write
      ydoc: Buffer.from([9]),
    });
    await run(ext);
    expect(clearStoreFailure).toHaveBeenCalledWith(document);
    expect(recordStoreFailure).not.toHaveBeenCalled();
  });

  it('RECORDS a store failure (never re-throws) and skips post-store side effects', async () => {
    const { ext } = build(
      {
        id: 'page-1',
        slugId: 's',
        content: { type: 'doc', content: [] },
        ydoc: Buffer.from([9]),
      },
      async () => {
        throw new Error('db down');
      },
    );

    await expect(run(ext)).resolves.toBeUndefined(); // never throws
    expect(recordStoreFailure).toHaveBeenCalledWith(document);
    expect(clearStoreFailure).not.toHaveBeenCalled();
    expect(document.broadcastStateless).not.toHaveBeenCalled(); // side effects skipped for a failed write
  });

  it('null-ydoc: refuses to overwrite non-empty row content with a blank resident doc', async () => {
    // row has real text, no ydoc lineage; outgoing doc serializes to blank text → the #390 clobber shape
    // non-empty content → real text (the row); empty content array → blank (the outgoing doc)
    jsonToText.mockImplementation((j: unknown) =>
      j && (j as any).content?.length ? 'real row text' : '',
    );
    fromYdoc.mockReturnValue({ type: 'doc', content: [] }); // outgoing = blank
    const { ext, updatePage } = build({
      id: 'page-1',
      slugId: 's',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
      ydoc: null,
    });

    await run(ext);

    expect(reconcileRowIntoDoc).not.toHaveBeenCalled(); // no ydoc lineage to diff
    expect(updatePage).not.toHaveBeenCalled(); // refused → row preserved
  });
});
