/**
 * CCC collab integration — NOT upstream Docmost code (wiki-v2 #919, F7; ADR 0036 #810 drain).
 *
 * The collab quiesce: ONE drain, run by the gateway's `destroy` (SIGTERM, seam §3) and by `POST /api/collab/quiesce`
 * (authz/collab/collab-quiesce.controller.ts), and the refusals that hold while it lasts.
 *
 * The drain state is the process's `CollabSocketBounds` flag (socket-bounds.ts `draining`), sticky for the life of the
 * process: a run sets it (`beginDrain`), a later run keeps it, and only the quiesce abort (`endDrain`) lifts it. The
 * gateway binds its Hocuspocus instance to its bounds (`bindCollabDrain`, collab-drain-state.ts, seam §3), so the hooks
 * and the handler, which hold only that instance, read the same flag (`collabDraining`). While it is set:
 *   - no frame applies: the update guard extension refuses every frame but a CLOSE in `beforeHandleMessage`, frames a
 *     socket queued before it authenticated included (Hocuspocus 4.7.1 drains that queue through the same hook), 1013;
 *   - no document loads: the extension's `onLoadDocument` refuses every load (a websocket reconnect's try-later, a
 *     direct connection's 503), before the row is read;
 *   - no direct write runs: `withYdocConnection` refuses before it opens and again before its transaction (503,
 *     nothing changed), so `/v1` content writes, job items and comment marks are never acknowledged; a settle of a
 *     resident document answers `reason: 'error'` (503);
 *   - no connection is held: user-connections.ts closes one established during the drain (#810);
 *   - no inline comment row is written (authz/comment-resolution): a create carrying a selection and a resolve or
 *     reopen of an inline comment are refused before their row write, because the mark they carry would be refused
 *     after it.
 * Outside a drain none of this changes anything.
 *
 * A run (`runCollabDrain`):
 *   1. sets the flag and logs the start (`beginDrain`); for the shutdown, the gateway then closes the ws server;
 *   2. settles the live documents: every pending debounced store runs now (Hocuspocus `flushPendingStores`);
 *   3. closes every websocket connection (`closeConnections`); each last close stores or unloads its document;
 *   4. waits, within its budget, for the documents to store and unload. A document whose last store failed stays
 *      resident (page-write/keep-failed-store.ts) and its failed store is retried with its own payload, every
 *      DRAIN_RETRY_INTERVAL_MS (the drain owns the retries: the unload veto schedules none while it lasts); a store
 *      debounced since the settle runs now; an idle document with no connection is asked to unload;
 *   5. answers `resident` = documents loaded + loading, and `failed` = the names of those holding a failed store
 *      (a document superseded by this process's own compaction is not one; one superseded by a lineage move is), and
 *      logs `COLLAB_DRAIN done resident=<n> failed=<n>`.
 * A quiesce run returns once nothing is resident, or every resident document holds a failed store that was retried in
 * this run (or cannot be), or its budget ends (QUIESCE_DRAIN_BUDGET_MS, under the ALB's 60 s idle timeout); the caller
 * calls again until `resident` is 0. A shutdown run retries until its budget ends (SHUTDOWN_DRAIN_BUDGET_MS, under the
 * ECS stopTimeout of 90 s), so the stopped task's last done line says what the process could not store. Runs on one
 * Hocuspocus instance are serialized, each within its budget counted from its call; an abort ends the running one at
 * its next step. Never rejects.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { Document, Hocuspocus } from '@hocuspocus/server';
import type { CollabDrainCounts, CollabDrainTrigger } from './socket-bounds';
import { canRetryFailedStore, retryFailedStore, storeFailedForGood } from '../page-write/keep-failed-store';
import { bindCollabDrain, collabDraining, type CollabDrainState } from './collab-drain-state';

export { bindCollabDrain, collabDraining, type CollabDrainState };

/** A quiesce run's budget: under the ALB's 60 s idle timeout, so the caller always gets an answer (contract: ≤45 s). */
export const QUIESCE_DRAIN_BUDGET_MS = 40_000;
/** The shutdown run's budget: under the ECS stopTimeout (90 s), leaving time for the rest of Nest's shutdown. */
export const SHUTDOWN_DRAIN_BUDGET_MS = 60_000;
/** How often a resident document's failed store is run again during a drain. */
export const DRAIN_RETRY_INTERVAL_MS = 2_000;
/** The longest a drain waits between two looks when nothing it listens to happens. */
export const DRAIN_POLL_MS = 50;

/** The part of `CollabSocketBounds` a drain run drives. */
export interface CollabDrainBounds extends CollabDrainState {
  readonly drainGeneration: number;
  beginDrain(documents: number, trigger: CollabDrainTrigger): (left: CollabDrainCounts) => void;
}

/** What a drain run answers (`POST /api/collab/quiesce` adds `draining: true`). */
export interface CollabDrainResult {
  /** Documents still loaded or loading. */
  resident: number;
  /** Names (`page.<id>`) of the resident documents whose last store failed. */
  failed: string[];
}

/** The part of Hocuspocus 4.7.1 a drain run uses (public members only). */
export type DrainableHocuspocus = Pick<
  Hocuspocus,
  | 'documents'
  | 'loadingDocuments'
  | 'unloadingDocuments'
  | 'debouncer'
  | 'closeConnections'
  | 'flushPendingStores'
  | 'storeDocumentHooks'
  | 'unloadDocument'
>;

/**
 * 503: collaboration is quiesced (a maintenance window, or the process is shutting down). Nothing was changed; retry
 * later (the fork's RetryAfterFilter adds `Retry-After`). `engine_busy` is the platform's retryable "refused, nothing
 * changed".
 */
export class CollabQuiescedException extends ServiceUnavailableException {
  constructor() {
    super({ message: 'collaboration is paused for maintenance; nothing was changed — retry later', code: 'engine_busy' });
  }
}

/** Seam #2 (`withYdocConnection`): throws the 503 while `hocuspocus` drains. */
export function assertCollabNotQuiesced(hocuspocus: unknown): void {
  if (collabDraining(hocuspocus)) throw new CollabQuiescedException();
}

const running = new WeakMap<object, Promise<unknown>>();

/**
 * Run one drain on `hocuspocus` (see the header). The flag is set and `onBegin` runs synchronously, at the call, even
 * when another run on the instance is still going (this one then starts when that one ends).
 */
export function runCollabDrain(
  hocuspocus: DrainableHocuspocus,
  bounds: CollabDrainBounds,
  opts: { trigger: CollabDrainTrigger; budgetMs?: number; onBegin?: () => void; now?: () => number },
): Promise<CollabDrainResult> {
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? (opts.trigger === 'quiesce' ? QUIESCE_DRAIN_BUDGET_MS : SHUTDOWN_DRAIN_BUDGET_MS);
  const generation = bounds.drainGeneration;
  const done = bounds.beginDrain(hocuspocus.documents.size + hocuspocus.loadingDocuments.size, opts.trigger);
  try {
    opts.onBegin?.();
  } catch {
    // the shutdown's ws-server close: never in the way of the drain
  }
  // The budget runs from the call, not from the run's start: a run queued behind another still answers in time (a
  // quiesce under the ALB's idle timeout, the shutdown inside the ECS stopTimeout).
  const deadline = now() + budgetMs;
  const previous = running.get(hocuspocus) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => drainOnce(hocuspocus, bounds, generation, opts.trigger, deadline, now))
    .catch(() => resultOf(hocuspocus))
    .then((result) => {
      done({ resident: result.resident, failed: result.failed.length });
      return result;
    });
  running.set(hocuspocus, run);
  return run;
}

function resultOf(hocuspocus: DrainableHocuspocus): CollabDrainResult {
  const failed: string[] = [];
  for (const [name, document] of hocuspocus.documents) if (storeFailedForGood(document)) failed.push(name);
  return { resident: hocuspocus.documents.size + hocuspocus.loadingDocuments.size, failed };
}

const storeId = (document: Document) => `onStoreDocument-${document.name}`;

/** No store pending, running or queued for the document (Hocuspocus's own `shouldUnloadDocument` signals). */
function storesIdle(hocuspocus: DrainableHocuspocus, document: Document): boolean {
  const id = storeId(document);
  return !hocuspocus.debouncer.isDebounced(id) && !hocuspocus.debouncer.isCurrentlyExecuting(id) && !document.saveMutex.isLocked();
}

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

async function drainOnce(
  hocuspocus: DrainableHocuspocus,
  bounds: CollabDrainBounds,
  generation: number,
  trigger: CollabDrainTrigger,
  deadline: number,
  now: () => number,
): Promise<CollabDrainResult> {
  const aborted = () => bounds.drainGeneration !== generation;
  // A frame the guard admitted before the flag was set applies in the microtasks after its check: let it land, so
  // its store is scheduled before the settle.
  await nextMacrotask();
  if (aborted()) return resultOf(hocuspocus);
  hocuspocus.flushPendingStores();
  hocuspocus.closeConnections();

  const retriedAt = new Map<Document, number>();
  for (;;) {
    const documents = [...hocuspocus.documents.values()];
    const loading = hocuspocus.loadingDocuments.size;
    const unloading = [...hocuspocus.unloadingDocuments.values()];
    if (documents.length === 0 && loading === 0 && unloading.length === 0) break;
    if (aborted() || now() >= deadline) break;
    if (documents.length === 0 && loading === 0) {
      // only an unload's last hooks (RedisSync's lock release among them) are still running: wait for them. Hocuspocus
      // removes the entry in its own continuation of that promise, which runs before this one's.
      await wake(hocuspocus, Math.max(0, deadline - now()));
      continue;
    }
    let settled = 0;
    for (const document of documents) {
      // a store debounced since the settle (a wedged document's, #847): run it now, as the settle did
      if (hocuspocus.debouncer.isDebounced(storeId(document)) && !hocuspocus.debouncer.isCurrentlyExecuting(storeId(document))) {
        void Promise.resolve(hocuspocus.debouncer.executeNow(storeId(document))).catch(() => undefined);
        continue;
      }
      if (!storesIdle(hocuspocus, document)) continue;
      if (storeFailedForGood(document)) {
        const at = retriedAt.get(document);
        if (canRetryFailedStore(document) && (at === undefined || now() - at >= DRAIN_RETRY_INTERVAL_MS)) {
          retriedAt.set(document, now());
          void retryFailedStore(hocuspocus, document, true);
          continue;
        }
        // a quiesce answers once every failed store was tried again in this run (or cannot be)
        if (!canRetryFailedStore(document) || at !== undefined) settled++;
        continue;
      }
      if (document.getConnectionsCount() === 0) void hocuspocus.unloadDocument(document).catch(() => undefined);
    }
    if (trigger === 'quiesce' && loading === 0 && settled === documents.length) break;
    if (!documents.some((document) => canRetryFailedStore(document) || !storeFailedForGood(document)) && loading === 0) {
      break; // nothing left can change: every resident document holds a store that can never succeed
    }
    await wake(hocuspocus, Math.max(0, Math.min(DRAIN_POLL_MS, deadline - now())));
  }
  return resultOf(hocuspocus);
}

/**
 * Wait until something the drain waits for happens (a document destroyed, a load or an unload settled) or `ms` passed.
 * Listeners and the timer are removed after, so a long drain does not pile them up.
 */
function wake(hocuspocus: DrainableHocuspocus, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const documents = [...hocuspocus.documents.values()];
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const document of documents) document.off('destroy', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    for (const document of documents) document.on('destroy', finish);
    for (const p of hocuspocus.loadingDocuments.values()) p.then(finish, finish);
    for (const p of hocuspocus.unloadingDocuments.values()) p.then(finish, finish);
  });
}
