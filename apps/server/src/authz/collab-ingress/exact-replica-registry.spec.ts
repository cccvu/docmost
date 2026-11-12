import * as Y from 'yjs';
import { rawUpdate } from './conflict-scan.testkit';
import { EXACT_REPLICA_CAPS } from './exact-replica';
import {
  attachReplicaLog,
  ensureReplicaLog,
  LOG_OVER_CAP,
  hasUnappliedFrames,
  mutationGeneration,
  noteAcceptedFrame,
  replicaLogDistrust,
  replicaLogOf,
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
      peak = Math.max(peak, replicaLogOf(live)?.bytes ?? 0);
    }
    expect(peak).toBeGreaterThan(MiB); // anti-vacuity: it logged them while it could
    expect(peak).toBeLessThanOrEqual(EXACT_REPLICA_CAPS.maxBytes + MiB + 1024);
    expect(replicaLogOf(live)).toBeNull();
    expect(replicaLogDistrust(live)).toBe(LOG_OVER_CAP);
    attachReplicaLog(live, Y.encodeStateAsUpdate(live)); // a verified checkpoint re-arms it, empty
    expect(replicaLogOf(live)!.bytes).toBe(0);
    expect(exact(live)).toBeNull();
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
