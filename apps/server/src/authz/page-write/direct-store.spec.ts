import * as Y from 'yjs';
import { storeDirectWriteNow } from './direct-store';
import { hasStoreFailure, isStoreCurrent, markStoredAt, storeGenerationOf } from './store-failure-registry';

/**
 * #810 T3: the first of a direct write's two stores (direct-store.ts). Hocuspocus 4.7.1's `storeDocumentHooks` catches
 * every hook error itself, so the catch arm runs only when the call itself rejects or throws, or when building its
 * payload throws. It is load-bearing then: without the recorded failure, a store generation that still matches
 * (`isStoreCurrent`) would make `disconnect()`'s store skip, and the failed first store would be lost silently.
 */
const doc = (connections: () => number = () => 1) => {
  const d = new Y.Doc() as Y.Doc & { name: string; getConnectionsCount(): number };
  d.name = 'page.00000000-0000-4000-8000-000000000810';
  d.getConnectionsCount = connections;
  d.getMap('m').set('k', 1); // a generation to record
  return d;
};
/** A document whose last store covered its current state: `disconnect()`'s store would be skipped. */
const storedDoc = (connections?: () => number) => {
  const d = doc(connections);
  markStoredAt(d, storeGenerationOf(d));
  expect(isStoreCurrent(d)).toBe(true); // precondition: the anti-vacuity of the assertions below
  return d;
};
const CONTEXT = { user: { id: 'u-810' } };

describe('#810 T3 storeDirectWriteNow', () => {
  it('a rejecting store is recorded as a failure (never rejects), so the next store runs in full', async () => {
    const d = storedDoc();
    const hp = { storeDocumentHooks: jest.fn(async () => Promise.reject(new Error('db down'))) };
    await expect(storeDirectWriteNow(hp as never, { document: d as never, context: CONTEXT })).resolves.toBeUndefined();
    expect(hp.storeDocumentHooks).toHaveBeenCalledTimes(1);
    expect(hasStoreFailure(d)).toBe(true);
    expect(isStoreCurrent(d)).toBe(false);
  });

  it('a store that throws synchronously is recorded the same way', async () => {
    const d = storedDoc();
    const hp = {
      storeDocumentHooks: jest.fn(() => {
        throw new Error('sync throw');
      }),
    };
    await expect(storeDirectWriteNow(hp as never, { document: d as never, context: CONTEXT })).resolves.toBeUndefined();
    expect(hasStoreFailure(d)).toBe(true);
    expect(isStoreCurrent(d)).toBe(false);
  });

  it('a payload that cannot be built (getConnectionsCount throws) is recorded too, and no store runs', async () => {
    const d = storedDoc(() => {
      throw new Error('destroyed');
    });
    const hp = { storeDocumentHooks: jest.fn(async () => undefined) };
    await expect(storeDirectWriteNow(hp as never, { document: d as never, context: CONTEXT })).resolves.toBeUndefined();
    expect(hp.storeDocumentHooks).not.toHaveBeenCalled();
    expect(hasStoreFailure(d)).toBe(true);
    expect(isStoreCurrent(d)).toBe(false);
  });

  it('control: a store that succeeds records nothing, and runs immediately with this caller\'s context', async () => {
    const d = storedDoc();
    const hp = { storeDocumentHooks: jest.fn(async (..._a: unknown[]) => undefined) };
    await storeDirectWriteNow(hp as never, { document: d as never, context: CONTEXT });
    expect(hasStoreFailure(d)).toBe(false);
    expect(isStoreCurrent(d)).toBe(true);
    expect(hp.storeDocumentHooks).toHaveBeenCalledTimes(1);
    const [document, payload, immediately] = hp.storeDocumentHooks.mock.calls[0] as [unknown, Record<string, unknown>, boolean];
    expect(document).toBe(d);
    expect(immediately).toBe(true);
    expect(payload).toEqual({
      instance: hp,
      clientsCount: 1,
      document: d,
      documentName: d.name,
      lastContext: CONTEXT,
      lastTransactionOrigin: { source: 'local', context: CONTEXT },
    });
  });

  it('no document: nothing is stored or recorded', async () => {
    const hp = { storeDocumentHooks: jest.fn() };
    await storeDirectWriteNow(hp as never, { document: null, context: CONTEXT });
    expect(hp.storeDocumentHooks).not.toHaveBeenCalled();
  });
});
