// #790: the settle must wait for a store QUEUED behind the one in flight, on the REAL Hocuspocus 4.7.1 debouncer.
//
// Hocuspocus 4.x's debouncer deletes a store's timer BEFORE it waits for the store already running (3.4.4 deleted it
// after). While the second store waits, `isDebounced` is false and it holds no lock, so a settle that ran a pending
// store via `executeNow` and drained `saveMutex` once returned `flushed: true` as soon as the FIRST store finished:
// before the row held the queued store's content, and with the queued store's failure not yet recorded. A guarded
// `/v1` write then pre-checks its `If-Match` against that stale row while its CAS digest is the live document's, so
// an edit only the queued store carried could be replaced unseen (the #282 lost update, ADR 0019).
//
// Real: Hocuspocus 4.7.1 (debouncer, `storeDocumentHooks`, `saveMutex`), the real CollaborationHandler. The only fake
// is the store hook itself, held open per call so the test controls when each store finishes.
import { Hocuspocus, type Document } from '@hocuspocus/server';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import {
  clearStoreFailure,
  recordStoreFailure,
} from '../page-write/store-failure-registry';

const DOC = 'page.33333333-3333-4333-8333-333333333333';

type Gate = { release: (fail?: boolean) => void };

/** A store hook whose every call waits until the test releases it (or until `autoRelease`). */
function gatedStore() {
  const calls: Gate[] = [];
  let autoRelease = false;
  const waiting: Array<() => void> = [];
  const extension = {
    async onStoreDocument({ document }: { document: Document }) {
      let release!: (fail?: boolean) => void;
      const done = new Promise<boolean>((resolve) => {
        release = (fail = false) => resolve(fail);
      });
      calls.push({ release });
      waiting.splice(0).forEach((wake) => wake());
      if (autoRelease) release(false);
      // The persistence extension never rejects: it records a failed store and clears it on a good one (#390).
      if (await done) recordStoreFailure(document);
      else clearStoreFailure(document);
    },
  };
  /** Resolves once the hook has been entered `n` times. */
  const enteredTimes = async (n: number) => {
    while (calls.length < n) await new Promise<void>((r) => waiting.push(r));
  };
  return {
    extension,
    calls,
    enteredTimes,
    releaseAll: () => {
      autoRelease = true;
      calls.forEach((c) => c.release(false));
    },
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('flushPageContent waits for a store queued behind the one in flight (#790, Hocuspocus 4.7.1)', () => {
  let hocuspocus: Hocuspocus;
  let store: ReturnType<typeof gatedStore>;
  let connection: Awaited<ReturnType<Hocuspocus['openDirectConnection']>>;
  let document: Document;

  beforeEach(async () => {
    store = gatedStore();
    hocuspocus = new Hocuspocus({
      debounce: 5,
      maxDebounce: 60_000,
      unloadImmediately: true,
      extensions: [store.extension as never],
    });
    // A held direct connection keeps the document resident (it is what an open editor does).
    connection = await hocuspocus.openDirectConnection(DOC, {});
    document = hocuspocus.documents.get(DOC)!;
  });

  afterEach(async () => {
    store.releaseAll();
    await connection.disconnect();
    clearStoreFailure(document);
  });

  const payload = () => ({
    instance: hocuspocus,
    clientsCount: 1,
    document,
    documentName: DOC,
    lastContext: {},
    lastTransactionOrigin: { source: 'local' as const, context: {} },
  });

  /** Store A in flight, then store B's debounce timer FIRES and B waits behind A (out of `timers`, holding nothing). */
  async function storeAInFlightWithBQueued() {
    void hocuspocus.storeDocumentHooks(document, payload() as never, true); // A
    await store.enteredTimes(1);
    void hocuspocus.storeDocumentHooks(document, payload() as never); // B: debounced
    await tick(30); // B's timer fires; B now waits for A
    const id = `onStoreDocument-${DOC}`;
    // The 4.x window this spec exists for: B is pending, yet the debouncer no longer reports it as debounced.
    expect(hocuspocus.debouncer.isDebounced(id)).toBe(false);
    expect(hocuspocus.debouncer.isCurrentlyExecuting(id)).toBe(true);
    expect(store.calls).toHaveLength(1);
  }

  const settle = (withDigest = false) =>
    new CollaborationHandler()
      .getHandlers(hocuspocus)
      .flushPageContent(DOC, { withDigest });

  it('does not report the row current until the queued store has landed', async () => {
    await storeAInFlightWithBQueued();
    let answered = false;
    const settling = settle().then((r) => {
      answered = true;
      return r;
    });

    store.calls[0].release(); // A finishes
    await store.enteredTimes(2); // B starts only now
    await tick(10);
    expect(answered).toBe(false); // B is still writing: the row is not current yet

    store.calls[1].release(); // B lands
    await expect(settling).resolves.toEqual({ flushed: true });
  });

  it('fails the settle when the queued store fails, even though the first one succeeded', async () => {
    await storeAInFlightWithBQueued();
    const settling = settle(true);

    store.calls[0].release(false); // A succeeds
    await store.enteredTimes(2);
    store.calls[1].release(true); // B fails: the row never received what B carried

    await expect(settling).resolves.toEqual({
      flushed: false,
      reason: 'error',
    });
  });

  it('reports success when the queued store succeeds after the first one failed', async () => {
    await storeAInFlightWithBQueued();
    const settling = settle();

    store.calls[0].release(true); // A fails (recorded)
    await store.enteredTimes(2);
    store.calls[1].release(false); // B persists the whole document and clears it

    await expect(settling).resolves.toEqual({ flushed: true });
  });
});
