// The handler module pulls the tiptap/yjs graph (lib0 ESM) that jest cannot parse. Only the FLUSH
// handler is under test here and it touches none of it, so stub the heavy value-imports; the
// `@hocuspocus/server` import is type-only and is elided by ts-jest.
const fromYdoc = jest.fn(() => ({ type: 'doc', content: [] }));
jest.mock('@hocuspocus/transformer', () => ({
  TiptapTransformer: { fromYdoc: (...a: unknown[]) => fromYdoc(...(a as [])) },
}));
jest.mock('yjs', () => ({}));
jest.mock('../../collaboration/collaboration.util', () => ({
  prosemirrorNodeToYElement: jest.fn(),
  tiptapExtensions: [],
}));
jest.mock('../../collaboration/yjs.util', () => ({
  setYjsMark: jest.fn(),
  updateYjsMarkAttribute: jest.fn(),
}));

import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { stableHash } from '../page-write/stable-hash';
import {
  recordStoreFailure,
  clearStoreFailure,
} from '../page-write/store-failure-registry';

/**
 * CCC integration test (part of the fork's compatibility suite) for the CONTENT SETTLE seam, issue 282.
 *
 * The invariant this protects: the platform's `/v1` optimistic-concurrency anchor is computed from the
 * `pages` row, which trails the live Y.Doc by up to `maxDebounce` while anyone is editing. The settle must
 * force the PENDING store to run so the anchor is compared against real state — and it must do so WITHOUT
 * synthesizing a store of its own, because `persistence.extension.onStoreDocument` takes `lastUpdatedById`
 * from the store payload's `context.user.id`. Re-running the already-scheduled closure keeps the edit
 * attributed to the human who typed it.
 */
describe('CollaborationHandler.flushPageContent (content settle, issue 282)', () => {
  const DOC = 'page.22222222-2222-4222-8222-222222222222';
  const DEBOUNCE_ID = `onStoreDocument-${DOC}`;

  const makeDoc = () => {
    const runExclusive = jest.fn(async (fn: () => Promise<unknown>) => fn());
    return { doc: { saveMutex: { runExclusive } }, runExclusive };
  };

  const makeHocuspocus = (
    doc: unknown,
    debouncer: Partial<{
      isDebounced: jest.Mock;
      executeNow: jest.Mock;
    }> = {},
  ) => {
    const documents = new Map<string, unknown>();
    if (doc) documents.set(DOC, doc);
    return {
      documents,
      debouncer: {
        isDebounced: debouncer.isDebounced ?? jest.fn(() => false),
        executeNow: debouncer.executeNow ?? jest.fn(),
      },
    };
  };

  beforeEach(() => {
    fromYdoc.mockReset();
    fromYdoc.mockReturnValue({ type: 'doc', content: [] });
  });

  const flushOf = (hocuspocus: unknown) =>
    new CollaborationHandler().getHandlers(hocuspocus as never)
      .flushPageContent;

  // A document that is not resident on the owning node has no unpersisted delta (Hocuspocus refuses to
  // unload while a store is debounced, executing, or holding saveMutex), so the row is authoritative and
  // the settle must be a cheap no-op — NOT a load-and-store, which would rewrite the row for nothing.
  it('is a no-op when the document is not resident', async () => {
    const hocuspocus = makeHocuspocus(null);
    // NO `reason` here, deliberately: this is a SUCCESSFUL settle with nothing to do. The error paths
    // below return `flushed: false` too, and the caller must be able to tell them apart.
    await expect(
      flushOf(hocuspocus)(DOC, { withDigest: true }),
    ).resolves.toEqual({ flushed: false });
    expect(hocuspocus.debouncer.isDebounced).not.toHaveBeenCalled();
    expect(hocuspocus.debouncer.executeNow).not.toHaveBeenCalled();
  });

  // The core behavior: a pending debounced store is executed NOW, by id, so the row catches up to the
  // live document before the platform reads its anchor.
  it('executes a PENDING debounced store immediately, keyed by the document name', async () => {
    const { doc, runExclusive } = makeDoc();
    const executeNow = jest.fn();
    const hocuspocus = makeHocuspocus(doc, {
      isDebounced: jest.fn(() => true),
      executeNow,
    });

    await expect(
      flushOf(hocuspocus)(DOC, { withDigest: true }),
    ).resolves.toEqual({
      flushed: true,
      contentDigest: stableHash({ type: 'doc', content: [] }),
    });
    expect(hocuspocus.debouncer.isDebounced).toHaveBeenCalledWith(DEBOUNCE_ID);
    expect(executeNow).toHaveBeenCalledWith(DEBOUNCE_ID);
    expect(runExclusive).toHaveBeenCalledTimes(1);
  });

  // `executeNow` re-runs the ALREADY-SCHEDULED closure; the settle must never open its own direct
  // connection or transact, which would store under the flush caller's context and mis-attribute
  // `lastUpdatedById` to the platform instead of the human who typed.
  it('never opens a direct connection or synthesizes its own store', async () => {
    const { doc } = makeDoc();
    const hocuspocus = {
      ...makeHocuspocus(doc, { isDebounced: jest.fn(() => true) }),
      openDirectConnection: jest.fn(),
      storeDocumentHooks: jest.fn(),
    };

    await flushOf(hocuspocus)(DOC, { withDigest: true });
    expect(hocuspocus.openDirectConnection).not.toHaveBeenCalled();
    expect(hocuspocus.storeDocumentHooks).not.toHaveBeenCalled();
  });

  // Nothing debounced but a store may still be mid-flight: draining saveMutex is what makes the settle
  // synchronous with respect to an in-progress write.
  it('drains an in-flight store via saveMutex even when nothing is debounced', async () => {
    const { doc, runExclusive } = makeDoc();
    const hocuspocus = makeHocuspocus(doc, {
      isDebounced: jest.fn(() => false),
    });

    await expect(
      flushOf(hocuspocus)(DOC, { withDigest: true }),
    ).resolves.toEqual({
      flushed: true,
      contentDigest: stableHash({ type: 'doc', content: [] }),
    });
    expect(hocuspocus.debouncer.executeNow).not.toHaveBeenCalled();
    expect(runExclusive).toHaveBeenCalledTimes(1);
  });

  // Order matters: run the pending store first, THEN drain — draining first would return before the
  // store it was supposed to wait for had even been scheduled to run.
  it('executes the pending store BEFORE draining the mutex', async () => {
    const order: string[] = [];
    const runExclusive = jest.fn(async (fn: () => Promise<unknown>) => {
      order.push('drain');
      return fn();
    });
    const executeNow = jest.fn(async () => {
      order.push('executeNow');
    });
    const hocuspocus = makeHocuspocus(
      { saveMutex: { runExclusive } },
      { isDebounced: jest.fn(() => true), executeNow },
    );

    await flushOf(hocuspocus)(DOC, { withDigest: true });
    expect(order).toEqual(['executeNow', 'drain']);
  });

  // The settle must await the store, not fire-and-forget: returning early would hand the platform a row
  // that is still stale, silently reopening the window this seam exists to close.
  it('awaits the executed store before resolving', async () => {
    let settled = false;
    const executeNow = jest.fn(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve();
          }, 5),
        ),
    );
    const { doc } = makeDoc();
    const hocuspocus = makeHocuspocus(doc, {
      isDebounced: jest.fn(() => true),
      executeNow,
    });

    await flushOf(hocuspocus)(DOC, { withDigest: true });
    expect(settled).toBe(true);
  });

  // The digest must be taken from the LIVE document, and only AFTER the pending store has run — a digest
  // captured before it would name a version the conditional write would then reject.
  it('returns the live document’s digest, computed after the store', async () => {
    const order: string[] = [];
    const { doc } = makeDoc();
    fromYdoc.mockImplementation(() => {
      order.push('serialize');
      return { type: 'doc', content: [{ type: 'paragraph' }] };
    });
    const hocuspocus = makeHocuspocus(doc, {
      isDebounced: jest.fn(() => true),
      executeNow: jest.fn(async () => {
        order.push('store');
      }),
    });

    const result = await flushOf(hocuspocus)(DOC, { withDigest: true });
    expect(order).toEqual(['store', 'serialize']);
    expect(result).toEqual({
      flushed: true,
      contentDigest: stableHash({
        type: 'doc',
        content: [{ type: 'paragraph' }],
      }),
    });
  });

  // No digest when nothing was live: its ABSENCE is how the caller learns there was nothing to race with.
  it('reports no digest when the document is not resident', async () => {
    const result = (await flushOf(makeHocuspocus(null))(DOC)) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ flushed: false });
    expect(result.contentDigest).toBeUndefined();
    expect(result.reason).toBeUndefined(); // a successful settle, not a failure
  });

  // Cross-node, a throwing custom-event handler never publishes its reply and the caller hangs until
  // RedisSync's customEvent TTL. The settle must therefore report failure, never throw.
  // The digest is only produced on request. Serializing and hashing a whole document runs on the event
  // loop every live editor on this node shares, and a read settle (`GET ?settle=true`) never looks at it.
  it('does NOT serialize or hash the document unless a digest was requested', async () => {
    const { doc } = makeDoc();
    const hocuspocus = makeHocuspocus(doc, {
      isDebounced: jest.fn(() => true),
      executeNow: jest.fn(async () => undefined),
    });
    await expect(flushOf(hocuspocus)(DOC)).resolves.toEqual({ flushed: true });
    expect(fromYdoc).not.toHaveBeenCalled();
    // ...but the store still ran: the settle's real job is the persist, not the digest.
    expect(hocuspocus.debouncer.executeNow).toHaveBeenCalledTimes(1);
  });

  it('reports an ERROR outcome instead of throwing when the store rejects', async () => {
    const { doc } = makeDoc();
    const hocuspocus = makeHocuspocus(doc, {
      isDebounced: jest.fn(() => true),
      executeNow: jest.fn(async () => {
        throw new Error('store failed');
      }),
    });

    // `reason: 'error'` distinguishes this from the not-resident answer below, which is ALSO
    // `flushed: false` but means "safe, the row is authoritative". Collapsing the two lets a guarded
    // write fall back to an unconditional one against a stale row — the #282 lost update itself.
    await expect(
      flushOf(hocuspocus)(DOC, { withDigest: true }),
    ).resolves.toEqual({ flushed: false, reason: 'error' });
  });

  // #390: onStoreDocument cannot re-throw a swallowed DB error (an unhandled rejection on the setTimeout
  // debounce path could crash the process), so it RECORDS the failure. The settle, which just ran that
  // store, must read the flag and fail closed — a false `flushed: true` + digest would let a guarded /v1
  // write trust a version the row never received.
  it('fails closed with reason:error when the store it ran failed to persist (#390)', async () => {
    const { doc } = makeDoc();
    const hocuspocus = makeHocuspocus(doc, {
      isDebounced: jest.fn(() => true),
      executeNow: jest.fn(async () => {
        recordStoreFailure(doc); // onStoreDocument recorded a swallowed DB failure during this store
      }),
    });

    try {
      await expect(
        flushOf(hocuspocus)(DOC, { withDigest: true }),
      ).resolves.toEqual({ flushed: false, reason: 'error' });
      // must NOT serialize/hash a digest for a row that was never written
      expect(fromYdoc).not.toHaveBeenCalled();
    } finally {
      clearStoreFailure(doc); // WeakMap is module-global; keep tests isolated
    }
  });

  it('reports an ERROR outcome instead of throwing when the mutex drain rejects', async () => {
    const hocuspocus = makeHocuspocus({
      saveMutex: {
        runExclusive: jest.fn(async () => {
          throw new Error('mutex failed');
        }),
      },
    });

    // `reason: 'error'` distinguishes this from the not-resident answer below, which is ALSO
    // `flushed: false` but means "safe, the row is authoritative". Collapsing the two lets a guarded
    // write fall back to an unconditional one against a stale row — the #282 lost update itself.
    await expect(
      flushOf(hocuspocus)(DOC, { withDigest: true }),
    ).resolves.toEqual({ flushed: false, reason: 'error' });
  });
});
