import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { Logger } from '@nestjs/common';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { serverSchema } from '../page-write/prelim-content';
import { compactOnUnload, loadStoredYdoc, type CompactableDocument, type CompactionStore } from '../page-write/compaction';
import { lineageEpoch, liveWedged, resetCompactionGapForTests, setCompactionClockForTests } from '../page-write/compaction-registry';
import { clearStoreFailure, markStoredAt, recordStoreFailure, storeGenerationOf } from '../page-write/store-failure-registry';
import { markRowCovered, reconcileRowIntoDoc } from '../page-write/reconcile-store';
import { COMPACTION_ARM_DELAY_MS } from './doc-bounds';
import { authFrame, DOC_NAME, FakeSocket, MSG, readServerFrame, RemoteClient, syncFrame } from './collab-ingress.testkit';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { CollabUpdateGuard } from './update-guard';

/**
 * #847 G4 through a real Hocuspocus 4.7.1: a frame the guard accepted before live wedged, applied by Hocuspocus after
 * it, is ACKNOWLEDGED (SyncStatus true: `readUpdate` integrates into a wedged document without throwing) yet emits no
 * update, so nothing schedules its store. The guard's wedge watch schedules that store through Hocuspocus's own
 * `storeDocumentHooks` (the extension's onConfigure wires it) before its drain closes anyone, so the store runs at the
 * last close and the unload's compaction heals from live with the acked frame in it. Control: without the forced store
 * the heal skips `not_stored` and the unload drops the acked frame. The persistence here is a stub with the real
 * persistence extension's registry effects (generation, covered bytes, failure); compaction is the real one.
 */
const PAGE_ID = DOC_NAME.slice('page.'.length);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');
const K = 9;

function storedPage(): Uint8Array {
  const doc = prosemirrorJSONToYDoc(
    serverSchema(),
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
    'default',
  );
  return Y.encodeStateAsUpdate(doc);
}

/** Server-local, as any server path could: a stranded keyed piece on paragraph 1 (stored like any change). */
function strand(live: Y.Doc): void {
  const peer = new Y.Doc();
  peer.clientID = K;
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
  const sv = Y.encodeStateVector(peer);
  const p = peer.getXmlFragment('default').get(1) as Y.XmlElement;
  p.setAttribute('textAlign', 'left');
  const item = p._map.get('textAlign')!;
  (item.content as Y.ContentAny).arr.push('center');
  item.length = 2;
  Y.applyUpdate(live, Y.encodeStateAsUpdate(peer, sv));
  Y.applyUpdate(live, new Uint8Array([0, 1, K, 1, 1, 1]));
}
/** The wedging transaction: a delete of that paragraph. It emits no update (so schedules no store). */
function wedgeLive(live: Y.Doc): void {
  try {
    live.getXmlFragment('default').delete(1, 1);
  } catch {
    // Yjs's cleanup threw: wedged
  }
}

function paragraphOf(text: string): Y.XmlElement {
  const el = new Y.XmlElement('paragraph');
  el.insert(0, [new Y.XmlText(text)]);
  return el;
}

const visibleText = (bytes: Uint8Array) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, bytes);
  return d.getXmlFragment('default').toString();
};
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe('#847 a wedged live document: the acknowledged frames are stored, and the heal keeps them', () => {
  let restore: () => void;
  let logs: string[];
  let offset = 10 ** 12; // moved a day per server: the per-page compaction interval never carries over
  const open: Hocuspocus[] = [];
  beforeEach(() => {
    logs = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void logs.push(String(m)));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    restore = setCompactionClockForTests({ now: () => Date.now() + offset, uptimeMs: () => COMPACTION_ARM_DELAY_MS + 1 });
    resetCompactionGapForTests();
  });
  afterEach(async () => {
    restore();
    resetCompactionGapForTests();
    jest.restoreAllMocks();
    for (const hp of open.splice(0)) hp.closeConnections();
  });

  type Reconcile = typeof reconcileRowIntoDoc;
  async function server(opts: { failStores?: boolean; splitBrainOnWedgedStore?: boolean; reconcile?: Reconcile } = {}) {
    const reconcile = opts.reconcile ?? reconcileRowIntoDoc;
    offset += 86_400_000;
    const row = { ydoc: storedPage() as Uint8Array };
    const stores: Uint8Array[] = [];
    const compactionStore: CompactionStore = {
      readRow: async () => ({ content: null, ydoc: row.ydoc, contentHash: null }),
      swapYdoc: async (_id, next, o) => {
        if (sha(row.ydoc) !== o.covered) return { swapped: false, why: 'cas_miss' };
        if (o.stillCurrent && !o.stillCurrent()) return { swapped: false, why: 'changed' };
        const beforeBytes = row.ydoc.length;
        row.ydoc = next;
        return { swapped: true, beforeBytes };
      },
    };
    let wedgeOnNextUpdate = false;
    const guard = new CollabUpdateGuard({ mode: 'enforce', logger: { warn: (m: string) => logs.push(m) } });
    const hp = new Hocuspocus({
      quiet: true,
      debounce: 50,
      maxDebounce: 100,
      extensions: [
        new CollabUpdateGuardExtension(guard),
        {
          // after the guard (priority 100 < 10,000): the frame is accepted; live wedges before Hocuspocus applies it
          async beforeHandleMessage({ document, update }: { document: Y.Doc; update: Uint8Array }) {
            if (wedgeOnNextUpdate && update[DOC_NAME.length + 1] === MSG.Sync) {
              wedgeOnNextUpdate = false;
              wedgeLive(document); // the stranded piece is already stored: this transaction alone wedges
            }
          },
        },
        {
          async onAuthenticate() {
            return { user: { id: 'editor' } };
          },
        },
        {
          // the persistence extension's registry effects (persistence.extension.ts, seams #390/#731/#122)
          async onLoadDocument({ document }: { document: Y.Doc }) {
            loadStoredYdoc(document, PAGE_ID, row.ydoc, compactionStore);
          },
          async onStoreDocument({ document }: { document: Y.Doc }) {
            if (opts.failStores) return recordStoreFailure(document); // what its catch does after logging
            if (opts.splitBrainOnWedgedStore && liveWedged(document)) {
              // another resident copy (Redis split-brain) stored first: the row holds structs live lacks
              opts.splitBrainOnWedgedStore = false;
              const other = new Y.Doc();
              other.clientID = 77;
              Y.applyUpdate(other, row.ydoc);
              other.getXmlFragment('default').insert(0, [paragraphOf('out of band')]);
              row.ydoc = Y.encodeStateAsUpdate(other);
            }
            try {
              reconcile(document, row.ydoc); // seam #390, under the row lock, before the snapshot
            } catch {
              return recordStoreFailure(document); // the store's catch
            }
            const generation = storeGenerationOf(document);
            const bytes = Y.encodeStateAsUpdate(document);
            row.ydoc = bytes;
            stores.push(bytes);
            clearStoreFailure(document);
            markStoredAt(document, generation);
            markRowCovered(document, bytes);
          },
          async beforeUnloadDocument({ document }: { document: Y.Doc }) {
            await compactOnUnload(document as CompactableDocument, compactionStore);
          },
        },
      ],
    } as never);
    open.push(hp);
    await new Promise((r) => setImmediate(r)); // onConfigure ran
    const sock = new FakeSocket();
    sock.connect(hp);
    sock.deliver(authFrame('t'));
    await waitFor(() => hp.documents.has(DOC_NAME) && hp.getConnectionsCount() === 1);
    const live = hp.documents.get(DOC_NAME)!;
    const edit = (s: string) => new RemoteClient(live).edit(live, (f) => ((f.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, s));
    const syncStatuses = () => sock.sent.map(readServerFrame).filter((f) => f.type === MSG.SyncStatus).length;
    return { hp, guard, row, stores, sock, live, edit, syncStatuses, armWedge: () => (wedgeOnNextUpdate = true) };
  }

  it('a frame accepted before the wedge and applied after it is acked, stored, and kept by the heal (control: lost without the forced store)', async () => {
    for (const forced of [true, false]) {
      logs = [];
      resetCompactionGapForTests();
      const s = await server();
      if (!forced) s.guard.setWedgedStore(null);
      s.sock.deliver(syncFrame(s.edit('before ')));
      await waitFor(() => s.syncStatuses() === 1);
      strand(s.live);
      // their debounced store ran: none is pending when live wedges (one pending would still encode the wedged live)
      await waitFor(() => s.stores.length === 1);
      await new Promise((r) => setTimeout(r, 120));
      expect(s.stores.length).toBe(1);
      s.armWedge();
      s.sock.deliver(syncFrame(s.edit('acked ')));
      await waitFor(() => s.syncStatuses() === 2);
      // the evidence that this is an acknowledged loss risk: Hocuspocus acked a frame live integrated while wedged
      expect(liveWedged(s.live)).toBe(true);
      expect(s.live.getXmlFragment('default').toString()).toContain('acked before one');
      // the wedge watch: logged, the heal drained, the socket closed 1013; the store (forced or not) and the unload follow
      await waitFor(() => s.hp.getDocumentsCount() === 0);
      expect(s.sock.closed).toMatchObject({ code: 1013 });
      expect(logs.some((l) => l.startsWith('COLLAB_ORDER_DIVERGENCE') && l.includes('"outcome":"live_wedged"'))).toBe(true);
      if (forced) {
        expect(visibleText(s.stores[s.stores.length - 1])).toContain('acked before one'); // the forced store holds it
        const healed = new Y.Doc();
        Y.applyUpdate(healed, s.row.ydoc);
        expect(lineageEpoch(healed)).toBe(1); // compacted from live: a new lineage
        expect(healed.getXmlFragment('default').toString()).toContain('acked before one');
        expect(healed.getXmlFragment('default').toString()).not.toContain('two'); // the wedging delete is kept too
      } else {
        // control: no store covered the wedged state, the heal skipped, the unload dropped the acked frame
        expect(logs.some((l) => l.includes('"event":"skipped"') && l.includes('"why":"not_stored"'))).toBe(true);
        expect(visibleText(s.row.ydoc)).not.toContain('acked');
      }
    }
  });

  it('a wedge no frame ever finds (live idle after it): the watch still stores live and the heal runs (it used to skip not_stored)', async () => {
    const s = await server();
    s.sock.deliver(syncFrame(s.edit('typed ')));
    await waitFor(() => s.syncStatuses() === 1);
    strand(s.live);
    await waitFor(() => s.stores.length === 1); // the debounced store ran: the row holds both
    await new Promise((r) => setTimeout(r, 120));
    wedgeLive(s.live); // server-side, no frame follows
    expect(liveWedged(s.live)).toBe(true);
    await waitFor(() => s.hp.getDocumentsCount() === 0);
    expect(s.stores.length).toBe(2); // the forced store of the wedged state
    expect(logs.some((l) => l.includes('"event":"done"'))).toBe(true);
    expect(visibleText(s.row.ydoc)).not.toContain('two');
    expect(visibleText(s.row.ydoc)).toContain('typed one');
  });

  it('a split-brain row at the forced store is merged: the row holds both sides and the heal keeps them (control: refusing the merge loses the acked frame)', async () => {
    // the pre-fix refusal (WedgedDocumentError), as a control: a row with structs a wedged live lacks fails the store
    const refusing: Reconcile = (doc, bytes) => {
      if (liveWedged(doc) && bytes && Y.decodeUpdate(Y.diffUpdate(bytes, Y.encodeStateVector(doc))).structs.length > 0) {
        throw new Error('refused to fold the row into a wedged document');
      }
      return reconcileRowIntoDoc(doc, bytes);
    };
    for (const refuse of [false, true]) {
      logs = [];
      resetCompactionGapForTests();
      const s = await server({ splitBrainOnWedgedStore: true, reconcile: refuse ? refusing : undefined });
      s.sock.deliver(syncFrame(s.edit('before ')));
      await waitFor(() => s.syncStatuses() === 1);
      strand(s.live);
      await waitFor(() => s.stores.length === 1);
      await new Promise((r) => setTimeout(r, 120));
      s.armWedge();
      s.sock.deliver(syncFrame(s.edit('acked ')));
      await waitFor(() => s.syncStatuses() === 2); // acknowledged, never stored before the wedge
      expect(liveWedged(s.live)).toBe(true);
      await waitFor(() => s.hp.getDocumentsCount() === 0);
      expect(s.sock.closed).toMatchObject({ code: 1013 });
      const final = visibleText(s.row.ydoc);
      expect(final).toContain('out of band'); // the other copy's write is never reverted
      if (!refuse) {
        expect(s.stores.length).toBe(2);
        expect(visibleText(s.stores[1])).toContain('out of band'); // the forced store wrote the union
        expect(visibleText(s.stores[1])).toContain('acked before one');
        expect(logs.some((l) => l.includes('"event":"skipped"'))).toBe(false);
        const healed = new Y.Doc();
        Y.applyUpdate(healed, s.row.ydoc);
        expect(lineageEpoch(healed)).toBe(1); // compacted from live, which the stored row covers
        expect(final).toContain('acked before one');
        expect(final).not.toContain('two'); // the wedging delete is kept too
      } else {
        // control: the refused store is recorded, the heal skips not_stored, and the acked frame is lost at unload
        expect(s.stores.length).toBe(1);
        expect(logs.some((l) => l.includes('"event":"skipped"') && l.includes('"why":"not_stored"'))).toBe(true);
        expect(final).not.toContain('acked');
      }
    }
  });

  it('a forced store that fails is recorded: the heal skips not_stored, as for any failed store', async () => {
    const s = await server({ failStores: true });
    s.sock.deliver(syncFrame(s.edit('typed ')));
    await waitFor(() => s.syncStatuses() === 1);
    strand(s.live);
    await new Promise((r) => setTimeout(r, 120)); // its (failing) store ran
    wedgeLive(s.live);
    await waitFor(() => s.hp.getDocumentsCount() === 0);
    expect(logs.some((l) => l.includes('"event":"skipped"') && l.includes('"why":"not_stored"'))).toBe(true);
    expect(logs.some((l) => l.includes('"event":"done"'))).toBe(false);
  });
});
