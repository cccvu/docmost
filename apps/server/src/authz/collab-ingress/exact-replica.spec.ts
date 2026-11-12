import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import { copyOf, rawUpdate, type RawClient, type RawId, type RawStruct } from './conflict-scan.testkit';
import { EXACT_REPLICA_CAPS, ExactReplicaLog, tryAdvance } from './exact-replica';
import { strictOrderDiff } from './order-parity';
import { parentConsistencyViolation } from './parent-consistency';

/**
 * #840 (ADR 0036): the exact shadow source. A rebuild replays the checkpoint and live's own inputs (raw client frames,
 * server-local updates) in live's order, and must strict-equal live wherever a reload of live does not. The property
 * fuzz (T2) runs the guard's flow: each frame is applied to the shadow first, refused frames (the parent rule, a wire
 * rule, unresolved structs, or at random as a content refusal) leave the shadow dirty and never reach live, accepted
 * ones apply to live raw; server-local transactions edit live through the Yjs API. Every dirty shadow is rebuilt from
 * the log and compared with live.
 */

const reloadOf = (doc: Y.Doc) => {
  const r = new Y.Doc({ gc: doc.gc });
  Y.applyUpdate(r, Y.encodeStateAsUpdate(doc));
  return r;
};
const chars = (origin: RawId | null, right: RawId | null, s = 'X'): RawStruct => ({ origin, right, content: new Y.ContentString(s) });
const element = (name: string) => new Y.ContentType(new Y.XmlElement(name)) as unknown as RawStruct['content'];
/** client 1 writes "abcdef" as ONE struct in root `text`; S1's frame splits it live and lands on a boundary after a reload. */
const abcdef = () => rawUpdate([{ client: 1, clock: 0, structs: [{ origin: null, right: null, parent: 'text', content: new Y.ContentString('abcdef') }] }]);
const s1Frame = (client: number) => rawUpdate([{ client, clock: 0, structs: [chars([1, 5], [1, 3])] }]);
const loaded = (bytes: Uint8Array, gc = true) => {
  const doc = new Y.Doc({ gc });
  Y.applyUpdate(doc, bytes);
  return doc;
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('#840 ExactReplicaLog: replay, not reload', () => {
  it('S1 then a refused frame: the log rebuilds live, a reload does not', () => {
    const checkpoint = abcdef();
    const live = loaded(checkpoint);
    const log = new ExactReplicaLog(checkpoint);
    const s1 = s1Frame(2);
    Y.applyUpdate(live, s1);
    log.recordFrame(s1, 1);
    expect(live.getText('text').toString()).toBe('abcXdef');
    // a refused frame: never applied to live, never logged; the shadow is rebuilt
    const shadow = log.rebuild();
    expect(shadow.getText('text').toString()).toBe('abcXdef');
    expect(strictOrderDiff(shadow, live)).toBeNull();
    expect(reloadOf(live).getText('text').toString()).toBe('abcdefX'); // the old rebuild
    expect(tryAdvance(log, live)).toBe(false); // unstable: the checkpoint stays
    expect(log.entries).toBe(1);
  });

  it('a checkpoint is the load bytes, even reload-unstable ones (a reload is not idempotent)', () => {
    const prior = loaded(abcdef());
    Y.applyUpdate(prior, s1Frame(2));
    const bytes = Y.encodeStateAsUpdate(prior); // what the store wrote
    const live = loaded(bytes); // what the load built: 'abcdefX'
    expect(live.getText('text').toString()).toBe('abcdefX');
    expect(reloadOf(live).getText('text').toString()).toBe('abcXdef'); // and the next reload flips back
    const log = new ExactReplicaLog(bytes);
    expect(strictOrderDiff(log.rebuild(), live)).toBeNull();
  });

  it('a frame with a missing dependency: the rebuild holds the same pending structs (live emits no update for it)', () => {
    const checkpoint = abcdef();
    const live = loaded(checkpoint);
    const log = new ExactReplicaLog(checkpoint);
    const waiting = rawUpdate([{ client: 40, clock: 0, structs: [chars([9, 4], null)] }]);
    const updates: Uint8Array[] = [];
    live.on('update', (u: Uint8Array) => updates.push(u));
    Y.applyUpdate(live, waiting);
    log.recordFrame(waiting, 1);
    expect(live.store.pendingStructs).not.toBeNull();
    expect(updates).toHaveLength(0); // a mirror of live's 'update' events would never see it
    expect(strictOrderDiff(log.rebuild(), live)).toBeNull();
  });

  it('server-local transactions are logged from live\'s update payload; the packed buffer survives growth', () => {
    const checkpoint = abcdef();
    const live = loaded(checkpoint);
    live.clientID = 7;
    const log = new ExactReplicaLog(checkpoint);
    live.on('update', (u: Uint8Array) => log.recordServerUpdate(u, 1));
    const r = rng(7);
    const t = live.getText('text');
    for (let i = 0; i < 1500; i++) {
      if (r() < 0.8 || t.length < 2) t.insert(Math.floor(r() * (t.length + 1)), 'lorem ipsum '.slice(0, 1 + Math.floor(r() * 12)));
      else t.delete(Math.floor(r() * (t.length - 1)), 1);
    }
    expect(log.entries).toBe(1500); // past the initial 4 KiB buffer
    expect(log.bytes).toBeGreaterThan(4096);
    expect(strictOrderDiff(log.rebuild(), live)).toBeNull();
  });

  it('advance: only a reload-stable live becomes the checkpoint, and the log empties', () => {
    const checkpoint = abcdef();
    const live = loaded(checkpoint);
    const log = new ExactReplicaLog(checkpoint);
    const peer = copyOf(live);
    peer.clientID = 3;
    peer.getText('text').insert(2, 'Q');
    const u = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live));
    Y.applyUpdate(live, u);
    log.recordFrame(u, 1);
    expect([log.entries, log.bytes, log.steps]).toEqual([1, u.length, 1]);
    expect(tryAdvance(log, live)).toBe(true);
    expect([log.entries, log.bytes, log.steps]).toEqual([0, 0, 0]);
    expect(strictOrderDiff(log.rebuild(), live)).toBeNull();
    const s1 = s1Frame(2); // origin 1:5, right 1:3: still 'abcdef' by client 1
    Y.applyUpdate(live, s1);
    log.recordFrame(s1, 1);
    expect(strictOrderDiff(log.rebuild(), live)).toBeNull();
    expect(tryAdvance(log, live)).toBe(false);
    expect(log.entries).toBe(1);
  });

  it('advance and rebuild keep live\'s gc setting (a gc:false live keeps deleted content)', () => {
    const checkpoint = abcdef();
    const live = loaded(checkpoint, false);
    const log = new ExactReplicaLog(checkpoint);
    live.on('update', (u: Uint8Array) => log.recordServerUpdate(u, 1));
    live.getText('text').delete(1, 3);
    expect(strictOrderDiff(log.rebuild({ gc: false }), live)).toBeNull();
    expect(strictOrderDiff(log.rebuild({ gc: true }), live)).toMatchObject({ kind: 'content' });
    expect(tryAdvance(log, live)).toBe(true);
    expect(strictOrderDiff(log.rebuild({ gc: false }), live)).toBeNull();
  });

  it('advance: a reload Yjs throws on is unstable, never a throw out of tryAdvance', () => {
    const checkpoint = abcdef();
    const live = loaded(checkpoint);
    const log = new ExactReplicaLog(checkpoint);
    const s = jest.spyOn(Y, 'applyUpdate').mockImplementationOnce(() => {
      throw new Error('unexpected case'); // what a crafted state's reload can do (Item.gc on a live keyed item)
    });
    try {
      expect(tryAdvance(log, live)).toBe(false);
    } finally {
      s.mockRestore();
    }
    const e = jest.spyOn(Y, 'encodeStateAsUpdate').mockImplementationOnce(() => {
      throw new Error('unexpected case');
    });
    try {
      expect(tryAdvance(log, live)).toBe(false); // nor out of the encode
    } finally {
      e.mockRestore();
    }
    expect(tryAdvance(log, live)).toBe(true);
  });

  it('caps: over at more than maxBytes of RETAINED memory (the buffer capacity) or maxSteps, never at them; the defaults', () => {
    expect(EXACT_REPLICA_CAPS).toEqual({ maxBytes: 8 * 1024 * 1024, maxSteps: 5_000_000 });
    // 6 + 4 bytes of entries, each behind a 4-byte length: 18 retained
    const byBytes = new ExactReplicaLog(new Uint8Array([0, 0]), { maxBytes: 18, maxSteps: 1e9 });
    expect(byBytes.retained).toBe(0); // nothing allocated before the first entry
    byBytes.recordFrame(new Uint8Array(6), 1);
    byBytes.recordServerUpdate(new Uint8Array(4), 1);
    expect([byBytes.bytes, byBytes.retained, byBytes.overCap()]).toEqual([10, 18, false]);
    expect(byBytes.wouldRetain(0, 0)).toBe(Infinity); // one more length does not fit
    byBytes.recordFrame(new Uint8Array(1), 0);
    expect(byBytes.overCap()).toBe(true);
    const bySteps = new ExactReplicaLog(new Uint8Array([0, 0]), { maxBytes: 1e9, maxSteps: 5 });
    bySteps.recordFrame(new Uint8Array(1), 3);
    bySteps.recordServerUpdate(new Uint8Array(1), 2);
    expect([bySteps.steps, bySteps.overCap()]).toEqual([5, false]);
    expect(bySteps.wouldRetain(1, 1)).toBe(Infinity);
    bySteps.recordServerUpdate(new Uint8Array(1), 1);
    expect(bySteps.overCap()).toBe(true);
    bySteps.advance(new Uint8Array([0, 0]));
    expect([bySteps.overCap(), bySteps.retained]).toEqual([false, 0]); // advance frees the buffers
    expect(bySteps.wouldRetain(1, NaN)).toBe(Infinity);
    bySteps.recordFrame(new Uint8Array(1), NaN); // a caller's broken meter fails closed, never under the cap forever
    expect(bySteps.overCap()).toBe(true);
  });

  it('growth never allocates past the cap: a log that fits retains at most maxBytes (no 2x overshoot)', () => {
    const KiB = 1024;
    for (const [cap, entry] of [[EXACT_REPLICA_CAPS.maxBytes, 64 * KiB], [EXACT_REPLICA_CAPS.maxBytes, 100], [100 * KiB, 3 * KiB + 7]] as const) {
      const log = new ExactReplicaLog(new Uint8Array([0, 0]), { maxBytes: cap, maxSteps: 1e12 });
      const u = new Uint8Array(entry);
      let appended = 0;
      for (;;) {
        const after = log.wouldRetain(u.length, 1);
        if (!Number.isFinite(after)) break;
        log.recordFrame(u, 1);
        appended++;
        expect(log.retained).toBe(after); // what it said it would retain
        expect(log.retained).toBeLessThanOrEqual(cap);
        expect(log.overCap()).toBe(false);
      }
      // it filled the cap, not half of it: the buffer grew to the cap instead of doubling past it
      expect(log.bytes + 4 * appended).toBeGreaterThan(cap * 0.75);
      expect(log.retained).toBeLessThanOrEqual(cap);
    }
  });

  it('never merges updates (not live\'s order, and far slower than the replay)', () => {
    const src = readFileSync(join(__dirname, 'exact-replica.ts'), 'utf8');
    expect(src).not.toMatch(/mergeUpdates(V2)?\s*\(/);
  });
});

/**
 * T2: the guard's flow over live, seeded. Crafted frames (hand-encoded V1: random origins and rightOrigins anywhere in
 * a struct, crossing ones, S1 shapes in a root text, keyed attributes, 1–2 client ids per frame, deletes) and honest
 * peers (grouped undo/redo, offline Step2 from a stale state vector, remounts from a reload) against a base written by
 * several clients in runs that never merge; server-local edits on live in between.
 */
type Mode = 'crafted' | 'honest';
type Peer = { doc: Y.Doc; undo: Y.UndoManager; out: Uint8Array[]; inbox: Uint8Array[]; sv: Uint8Array };
const WORDS = ['lorem ', 'ipsum ', 'x', 'é', 'dolor sit '];
const KEYS = ['textAlign', 'level', 'indent'];
const ATTACKERS = [3, 4, 5, 6, 2_000_000_000, 2_000_000_001];
const total = {
  sessions: 0,
  frames: 0,
  accepted: 0,
  refusedThrow: 0,
  refusedParent: 0,
  refusedRule: 0,
  refusedPending: 0,
  refusedRandom: 0,
  pendingAccepted: 0,
  step2: 0,
  remounts: 0,
  peerCrashes: 0,
  serverTx: 0,
  rebuilds: 0,
  reloadMismatch: 0,
  reloadCrash: 0,
  mirrorCrash: 0,
  liveCrash: 0,
  mirrorMismatch: 0,
  advanced: 0,
  advanceRefused: 0,
  maxEntries: 0,
};

function session(seed: number, mode: Mode, ops: number): void {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const gc = r() < 0.8;
  const base = baseBytes(r, mode);
  const live = loaded(base, gc);
  live.clientID = 1_000_000 + Math.floor(r() * 1000);
  const log = new ExactReplicaLog(base);
  const mirrored = new ExactReplicaLog(base); // the rejected design: live's 'update' payloads only (anti-vacuity)
  let shadow = log.rebuild({ gc });
  let dirty = false;
  const peers: Peer[] = [];
  const CONN = Symbol('connection');
  live.on('update', (u: Uint8Array, origin: unknown) => {
    mirrored.recordServerUpdate(u, 1);
    if (!(typeof origin === 'object' && origin !== null && CONN in origin)) {
      total.serverTx++;
      log.recordServerUpdate(u, 1);
      if (!dirty) Y.applyUpdate(shadow, u); // the guard's mirror
    }
    for (const p of peers) if ((origin as { [CONN]?: Peer } | null)?.[CONN] !== p) p.inbox.push(u);
  });

  const check = () => {
    total.rebuilds++;
    const rebuilt = log.rebuild({ gc });
    const d = strictOrderDiff(rebuilt, live);
    if (d) throw new Error(`${mode} seed ${seed}: rebuild != live ${JSON.stringify(d)}`);
    const differs = (make: () => Y.Doc, crash: 'reloadCrash' | 'mirrorCrash') => {
      try {
        return strictOrderDiff(make(), live) !== null;
      } catch {
        total[crash]++; // Yjs throws integrating it: a crafted state's reload can crash a joiner or a restart
        return true;
      }
    };
    if (differs(() => reloadOf(live), 'reloadCrash')) total.reloadMismatch++;
    if (differs(() => mirrored.rebuild({ gc }), 'mirrorCrash')) total.mirrorMismatch++;
    shadow = rebuilt;
    dirty = false;
  };

  const mount = (): Peer => {
    const doc = new Y.Doc();
    doc.clientID = 10_000 + Math.floor(r() * 1_000_000);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(live), 'remote'); // a joiner's Step2 is a reload of live
    const peer: Peer = { doc, undo: new Y.UndoManager(doc.getXmlFragment('default'), { captureTimeout: Infinity }), out: [], inbox: [], sv: Y.encodeStateVector(live) };
    doc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && peer.out.push(u));
    return peer;
  };

  /** The guard's flow for one frame: shadow first, then live (raw) and the log, or a refusal. */
  const submit = (raw: Uint8Array, from: Peer | null): boolean => {
    total.frames++;
    if (dirty) check();
    const pendingBefore = pendingOf(shadow);
    let parent: ReturnType<typeof parentConsistencyViolation> = null;
    let keyedRight = false;
    let steps = 0;
    let threw = false;
    try {
      Y.transact(
        shadow,
        (tr) => {
          Y.applyUpdate(shadow, raw);
          parent = parentConsistencyViolation(tr);
          for (const item of newItems(tr)) {
            steps++;
            if (item.parentSub !== null && item.rightOrigin !== null) keyedRight = true;
          }
        },
        'frame',
        false,
      );
    } catch {
      threw = true; // the guard's `internal` refusal (a crafted keyed chain can make Yjs's GC throw)
    }
    const pendingGrew = pendingOf(shadow) !== pendingBefore;
    // attr-kind and unresolved are let through 30% of the time, to stress the replay; 5% are content refusals
    const refused = threw
      ? 'refusedThrow'
      : parent
        ? 'refusedParent'
        : keyedRight && r() < 0.7
          ? 'refusedRule'
          : pendingGrew && r() < 0.7
            ? 'refusedPending'
            : r() < 0.05
              ? 'refusedRandom'
              : null;
    if (refused) {
      total[refused]++;
      dirty = true;
      if (from) {
        peers.splice(peers.indexOf(from), 1, mount()); // a refused editor goes read-only; it remounts later
        total.remounts++;
      }
      return false;
    }
    if (pendingGrew) total.pendingAccepted++;
    total.accepted++;
    Y.applyUpdate(live, raw, { [CONN]: from });
    log.recordFrame(raw, steps);
    return true;
  };

  const n = mode === 'honest' ? 2 + Math.floor(r() * 3) : 1 + Math.floor(r() * 2);
  for (let i = 0; i < n; i++) peers.push(mount());
  for (let op = 0; op < ops; op++) {
    const y = r();
    const p = pick(peers);
    if (mode === 'crafted' && y < 0.35) submit(crafted(r, live), null);
    else if (y < 0.6) honestEdit(r, p);
    else if (y < 0.8) {
      if (r() < 0.06) {
        // offline: everything unsent as one Step2 against the state vector it last synced with (partly known structs)
        total.step2++;
        const step2 = Y.encodeStateAsUpdate(p.doc, p.sv);
        p.out.length = 0;
        if (submit(step2, p)) p.sv = Y.encodeStateVector(live);
      } else {
        for (const u of p.out.splice(0, 1 + Math.floor(r() * p.out.length))) if (!submit(u, p)) break;
      }
    } else if (y < 0.92) {
      try {
        for (const u of p.inbox.splice(0, 1 + Math.floor(r() * p.inbox.length))) Y.applyUpdate(p.doc, u, 'remote');
      } catch {
        // an accepted crafted frame can crash a lagging peer's Yjs (the plan's separate defect): it remounts
        total.peerCrashes++;
        peers.splice(peers.indexOf(p), 1, mount());
      }
    } else {
      try {
        serverEdit(r, live);
      } catch {
        // Yjs threw in live's own transaction (a crafted state; the plan's separate defect): live is no longer what any
        // input sequence produces, so the session ends here. The guard heals such a document instead.
        total.liveCrash++;
        return;
      }
    }
    if (r() < 0.04 || log.overCap()) {
      if (tryAdvance(log, live)) {
        total.advanced++;
        mirrored.advance(Y.encodeStateAsUpdate(live));
      } else total.advanceRefused++;
    }
    if (op % 40 === 39) check(); // a rebuild of a clean shadow too
    total.maxEntries = Math.max(total.maxEntries, log.entries);
  }
  check();
  total.sessions++;
}

/** The checkpoint: a page by several clients in runs that never merge, a root text, sometimes an S1 already in it. */
function baseBytes(r: () => number, mode: Mode): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const f = doc.getXmlFragment('default');
  f.insert(0, Array.from({ length: 2 + Math.floor(r() * 4) }, () => paragraphOf(WORDS[Math.floor(r() * WORDS.length)])));
  const writers = [11, 12].map((client) => {
    const w = copyOf(doc);
    w.clientID = client;
    return w;
  });
  for (let i = 0; i < 12; i++) {
    const w = writers[i % 2];
    const texts = textsOf(w);
    const t = texts[Math.floor(r() * texts.length)];
    t.insert(Math.floor(r() * (t.length + 1)), 'ab');
    Y.applyUpdate(writers[(i + 1) % 2], Y.encodeStateAsUpdate(w));
  }
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(writers[0]));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(writers[1]));
  Y.applyUpdate(doc, abcdef());
  if (mode === 'crafted' && r() < 0.3) Y.applyUpdate(doc, s1Frame(2)); // stored unstable
  return Y.encodeStateAsUpdate(doc);
}

function paragraphOf(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
}

function textsOf(doc: Y.Doc): Y.XmlText[] {
  const out: Y.XmlText[] = [];
  const visit = (t: Y.XmlFragment | Y.XmlElement) =>
    t.forEach((c) => {
      if (c instanceof Y.XmlText) out.push(c);
      else if (c instanceof Y.XmlElement) visit(c);
    });
  visit(doc.getXmlFragment('default'));
  return out;
}

function containersOf(doc: Y.Doc): Array<Y.XmlFragment | Y.XmlElement> {
  const out: Array<Y.XmlFragment | Y.XmlElement> = [doc.getXmlFragment('default')];
  const visit = (t: Y.XmlFragment | Y.XmlElement) =>
    t.forEach((c) => {
      if (c instanceof Y.XmlElement) {
        out.push(c);
        visit(c);
      }
    });
  visit(doc.getXmlFragment('default'));
  return out;
}

function honestEdit(r: () => number, p: Peer): void {
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const texts = textsOf(p.doc);
  const x = r();
  if (x < 0.35 && texts.length) {
    const t = pick(texts);
    t.insert(Math.floor(r() * (t.length + 1)), pick(WORDS), r() < 0.2 ? { bold: true } : undefined);
  } else if (x < 0.47 && texts.length) {
    const t = pick(texts);
    if (t.length) t.delete(Math.floor(r() * t.length), 1 + Math.floor(r() * 4));
  } else if (x < 0.55 && texts.length) {
    const t = pick(texts);
    if (t.length) t.format(Math.floor(r() * t.length), 1 + Math.floor(r() * 4), { bold: r() < 0.6 ? true : null });
  } else if (x < 0.68) {
    const c = pick(containersOf(p.doc).filter((e) => !(e instanceof Y.XmlElement && e.nodeName === 'paragraph')));
    c.insert(Math.floor(r() * (c.length + 1)), [paragraphOf(pick(WORDS))]);
  } else if (x < 0.74) {
    const f = p.doc.getXmlFragment('default');
    if (f.length > 1) f.delete(Math.floor(r() * f.length), 1);
  } else if (x < 0.82) {
    const els = containersOf(p.doc).filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
    if (els.length) pick(els).setAttribute(pick(KEYS), pick(['left', 'center', 'right']));
  } else if (x < 0.91) p.undo.undo();
  else p.undo.redo();
  if (r() < 0.3) p.undo.stopCapturing();
}

function serverEdit(r: () => number, live: Y.Doc): void {
  const texts = textsOf(live);
  const x = r();
  if (x < 0.5 && texts.length) {
    const t = texts[Math.floor(r() * texts.length)];
    t.insert(Math.floor(r() * (t.length + 1)), 'srv');
  } else if (x < 0.65) {
    const t = live.getText('text');
    if (t.length) t.delete(Math.floor(r() * t.length), 1);
  } else if (x < 0.8) {
    const f = live.getXmlFragment('default');
    f.insert(Math.floor(r() * (f.length + 1)), [paragraphOf('server')]);
  } else {
    const els = containersOf(live).filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
    if (els.length) els[Math.floor(r() * els.length)].setAttribute(KEYS[Math.floor(r() * KEYS.length)], 'srv');
  }
}

/** A hand-encoded frame against live's current structs: 1–2 client ids, 1–3 structs each, sometimes a delete set. */
function crafted(r: () => number, live: Y.Doc): Uint8Array {
  const items: Y.Item[] = [];
  for (const structs of live.store.clients.values()) for (const s of structs) if (s instanceof Y.Item && s.parent instanceof Y.AbstractType) items.push(s);
  const at = (item: Y.Item): RawId => [item.id.client, item.id.clock + Math.floor(r() * item.length)];
  const clients: RawClient[] = [];
  const ids = r() < 0.7 ? [ATTACKERS[Math.floor(r() * ATTACKERS.length)]] : [ATTACKERS[0], ATTACKERS[4]];
  for (const client of ids) {
    const state = Y.getState(live.store, client);
    const y = r();
    // a resend over known clocks (Yjs integrates the tail beside the previous clock: the parent split), or a gap (pending)
    const clock = y < 0.12 ? Math.max(0, state - 1 - Math.floor(r() * 2)) : y < 0.18 ? state + 1 + Math.floor(r() * 2) : state;
    const structs: RawStruct[] = [];
    for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
      const prev: RawId | null = structs.length ? [client, clock + structs.reduce((n, s) => n + s.content.getLength(), 0) - 1] : null;
      const x = r();
      const list = items.filter((i) => i.parentSub === null);
      if (x < 0.65 && list.length) {
        const o = list[Math.floor(r() * list.length)];
        const parent = o.parent as Y.AbstractType<any>;
        const siblings = r() < 0.9 ? list.filter((i) => i.parent === parent) : list; // a foreign right: the parent rule
        const right = r() < 0.2 ? null : at(siblings[Math.floor(r() * siblings.length)]);
        const missing: RawId = [ATTACKERS[Math.floor(r() * ATTACKERS.length)], 1000 + Math.floor(r() * 5)];
        const origin = prev && r() < 0.4 ? prev : r() < 0.05 ? missing : r() < 0.1 ? null : at(o);
        const text = parent instanceof Y.Text && origin !== missing; // XmlText extends Text
        structs.push({ origin, right: origin || right ? right : null, parent: origin || right ? undefined : 'text', content: text || !(origin || right) ? new Y.ContentString('XYZ'.slice(0, 1 + Math.floor(r() * 3))) : element(r() < 0.5 ? 'paragraph' : 'heading') });
      } else {
        const els = items.filter((i) => i.content instanceof Y.ContentType && i.content.type instanceof Y.XmlElement && !i.deleted);
        if (!els.length) continue;
        const el = els[Math.floor(r() * els.length)];
        const key = KEYS[Math.floor(r() * KEYS.length)];
        const chain = items.filter((i) => i.parent === (el.content as Y.ContentType).type && i.parentSub === key);
        const origin = chain.length && r() < 0.7 ? at(chain[Math.floor(r() * chain.length)]) : null;
        const right = chain.length && r() < 0.15 ? at(chain[Math.floor(r() * chain.length)]) : null;
        const values = new Y.ContentAny(Array.from({ length: 1 + Math.floor(r() * 3) }, () => KEYS[Math.floor(r() * 3)]));
        structs.push(origin || right ? { origin, right, content: values } : { origin: null, right: null, parent: [el.id.client, el.id.clock], sub: key, content: values });
      }
    }
    if (structs.length) clients.push({ client, clock, structs });
  }
  const ds =
    r() < 0.15 && items.length
      ? (() => {
          const victim = items[Math.floor(r() * items.length)];
          return [{ client: victim.id.client, ranges: [[victim.id.clock, 1 + Math.floor(r() * victim.length)]] as Array<[number, number]> }];
        })()
      : [];
  return rawUpdate(clients, ds);
}

function* newItems(tr: Y.Transaction): Generator<Y.Item> {
  const store = tr.doc.store;
  for (const [client, structs] of store.clients) {
    const before = tr.beforeState.get(client) ?? 0;
    if (Y.getState(store, client) <= before) continue;
    for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) if (structs[i] instanceof Y.Item) yield structs[i] as Y.Item;
  }
}

function pendingOf(doc: Y.Doc): string {
  const { pendingStructs, pendingDs } = doc.store;
  return `${pendingStructs ? `${[...pendingStructs.missing]}:${pendingStructs.update.length}` : '-'}|${pendingDs?.length ?? '-'}`;
}

describe('#840 T2: a shadow rebuilt from the log strict-equals live (seeded property fuzz)', () => {
  const CRAFTED_SEED = 1000;
  const HONEST_SEEDS = [100000, 500000, 700000];
  const CRAFTED_SESSIONS = 350;
  const HONEST_SESSIONS = 60;
  const OPS = 200;

  it(`crafted (${CRAFTED_SESSIONS} sessions) and honest (${HONEST_SEEDS.length} × ${HONEST_SESSIONS} sessions) × ${OPS} ops: 0 mismatches`, () => {
    for (let s = 0; s < CRAFTED_SESSIONS; s++) session(CRAFTED_SEED + s, 'crafted', OPS);
    const crafted = { ...total };
    for (const seed of HONEST_SEEDS) for (let s = 0; s < HONEST_SESSIONS; s++) session(seed + s, 'honest', OPS);
    console.log(`#840 exact-replica fuzz: ${JSON.stringify({ crafted, all: total })}`);
    // Anti-vacuity: rebuilding by reload, or from live's 'update' payloads, would have been wrong, frames were refused for every reason, the log advanced
    // and also refused to, and accepted frames left live with unresolved structs.
    expect(crafted.reloadMismatch).toBeGreaterThan(50);
    expect(crafted.mirrorMismatch).toBeGreaterThan(50);
    for (const k of ['refusedParent', 'refusedRule', 'refusedPending', 'refusedRandom', 'pendingAccepted', 'advanced', 'advanceRefused'] as const) {
      expect(crafted[k]).toBeGreaterThan(0);
    }
    expect(total.step2 - crafted.step2).toBeGreaterThan(20);
    expect(total.serverTx - crafted.serverTx).toBeGreaterThan(100);
    expect(total.rebuilds).toBeGreaterThan(1000);
  });

  it('rebuild cost grows linearly with the log (logged, not asserted)', () => {
    const times: Record<number, string> = {};
    for (const n of [1000, 2000, 4000, 8000]) {
      const checkpoint = abcdef();
      const author = loaded(checkpoint);
      author.clientID = 9;
      const log = new ExactReplicaLog(checkpoint);
      author.on('update', (u: Uint8Array) => log.recordFrame(u, 1));
      const t = author.getText('text');
      const r = rng(n);
      for (let i = 0; i < n; i++) t.insert(Math.floor(r() * (t.length + 1)), 'w');
      const start = process.hrtime.bigint();
      const rebuilt = log.rebuild();
      times[n] = `${(Number(process.hrtime.bigint() - start) / 1e6).toFixed(1)}ms`;
      expect(strictOrderDiff(rebuilt, author)).toBeNull();
    }
    console.log(`#840 exact-replica rebuild cost by entries: ${JSON.stringify(times)}`);
  });
});
