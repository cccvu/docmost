import { bindCollabDrain } from '../collab-ingress/collab-drain-state';
import { markSuperseded } from './compaction-registry';
import { clearStoreFailure, failedStorePayload, hasStoreFailure, recordStoreFailure } from './store-failure-registry';
import {
  KEPT_RESIDENT_REASON,
  KEPT_RETRY_MS,
  canRetryFailedStore,
  keepFailedDocumentResident,
  rearmFailedStoreRetries,
  restoreContributors,
  retryFailedStore,
  storeFailedForGood,
} from './keep-failed-store';

/**
 * wiki-v2 #919 (F7): the unload veto for a document whose last store failed, its retry, and the contributors a failed
 * store gives back. The end-to-end proof through the real Hocuspocus and persistence extension is
 * collab-ingress/collab-quiesce.spec.ts.
 */
const doc = () => ({ name: 'page.x' }) as never;
const instance = () => ({ storeDocumentHooks: jest.fn(async () => undefined) });
const thrownBy = (fn: () => void): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('#919 keepFailedDocumentResident', () => {
  it('a healthy document unloads (no throw, no store scheduled)', () => {
    const d = doc();
    const i = instance();
    expect(thrownBy(() => keepFailedDocumentResident({ document: d, instance: i }))).toBeUndefined();
    expect(i.storeDocumentHooks).not.toHaveBeenCalled();
  });

  it('a failed store keeps it resident (a message-less reason) and runs that store again later, once, with its own payload', () => {
    jest.useFakeTimers();
    try {
      const d = doc();
      const payload = { documentName: 'page.x', lastContext: { user: { id: 'alice' } } };
      recordStoreFailure(d, payload);
      const i = instance();
      const err = thrownBy(() => keepFailedDocumentResident({ document: d, instance: i }));
      expect(err).toEqual({ reason: KEPT_RESIDENT_REASON });
      expect((err as { message?: unknown }).message).toBeUndefined();
      thrownBy(() => keepFailedDocumentResident({ document: d, instance: i })); // a second unload attempt: still one timer
      expect(i.storeDocumentHooks).not.toHaveBeenCalled();
      jest.advanceTimersByTime(KEPT_RETRY_MS);
      expect(i.storeDocumentHooks).toHaveBeenCalledTimes(1);
      expect(i.storeDocumentHooks).toHaveBeenCalledWith(d, payload, true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the retry timer never keeps the process alive (unref), and skips a document destroyed meanwhile', () => {
    jest.useFakeTimers();
    try {
      const d = { name: 'page.x', isDestroyed: false } as never as { isDestroyed: boolean };
      recordStoreFailure(d, { documentName: 'page.x' });
      const i = instance();
      const unref = jest.fn();
      const realSetTimeout = global.setTimeout;
      jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
        const t = realSetTimeout(fn, ms);
        return Object.assign(t, { unref });
      }) as never);
      thrownBy(() => keepFailedDocumentResident({ document: d as never, instance: i }));
      expect(unref).toHaveBeenCalledTimes(1);
      d.isDestroyed = true;
      jest.advanceTimersByTime(KEPT_RETRY_MS);
      expect(i.storeDocumentHooks).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  it('while the collab drain runs it keeps the document but schedules nothing (the drain owns the retries)', () => {
    const d = doc();
    recordStoreFailure(d, { documentName: 'page.x' });
    const i = instance();
    bindCollabDrain(i, { draining: true });
    expect(thrownBy(() => keepFailedDocumentResident({ document: d, instance: i }))).toEqual({ reason: KEPT_RESIDENT_REASON });
    expect(i.storeDocumentHooks).not.toHaveBeenCalled();
  });

  it('rearmFailedStoreRetries (the quiesce abort): schedules each kept, retriable document once; never a healthy or superseded one', () => {
    jest.useFakeTimers();
    try {
      const kept = { name: 'page.k' } as never;
      const healthy = { name: 'page.h' } as never;
      const moved = { name: 'page.m' } as never;
      const keptPayload = { documentName: 'page.k', lastContext: { user: { id: 'alice' } } };
      recordStoreFailure(kept, keptPayload);
      recordStoreFailure(moved, { documentName: 'page.m' });
      markSuperseded(moved);
      const i = { ...instance(), documents: new Map<string, never>([['page.k', kept], ['page.h', healthy], ['page.m', moved]]) };
      bindCollabDrain(i, { draining: false });
      rearmFailedStoreRetries(i as never);
      rearmFailedStoreRetries(i as never); // twice: still one timer per document
      expect(i.storeDocumentHooks).not.toHaveBeenCalled();
      jest.advanceTimersByTime(KEPT_RETRY_MS);
      expect(i.storeDocumentHooks).toHaveBeenCalledTimes(1);
      expect(i.storeDocumentHooks).toHaveBeenCalledWith(kept, keptPayload, true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a kept document's awareness interval stops holding the process (unref'd); an unloading one is left alone", () => {
    const unref = jest.fn();
    const kept = { name: 'page.x', awareness: { _checkInterval: { unref } } } as never;
    recordStoreFailure(kept);
    thrownBy(() => keepFailedDocumentResident({ document: kept, instance: null }));
    expect(unref).toHaveBeenCalledTimes(1);
    const healthyUnref = jest.fn();
    keepFailedDocumentResident({ document: { name: 'page.y', awareness: { _checkInterval: { unref: healthyUnref } } } as never, instance: null });
    expect(healthyUnref).not.toHaveBeenCalled();
  });

  it("superseded by this process's own compaction: its content is in the row, so it unloads", () => {
    const d = doc();
    markSuperseded(d, 3, 'compacted');
    recordStoreFailure(d);
    expect(storeFailedForGood(d)).toBe(false);
    expect(thrownBy(() => keepFailedDocumentResident({ document: d, instance: instance() }))).toBeUndefined();
  });

  it('superseded by a lineage move: kept (reported failed) and never retried (it can never store)', () => {
    const d = doc();
    markSuperseded(d, 3, 'lineage');
    recordStoreFailure(d, { documentName: 'page.x' });
    const i = instance();
    expect(storeFailedForGood(d)).toBe(true);
    expect(canRetryFailedStore(d)).toBe(false);
    expect(thrownBy(() => keepFailedDocumentResident({ document: d, instance: i }))).toEqual({ reason: KEPT_RESIDENT_REASON });
    expect(i.storeDocumentHooks).not.toHaveBeenCalled();
  });

  it('markSuperseded defaults to a lineage move (fail closed: an unknown supersede counts as a lost store)', () => {
    const d = doc();
    markSuperseded(d, 3);
    recordStoreFailure(d);
    expect(storeFailedForGood(d)).toBe(true);
  });
});

describe('#919 the failed payload and its retry', () => {
  it('kept until a store succeeds; a payload-less failure keeps the last payload', () => {
    const d = doc();
    const p1 = { documentName: 'page.x', n: 1 };
    recordStoreFailure(d, p1);
    recordStoreFailure(d); // e.g. direct-store.ts's own catch
    expect(failedStorePayload(d)).toBe(p1);
    const p2 = { documentName: 'page.x', n: 2 };
    recordStoreFailure(d, p2);
    expect(failedStorePayload(d)).toBe(p2); // the latest failed store (its writer is the latest)
    clearStoreFailure(d);
    expect(hasStoreFailure(d)).toBe(false);
    expect(failedStorePayload(d)).toBeUndefined();
  });

  it('retryFailedStore runs that store now through storeDocumentHooks; a throw past the hook is recorded', async () => {
    const d = doc();
    const payload = { documentName: 'page.x' };
    recordStoreFailure(d, payload);
    const i = instance();
    await retryFailedStore(i, d, true);
    expect(i.storeDocumentHooks).toHaveBeenCalledWith(d, payload, true);

    const failing = { storeDocumentHooks: jest.fn(async () => Promise.reject(new Error('mutex'))) };
    clearStoreFailure(d);
    recordStoreFailure(d, payload);
    await expect(retryFailedStore(failing, d, true)).resolves.toBeUndefined();
    expect(hasStoreFailure(d)).toBe(true);
  });

  it('no payload, nothing to retry', async () => {
    const d = doc();
    recordStoreFailure(d);
    const i = instance();
    expect(canRetryFailedStore(d)).toBe(false);
    await retryFailedStore(i, d, true);
    expect(i.storeDocumentHooks).not.toHaveBeenCalled();
  });
});

describe('#919 restoreContributors', () => {
  it('puts the failed store’s contributors back, merged with anyone who edited since', () => {
    const map = new Map<string, Set<string>>([['page.x', new Set(['bob'])]]);
    restoreContributors(map, 'page.x', ['alice', 'bob']);
    expect([...map.get('page.x')!].sort()).toEqual(['alice', 'bob']);
    restoreContributors(map, 'page.y', ['carol']);
    expect([...map.get('page.y')!]).toEqual(['carol']);
    restoreContributors(map, 'page.z', []);
    expect(map.has('page.z')).toBe(false);
  });
});
