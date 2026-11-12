import * as Y from 'yjs';
import { createHash } from 'node:crypto';
import { basePage, rawUpdate } from '../collab-ingress/conflict-scan.testkit';
import { COLLAB_PAGE_COMPACTING_REASON } from '../collab-ingress/collab-reasons';
import { deadlineExceeded, overrideDeadlineForTests } from '../collab-ingress/deadline';
import { COMPACTION_ARM_DELAY_MS, COMPACTION_MIN_INTERVAL_MS } from '../collab-ingress/doc-bounds';
import { attachReplicaLog, distrustReplicaLog, replicaLogOf } from '../collab-ingress/exact-replica-registry';
import { isReloadStable, strictOrderDiff } from '../collab-ingress/order-parity';
import * as compaction from './compaction';
import { isPageCompactingRefusal, resetLoadTripsForTests } from './compaction';
import { compactionRequest, LINEAGE_ROOT, lineageEpoch, setCompactionClockForTests } from './compaction-registry';
import { liveContentDigest } from './doc-version';
import { afterOrderStore, checkStoreOrder, loadStableYdoc, persistOrderState, type HealImageStore } from './heal-image';
import { memoryHealStore } from './heal-image.testkit';
import { snapshotForStore } from './persistence-steps';

/**
 * #840 (ADR 0036): the heal image's store and load steps against an in-memory store (heal-image.pg.spec.ts runs the crash
 * matrix on Postgres through Hocuspocus). The unstable page is S1 in a paragraph: live "abcXYZdefgh", its reload
 * "abcdefghXYZ", every reload flipping.
 */
const PAGE = '00000000-0000-4000-8000-000000000840';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');
const loaded = (bytes: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
};

function unstable() {
  const b = basePage('abcdefgh');
  const stable = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(b.doc, rawUpdate([{ client: 2, clock: 0, structs: [{ origin: [1, b.first + 5], right: [1, b.first + 3], content: new Y.ContentString('XYZ') }] }]));
  b.doc.getXmlFragment('default');
  return { live: b.doc, stable };
}

/** The guard's replica log rebuilds `doc` exactly (the load attached the exact bytes it applied). */
const logRebuilds = (doc: Y.Doc) => strictOrderDiff(replicaLogOf(doc)!.rebuild(), doc) === null;

let armed = true;
let restoreClock: () => void;
beforeEach(() => {
  armed = true;
  restoreClock = setCompactionClockForTests({ now: () => 10 * COMPACTION_MIN_INTERVAL_MS, uptimeMs: () => (armed ? COMPACTION_ARM_DELAY_MS + 1 : 0) });
  resetLoadTripsForTests();
});
afterEach(() => restoreClock());

describe('checkStoreOrder (#840): the stored bytes against live, in the snapshot\'s run', () => {
  it('a stable page is stable and reads no image source; an unstable one names the difference and reads its source', () => {
    const { live, stable } = unstable();
    const calm = loaded(stable);
    calm.getXmlFragment('default');
    expect(checkStoreOrder(calm, snapshotForStore(calm))).toMatchObject({ stable: true, why: null, source: null });

    const snapshot = snapshotForStore(live);
    const order = checkStoreOrder(live, snapshot);
    expect(order).toMatchObject({ stable: false, why: 'length', structs: expect.any(Number) });
    expect(order.source).toMatchObject({ epoch: 0, digest: liveContentDigest(live) });
  });

  it('a reload that throws (its deadline, its walk budget) counts as unstable', () => {
    const { stable } = unstable();
    const calm = loaded(stable);
    calm.getXmlFragment('default');
    const restore = overrideDeadlineForTests((_fn, ms) => {
      throw deadlineExceeded(ms);
    });
    try {
      expect(checkStoreOrder(calm, snapshotForStore(calm))).toMatchObject({ stable: false, why: 'reload_failed' });
    } finally {
      restore();
    }
  });

  it('a stable store is the replay log\'s new checkpoint (the log empties, an untrusted one is trusted again); an unstable one leaves it', () => {
    const { stable } = unstable();
    const calm = loaded(stable);
    attachReplicaLog(calm, stable);
    calm.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]); // a server-local write: logged
    expect(replicaLogOf(calm)!.entries).toBe(1);
    distrustReplicaLog(calm, 'spec');
    expect(checkStoreOrder(calm, snapshotForStore(calm)).stable).toBe(true);
    expect(replicaLogOf(calm)!.entries).toBe(0);
    expect(logRebuilds(calm)).toBe(true);

    const s1 = loaded(stable);
    attachReplicaLog(s1, stable);
    Y.applyUpdate(s1, Y.encodeStateAsUpdate(unstable().live, Y.encodeStateVector(s1))); // S1, logged from 'update'
    expect(checkStoreOrder(s1, snapshotForStore(s1)).stable).toBe(false);
    expect(replicaLogOf(s1)!.entries).toBe(1); // a reload of it is not live: never a checkpoint
    expect(logRebuilds(s1)).toBe(true);
  });
});

describe('persistOrderState (#840): in the store\'s transaction', () => {
  it('stable drops the heal row; unstable writes the verified image, and the raw bytes when content is unchanged', async () => {
    const { live } = unstable();
    const row = { ydoc: null as Uint8Array | null };
    const store = memoryHealStore(row);
    store.heals.set(PAGE, { image: null, rowSha: 'old', epoch: 3 });
    const calm = loaded(Y.encodeStateAsUpdate(basePage('x').doc));
    calm.getXmlFragment('default');
    const s0 = snapshotForStore(calm);
    await expect(persistOrderState(store, {}, PAGE, s0, checkStoreOrder(calm, s0), false)).resolves.toMatchObject({ unstable: false });
    expect(store.heals.has(PAGE)).toBe(false);
    expect(row.ydoc).toBeNull(); // content changed: the store's own write carries the bytes
    // Content unchanged: the bytes the heal row named are replaced here, or they stay and are served unhealed.
    store.heals.set(PAGE, { image: null, rowSha: 'old', epoch: 3 });
    await expect(persistOrderState(store, {}, PAGE, s0, checkStoreOrder(calm, s0), true)).resolves.toMatchObject({ unstable: false, ydocWritten: true });
    expect(Buffer.from(row.ydoc!)).toEqual(s0.state);
    row.ydoc = null; // …and with no heal row, an unchanged stable store writes nothing (as before #840)
    await expect(persistOrderState(store, {}, PAGE, s0, checkStoreOrder(calm, s0), true)).resolves.toMatchObject({ ydocWritten: false });
    expect(row.ydoc).toBeNull();

    const snapshot = snapshotForStore(live);
    const out = await persistOrderState(store, {}, PAGE, snapshot, checkStoreOrder(live, snapshot), true);
    expect(out).toMatchObject({ unstable: true, imaged: true, ydocWritten: true });
    expect(Buffer.from(row.ydoc!)).toEqual(snapshot.state);
    const heal = store.heals.get(PAGE)!;
    expect(heal).toMatchObject({ rowSha: sha(snapshot.state), epoch: 1 });
    const image = loaded(heal.image!);
    expect(isReloadStable(image).stable).toBe(true);
    expect(liveContentDigest(image)).toBe(liveContentDigest(live));
    expect(lineageEpoch(image)).toBe(1);
  });

  it('a malformed lineage: the row goes in with no image (epoch -1), nothing healed from a guess', async () => {
    const { live } = unstable();
    live.getMap(LINEAGE_ROOT).set('epoch', 'not a number');
    const store = memoryHealStore();
    const snapshot = snapshotForStore(live);
    const out = await persistOrderState(store, {}, PAGE, snapshot, checkStoreOrder(live, snapshot), false);
    expect(out).toMatchObject({ unstable: true, imaged: false, ydocWritten: false });
    expect(store.heals.get(PAGE)).toEqual({ image: null, rowSha: sha(snapshot.state), epoch: -1 });
  });
});

describe('buildHealImage (#840): never an image that reloads into another order', () => {
  it('a build whose bytes are themselves reload-unstable is refused (the row then goes in with no image)', async () => {
    const { live } = unstable();
    const bad = Y.encodeStateAsUpdate(live);
    const spy = jest.spyOn(compaction, 'buildCompacted').mockReturnValue({ update: bad, epoch: 1, counts: { structs: 0, clients: 0 }, digest: '' });
    try {
      const store = memoryHealStore();
      const snapshot = snapshotForStore(live);
      const out = await persistOrderState(store, {}, PAGE, snapshot, checkStoreOrder(live, snapshot), false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(out).toMatchObject({ unstable: true, imaged: false });
      expect(store.heals.get(PAGE)).toMatchObject({ image: null, epoch: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('afterOrderStore (#840): after the commit', () => {
  const doc = (closes: Array<[number, string]>, throwing = false) =>
    Object.assign(new Y.Doc(), {
      getConnections: () => [
        { webSocket: { close: (code: number, reason: string) => (throwing ? (() => { throw new Error('gone'); })() : closes.push([code, reason])) } },
        { webSocket: { close: (code: number, reason: string) => closes.push([code, reason]) } },
      ],
    });
  const unstableOutcome = { unstable: true, imaged: true, ydocWritten: false, structs: 9, ms: 1 };

  it('an unstable store requests compaction and drains the sockets 1013 when one can start; a stable one does nothing', () => {
    const closes: Array<[number, string]> = [];
    const live = doc(closes);
    afterOrderStore(live, PAGE, { ...unstableOutcome, unstable: false });
    expect(compactionRequest(live)).toBeNull();
    afterOrderStore(live, PAGE, unstableOutcome);
    expect(compactionRequest(live)).toEqual({ reason: 'order_divergence', userId: null, drain: true });
    expect(closes).toEqual([
      [1013, COLLAB_PAGE_COMPACTING_REASON],
      [1013, COLLAB_PAGE_COMPACTING_REASON],
    ]);
  });

  it('before compaction is armed: requested for the next unload, no socket closed; a socket that throws never fails it', () => {
    armed = false;
    const closes: Array<[number, string]> = [];
    const live = doc(closes);
    afterOrderStore(live, PAGE, unstableOutcome);
    expect(compactionRequest(live)).toEqual({ reason: 'order_divergence', userId: null, drain: false });
    expect(closes).toEqual([]);
    armed = true;
    const broken = doc(closes, true);
    expect(() => afterOrderStore(broken, PAGE, unstableOutcome)).not.toThrow();
    expect(closes).toEqual([[1013, COLLAB_PAGE_COMPACTING_REASON]]); // the other socket still closed
  });
});

describe('loadStableYdoc (#840): the branches the crash matrix does not reach', () => {
  async function healedRow() {
    const { live } = unstable();
    const row = { ydoc: null as Uint8Array | null };
    const store = memoryHealStore(row);
    const snapshot = snapshotForStore(live);
    await persistOrderState(store, {}, PAGE, snapshot, checkStoreOrder(live, snapshot), true);
    return { live, row, store, raw: snapshot.state };
  }

  it('a row that moved under the heal read is re-read, and the decision is made on what it holds now', async () => {
    const { live, row, store, raw } = await healedRow();
    const older = Y.encodeStateAsUpdate(basePage('abcdefgh').doc); // what the caller read first
    const doc = new Y.Doc();
    await loadStableYdoc(doc, PAGE, older, store);
    expect(sha(row.ydoc!)).not.toBe(sha(raw)); // the image was swapped in over the current bytes
    expect(store.heals.has(PAGE)).toBe(false);
    expect(liveContentDigest(doc)).toBe(liveContentDigest(live));
    expect(logRebuilds(doc)).toBe(true);
  });

  it('a row that keeps moving: try-later after the bounded re-reads, nothing written', async () => {
    const { row, store } = await healedRow();
    const before = row.ydoc;
    const moving: HealImageStore & typeof store = { ...store, read: async (id) => ({ ...(await store.read(id))!, currentSha: 'moving' }) };
    const reads = jest.spyOn(moving, 'readYdoc');
    let refused: unknown;
    try {
      await loadStableYdoc(new Y.Doc(), PAGE, before!, moving);
    } catch (err) {
      refused = err;
    }
    expect(isPageCompactingRefusal(refused)).toBe(true);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(row.ydoc).toBe(before);
    expect(store.heals.has(PAGE)).toBe(true);
  });

  it('every served branch hands the replica log the exact bytes it applied (plain, legacy, healed)', async () => {
    const { live, stable } = unstable();
    const plain = new Y.Doc();
    await loadStableYdoc(plain, PAGE, stable, memoryHealStore({ ydoc: stable }));
    expect(logRebuilds(plain)).toBe(true);
    expect(compactionRequest(plain)).toBeNull();

    const legacyBytes = Y.encodeStateAsUpdate(live);
    const legacy = new Y.Doc();
    await loadStableYdoc(legacy, PAGE, legacyBytes, memoryHealStore({ ydoc: legacyBytes }));
    expect(isReloadStable(legacy).stable).toBe(false); // served as today…
    expect(compactionRequest(legacy)).toMatchObject({ reason: 'order_divergence', drain: false }); // …and compacted
    expect(logRebuilds(legacy)).toBe(true);

    const { store, raw } = await healedRow();
    const healed = new Y.Doc();
    await loadStableYdoc(healed, PAGE, raw, store);
    expect(isReloadStable(healed).stable).toBe(true);
    expect(logRebuilds(healed)).toBe(true);
  });
});
