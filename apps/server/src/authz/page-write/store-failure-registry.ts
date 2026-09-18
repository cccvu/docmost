/**
 * #390 — a tiny cross-hook signal for a FAILED page store.
 *
 * ADR 0019 flagged that `onStoreDocument` swallows DB errors, so a failed store can let the settle
 * (`flushPageContent`, which runs the store via `debouncer.executeNow`) report SUCCESS over a row that was
 * never written — and a guarded `/v1` write then trusts a version the row does not hold.
 *
 * We cannot simply re-throw from `onStoreDocument`: Hocuspocus re-throws hook errors, and on the ordinary
 * `setTimeout`-driven debounce path (not the settle path) nothing awaits the rejected promise, so it becomes
 * an unhandled rejection. Instead the persistence extension RECORDS a failure here (and clears it on a
 * successful store), and the settle handler READS it after running the store — turning "the store I just ran
 * failed" into `{ flushed: false, reason: 'error' }`, which the platform already maps to a fail-closed 503.
 *
 * Keyed by the Hocuspocus `Document` instance (a WeakMap, so entries vanish when the document is GC'd after
 * unload). Both producers/consumers hold the SAME resident `Document` object, so no id plumbing is needed.
 */
const storeFailures = new WeakMap<object, true>();

export function recordStoreFailure(document: object): void {
  storeFailures.set(document, true);
}

export function clearStoreFailure(document: object): void {
  storeFailures.delete(document);
}

export function hasStoreFailure(document: object): boolean {
  return storeFailures.has(document);
}
