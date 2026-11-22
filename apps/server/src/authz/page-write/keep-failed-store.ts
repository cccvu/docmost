/**
 * CCC collab integration — NOT upstream Docmost code (wiki-v2 #919, F7).
 *
 * A document whose last store FAILED stays in memory until a store succeeds.
 *
 * The persistence extension swallows a failed store on purpose (#390: a rejected store on the debounce path is an
 * unhandled rejection) and records it (store-failure-registry.ts). Hocuspocus 4.7.1 then still unloads the document:
 * after a store hook resolves it schedules `unloadDocument`, and `shouldUnloadDocument` reads only the debouncer, the
 * save mutex and the connection count, never the failure. So the edits the store failed to persist, already
 * acknowledged to their editors, left memory with the document, and so did the failure flag (ADR 0019): a later settle
 * read "not resident, the row is authoritative". Every deploy drain could do this, and a quiesce reading "nothing
 * resident" could not tell a saved document from a dropped one.
 *
 * Hocuspocus keeps a document when a `beforeUnloadDocument` hook throws (`unloadDocument` catches it and returns,
 * Hocuspocus.ts:622-627 in 4.7.1). So the persistence seam (#122) calls `keepFailedDocumentResident` first in that
 * hook:
 *   - it throws while the document's last store failed, unless this process's own compaction superseded the document:
 *     that compaction's CAS proved the row holds the document's content, so nothing is lost (compaction-registry.ts
 *     `supersededByCompaction`). A document superseded by a LINEAGE MOVE is kept: what it took since its last store
 *     can never be stored, and kept resident it is what the collab drain reports as `failed` instead of an unload
 *     that looks like success;
 *   - before throwing it schedules the failed store again in KEPT_RETRY_MS, with that store's own payload (so
 *     attribution is unchanged); a success clears the failure and Hocuspocus unloads the document as usual, a failure
 *     comes back here and schedules the next. One timer per document, unref'd (a kept document never keeps a process,
 *     or a test run, alive), and not Hocuspocus's debouncer (whose pending store would keep the document busy for the
 *     drain). Not while the collab drain runs: the drain retries on its own interval. A lineage-moved document or one
 *     with no recorded payload is not retried (a retry cannot succeed, or has no author to store as).
 * The throw carries a `reason` and no `message`, so Hocuspocus logs nothing per attempt; the failure itself was logged
 * and alarmed (COLLAB_STORE_FAILED) when it happened.
 *
 * The contributors the failed store consumed are put back (`restoreContributors`), so the retry still records them.
 */
import type { Document, Hocuspocus, onStoreDocumentPayload } from '@hocuspocus/server';
import { isSuperseded, supersededByCompaction } from './compaction-registry';
import { failedStorePayload, hasStoreFailure, recordStoreFailure } from './store-failure-registry';
import { collabDraining } from '../collab-ingress/collab-drain-state';

/** The reason `keepFailedDocumentResident` throws with (no `message`: Hocuspocus logs only a message). */
export const KEPT_RESIDENT_REASON = 'ccc:collab-store-failed-kept-resident';

/** How long a kept document waits before its failed store runs again (outside a drain): Hocuspocus's own debounce. */
export const KEPT_RETRY_MS = 10_000;

/** Documents with a retry timer pending (at most one each). */
const retryPending = new WeakSet<object>();

/** True when the document holds content its stores failed to persist: its last store failed, and no own compaction covers it. */
export function storeFailedForGood(document: object): boolean {
  return hasStoreFailure(document) && !supersededByCompaction(document);
}

/** A failed store that can be run again: its payload was recorded and the document still stores (not superseded). */
export function canRetryFailedStore(document: object): boolean {
  return failedStorePayload(document) !== undefined && !isSuperseded(document);
}

/**
 * Run the document's last failed store again, through Hocuspocus's own store path (`storeDocumentHooks`, the call
 * direct-store.ts makes), with that store's payload. `immediately`: now (the drain, the kept document's timer); otherwise
 * at Hocuspocus's debounce. Resolves when an immediate store finished. Never rejects: a store that throws past the
 * persistence extension's own catch is recorded as a failure.
 */
export async function retryFailedStore(
  instance: Pick<Hocuspocus, 'storeDocumentHooks'>,
  document: Document,
  immediately: boolean,
): Promise<void> {
  const payload = failedStorePayload(document) as onStoreDocumentPayload | undefined;
  if (!payload || isSuperseded(document)) return;
  try {
    await instance.storeDocumentHooks(document, payload, immediately);
  } catch {
    recordStoreFailure(document);
  }
}

/**
 * Seam #122, first in `beforeUnloadDocument`: throws (so Hocuspocus keeps the document) while the document's last
 * store failed, after scheduling that store again when it can succeed. Returns (the unload goes on) otherwise.
 */
export function keepFailedDocumentResident(data: {
  document: Document;
  instance?: Pick<Hocuspocus, 'storeDocumentHooks'> | null;
}): void {
  const { document, instance } = data;
  if (!storeFailedForGood(document)) return;
  releaseProcessHold(document);
  // while the collab drain runs it owns the retries (collab-quiesce.ts), on its own interval
  if (instance && canRetryFailedStore(document) && !collabDraining(instance)) scheduleRetry(instance, document);
  throw Object.freeze({ reason: KEPT_RESIDENT_REASON });
}

/**
 * A kept document is never destroyed by an unload, so its awareness (y-protocols `Awareness`) keeps the ref'd 3 s
 * interval it starts at construction (`_checkInterval`, cleared only by `destroy`). Unref it: a kept document must not
 * by itself keep a process alive (a stopping task, or a test run). The interval still runs while anything else does.
 * Never throws.
 */
function releaseProcessHold(document: Document): void {
  try {
    const awareness = (document as unknown as { awareness?: { _checkInterval?: { unref?: () => void } } }).awareness;
    awareness?._checkInterval?.unref?.();
  } catch {
    // never out of the unload hook
  }
}

function scheduleRetry(instance: Pick<Hocuspocus, 'storeDocumentHooks'>, document: Document): void {
  if (retryPending.has(document)) return;
  retryPending.add(document);
  const timer = setTimeout(() => {
    retryPending.delete(document);
    if ((document as { isDestroyed?: boolean }).isDestroyed || collabDraining(instance)) return;
    void retryFailedStore(instance, document, true);
  }, KEPT_RETRY_MS);
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Seam #122, in the store's catch: put back the contributors the failed store took out of `contributors` (the
 * extension's per-document map), so the retry records them. Never throws.
 */
export function restoreContributors(
  contributors: Map<string, Set<string>>,
  documentName: string,
  userIds: readonly string[],
): void {
  try {
    if (userIds.length === 0) return;
    const set = contributors.get(documentName) ?? new Set<string>();
    for (const id of userIds) set.add(id);
    contributors.set(documentName, set);
  } catch {
    // never out of the store's catch
  }
}
