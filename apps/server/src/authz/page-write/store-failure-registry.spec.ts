import * as Y from 'yjs';
import * as reg from './store-failure-registry';
import {
  recordStoreFailure,
  clearStoreFailure,
  hasStoreFailure,
} from './store-failure-registry';

describe('store-failure-registry (#390 DB-error fold-in)', () => {
  it('reports no failure for an unknown document', () => {
    expect(hasStoreFailure({})).toBe(false);
  });

  it('records and reports a failure, then clears it', () => {
    const doc = {};
    recordStoreFailure(doc);
    expect(hasStoreFailure(doc)).toBe(true);
    clearStoreFailure(doc);
    expect(hasStoreFailure(doc)).toBe(false);
  });

  it('keys failures per document instance (no cross-talk)', () => {
    const a = {};
    const b = {};
    recordStoreFailure(a);
    expect(hasStoreFailure(a)).toBe(true);
    expect(hasStoreFailure(b)).toBe(false);
  });
});

// #731 — the one-store-per-write skip's state, against REAL Yjs documents (their transactions bump doc-version's
// generation). The seam's call sites: persistence-reconcile.spec.ts; end to end: content-write-passes.spec.ts.
describe('store-failure-registry: last successful store generation (#731)', () => {
  const edit = (d: Y.Doc, t = 'x') => d.getXmlFragment('default').insert(0, [new Y.XmlText(t)]);

  it('current only after a mark at the CURRENT generation', () => {
    const d = new Y.Doc();
    expect(reg.isStoreCurrent(d)).toBe(false); // never stored
    reg.markStoredAt(d, reg.storeGenerationOf(d));
    expect(reg.isStoreCurrent(d)).toBe(true);
  });

  it('any transaction after the mark makes it stale — an edit, a delete-only edit, an empty transaction, a remote update', () => {
    const d = new Y.Doc();
    edit(d, 'ab');
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(d));
    const cases: Array<() => void> = [
      () => edit(d),
      () => d.getXmlFragment('default').delete(0, 1),
      () => d.transact(() => undefined),
      () => {
        const sv = Y.encodeStateVector(peer);
        peer.getMap('m').set('k', 1);
        Y.applyUpdate(d, Y.encodeStateAsUpdate(peer, sv));
      },
    ];
    for (const change of cases) {
      reg.markStoredAt(d, reg.storeGenerationOf(d));
      expect(reg.isStoreCurrent(d)).toBe(true);
      change();
      expect(reg.isStoreCurrent(d)).toBe(false);
    }
  });

  it('a mark taken BEFORE an edit (an edit landing while the store awaited the database) is stale', () => {
    const d = new Y.Doc();
    const gen = reg.storeGenerationOf(d); // read in the store's serialization block
    edit(d); // lands during updatePage
    reg.markStoredAt(d, gen); // the store commits afterwards
    expect(reg.isStoreCurrent(d)).toBe(false);
  });

  it('a recorded failure is never current, and forgets the mark: a later clear alone does not make it current', () => {
    const d = new Y.Doc();
    reg.markStoredAt(d, reg.storeGenerationOf(d));
    reg.recordStoreFailure(d);
    expect(reg.isStoreCurrent(d)).toBe(false);
    reg.clearStoreFailure(d);
    expect(reg.isStoreCurrent(d)).toBe(false); // the next successful store must mark again
    reg.markStoredAt(d, reg.storeGenerationOf(d));
    expect(reg.isStoreCurrent(d)).toBe(true);
  });

  it('a recorded failure wins over any mark (a mark set without the clear does not make it current)', () => {
    const d = new Y.Doc();
    reg.recordStoreFailure(d);
    reg.markStoredAt(d, reg.storeGenerationOf(d));
    expect(reg.isStoreCurrent(d)).toBe(false);
  });

  it('markStoredAt(undefined) forgets', () => {
    const d = new Y.Doc();
    reg.markStoredAt(d, reg.storeGenerationOf(d));
    reg.markStoredAt(d, undefined);
    expect(reg.isStoreCurrent(d)).toBe(false);
  });

  it('a document whose transactions cannot be observed is never current, and checking it never throws', () => {
    const mock = {};
    expect(reg.storeGenerationOf(mock)).toBeUndefined();
    reg.markStoredAt(mock, reg.storeGenerationOf(mock));
    expect(reg.isStoreCurrent(mock)).toBe(false);
    const hostile = {
      on: () => {
        throw new Error('boom');
      },
    };
    reg.markStoredAt(hostile, 3);
    expect(() => reg.isStoreCurrent(hostile)).not.toThrow();
    expect(reg.isStoreCurrent(hostile)).toBe(false);
  });

  it('keyed per document (no cross-talk)', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    reg.markStoredAt(a, reg.storeGenerationOf(a));
    expect(reg.isStoreCurrent(a)).toBe(true);
    expect(reg.isStoreCurrent(b)).toBe(false);
  });
});
