import * as Y from 'yjs';
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
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
import { afterOrderStore, checkStoreOrder, loadStableYdoc, persistOrderState, prepareStore, resetContentHealRefusalsForTests, storeSnapshotUnderLock, type HealImageStore } from './heal-image';
import { memoryHealStore } from './heal-image.testkit';
import { snapshotForStore } from './persistence-steps';
import { storeSafeJson } from './store-safe-json';
import { isDuplicateWriteKey, recordWriteKey, scopedWriteKey } from './write-idem';
import { repairLegacyValues } from '../collab-ingress/legacy-repair';
import { markRowCovered } from './reconcile-store';
import { resetLoadDivergenceLogForTests } from './order-divergence-log';

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

/**
 * S1 on a page converted through the server schema (as the editor and the API write it: every default attribute
 * present), so a rebuild from its `content` can reproduce it. `unstable()`'s bare paragraph has none, and a rebuild
 * through the schema fills them in (its digest then differs: that page can only heal from live or a stored image).
 */
function schemaUnstable(tail = '') {
  const live = TiptapTransformer.toYdoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'abcdefgh' }] }] } as never, 'default', tiptapExtensions);
  // A tail typed after the conversion (the JSON route would reject a lone surrogate): as a client writes it.
  if (tail) ((live.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(8, tail);
  const text = (live.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const start = (text as unknown as { _start: Y.Item })._start.id;
  Y.applyUpdate(live, rawUpdate([{ client: start.client + 1, clock: 0, structs: [{ origin: [start.client, start.clock + 5], right: [start.client, start.clock + 3], content: new Y.ContentString('XYZ') }] }]));
  live.getXmlFragment('default');
  expect(isReloadStable(live).stable).toBe(false); // precondition
  return { live };
}

/** The guard's replica log rebuilds `doc` exactly (the load attached the exact bytes it applied). */
const logRebuilds = (doc: Y.Doc) => strictOrderDiff(replicaLogOf(doc)!.rebuild(), doc) === null;

let armed = true;
let restoreClock: () => void;
beforeEach(() => {
  armed = true;
  restoreClock = setCompactionClockForTests({ now: () => 10 * COMPACTION_MIN_INTERVAL_MS, uptimeMs: () => (armed ? COMPACTION_ARM_DELAY_MS + 1 : 0) });
  resetLoadTripsForTests();
  resetLoadDivergenceLogForTests();
  resetContentHealRefusalsForTests();
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

    const { snapshot, order } = await prepareStore(live, PAGE);
    const out = await persistOrderState(store, {}, PAGE, snapshot, order, true);
    expect(out).toMatchObject({ unstable: true, reloadFailed: false, imaged: true, ydocWritten: true });
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
    const { snapshot, order } = await prepareStore(live, PAGE);
    const out = await persistOrderState(store, {}, PAGE, snapshot, order, false);
    expect(out).toMatchObject({ unstable: true, imaged: false, ydocWritten: false });
    expect(store.heals.get(PAGE)).toEqual({ image: null, rowSha: sha(snapshot.state), epoch: -1, contentDigest: liveContentDigest(live) });
  });
});

describe('buildHealImage (#840): never an image that reloads into another order', () => {
  it('a build whose bytes are themselves reload-unstable is refused (the row then goes in with no image)', async () => {
    const { live } = unstable();
    const bad = Y.encodeStateAsUpdate(live);
    const spy = jest.spyOn(compaction, 'buildCompacted').mockReturnValue({ update: bad, epoch: 1, counts: { structs: 0, clients: 0 }, digest: '' });
    try {
      const store = memoryHealStore();
      const { snapshot, order } = await prepareStore(live, PAGE);
      const out = await persistOrderState(store, {}, PAGE, snapshot, order, false);
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
  const unstableOutcome = { unstable: true, reloadFailed: false, imaged: true, ydocWritten: false, structs: 9, ms: 1 };

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

  it('#827: drains only when the page heals after it: an image to adopt at the next load, or an unload that can compact', () => {
    const closes: Array<[number, string]> = [];
    // no image and uncovered bytes (they leave structs pending): nothing would heal, so the writers keep the page
    const bare = doc(closes);
    afterOrderStore(bare, PAGE, { ...unstableOutcome, imaged: false });
    expect(compactionRequest(bare)).toEqual({ reason: 'order_divergence', userId: null, drain: false });
    expect(closes).toEqual([]);
    // no image, covered bytes: the unload compacts from live
    const covered = doc(closes);
    markRowCovered(covered, Y.encodeStateAsUpdate(basePage('abc').doc));
    afterOrderStore(covered, PAGE, { ...unstableOutcome, imaged: false });
    expect(compactionRequest(covered)).toMatchObject({ drain: true });
    expect(closes).toHaveLength(2);
    // an image (uncovered bytes): the next load adopts it
    const imaged = doc((closes.length = 0, closes));
    afterOrderStore(imaged, PAGE, unstableOutcome);
    expect(compactionRequest(imaged)).toMatchObject({ drain: true });
    expect(closes).toHaveLength(2);
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
    const { snapshot, order } = await prepareStore(live, PAGE);
    await persistOrderState(store, {}, PAGE, snapshot, order, true);
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

// --- review fixes (#840): items 1–4 of the phase-2 review

const linesOf = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('COLLAB_ORDER_DIVERGENCE '));
const outcomes = (spy: jest.SpyInstance) => linesOf(spy).map((l) => JSON.parse(l.slice('COLLAB_ORDER_DIVERGENCE '.length)).outcome);

describe('a reload that throws at the store is no evidence of instability (#840 review item 3)', () => {
  it('reload_failed: the heal row still gets a verified image, compaction waits for the next unload (no drain), logged reload_failed', async () => {
    const { stable } = unstable();
    const calm = loaded(stable); // an honest, stable page whose store reload misses its deadline (a GC pause)
    calm.getXmlFragment('default');
    let calls = 0;
    const restore = overrideDeadlineForTests((fn, ms) => {
      if (++calls === 1) throw deadlineExceeded(ms); // the reload only; the image build runs
      return fn();
    });
    let prepared: Awaited<ReturnType<typeof prepareStore>>;
    try {
      prepared = await prepareStore(calm, PAGE);
    } finally {
      restore();
    }
    expect(prepared.order).toMatchObject({ stable: false, why: 'reload_failed' });
    expect(prepared.order.image).not.toBeNull(); // fail closed for a crash: an unknown order stays recoverable
    const row = { ydoc: null as Uint8Array | null };
    const store = memoryHealStore(row);
    const out = await persistOrderState(store, {}, PAGE, prepared.snapshot, prepared.order, true);
    expect(out).toMatchObject({ unstable: true, reloadFailed: true, imaged: true });
    expect(store.heals.get(PAGE)).toMatchObject({ rowSha: sha(prepared.snapshot.state), epoch: 1 });

    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const closes: Array<[number, string]> = [];
      const live = Object.assign(calm, { getConnections: () => [{ webSocket: { close: (code: number, reason: string) => closes.push([code, reason]) } }] });
      afterOrderStore(live, PAGE, out);
      expect(compactionRequest(live)).toEqual({ reason: 'order_divergence', userId: null, drain: false });
      expect(closes).toEqual([]); // never a page-wide drain for one slow reload
      expect(outcomes(warn)).toEqual(['reload_failed']);
      expect(linesOf(error)).toEqual([]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe('storeSnapshotUnderLock (#840 review item 4): the snapshot taken before the row lock is written only while it holds the locked row', () => {
  it('the row is the bytes the document covered at the snapshot: the prepared store is written (a later edit waits for the next store)', async () => {
    const { stable } = unstable();
    const doc = loaded(stable);
    doc.getXmlFragment('default');
    markRowCovered(doc, stable); // what the load records
    const prepared = await prepareStore(doc, PAGE);
    expect(prepared.underLock).toBe(false);
    doc.getXmlFragment('default').insert(1, [new Y.XmlElement('paragraph')]); // an edit landing before the lock
    await expect(storeSnapshotUnderLock(doc, PAGE, prepared, stable)).resolves.toBe(prepared);
    await expect(storeSnapshotUnderLock(doc, PAGE, prepared, null)).resolves.toBe(prepared); // no Yjs state to cover
  });

  it('any other row bytes (another node\'s write, a fold-in by the reconcile): snapshot, order and image are taken again under the lock', async () => {
    const { live, stable } = unstable();
    const doc = loaded(stable);
    doc.getXmlFragment('default');
    markRowCovered(doc, stable);
    const prepared = await prepareStore(doc, PAGE);
    const other = Y.encodeStateAsUpdate(live); // a row this document never covered
    Y.applyUpdate(doc, other); // …which the reconcile folded in (S1: live is now unstable)
    const under = await storeSnapshotUnderLock(doc, PAGE, prepared, other);
    expect(under.underLock).toBe(true);
    expect(Buffer.from(under.snapshot.state)).toEqual(Buffer.from(Y.encodeStateAsUpdate(doc))); // a superset of the row
    expect(under.order).toMatchObject({ stable: false, why: 'length' });
    expect(under.order.image).not.toBeNull();
  });
});

describe('loadStableYdoc (#840 review items 1 and 2)', () => {
  it('a stale heal row over unstable bytes is a legacy row: served as loaded, compacted from that tree, the stale row dropped, logged stale_legacy', async () => {
    const { live } = unstable();
    const legacyBytes = Y.encodeStateAsUpdate(live); // written by a pre-#840 task, which served this reload order
    const store = memoryHealStore({ ydoc: legacyBytes });
    store.heals.set(PAGE, { image: Y.encodeStateAsUpdate(basePage('older').doc), rowSha: 'bytes-the-pre-840-write-replaced', epoch: 1 });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const doc = new Y.Doc();
    try {
      await loadStableYdoc(doc, PAGE, legacyBytes, store);
      expect(outcomes(warn)).toEqual(['stale_legacy']);
    } finally {
      warn.mockRestore();
    }
    expect(isReloadStable(doc).stable).toBe(false); // served as the pre-#840 task served it
    expect(compactionRequest(doc)).toMatchObject({ reason: 'order_divergence', drain: false });
    expect(store.heals.has(PAGE)).toBe(false);
    expect(logRebuilds(doc)).toBe(true);
  });

  /** An unstable store whose image could not be built: raw bytes, live's content (the store's own write), no image. */
  async function imagelessRow(tail = '') {
    const { live } = schemaUnstable(tail);
    const row = { ydoc: null as Uint8Array | null, content: undefined as unknown };
    const store = memoryHealStore(row);
    const prepared = await prepareStore(live, PAGE);
    await persistOrderState(store, {}, PAGE, prepared.snapshot, { ...prepared.order, image: null }, true);
    row.content = JSON.parse(JSON.stringify(prepared.snapshot.json)); // jsonb
    expect(store.heals.get(PAGE)).toMatchObject({ image: null, epoch: 1 });
    return { live, row, store, raw: prepared.snapshot.state };
  }

  it('a heal row with no image: the image is rebuilt from the row\'s content, verified against it, and swapped in (healed_from_content)', async () => {
    const { live, row, store, raw } = await imagelessRow();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const doc = new Y.Doc();
    try {
      await loadStableYdoc(doc, PAGE, raw, store);
      expect(outcomes(warn)).toEqual(['healed_from_content']);
    } finally {
      warn.mockRestore();
    }
    expect(isReloadStable(doc).stable).toBe(true);
    expect(liveContentDigest(doc)).toBe(liveContentDigest(live)); // what live showed at the store
    expect(lineageEpoch(doc)).toBe(1);
    expect(store.heals.has(PAGE)).toBe(false);
    expect(sha(row.ydoc!)).not.toBe(sha(raw));
    expect(logRebuilds(doc)).toBe(true);
  });

  it.each([
    ['content that is not what live showed', (row: { content: any }) => (row.content.content[0].content[0].text = 'abcdefghXYZ')],
    ['no content', (row: { content: any }) => (row.content = null)],
    ['content whose own rebuild matches it but which is not live\'s at that store (no content_digest)', (_row: unknown, store: any) => (store.heals.get(PAGE).contentDigest = null)],
    ['a heal row whose epoch is not the next of the raw bytes\' lineage', (_row: unknown, store: any) => (store.heals.get(PAGE).epoch = 7)],
  ])('%s: nothing is healed from it: try-later and an alert, nothing written', async (_label, tamper: (row: any, store?: any) => unknown) => {
    const { row, store, raw } = await imagelessRow();
    tamper(row, store);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let refused: unknown;
    try {
      await loadStableYdoc(new Y.Doc(), PAGE, raw, store);
    } catch (err) {
      refused = err;
    } finally {
      jest.restoreAllMocks();
    }
    expect(isPageCompactingRefusal(refused)).toBe(true);
    expect(outcomes(error)).toEqual(['image_missing']);
    expect(Buffer.from(row.ydoc!)).toEqual(Buffer.from(raw));
    expect(store.heals.get(PAGE)).toMatchObject({ image: null });
  });

  it('live held a lone surrogate (content shows U+FFFD, its digest matches): the rebuild would replace it, so nothing is healed', async () => {
    const { row, store, raw } = await imagelessRow('\uD800');
    expect(JSON.stringify(row.content)).toContain('\uFFFD'); // storeSafeJson wrote U+FFFD
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let refused: unknown;
    try {
      await loadStableYdoc(new Y.Doc(), PAGE, raw, store);
    } catch (err) {
      refused = err;
    } finally {
      jest.restoreAllMocks();
    }
    expect(isPageCompactingRefusal(refused)).toBe(true);
    expect(outcomes(error)).toEqual(['image_missing']);
    expect(Buffer.from(row.ydoc!)).toEqual(Buffer.from(raw));
  });

  it('a refused rebuild is not rerun for the same row and content: a retrying client costs no conversion and no second failure line', async () => {
    const { row, store, raw } = await imagelessRow();
    (row.content as any).content[0].content[0].text = 'abcdefghXYZ'; // not live's at that store
    const build = jest.spyOn(compaction, 'buildCompacted');
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 3; i++) await expect(loadStableYdoc(new Y.Doc(), PAGE, raw, store)).rejects.toMatchObject({ reason: COLLAB_PAGE_COMPACTING_REASON });
      expect(error.mock.calls.filter((c) => String(c[0]).startsWith('COLLAB_COMPACTION_FAILED ')).length).toBe(1);
      expect(outcomes(error)).toEqual(['image_missing']); // and the divergence line is rate-limited too
      expect(build).not.toHaveBeenCalled(); // refused on the stored digest, before any conversion
      resetContentHealRefusalsForTests(); // the window over (or the row or content changed): it is tried again
      await expect(loadStableYdoc(new Y.Doc(), PAGE, raw, store)).rejects.toMatchObject({ reason: COLLAB_PAGE_COMPACTING_REASON });
      expect(error.mock.calls.filter((c) => String(c[0]).startsWith('COLLAB_COMPACTION_FAILED ')).length).toBe(2);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('a heal row with no image before compaction is armed: try-later (not_armed), nothing rebuilt', async () => {
    const { row, store, raw } = await imagelessRow();
    const read = jest.spyOn(store, 'readContent');
    armed = false;
    let refused: unknown;
    try {
      await loadStableYdoc(new Y.Doc(), PAGE, raw, store);
    } catch (err) {
      refused = err;
    }
    expect(isPageCompactingRefusal(refused)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(Buffer.from(row.ydoc!)).toEqual(Buffer.from(raw));
  });
});

/**
 * The #827 merge: compaction's digest check joins a text run Yjs left split (`textRunsDigest`): the #781 load repair
 * deletes a refused mark's opening format item and leaves its closing one, so `fromYdoc` shows two text nodes where any
 * rebuild (from the tree or through the schema) has one. The heal image and the rebuild from `content` must check the
 * same way, or such a page, once unstable, gets no image at the store and none from `content` at the load: try-later
 * for good. And both heals carry the write-idem ledger through write-idem.ts (a keyed /v1 write applied before the
 * heal still dedups after it).
 */
describe('#840 heals after the #827 merge: split text runs and the write-idem ledger', () => {
  const USER = '00000000-0000-4000-8000-0000000000aa';
  const KEY = scopedWriteKey(USER, 'heal-key');
  const runsOf = (doc: Y.Doc) => compaction.textRunsDigest(storeSafeJson(TiptapTransformer.fromYdoc(doc, 'default')));

  /** S1 on a schema page whose first two letters lost a refused link mark to the load repair (a split run). */
  function splitRunUnstable() {
    const live = TiptapTransformer.toYdoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'abcdefgh' }] }] } as never, 'default', tiptapExtensions);
    const text = (live.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const start = (text as unknown as { _start: Y.Item })._start.id;
    text.format(0, 2, { link: { href: 5 } }); // a stored legacy value the guard refuses
    expect(repairLegacyValues(live).marks).toBeGreaterThan(0);
    Y.applyUpdate(live, rawUpdate([{ client: start.client + 1, clock: 0, structs: [{ origin: [start.client, start.clock + 5], right: [start.client, start.clock + 3], content: new Y.ContentString('XYZ') }] }]));
    live.transact(() => recordWriteKey(live, KEY, 1234));
    live.getXmlFragment('default');
    // preconditions: unstable, a split run, and an exact digest no rebuild can reproduce
    expect(isReloadStable(live).stable).toBe(false);
    const runs = (TiptapTransformer.fromYdoc(live, 'default') as { content: Array<{ content: unknown[] }> }).content[0].content;
    expect(runs.length).toBeGreaterThan(1);
    return live;
  }

  function healedFrom(update: Uint8Array) {
    const doc = loaded(update);
    doc.getXmlFragment('default');
    return doc;
  }

  it('the store builds the heal image of a split-run page, and the load heals from it: same document, ledger kept', async () => {
    const live = splitRunUnstable();
    const row = { ydoc: null as Uint8Array | null };
    const store = memoryHealStore(row);
    const { snapshot, order } = await prepareStore(live, PAGE);
    expect(order.image).not.toBeNull(); // with the exact digest: null (CompactionDigestMismatchError)
    const out = await persistOrderState(store, {}, PAGE, snapshot, order, true);
    expect(out).toMatchObject({ unstable: true, imaged: true });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const doc = new Y.Doc();
    try {
      await loadStableYdoc(doc, PAGE, snapshot.state, store);
      expect(outcomes(warn)).toEqual(['healed']);
    } finally {
      warn.mockRestore();
    }
    expect(isReloadStable(doc).stable).toBe(true);
    expect(runsOf(doc)).toBe(runsOf(live)); // the same ProseMirror document live showed
    expect(isDuplicateWriteKey(doc, KEY)).toBe(true);
    expect(isDuplicateWriteKey(healedFrom(row.ydoc!), KEY)).toBe(true);
  });

  it('a heal row with no image over a split-run page heals from content (healed_from_content), ledger read from the raw bytes', async () => {
    const live = splitRunUnstable();
    const row = { ydoc: null as Uint8Array | null, content: undefined as unknown };
    const store = memoryHealStore(row);
    const prepared = await prepareStore(live, PAGE);
    await persistOrderState(store, {}, PAGE, prepared.snapshot, { ...prepared.order, image: null }, true);
    row.content = JSON.parse(JSON.stringify(prepared.snapshot.json)); // jsonb
    expect(store.heals.get(PAGE)).toMatchObject({ image: null, epoch: 1 });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const doc = new Y.Doc();
    try {
      await loadStableYdoc(doc, PAGE, prepared.snapshot.state, store);
      expect(outcomes(warn)).toEqual(['healed_from_content']);
      expect(outcomes(error)).toEqual([]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
    expect(isReloadStable(doc).stable).toBe(true);
    expect(runsOf(doc)).toBe(runsOf(live));
    expect(lineageEpoch(doc)).toBe(1);
    expect(isDuplicateWriteKey(doc, KEY)).toBe(true);
    expect(store.heals.has(PAGE)).toBe(false);
  });

  it('content that differs only in a split run is still refused when it is not what live showed (the exact digest gates first)', async () => {
    const live = splitRunUnstable();
    const row = { ydoc: null as Uint8Array | null, content: undefined as unknown };
    const store = memoryHealStore(row);
    const prepared = await prepareStore(live, PAGE);
    await persistOrderState(store, {}, PAGE, prepared.snapshot, { ...prepared.order, image: null }, true);
    // the same ProseMirror document with the run joined: textRunsDigest-equal, but not the bytes live's store wrote
    const joined = JSON.parse(JSON.stringify(prepared.snapshot.json));
    const para = joined.content[0];
    para.content = [{ type: 'text', text: para.content.map((n: { text: string }) => n.text).join('') }];
    row.content = joined;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let refused: unknown;
    try {
      await loadStableYdoc(new Y.Doc(), PAGE, prepared.snapshot.state, store);
    } catch (err) {
      refused = err;
    } finally {
      jest.restoreAllMocks();
    }
    expect(isPageCompactingRefusal(refused)).toBe(true);
    expect(outcomes(error)).toEqual(['image_missing']);
  });
});
