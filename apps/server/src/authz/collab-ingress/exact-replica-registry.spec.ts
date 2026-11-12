import * as Y from 'yjs';
import { rawUpdate } from './conflict-scan.testkit';
import { EXACT_REPLICA_CAPS } from './exact-replica';
import {
  attachReplicaLog,
  ensureReplicaLog,
  LOG_OVER_CAP,
  LOG_OUT_OF_ORDER,
  LOG_OVER_TOTAL,
  hasUnappliedFrames,
  mutationGeneration,
  noteAcceptedFrame,
  replicaLogDistrust,
  replicaLogOf,
  replicaLogTotal,
  setReplicaLogTotalForTests,
  settleAcceptedFrames,
} from './exact-replica-registry';
import { strictOrderDiff } from './order-parity';

/**
 * #840 (ADR 0036): the replay log is recorded from live's own events, so it holds live's inputs in live's order: an
 * accepted frame's RAW bytes when live applies it (Hocuspocus 4.7.1's `{ source: 'connection', connection }` origin),
 * and every other transaction's 'update' payload. It stops being trusted whenever it may not rebuild live exactly.
 */
const text = (doc: Y.Doc) => ((doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText);
function page() {
  const base = new Y.Doc();
  base.clientID = 1;
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  base.transact(() => {
    base.getXmlFragment('default').insert(0, [p]);
    p.insert(0, [t]);
    t.insert(0, 'abcdef');
  });
  const bytes = Y.encodeStateAsUpdate(base);
  const live = new Y.Doc();
  Y.applyUpdate(live, bytes);
  attachReplicaLog(live, bytes);
  const first = (t as any)._start.id.clock as number;
  return { live, bytes, first };
}
const connection = () => ({ id: Math.random() });
const fromConnection = (live: Y.Doc, c: object, update: Uint8Array) => Y.applyUpdate(live, update, { source: 'connection', connection: c });
const accept = (live: Y.Doc, c: object, raw: Uint8Array, extra: Partial<Parameters<typeof noteAcceptedFrame>[2]> = {}) =>
  noteAcceptedFrame(live, c, { raw, steps: 1, ...extra });
const exact = (live: Y.Doc) => strictOrderDiff(replicaLogOf(live)!.rebuild({ gc: live.gc }), live);

describe('#840 the replay log, recorded from live', () => {
  it('raw frames at their apply and server updates in between, in live\'s order: the rebuild is live where a reload is not', () => {
    const { live, first } = page();
    const c = connection();
    // S1: 'X' between 'f' (origin) and 'd' (rightOrigin): live "abcXdef", a reload "abcdefX"
    const s1 = rawUpdate([{ client: 2, clock: 0, structs: [{ origin: [1, first + 5], right: [1, first + 3], content: new Y.ContentString('X') }] }]);
    accept(live, c, s1);
    expect(hasUnappliedFrames(live)).toBe(true);
    let local: Uint8Array | null = null;
    live.once('update', (u: Uint8Array) => (local = u));
    live.transact(() => text(live).insert(3, 'Q'), { source: 'local' }); // a server-local write lands first
    fromConnection(live, c, s1);
    expect(hasUnappliedFrames(live)).toBe(false);
    expect(text(live).toString()).toBe('abcQdefX');
    expect(replicaLogOf(live)!.entries).toBe(2);
    expect(exact(live)).toBeNull();
    // control: the same inputs in the order the guard accepted them (the frame first) are not live
    const wrong = new Y.Doc();
    Y.applyUpdate(wrong, page().bytes);
    Y.applyUpdate(wrong, s1);
    Y.applyUpdate(wrong, local!);
    expect(text(wrong).toString()).toBe('abcQXdef');
    expect(mutationGeneration(live)).toBe(2);
  });

  it('a frame with a missing dependency: live emits no update for it; the raw frame is what rebuilds its pending structs', () => {
    const { live } = page();
    const c = connection();
    const waiting = rawUpdate([{ client: 40, clock: 0, structs: [{ origin: [9, 4], right: null, content: new Y.ContentString('w') }] }]);
    const updates: Uint8Array[] = [];
    live.on('update', (u: Uint8Array) => updates.push(u));
    accept(live, c, waiting);
    fromConnection(live, c, waiting);
    expect(updates).toHaveLength(0);
    expect(live.store.pendingStructs).not.toBeNull();
    expect(exact(live)).toBeNull();
  });

  it('a connection transaction with no accepted frame, or an accepted frame never applied, makes it untrusted; attaching again re-arms it', () => {
    const { live } = page();
    const c = connection();
    fromConnection(live, c, rawUpdate([{ client: 3, clock: 0, structs: [{ origin: null, right: null, parent: 'default', content: new Y.ContentType(new Y.XmlElement('paragraph')) as never }] }]));
    expect(replicaLogOf(live)).toBeNull();
    expect(replicaLogDistrust(live)).toBe('connection transaction with no accepted frame');
    attachReplicaLog(live, Y.encodeStateAsUpdate(live)); // a verified checkpoint
    expect(exact(live)).toBeNull();
    accept(live, c, rawUpdate([{ client: 4, clock: 0, structs: [{ origin: null, right: null, parent: 'default', content: new Y.ContentType(new Y.XmlElement('paragraph')) as never }] }]));
    settleAcceptedFrames(live); // the next macrotask: it never applied
    expect(replicaLogDistrust(live)).toBe('accepted frame never applied');
    expect(hasUnappliedFrames(live)).toBe(false);
  });

  it('a transaction an observer opens inside another\'s cleanup makes it untrusted; Yjs\'s own formatting cleanup does not', () => {
    // Yjs's formatting cleanup: a remote frame that formats text over a format boundary (cleanupYTextAfterTransaction)
    const { live } = page();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    peer.clientID = 5;
    const sv = Y.encodeStateVector(live);
    text(peer).format(0, 3, { bold: {} });
    text(peer).format(1, 4, { bold: null });
    text(peer).format(0, 6, { bold: {} });
    const frame = Y.encodeStateAsUpdate(peer, sv);
    let nested = 0;
    live.on('beforeTransaction', () => (live as any)._transactionCleanups.length > 1 && nested++);
    const c = connection();
    accept(live, c, frame);
    fromConnection(live, c, frame);
    expect(nested).toBeGreaterThan(0); // anti-vacuity: the cleanup did nest
    expect(replicaLogDistrust(live)).toBeNull();
    expect(exact(live)).toBeNull();
    // an observer writing to live during a transaction's observer calls (before that transaction's GC and merges)
    live.getXmlFragment('default').observeDeep(() => {
      if (text(live).length < 20) text(live).insert(0, 'o');
    });
    live.transact(() => text(live).insert(0, 'x'), { source: 'local' });
    expect(replicaLogDistrust(live)).toBe('nested transaction');
  });

  it('onApplied gets live\'s CPU ms and wall start; a throwing callback never stops live\'s later listeners', () => {
    const { live } = page();
    let cpu = 100;
    let wall = 5_000;
    const calls: Array<[number, number]> = [];
    const c = connection();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    const sv = Y.encodeStateVector(live);
    text(peer).insert(0, 'p');
    const frame = Y.encodeStateAsUpdate(peer, sv);
    live.on('afterTransaction', () => {
      cpu += 7; // the apply's work
      wall += 7;
    });
    accept(live, c, frame, { clock: () => cpu, wall: () => wall, onApplied: (ms, at) => calls.push([ms, at]) });
    fromConnection(live, c, frame);
    expect(calls).toEqual([[7, 5_000]]);
    const updates: number[] = [];
    live.on('update', () => updates.push(1));
    text(peer).insert(0, 'q');
    const next = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live));
    accept(live, c, next, { clock: () => cpu, onApplied: () => { throw new Error('boom'); } });
    fromConnection(live, c, next);
    expect(updates).toHaveLength(1); // the 'update' listener after it still ran
    expect(replicaLogDistrust(live)).toBe('listener failed');
    expect(text(live).toString()).toBe('qpabcdef');
  });

  it('server writes with no client frame to checkpoint them (a reader open, API writes) never grow it past its caps', () => {
    // Insert-then-delete keeps the page tiny while every logged byte stays: an unbounded log was process memory.
    const { live } = page();
    const MiB = 1024 * 1024;
    let peak = 0;
    for (let i = 0; i < 12; i++) {
      live.transact(() => text(live).insert(0, 'y'.repeat(MiB)), { source: 'local' });
      live.transact(() => text(live).delete(0, MiB), { source: 'local' });
      peak = Math.max(peak, replicaLogOf(live)?.retained ?? 0);
    }
    expect(peak).toBeGreaterThan(MiB); // anti-vacuity: it logged them while it could
    expect(peak).toBeLessThanOrEqual(EXACT_REPLICA_CAPS.maxBytes); // retained, by capacity
    expect(replicaLogOf(live)).toBeNull();
    expect(replicaLogDistrust(live)).toBe(LOG_OVER_CAP);
    attachReplicaLog(live, Y.encodeStateAsUpdate(live)); // a verified checkpoint re-arms it, empty
    expect(replicaLogOf(live)!.bytes).toBe(0);
    expect(exact(live)).toBeNull();
  });

  it('the generation moves only when live\'s encoding can: random honest and crafted frames, empty, re-sent and pending-only ones', () => {
    // The join check's cache key (#840 part 5): a writer's empty SyncStep2 is a transaction too, so a generation counting
    // every transaction re-ran the encode, reload and compare on nearly every join of a reconnect storm.
    let a = 840 >>> 0;
    const r = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const failures: string[] = [];
    const tally = { frames: 0, unmoved: 0, emptyUnmoved: 0, pendingOnly: 0, pendingDs: 0, resends: 0 };
    for (let session = 0; session < 40; session++) {
      const { live, first } = page();
      const peers = [11, 12, 13].map((client) => {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(live));
        doc.clientID = client;
        return { doc, undo: new Y.UndoManager(doc.getXmlFragment('default'), { captureTimeout: 0 }) };
      });
      const sent: Uint8Array[] = [];
      const held: Uint8Array[] = []; // a lagging peer's earlier updates, sent after its later ones
      let craftedClient = 100 + session * 10;
      for (let op = 0; op < 50; op++) {
        const x = r();
        let frame: Uint8Array;
        let kind = 'honest';
        if (x < 0.4) {
          const p = peers[Math.floor(r() * peers.length)];
          Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(live, Y.encodeStateVector(p.doc)), 'remote');
          const sv = Y.encodeStateVector(p.doc);
          const t = text(p.doc);
          const y = r();
          if (y < 0.4 || t.length < 3) t.insert(Math.floor(r() * (t.length + 1)), 'lorem'.slice(0, 1 + Math.floor(r() * 5)));
          else if (y < 0.6) t.delete(Math.floor(r() * (t.length - 1)), 1 + Math.floor(r() * 2));
          else if (y < 0.75) t.format(0, Math.max(1, Math.floor(r() * t.length)), { bold: r() < 0.5 ? {} : null });
          else if (y < 0.88) p.undo.undo();
          else p.undo.redo();
          frame = Y.encodeStateAsUpdate(p.doc, sv);
          if (r() < 0.15) {
            // a lagging peer: this update waits for the next one
            held.push(frame);
            continue;
          }
        } else if (x < 0.55) {
          frame = Y.encodeStateAsUpdate(new Y.Doc()); // an empty Step2: what every writer's reconnect sends
          kind = 'empty';
        } else if (x < 0.7 && sent.length) {
          frame = sent[Math.floor(r() * sent.length)]; // a re-sent frame: known structs, already deleted ranges
          kind = 'resend';
        } else if (x < 0.8) {
          // pending only: a crafted client's later clocks with its earlier ones missing, sometimes released later
          const c = craftedClient++;
          frame = rawUpdate([{ client: c, clock: 1 + Math.floor(r() * 3), structs: [{ origin: [1, first + Math.floor(r() * 5)], right: null, content: new Y.ContentString('p') }] }]);
          if (r() < 0.5) held.push(rawUpdate([{ client: c, clock: 0, structs: [{ origin: [1, first], right: null, content: new Y.ContentString('q') }] }]));
          kind = 'pending';
        } else if (x < 0.86) {
          frame = rawUpdate([], [{ client: 900 + Math.floor(r() * 3), ranges: [[Math.floor(r() * 4), 1 + Math.floor(r() * 3)]] }]); // deletes of unknown items: pendingDs
          kind = 'pendingDs';
        } else if (x < 0.93 && held.length) {
          frame = held.splice(Math.floor(r() * held.length), 1)[0];
        } else {
          // crafted: S1-like items with contradictory origins
          frame = rawUpdate([{ client: craftedClient++, clock: 0, structs: [{ origin: [1, first + 5], right: [1, first + 1 + Math.floor(r() * 3)], content: new Y.ContentString('X') }] }]);
          kind = 'crafted';
        }
        const before = Y.encodeStateAsUpdate(live);
        const generation = mutationGeneration(live);
        const pendingBefore = live.store.pendingStructs;
        const svBefore = Y.encodeStateVector(live);
        Y.applyUpdate(live, frame, 'remote');
        sent.push(frame);
        tally.frames++;
        const after = Y.encodeStateAsUpdate(live);
        if (kind === 'resend') tally.resends++;
        if (kind === 'pending' && Buffer.from(svBefore).equals(Buffer.from(Y.encodeStateVector(live)))) tally.pendingOnly++;
        if (kind === 'pendingDs' && live.store.pendingDs !== null) tally.pendingDs++;
        if (mutationGeneration(live) !== generation) continue;
        tally.unmoved++;
        if (kind === 'empty') tally.emptyUnmoved++;
        if (!Buffer.from(before).equals(Buffer.from(after))) {
          failures.push(`session ${session} op ${op} (${kind}, pending ${pendingBefore ? 'set' : 'none'}): the generation did not move, the encoding did`);
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    // Anti-vacuity: no-op transactions left it alone (an empty Step2 always), and the corpus held pending structs and deletes.
    expect(tally.emptyUnmoved).toBeGreaterThan(tally.frames / 20);
    expect(tally.unmoved).toBeGreaterThan(tally.emptyUnmoved);
    expect(tally.pendingOnly).toBeGreaterThan(50);
    expect(tally.pendingDs).toBeGreaterThan(50);
    expect(tally.resends).toBeGreaterThan(50);
  });

  it('a split Yjs does not merge back (a redone item) changes the encoding with no new clock and no delete: the generation moves', () => {
    const doc = new Y.Doc();
    doc.clientID = 7;
    const t = doc.getText('t');
    const undo = new Y.UndoManager(t, { captureTimeout: 0 });
    t.insert(0, 'abcdef');
    undo.stopCapturing();
    t.delete(0, 6);
    undo.undo(); // the deleted run is redone: its item carries `redone`, and Item.mergeWith refuses to merge it again
    attachReplicaLog(doc, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateAsUpdate(doc);
    const sv = Y.encodeStateVector(doc);
    const generation = mutationGeneration(doc);
    // a re-sent known id whose origin points inside that run: integrate skips it, but reading its origin splits the run
    Y.applyUpdate(doc, rawUpdate([{ client: 7, clock: 0, structs: [{ origin: [7, 2], right: null, content: new Y.ContentString('a') }] }]), 'remote');
    expect(Buffer.from(Y.encodeStateVector(doc)).equals(Buffer.from(sv))).toBe(true);
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(Buffer.from(before))).toBe(false); // anti-vacuity
    expect(mutationGeneration(doc)).toBe(generation + 1);
  });

  it('live applying accepted frames out of the order they were accepted in (across connections) makes it untrusted', () => {
    for (const inOrder of [true, false]) {
      const { live } = page();
      const [c1, c2] = [connection(), connection()];
      const edit = (client: number, s: string) => {
        const peer = new Y.Doc();
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
        peer.clientID = client;
        text(peer).insert(2, s);
        return Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live));
      };
      const [u1, u2] = [edit(21, 'one'), edit(22, 'two')];
      accept(live, c1, u1);
      accept(live, c2, u2);
      if (inOrder) fromConnection(live, c1, u1);
      fromConnection(live, c2, u2);
      if (!inOrder) fromConnection(live, c1, u1);
      expect(replicaLogDistrust(live)).toBe(inOrder ? null : LOG_OUT_OF_ORDER);
      if (inOrder) expect(exact(live)).toBeNull();
    }
  });

  it('one process total across documents: past it the largest logs stop being trusted (their bytes go); a destroyed document releases its share', () => {
    const KiB = 1024;
    const LIMIT = 256 * KiB;
    const restore = setReplicaLogTotalForTests(LIMIT);
    try {
      const docs = Array.from({ length: 12 }, () => page().live);
      let peak = 0;
      let distrusted = 0;
      for (let round = 0; round < 40; round++) {
        docs.forEach((live, i) => {
          // a server write, inserted then deleted: the page stays tiny, the log keeps every byte
          const n = 1 + ((round * 7 + i * 13) % 9) * KiB;
          live.transact(() => text(live).insert(0, 'z'.repeat(n)), { source: 'local' });
          live.transact(() => text(live).delete(0, n), { source: 'local' });
          peak = Math.max(peak, replicaLogTotal());
          if (replicaLogDistrust(live) === LOG_OVER_TOTAL) {
            distrusted++;
            attachReplicaLog(live, Y.encodeStateAsUpdate(live)); // what the guard's next frame does when the reload is stable
            expect(exact(live)).toBeNull();
          }
        });
      }
      expect(distrusted).toBeGreaterThan(10); // anti-vacuity: the total was reached, often
      expect(peak).toBeLessThanOrEqual(LIMIT); // asked before it grows: never past it, not even by one entry
      docs[0].transact(() => text(docs[0]).insert(0, 'h'), { source: 'local' });
      const held = replicaLogOf(docs[0])!.retained;
      expect(held).toBeGreaterThan(0);
      const before = replicaLogTotal();
      docs[0].destroy();
      expect(replicaLogTotal()).toBe(before - held);
      expect(replicaLogOf(docs[0])).toBeNull();
      const rest = docs.slice(1).reduce((n, live) => n + (replicaLogOf(live)?.retained ?? 0), 0);
      for (const live of docs.slice(1)) live.destroy();
      expect(replicaLogTotal()).toBe(before - held - rest); // what other specs' documents still hold
    } finally {
      restore();
    }
  });

  it('the process total counts retained capacity, and an over-cap entry or a re-armed checkpoint frees it', () => {
    const { live } = page();
    const before = replicaLogTotal();
    live.transact(() => text(live).insert(0, 'q'), { source: 'local' });
    const log = replicaLogOf(live)!;
    expect(log.retained).toBeGreaterThan(log.bytes); // capacity, not just what is used
    expect(replicaLogTotal() - before).toBe(log.retained);
    attachReplicaLog(live, Y.encodeStateAsUpdate(live));
    expect(replicaLogTotal()).toBe(before);
    live.transact(() => text(live).insert(0, 'y'.repeat(EXACT_REPLICA_CAPS.maxBytes)), { source: 'local' }); // over its cap at once
    expect(replicaLogDistrust(live)).toBe(LOG_OVER_CAP);
    expect(replicaLogTotal()).toBe(before);
    live.destroy();
  });

  it('a document nobody attached a log to gets one untrusted (the guard\'s fallback)', () => {
    const live = new Y.Doc();
    ensureReplicaLog(live);
    expect(replicaLogOf(live)).toBeNull();
    expect(replicaLogDistrust(live)).toBe('not attached at load');
    attachReplicaLog(live, Y.encodeStateAsUpdate(live));
    expect(exact(live)).toBeNull();
  });
});
