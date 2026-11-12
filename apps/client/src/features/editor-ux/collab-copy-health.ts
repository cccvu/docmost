import type * as Y from "yjs";

/**
 * CCC fork addition (cccvu/wiki-v2#847) — notices when this browser's Yjs copy of a page broke, so the editor stops
 * instead of failing silently.
 *
 * Two ways a copy breaks without anyone seeing it (yjs 13.6.30, y-indexeddb 9.0.12):
 *
 *   - `wedged`: a transaction's cleanup threw (a live keyed item longer than one value, split by a delete, whose parent
 *     is then deleted: `Item.gc` throws "Unexpected case"). yjs then never empties `doc._transactionCleanups`, so it
 *     never emits `beforeAllTransactions`/`afterAllTransactions` again and, worse, never emits `update`: nothing is sent
 *     to the server and nothing is persisted to IndexedDB, with no error in sight. Seen as a batch that emitted
 *     `beforeAllTransactions` and still has no `afterAllTransactions` at the next microtask (transactions are
 *     synchronous, so an honest batch has always ended by then).
 *   - `replay`: y-indexeddb replays the stored copy in one transaction whose origin is the persistence object, and sets
 *     `synced = true` synchronously after a successful replay. A replay that throws leaves `synced` false for good:
 *     `whenSynced` never resolves, the page keeps showing the server's static version, and every reload throws again.
 *     Seen as a transaction from the persistence object with `synced === false` at the next microtask. Strictly
 *     `=== false`, never `!synced`: a copy that does not say (no `synced` field) is never reported.
 *
 * Deterministic: no timers, only listeners and a microtask per batch. It reports once, then removes its listeners; the
 * returned function removes them sooner. `collab-access-controller.ts` turns the report into a refusal
 * (`local-copy-broken`, `collab-access.ts`): the provider is detached, the socket closed and the editor read-only, so
 * the broken copy stops sending and persisting, and the notice offers Reload and Discard (`client:local-copy`,
 * `collab-refusal-cause.ts`). Never discarded automatically: the dirty marker cannot vouch for a broken copy.
 *
 * Residual: y-indexeddb also replays when it trims its store (after `synced` is already true). A throw there is seen
 * only if it wedges the document; the yjs patch C (#847) removes the known instance of it (the M1 TypeError).
 */

export type CollabCopyBreak = "wedged" | "replay";

/** The slice of `IndexeddbPersistence` the watcher reads: its doc, and y-indexeddb's `synced` flag. */
export interface CollabCopyHealthTarget {
  doc: Pick<Y.Doc, "on" | "off">;
  synced?: boolean;
}

export function watchCollabCopyHealth(
  local: CollabCopyHealthTarget,
  onBroken: (why: CollabCopyBreak) => void,
): () => void {
  const { doc } = local;
  let open = false;
  let replaying = false;
  let stopped = false;

  const check = () => {
    if (stopped) return;
    const why: CollabCopyBreak | null = open
      ? "wedged"
      : replaying && local.synced === false
        ? "replay"
        : null;
    replaying = false;
    if (why === null) return;
    stop();
    onBroken(why);
  };
  const onBeforeAll = () => {
    open = true;
    queueMicrotask(check);
  };
  const onAfterAll = () => {
    open = false;
  };
  const onBeforeTransaction = (transaction: Y.Transaction) => {
    if (transaction.origin === local) replaying = true;
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    doc.off("beforeAllTransactions", onBeforeAll);
    doc.off("afterAllTransactions", onAfterAll);
    doc.off("beforeTransaction", onBeforeTransaction);
  }

  doc.on("beforeAllTransactions", onBeforeAll);
  doc.on("afterAllTransactions", onAfterAll);
  doc.on("beforeTransaction", onBeforeTransaction);
  return stop;
}
