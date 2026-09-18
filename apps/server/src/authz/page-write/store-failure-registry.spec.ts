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
