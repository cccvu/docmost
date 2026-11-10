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
import type * as Y from 'yjs';
import { docGeneration } from './doc-version';

const storeFailures = new WeakMap<object, true>();

export function recordStoreFailure(document: object): void {
  storeFailures.set(document, true);
  // #731: a failed store also invalidates what the last successful one covered, so the next store runs in full.
  storedAt.delete(document);
}

export function clearStoreFailure(document: object): void {
  storeFailures.delete(document);
}

export function hasStoreFailure(document: object): boolean {
  return storeFailures.has(document);
}

/**
 * #731 — one store per write instead of two (ADR 0031 amendment).
 *
 * A content write runs a store right after its transaction (direct-store.ts; Hocuspocus 3.4.4's `transact()` ran it
 * itself) and then `disconnect()`'s, and both serialize, read the
 * locked row and reconcile the whole page. The second one has nothing new to persist when no transaction ran on the
 * document since the first one SUCCEEDED, so it is skipped: the persistence extension records the document's mutation
 * generation (doc-version.ts) at each successful store, and `isStoreCurrent` is true only while that generation is
 * unchanged and no failure is recorded.
 *
 * Why this loses nothing:
 *   - every change to a Y.Doc (a local edit, a delete-only or remote update, a reconcile merge) runs in a transaction,
 *     and every transaction bumps the generation synchronously at its end;
 *   - the generation is read in the SAME synchronous block as the serialization (right after the reconcile), so an
 *     edit that lands while the store awaits the database bumps it past the recorded one and the next store runs;
 *   - it is recorded only after the store's transaction committed (a write, or the deep-equal no-op), never for a
 *     store that found no row or refused a blank clobber;
 *   - a FAILED store forgets it and records a failure, so `disconnect()`'s store still retries a failed
 *     first store in full (the R4 retry ADR 0031 kept the second store for).
 * A document whose transactions cannot be observed (no `on`) has no generation and is never skipped.
 */
const storedAt = new WeakMap<object, number>();

/** The document's mutation generation, or `undefined` when its transactions cannot be observed. */
export function storeGenerationOf(document: object): number | undefined {
  if (typeof (document as { on?: unknown })?.on !== 'function') return undefined;
  return docGeneration(document as Y.Doc);
}

/** Record that a store persisted (or found already persisted) the document as of `generation`; `undefined` forgets. */
export function markStoredAt(document: object, generation: number | undefined): void {
  if (generation === undefined) storedAt.delete(document);
  else storedAt.set(document, generation);
}

/** True when the last successful store covered the document's current state and no failure is recorded. Never throws. */
export function isStoreCurrent(document: object): boolean {
  try {
    if (hasStoreFailure(document)) return false;
    const at = storedAt.get(document);
    return at !== undefined && at === storeGenerationOf(document);
  } catch {
    return false;
  }
}
