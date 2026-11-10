/**
 * #790 — the settle's wait for a document's stores (ADR 0019, #282, #390).
 *
 * The settle (`flushPageContent`) answers "the `pages` row is current" and then reads the store-failure signal. Both
 * need EVERY store that was pending when it arrived to have finished, including one queued behind another.
 *
 * Hocuspocus 4.x's debouncer deletes a store's timer BEFORE it waits for the store already executing (3.4.4 deleted it
 * after). While it waits, the queued store is invisible to `isDebounced` and holds no `saveMutex`, so running the
 * pending store and draining the mutex once returned as soon as the FIRST store finished: the row still lacked what
 * the queued store carried, and a failure of that store was read too early to count. Only `isCurrentlyExecuting`
 * still sees it (the store it waits on stays registered until the queued one registers itself, in the same microtask
 * run).
 *
 * So: run the pending store once (as before, keeping the human's attribution), then drain the mutex and re-check
 * until no store is executing or waiting and the mutex is free. Two signals, each relying on a different internal:
 * `isCurrentlyExecuting` stays true across the hand-over from one store to the one queued behind it, and after a
 * macrotask turn the queued store has started and holds `saveMutex`. Either alone closes the race the spec pins; both
 * are read so a change to one internal does not reopen it. The macrotask turn also lets a finished store's tail run,
 * so each round waits for one store instead of burning the cap in microtasks. Rounds are bounded by the stores queued;
 * the cap only catches a debouncer that never clears, and fails the settle closed (503, retryable) rather than
 * spinning. A store that starts during the wait (an edit after the settle began) is waited for too, which is
 * harmless. Public Hocuspocus API only: `isDebounced`, `executeNow`, `isCurrentlyExecuting`, `saveMutex`.
 */
import type { Hocuspocus } from '@hocuspocus/server';

/** Upper bound on drain rounds; each round normally waits for one whole store. */
export const SETTLE_DRAIN_MAX_ROUNDS = 32;

type Debouncer = Pick<
  Hocuspocus['debouncer'],
  'isDebounced' | 'executeNow' | 'isCurrentlyExecuting'
>;
/** The part of a Hocuspocus `Document` read here (its `saveMutex`, an async-mutex `Mutex`). */
type Saving = {
  saveMutex: {
    runExclusive(callback: () => Promise<undefined>): Promise<unknown>;
    isLocked(): boolean;
  };
};

/** One macrotask turn: a finished store's tail and the next store's start both run before the re-check. */
const nextMacrotask = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Wait until every store pending for `documentName` when this was called has finished. Throws when the stores do not
 * drain within {@link SETTLE_DRAIN_MAX_ROUNDS} rounds; the caller turns any throw into a failed settle.
 */
export async function drainDocumentStores(
  debouncer: Debouncer,
  document: Saving,
  documentName: string,
): Promise<void> {
  const debounceId = `onStoreDocument-${documentName}`;
  if (debouncer.isDebounced(debounceId)) {
    await debouncer.executeNow(debounceId);
  }
  for (let round = 0; round < SETTLE_DRAIN_MAX_ROUNDS; round++) {
    await document.saveMutex.runExclusive(async () => undefined);
    await nextMacrotask();
    if (
      !debouncer.isCurrentlyExecuting(debounceId) &&
      !document.saveMutex.isLocked()
    ) {
      return;
    }
  }
  throw new Error(
    `stores for ${documentName} did not drain within ${SETTLE_DRAIN_MAX_ROUNDS} rounds`,
  );
}
