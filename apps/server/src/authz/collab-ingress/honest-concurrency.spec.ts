import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import { initProseMirrorDoc, updateYFragment } from '@tiptap/y-tiptap';
import { Node as PMNode } from '@tiptap/pm/model';
import { serverSchema } from '../page-write/prelim-content';
import {
  awarenessFrame,
  contentOf,
  cpuTimeDeadline,
  DOC_NAME,
  processCpuMs,
  renderLikeABrowser,
  step1Frame,
  SYNC,
  syncFrame,
} from './collab-ingress.testkit';
import { basePage, blocksOf, encodeStructs, rawUpdate, unguardedSteps, type RawStruct } from './conflict-scan.testkit';
import { ClaimLedger, type OwnerClaim } from './relay-claims';
import { compactionRequest } from '../page-write/compaction-registry';
import { PAGE_MAX_YDOC_BYTES } from '../page-write/page-size';
import { C_MAX, E_MAX } from './doc-bounds';
import { SocketLimitLog } from './socket-limit-log';
import { replicaLogDistrust, replicaLogOf } from './exact-replica-registry';
import { strictOrderDiff } from './order-parity';
import { markRowCovered } from '../page-write/reconcile-store';
import { COLLAB_REFUSAL_CODE, COLLAB_TRY_LATER_CODE, CollabUpdateGuard, UNRESOLVED_REASON, USER_COLLAB_CPU_BURST_MS } from './update-guard';

/**
 * #816 (ADR 0036): honest concurrency never trips the CPU bounds. A seeded corpus of 2–5 peers editing one page
 * concurrently: typing, marks, links, attribute sets, deletes, pastes of up to 1000 paragraphs, y-tiptap
 * (`updateYFragment`) edits, undo and redo, offline runs sent as one Step2 on reconnect, remounts that load the old
 * session's unsent edits (a page's local copy) under a new client id, and latency both ways. Every frame goes through a
 * real CollabUpdateGuard in enforce mode before it applies: zero refusals, zero 1013s, and every peer converges.
 *
 * The CPU budget is charged on the real CPU clock (the worker's own CPU time, `processCpuMs`, and the deadlines decided
 * on it: `cpuTimeDeadline`; a shared CI runner's waits for a core are not the work's cost, #567) while the wall clock
 * is simulated (200 ms per op, slower than people type in bursts, faster than they type on average), so the corpus
 * also shows how far an honest session stays from the debt: the lowest balance any user reached is asserted with a
 * wide margin (ADR 0036 §6).
 */
const schema = serverSchema();
const SEEDS = 8;
const OPS = 600;
/** What the corpus exercised, summed over its seeds (anti-vacuity). */
const seen = { frames: 0, step2: 0, remounts: 0, ytiptap: 0, undo: 0, pastes: 0, offline: 0 };
/**
 * No astral characters: positions here are random UTF-16 offsets, and a split inside a surrogate pair makes Yjs write
 * U+FFFD on one replica and not the other (a Yjs property, guard or no guard). Editors place positions on code points.
 */
const WORDS = ['lorem ', 'ipsum ', 'dolor ', 'sit ', 'amet ', 'x', 'é', 'the quick brown fox '];

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

type Conn = { readOnly: boolean; webSocket: { close: () => void }; context: { user: { id: string } } };
type Peer = { user: string; doc: Y.Doc; conn: Conn; out: Uint8Array[]; inbox: Uint8Array[]; offline: number; undo: Y.UndoManager };

function harness(seed: number) {
  const r = rng(seed);
  let now = 1_000_000;
  const live = new Y.Doc() as Y.Doc & { name: string; awareness: { meta: Map<number, { clock: number }> } };
  live.name = DOC_NAME;
  live.awareness = { meta: new Map() };
  const refusals: string[] = [];
  const guard = new CollabUpdateGuard({
    mode: 'enforce',
    logger: { warn: (m: string) => refusals.push(m) },
    limitLog: new SocketLimitLog({ warn: (m: string) => refusals.push(m) }),
    now: () => now,
    cpuNow: processCpuMs,
    runWithDeadline: cpuTimeDeadline(),
  });
  const peers: Peer[] = [];
  const results = { frames: 0, refused: [] as string[], lowestBalance: Infinity };

  /** A frame through the guard, then applied as Hocuspocus applies it. */
  const deliver = (peer: Peer, frame: Uint8Array, apply?: () => void): boolean => {
    results.frames++;
    try {
      guard.check({ connection: peer.conn, document: live, update: frame, context: peer.conn.context });
    } catch (err: any) {
      results.refused.push(`${err?.code === COLLAB_TRY_LATER_CODE ? '1013' : err?.code === COLLAB_REFUSAL_CODE ? '4422' : '?'} ${err?.reason}`);
      return false;
    }
    results.lowestBalance = Math.min(results.lowestBalance, guard.cpuBalance(peer.user));
    apply?.();
    return true;
  };
  const sendUpdate = (peer: Peer, update: Uint8Array, subtype: number = SYNC.Update) => {
    if (subtype === SYNC.Step2) seen.step2++;
    // #840: 4.7.1's origin for a client frame (the replay log reads it)
    return deliver(peer, syncFrame(update, subtype), () => Y.applyUpdate(live, update, { source: 'connection', connection: peer.conn }));
  };

  live.on('update', (u: Uint8Array, origin: unknown) => {
    const from = (origin as { connection?: unknown } | null)?.connection;
    for (const p of peers) if (p.conn !== from && r() < 0.9) p.inbox.push(u); // broadcast, delivered late
  });

  /** A provider (re)connecting: its awareness, a Step1, then a Step2 with everything the server lacks. */
  const connect = (peer: Peer) => {
    peer.conn = { readOnly: false, webSocket: { close: () => undefined }, context: { user: { id: peer.user } } };
    const clock = (live.awareness.meta.get(peer.doc.clientID)?.clock ?? 0) + 1;
    deliver(peer, awarenessFrame([{ clientID: peer.doc.clientID, clock, state: { user: { name: peer.user } } }]), () =>
      live.awareness.meta.set(peer.doc.clientID, { clock }),
    );
    deliver(peer, step1Frame(peer.doc));
    const missing = Y.encodeStateAsUpdate(peer.doc, Y.encodeStateVector(live));
    if (Y.parseUpdateMeta(missing).to.size || Y.decodeUpdate(missing).ds.clients.size) sendUpdate(peer, missing, SYNC.Step2);
    peer.out.length = 0; // the Step2 carried them
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(live, Y.encodeStateVector(peer.doc)), 'remote');
    peer.inbox.length = 0;
  };

  /** A page mount: a fresh Y.Doc (a new client id) loaded from its local copy, which may hold an older session's edits. */
  const mount = (user: string, localCopy?: Y.Doc): Peer => {
    if (localCopy) seen.remounts++;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(localCopy ?? live), 'remote');
    const peer: Peer = { user, doc, conn: null as never, out: [], inbox: [], offline: 0, undo: new Y.UndoManager(doc.getXmlFragment('default'), { captureTimeout: 0 }) };
    doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') peer.out.push(u);
    });
    connect(peer);
    return peer;
  };

  return { r, live, guard, peers, results, refusals, deliver, sendUpdate, connect, mount, tick: (ms: number) => (now += ms) };
}

const paragraph = (r: () => number, words: number): Y.XmlElement => {
  const heading = r() < 0.1;
  const p = new Y.XmlElement(heading ? 'heading' : 'paragraph');
  if (heading) p.setAttribute('level', (1 + Math.floor(r() * 3)) as never);
  if (r() < 0.3) p.setAttribute('textAlign', 'center');
  const t = new Y.XmlText();
  p.insert(0, [t]);
  let at = 0;
  for (let w = 0; w < words; w++) {
    const s = WORDS[Math.floor(r() * WORDS.length)];
    const x = r();
    t.insert(at, s, x < 0.25 ? { bold: {} } : x < 0.35 ? { italic: {}, link: { href: 'https://example.com/a' } } : {});
    at += s.length;
  }
  return p;
};
const texts = (f: Y.XmlFragment): Y.XmlText[] => {
  const out: Y.XmlText[] = [];
  f.forEach((el) => el instanceof Y.XmlElement && el.forEach((c) => c instanceof Y.XmlText && out.push(c)));
  return out;
};

/** One random honest edit on `peer`'s replica (one transaction, as an editor makes). */
function edit(r: () => number, peer: Peer): void {
  const d = peer.doc;
  const f = d.getXmlFragment('default');
  const ts = texts(f);
  const x = r();
  if (x < 0.02) {
    // a y-tiptap edit: the editor's own binding writes a changed ProseMirror document back
    const { doc: pm, meta } = initProseMirrorDoc(f, schema);
    const json = pm.toJSON() as { content?: Array<{ type: string; content?: unknown[] }> };
    const content = json.content ?? [];
    const at = Math.floor(r() * (content.length + 1));
    if (r() < 0.5) content.splice(at, 0, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] });
    else if (content.length) content.splice(Math.min(at, content.length - 1), 1, { type: 'paragraph', content: [{ type: 'text', text: 'rewritten', marks: [{ type: 'bold' }] }] });
    json.content = content.length ? content : [{ type: 'paragraph' }];
    d.transact(() => updateYFragment(d, f, PMNode.fromJSON(schema, json), meta as never));
    seen.ytiptap++;
    return;
  }
  if (x < 0.06) {
    const stack = r() < 0.5 ? peer.undo.undoStack : peer.undo.redoStack;
    if (!stack.length) return;
    if (stack === peer.undo.undoStack) peer.undo.undo();
    else peer.undo.redo();
    seen.undo++;
    return;
  }
  d.transact(() => {
    if (x < 0.45 && ts.length) {
      const t = ts[Math.floor(r() * ts.length)];
      t.insert(Math.floor(r() * (t.length + 1)), WORDS[Math.floor(r() * WORDS.length)], r() < 0.2 ? { bold: {} } : undefined);
    } else if (x < 0.58 && ts.length) {
      const t = ts[Math.floor(r() * ts.length)];
      if (t.length) {
        const at = Math.floor(r() * t.length);
        t.delete(at, Math.min(t.length - at, r() < 0.8 ? 1 : 1 + Math.floor(r() * 20)));
      }
    } else if (x < 0.68 && ts.length) {
      const t = ts[Math.floor(r() * ts.length)];
      if (t.length) {
        const at = Math.floor(r() * t.length);
        t.format(at, Math.min(t.length - at, 1 + Math.floor(r() * 15)), { [r() < 0.5 ? 'bold' : 'italic']: r() < 0.7 ? {} : null });
      }
    } else if (x < 0.74 && f.length) {
      const el = f.get(Math.floor(r() * f.length));
      if (el instanceof Y.XmlElement) el.setAttribute('textAlign', ['left', 'center', 'right'][Math.floor(r() * 3)]);
    } else if (x < 0.79 && f.length > 2) {
      const at = Math.floor(r() * f.length);
      f.delete(at, Math.min(f.length - at, 1 + Math.floor(r() * 30)));
    } else if (x < 0.795) {
      seen.pastes++;
      f.insert(Math.floor(r() * (f.length + 1)), Array.from({ length: 200 + Math.floor(r() * 801) }, () => paragraph(r, 1 + Math.floor(r() * 10)))); // a paste
    } else if (x < 0.84) {
      f.insert(Math.floor(r() * (f.length + 1)), Array.from({ length: 1 + Math.floor(r() * 20) }, () => paragraph(r, 3)));
    }
  });
}

function runSeed(seed: number) {
  const h = harness(seed);
  const { r } = h;
  // a busy page to start from
  const seedDoc = new Y.Doc();
  seedDoc.transact(() => seedDoc.getXmlFragment('default').insert(0, Array.from({ length: 150 }, () => paragraph(r, 1 + Math.floor(r() * 12)))));
  Y.applyUpdate(h.live, Y.encodeStateAsUpdate(seedDoc));
  const n = 2 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) h.peers.push(h.mount(`user-${i}`));
  for (let op = 0; op < OPS; op++) {
    h.tick(200);
    const i = Math.floor(r() * h.peers.length);
    const peer = h.peers[i];
    edit(r, peer);
    if (!peer.offline && r() < 0.01) {
      peer.offline = 1 + Math.floor(r() * 300); // goes offline, keeps editing
      seen.offline++;
    }
    if (peer.offline) {
      if (--peer.offline === 0) {
        h.tick(1_000);
        if (r() < 0.5) h.connect(peer); // the socket comes back: Step2 of everything unsent
        else h.peers[i] = h.mount(peer.user, peer.doc); // a remount: a new id, the old session's edits from its local copy
      }
    } else if (peer.out.length && r() < 0.6) {
      for (const u of peer.out.splice(0)) h.sendUpdate(peer, u); // the provider sends each update as its own frame
    }
    for (const p of h.peers) {
      if (p.offline || !p.inbox.length || r() < 0.5) continue;
      for (const u of p.inbox.splice(0)) Y.applyUpdate(p.doc, u, 'remote'); // late broadcasts, edited over meanwhile
    }
    if (r() < 0.003) {
      const j = Math.floor(r() * h.peers.length);
      if (!h.peers[j].offline) h.peers[j] = h.mount(h.peers[j].user, h.peers[j].doc); // a reload
    }
  }
  for (const p of h.peers) {
    p.offline = 0;
    if (p.out.length) h.connect(p);
  }
  for (const p of h.peers) Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(h.live, Y.encodeStateVector(p.doc)), 'remote');
  return h;
}

describe('#816 honest concurrency never meets the CPU bounds', () => {
  it(`${SEEDS} seeded sessions of 2–5 concurrent editors: every frame accepted, every peer converges`, () => {
    let lowest = Infinity;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const h = runSeed(seed);
      seen.frames += h.results.frames;
      lowest = Math.min(lowest, h.results.lowestBalance);
      expect({ seed, refused: h.results.refused }).toEqual({ seed, refused: [] });
      expect(h.refusals.filter((l) => !l.startsWith('COLLAB_STORED_CONTENT_INVALID'))).toEqual([]);
      const expected = contentOf(h.live);
      for (const p of h.peers) expect(contentOf(p.doc)).toEqual(expected);
      expect(renderLikeABrowser(h.live)).toMatchObject({ deleted: false, threw: false });
      // #840: the replay log stayed exact and trusted through the session, and no honest editor became a suspect
      expect({ seed, distrust: replicaLogDistrust(h.live), suspects: h.guard.suspectsOf(h.live) }).toEqual({ seed, distrust: null, suspects: [] });
      expect(strictOrderDiff(replicaLogOf(h.live)!.rebuild({ gc: h.live.gc }), h.live)).toBeNull();
    }
    // anti-vacuity: the corpus really sent frames of every kind it claims
    if (process.env.CONFLICT_SCAN_TALLY) console.log(JSON.stringify({ ...seen, lowest }));
    // the CPU budget: no honest session came near the debt (a wide margin, so a slow CI runner stays far from it)
    expect(lowest).toBeGreaterThan(USER_COLLAB_CPU_BURST_MS / 2);
    expect(seen.frames).toBeGreaterThan(SEEDS * 200);
    for (const n of Object.values(seen)) expect(n).toBeGreaterThan(0);
  });

  it('the worst honest cases: an offline run typed where another editor pasted, a Step2 carrying several offline sessions', () => {
    const h = harness(4242);
    const seedDoc = new Y.Doc();
    seedDoc.transact(() => seedDoc.getXmlFragment('default').insert(0, Array.from({ length: 50 }, () => paragraph(h.r, 4))));
    Y.applyUpdate(h.live, Y.encodeStateAsUpdate(seedDoc));
    // B goes offline (a HIGHER client id than A, so each of its items walks past everything A inserted at the spot)
    const a = h.mount('user-a');
    const b = h.mount('user-b');
    b.doc.clientID = a.doc.clientID + 1_000_000;
    h.connect(b);
    // A pastes 2000 paragraphs at paragraph 25 and sends it
    a.doc.transact(() => a.doc.getXmlFragment('default').insert(25, Array.from({ length: 2000 }, () => paragraph(h.r, 6))));
    expect(h.sendUpdate(a, Y.mergeUpdates(a.out.splice(0)))).toBe(true);
    // meanwhile B, offline, typed 500 edits at that same spot; it reconnects with one Step2
    for (let k = 0; k < 500; k++) {
      const f = b.doc.getXmlFragment('default');
      b.doc.transact(() => {
        if (h.r() < 0.5) f.insert(25 + Math.floor(h.r() * 3), [paragraph(h.r, 2)]);
        else {
          const t = (f.get(25 + Math.floor(h.r() * 3)) as Y.XmlElement).get(0) as Y.XmlText;
          t.insert(Math.floor(h.r() * (t.length + 1)), 'ab', h.r() < 0.3 ? { bold: {} } : undefined);
        }
      });
    }
    const offline = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(h.live));
    const steps = unguardedSteps(h.live, offline);
    expect(steps).toBeGreaterThan(100_000); // the largest honest walk the step-0 bench found (176k): this corpus has it
    expect(h.sendUpdate(b, offline, SYNC.Step2)).toBe(true);
    // C reloads the page four times while offline: each mount a new client id over the last one's local copy, then
    // one Step2 carries all of them (the current id is announced by its awareness, the others are new to the page)
    let c = h.mount('user-c');
    for (let session = 0; session < 4; session++) {
      const next = new Y.Doc();
      Y.applyUpdate(next, Y.encodeStateAsUpdate(c.doc), 'remote');
      next.getXmlFragment('default').insert(0, [paragraph(h.r, 3)]);
      c = { ...c, doc: next };
    }
    h.connect(c);
    expect(Y.decodeStateVector(Y.encodeStateVector(c.doc)).size - Y.decodeStateVector(Y.encodeStateVector(seedDoc)).size).toBeGreaterThan(4);
    expect(h.results.refused).toEqual([]);
    if (process.env.CONFLICT_SCAN_TALLY) console.log(JSON.stringify({ worstLowest: h.results.lowestBalance }));
    // a 2000-paragraph paste, then a 176k-step Step2: never in debt. Real CPU clock: measured ~1,590 of 2,000 ms left on
    // the dev box (~4.7x headroom); a runner that much slower would fail here, which is the signal to re-measure.
    expect(h.results.lowestBalance).toBeGreaterThan(0);
    expect(contentOf(h.live)).toEqual(contentOf(c.doc));
  });

  it('anti-vacuity: in the same harness, one adversarial peer is refused conflict-scan', () => {
    const h = runSeed(SEEDS + 1);
    const t = texts(h.live.getXmlFragment('default')).find((x) => x.length >= 2)!;
    const first = (t as any)._start as Y.Item;
    const O: [number, number] = [first.id.client, first.id.clock];
    const R: [number, number] = [first.id.client, first.id.clock + 1];
    const at = (): RawStruct => ({ origin: O, right: R, content: new Y.ContentString('x') });
    const attacker = h.mount('attacker');
    expect(h.sendUpdate(attacker, rawUpdate([{ client: 900_001, clock: 0, structs: Array.from({ length: 1100 }, at) }]))).toBe(true);
    expect(h.sendUpdate(attacker, rawUpdate([{ client: 900_002, clock: 0, structs: Array.from({ length: 1100 }, at) }]))).toBe(false);
    expect(h.results.refused).toEqual(['4422 ccc:collab-update-refused:conflict-scan']);
  });
});

/**
 * #827 (ADR 0036): honest work at the per-page caps, through a guard with the PRODUCTION bounds (doc-bounds.ts: the
 * frame deadline, the struct, client-id and children caps, the frame cap): never refused, never closed 1013, never a
 * drain. Compaction may be requested past a soft cap (for the next unload), never forced on a session.
 */
describe('#827 honest work at the caps is never refused', () => {
  type Live = Y.Doc & { name: string; getConnections: () => unknown[] };
  function caps(seed?: Y.Doc) {
    const live = new Y.Doc() as Live;
    live.name = DOC_NAME;
    live.getConnections = () => [];
    if (seed) Y.applyUpdate(live, Y.encodeStateAsUpdate(seed));
    markRowCovered(live, Y.encodeStateAsUpdate(live)); // a stored row the unload can compact
    const lines: string[] = [];
    // The production bounds, held in CPU time (the worker's own: a busy CI runner's waits are not the frame's cost)
    const guard = new CollabUpdateGuard({
      mode: 'enforce',
      logger: { warn: (m: string) => lines.push(m) },
      limitLog: new SocketLimitLog({ warn: (m: string) => lines.push(m) }),
      cpuNow: processCpuMs,
      runWithDeadline: cpuTimeDeadline(),
    });
    const conn = (id: string): Conn => ({ readOnly: false, webSocket: { close: () => undefined }, context: { user: { id } } });
    const send = (c: Conn, update: Uint8Array, subtype: number = SYNC.Update): string => {
      try {
        guard.check({ connection: c, document: live, update: syncFrame(update, subtype), context: c.context });
      } catch (err: any) {
        // the guard's own log line names the rule or limit (a 1013 reason is shared by several limits)
        return `${err?.code} ${err?.reason}${lines.length ? ` [${lines[lines.length - 1]}]` : ''}`;
      }
      Y.applyUpdate(live, update, { source: 'connection', connection: c });
      return 'applied';
    };
    const drained = () => compactionRequest(live)?.drain === true;
    return { live, guard, lines, conn, send, drained };
  }
  /** `n` paragraphs of `chars` characters, one bold word each: what a paste of real prose looks like. */
  function prose(n: number, chars: number): Y.XmlElement[] {
    return Array.from({ length: n }, (_, i) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, `${i} `.padEnd(chars, 'lorem ipsum dolor sit amet '));
      t.format(2, 5, { bold: {} });
      return p;
    });
  }
  const paste = (live: Y.Doc, client: number, els: () => Y.XmlElement[]) => {
    const r = new Y.Doc();
    Y.applyUpdate(r, Y.encodeStateAsUpdate(live));
    r.clientID = client;
    r.transact(() => r.getXmlFragment('default').insert(0, els()));
    return Y.encodeStateAsUpdate(r, Y.encodeStateVector(live));
  };

  it('a paste just under the frame cap (prose, 600-character paragraphs, under E_MAX) is accepted', () => {
    const s = caps();
    const update = paste(s.live, 4242, () => prose(4_400, 600));
    expect(update.length).toBeGreaterThan(2.5 * 1024 * 1024);
    expect(update.length).toBeLessThanOrEqual(PAGE_MAX_YDOC_BYTES);
    expect(s.send(s.conn('a'), update)).toBe('applied');
    expect(s.drained()).toBe(false);
  });

  it('a select-all delete of a page at the children cap is accepted, and so is an API replace of it (mirrored)', () => {
    const seed = new Y.Doc();
    seed.transact(() => seed.getXmlFragment('default').insert(0, prose(E_MAX, 40)));
    const s = caps(seed);
    const r = new Y.Doc();
    Y.applyUpdate(r, Y.encodeStateAsUpdate(s.live));
    r.clientID = 777;
    r.transact(() => r.getXmlFragment('default').delete(0, E_MAX));
    expect(s.send(s.conn('a'), Y.encodeStateAsUpdate(r, Y.encodeStateVector(s.live)))).toBe('applied');
    // the API's replace: a server-local transaction, mirrored into the shadow under its own deadline
    s.live.transact(() => {
      const f = s.live.getXmlFragment('default');
      f.delete(0, f.length);
      f.insert(0, prose(E_MAX - 1, 40));
    }, { source: 'local' });
    expect(s.guard.shadowOf(s.live)).not.toBeNull(); // mirrored in time
    // the shadow still serves (another editor: on a slow core the select-all alone is about a CPU burst for its sender,
    // whose next frame then waits on the debt with a retryable 1013; nothing is lost)
    expect(s.send(s.conn('b'), paste(s.live, 778, () => prose(1, 10)))).toBe('applied');
    expect(s.drained()).toBe(false);
  });

  it('typing on a page holding C_MAX client ids is accepted (compaction only requested, for the next unload)', () => {
    const b = basePage('hello');
    const clients = Array.from({ length: C_MAX - 2 }, (_, i) => ({
      client: 10_000 + i,
      clock: 0,
      structs: [{ origin: i === 0 ? ([1, b.first + 4] as [number, number]) : ([10_000 + i - 1, 0] as [number, number]), right: null, content: new Y.ContentString('c') }],
    }));
    Y.applyUpdate(b.doc, rawUpdate(clients));
    const s = caps(b.doc);
    expect(s.live.store.clients.size).toBe(C_MAX - 1);
    const typist = new Y.Doc();
    Y.applyUpdate(typist, Y.encodeStateAsUpdate(s.live));
    typist.clientID = 99_999_999;
    const t = (typist.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    for (let k = 0; k < 20; k++) {
      const sv = Y.encodeStateVector(s.live);
      t.insert(k, 'x');
      expect(s.send(s.conn('typist'), Y.encodeStateAsUpdate(typist, sv))).toBe('applied');
    }
    expect(s.live.store.clients.size).toBe(C_MAX);
    expect(compactionRequest(s.live)).toMatchObject({ reason: 'client_ids', drain: false });
  });
});

/**
 * #781 lineage, #842 (ADR 0036 §4): a lifetime that lost its editors' last edits (the process died inside the store
 * debounce) gets them back from whichever browser resends them first: the author's own Step2, or a peer's that the dead
 * lifetime relayed them to. Lifetime 1 runs unguarded (it is not under test) with debounced stores at random points;
 * then the crash, edits typed while disconnected, and reloads over the local copy (a new client id). Lifetime 2 is
 * guarded, and each provider's connect is split as 4.7.1 sends it: Auth, Step1 and its own awareness on a jittered
 * reconnect, then its Step2 one round trip later (an answer to the server's Step1). Between events the next macrotask
 * runs, so the guard clears its in-flight frames as it does on the real server, and its probe timer runs on the
 * simulated clock.
 *
 * The client's rule is modelled (apps/client features/editor-ux/collab-access.ts, COLLAB_UNRESOLVED_RETRY_MS, pinned
 * below): an `unresolved` close is retried 6 times since the last landing, the first at once and then after 0.5, 1, 2,
 * 4 and 8 s, each jittered to half to all of it (its own RNG); the 7th is final. Each retry is a new Auth one round trip
 * after the close. "Today" is the guard with no owner claims (a ledger with no room: every claim is `full`) and the
 * client's one immediate retry before #842.
 *
 * Variants (`CRASH_VARIANTS`): a Y.UndoManager per mount, as every browser has (y-tiptap's yUndoPlugin), which keeps the
 * items its user deletes, so a relayer's copy of an owner's deleted text can differ from the owner's (the corpus without
 * one cannot see that); round trips of 30–400 ms; stress (2–6 editors, deletes of up to 6 characters, paragraph deletes,
 * fewer stores, reconnects within 150 ms); and "+moves", where a quarter of the edits move content in ONE transaction
 * (typing over a selection, a paragraph drag, a cut pasted into another paragraph), so a transaction both deletes and
 * inserts. Moves and jitter draw from their own RNGs: the base corpus is the one #781 measured (today: 49 of 347 blocked).
 *
 * Properties, in every variant: every editor lands or is final; every landed editor's edits (its own and those it was
 * relayed) are in live and it converges; live renders; and the ATOMICITY ORACLE holds: each local transaction of
 * lifetime 1 is all or none in live after every lifetime-2 mutation (`AtomicityOracle`), so no landing ever applies half
 * of a user's edit (a move's delete without its re-insert). Blocked editors: none in the base, UndoManager, wide and
 * base+moves corpora; under stress, and with moves at wide round trips, a bounded residual (`blocked`), each member
 * final on an unprovable copy (`unprovableResidual`). The owner-claim guess budget costs honest recovery nothing: the
 * corpus with it disabled blocks exactly the same editors.
 *
 * Measured (CONFLICT_SCAN_TALLY prints CRASH_CORPUS_TALLY lines), blocked editors today → now: base and UndoManager
 * 49/347 → 0, wide 122/347 → 0, stress 334/463 → 5, stress+undo 334/463 → 16, base+moves 79/347 → 0, wide+moves
 * 137/347 → 12, stress+moves 320/463 → 101; 0 split transactions everywhere. Moves raise the residual: a move deletes
 * (a whole paragraph, for a drag), so a relayer's copy more often lacks a delete its owner received (R5) or holds as a
 * kept item what the owner's replica garbage-collected (R6).
 */
const CRASH_SEEDS = 120;
/** The client's schedule (collab-access.ts COLLAB_UNRESOLVED_RETRY_MS: parity pinned below), and today's (#781). */
const UNRESOLVED_RETRY_MS: readonly number[] = [0, 500, 1_000, 2_000, 4_000, 8_000];
const TODAY_RETRY_MS: readonly number[] = [0];

type CrashVariant = {
  name: string;
  undo: boolean;
  wide: boolean;
  stress: boolean;
  moves: boolean;
  /** `none`: no editor ends blocked. A number: at most this share of the editors (about twice what was measured), each
   *  one `unprovableResidual`. */
  blocked: 'none' | number;
};
const CRASH_VARIANTS: CrashVariant[] = [
  { name: 'base', undo: false, wide: false, stress: false, moves: false, blocked: 'none' },
  { name: 'undo', undo: true, wide: false, stress: false, moves: false, blocked: 'none' },
  { name: 'wide', undo: true, wide: true, stress: false, moves: false, blocked: 'none' },
  { name: 'stress', undo: false, wide: false, stress: true, moves: false, blocked: 0.03 },
  { name: 'stress+undo', undo: true, wide: false, stress: true, moves: false, blocked: 0.06 },
  { name: 'base+moves', undo: true, wide: false, stress: false, moves: true, blocked: 'none' },
  { name: 'wide+moves', undo: true, wide: true, stress: false, moves: true, blocked: 0.05 },
  { name: 'stress+moves', undo: true, wide: false, stress: true, moves: true, blocked: 0.25 },
];
type CrashMode = 'today' | 'now' | 'no-budget';

type CrashPeer = {
  user: string;
  doc: Y.Doc;
  ownIds: Set<number>;
  outbox: Uint8Array[];
  inbox: Uint8Array[];
  rtt: number;
  clock: number;
  /** `unresolved` closes since its last landing (the client's counter, reset by sync-acked), and retries in all. */
  unresolved: number;
  retries: number;
  landed: boolean;
  terminal: string | null;
  /** #842: the owner-claim word of its final refusal. */
  claim?: string;
  /** #842: its final frame carries a copy of a blocker's structs that differs from the blocker's own where no rule can
   *  prove it (`unprovableCopy`). */
  unprovable: boolean;
  blockers: CrashPeer[];
};

/**
 * The residual, documented (ADR 0036 #842): final `unresolved` at stage `unproven-owner`, with the claim word
 * `mismatch` / `burned` (its copy was compared with the owner's claim and differs) or `uncovered` (it carries clocks the
 * claim does not), AND its copy of some blocker's structs really is unprovable: at a clock the blocker's own copy holds
 * differently, other than the relay having deleted it (R4), e.g. text the owner deleted still live in the copy (R5), a
 * GC on either side (R6), or a clock the owner does not hold (R2). Never a forgery: it falls back to today's answer.
 */
const unprovableResidual = (p: CrashPeer): boolean =>
  p.terminal === `${COLLAB_REFUSAL_CODE} ${UNRESOLVED_REASON} (unproven-owner)` &&
  (p.claim === 'mismatch' || p.claim === 'burned' || p.claim === 'uncovered') &&
  p.unprovable;

/** A light honest edit (lifetime 1 and the outage): typing, a short delete, a new paragraph; stress: longer deletes and
 *  paragraph deletes; +moves: a quarter of them one-transaction moves (their own RNG, `m`). */
function crashEdit(r: () => number, d: Y.Doc, v: CrashVariant, m: () => number): void {
  if (v.moves && m() < 0.25) return moveEdit(m, d);
  const f = d.getXmlFragment('default');
  const ts = texts(f);
  d.transact(() => {
    const x = r();
    if (v.stress && x < 0.08 && f.length > 1) {
      f.delete(Math.floor(r() * f.length), 1); // a paragraph deleted
    } else if (x < 0.7 && ts.length) {
      const t = ts[Math.floor(r() * ts.length)];
      t.insert(Math.floor(r() * (t.length + 1)), WORDS[Math.floor(r() * WORDS.length)]);
    } else if (x < 0.85 && ts.length) {
      const t = ts[Math.floor(r() * ts.length)];
      if (t.length) {
        const at = Math.floor(r() * t.length);
        t.delete(at, v.stress ? Math.min(t.length - at, 1 + Math.floor(r() * 6)) : 1);
      }
    } else {
      f.insert(Math.floor(r() * (f.length + 1)), [paragraph(r, 2)]);
    }
  });
}

const plainText = (t: Y.XmlText): string => t.toDelta().map((op: { insert?: unknown }) => (typeof op.insert === 'string' ? op.insert : '')).join('');

/** One move in one transaction: it deletes content and inserts its replacement, as an editor's move does. */
function moveEdit(m: () => number, d: Y.Doc): void {
  const f = d.getXmlFragment('default');
  const ts = texts(f).filter((t) => t.length > 0);
  const kind = m();
  d.transact(() => {
    if (kind < 1 / 3 && ts.length) {
      // type over a selection
      const t = ts[Math.floor(m() * ts.length)];
      const at = Math.floor(m() * t.length);
      t.delete(at, Math.min(t.length - at, 1 + Math.floor(m() * 8)));
      t.insert(at, WORDS[Math.floor(m() * WORDS.length)]);
    } else if (kind < 2 / 3 && f.length > 1) {
      // drag a paragraph elsewhere (ProseMirror deletes the node and inserts a copy)
      const from = Math.floor(m() * f.length);
      const copy = (f.get(from) as Y.XmlElement).clone();
      f.delete(from, 1);
      f.insert(Math.floor(m() * (f.length + 1)), [copy]);
    } else if (ts.length > 1) {
      // cut a run and paste it into another paragraph
      const a = ts[Math.floor(m() * ts.length)];
      const others = ts.filter((t) => t !== a);
      const b = others[Math.floor(m() * others.length)];
      const at = Math.floor(m() * a.length);
      const len = Math.min(a.length - at, 1 + Math.floor(m() * 10));
      const cut = plainText(a).slice(at, at + len);
      a.delete(at, len);
      b.insert(Math.floor(m() * (b.length + 1)), cut);
    }
  });
}

/** Does `doc` hold every clock of [clock, clock + len) at `client`, deleted? */
function allDeleted(doc: Y.Doc, client: number, clock: number, len: number): boolean {
  const structs = doc.store.clients.get(client);
  if (!structs || Y.getState(doc.store, client) < clock + len) return false;
  for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i].id.clock < clock + len; i++) {
    if (!structs[i].deleted) return false;
  }
  return true;
}

/**
 * Per-transaction atomicity. Records every local transaction of lifetime 1 (its inserted clocks, [from, to) at its own
 * id, and its delete set); after every lifetime-2 mutation, each must be whole in live: its inserted clocks all or none
 * (never a partial range), and where its inserts are in live, so are all its deletes. A delete set names no author (two
 * users can delete the same character), so deletes are only held against a transaction when live holds its inserts, or
 * when the mutation's SENDER held the transaction (then live, having taken that sender's whole frame, must hold all of
 * it). That attribution keeps concurrent deletes from counting as splits, and makes "a landing applied a move's delete
 * without its re-insert" (a partial landing of a relayer's frame) a split.
 */
class AtomicityOracle {
  readonly txs: Array<{ client: number; from: number; to: number; deletes: Array<[number, number, number]>; split: boolean }> = [];
  mixed = 0;
  heldChecks = 0;
  splits = 0;

  record(doc: Y.Doc, tr: Y.Transaction): void {
    const client = doc.clientID;
    const from = tr.beforeState.get(client) ?? 0;
    const to = tr.afterState.get(client) ?? 0;
    const deletes: Array<[number, number, number]> = [];
    tr.deleteSet.clients.forEach((items, c) => items.forEach((d) => d.len > 0 && deletes.push([c, d.clock, d.len])));
    if (to === from && !deletes.length) return;
    if (to > from && deletes.length) this.mixed++;
    this.txs.push({ client, from, to, deletes, split: false });
  }

  /** After a mutation of `live`, by a landing of `sender`'s frame (null: the stored row's load). New splits. */
  check(live: Y.Doc, sender: Y.Doc | null): number {
    const before = this.splits;
    for (const tx of this.txs) {
      if (tx.split) continue;
      const inserts = tx.to > tx.from;
      const state = Y.getState(live.store, tx.client);
      const all = !inserts || state >= tx.to;
      let whole = all || state <= tx.from;
      const held = sender !== null && Y.getState(sender.store, tx.client) >= tx.to && tx.deletes.every(([c, k, l]) => allDeleted(sender, c, k, l));
      if (held) this.heldChecks++;
      if (whole && ((inserts && all) || held)) whole = all && tx.deletes.every(([c, k, l]) => allDeleted(live, c, k, l));
      if (!whole) {
        tx.split = true;
        this.splits++;
      }
    }
    return this.splits - before;
  }
}

/** Per clock at `x` from `from` on, what an update holds there: `gc`, `del` (ContentDeleted or in its delete set), or
 *  the live content (class and value). */
function clocksAt(update: Uint8Array, x: number, from: number): Map<number, string> {
  const decoded = Y.decodeUpdate(update);
  const ds = decoded.ds.clients.get(x) ?? [];
  const out = new Map<number, string>();
  for (const s of decoded.structs) {
    if (s.id.client !== x || s instanceof Y.Skip) continue;
    for (let c = Math.max(from, s.id.clock); c < s.id.clock + s.length; c++) {
      if (s instanceof Y.GC) out.set(c, 'gc');
      else if (s.content instanceof Y.ContentDeleted || ds.some((d) => d.clock <= c && c < d.clock + d.len)) out.set(c, 'del');
      else {
        const k = c - s.id.clock;
        const content = s.content;
        if (content instanceof Y.ContentString) out.set(c, `s:${content.str[k]}`);
        else if (content instanceof Y.ContentFormat) out.set(c, `f:${content.key}:${JSON.stringify(content.value)}`);
        else if (content instanceof Y.ContentType) out.set(c, `t:${(content.type as Y.XmlElement).nodeName ?? 'text'}`);
        else if (content instanceof Y.ContentAny) out.set(c, `a:${JSON.stringify(content.arr[k])}`);
        else out.set(c, content.constructor.name);
      }
    }
  }
  return out;
}

/** Is `relay`'s copy of the structs at `x` (from live's state on) unprovable against the owner's own copy `own`? */
function unprovableCopy(relay: Uint8Array, own: Uint8Array, x: number, from: number): boolean {
  const owner = clocksAt(own, x, from);
  for (const [c, copy] of clocksAt(relay, x, from)) {
    const theirs = owner.get(c);
    if (theirs === undefined) return true; // R2: a clock the owner does not hold
    if (copy === theirs || (copy === 'del' && theirs !== 'gc')) continue; // equal, or the relay ends deleted (R4)
    return true; // R5 (owner-deleted text live in the copy), R6 (a GC on either side), other content
  }
  return false;
}

/** Counts the claims the guard records; `guessBudget: false` disables the one-guess-per-relayer budget (no relayer is
 *  ever burned), for the equality check. Today: no room (every claim `full`), so the guard has no owner claims. */
class CorpusLedger extends ClaimLedger {
  recorded = 0;
  constructor(
    private readonly guessBudget: boolean,
    perUser?: number,
    total?: number,
  ) {
    super(perUser, total);
  }
  override enqueue(claim: OwnerClaim): void {
    this.recorded++;
    if (!this.guessBudget) (claim.burned as unknown as { add: unknown }).add = () => claim.burned;
    super.enqueue(claim);
  }
}

type CrashTally = {
  peers: number;
  landed: number;
  blocked: number;
  /** `seed:user` of every blocked editor (the guess-budget equality compares these), and their final claim words. */
  blockedEditors: string[];
  words: Record<string, number>;
  splits: number;
  attested: number;
  claims: number;
  retries: number;
  maxRetries: number;
  recovered: number;
  relays: number;
  storedPrefix: number;
  remounts: number;
  txs: number;
  mixed: number;
  heldChecks: number;
};

async function crashSeed(seed: number, v: CrashVariant, mode: CrashMode, tally: CrashTally) {
  const r = rng(seed * 7919);
  const m = rng(seed * 104_729 + 1); // the moves (their own RNG: the base sequence is unchanged)
  const jitter = rng(seed * 15_485_863 + 2); // the client's retry jitter
  const oracle = new AtomicityOracle();
  let recording = true;
  let nextId = seed * 1000;
  const peers: CrashPeer[] = [];
  /** A page mount over `from` (a fresh Y.Doc, a new client id), as the page editor makes on every load. */
  const mountDoc = (p: CrashPeer, from: Y.Doc) => {
    const d = new Y.Doc();
    Y.applyUpdate(d, Y.encodeStateAsUpdate(from), 'remote');
    d.clientID = ++nextId;
    d.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') p.outbox.push(u);
    });
    d.on('afterTransaction', (tr: Y.Transaction) => {
      if (recording && tr.local) oracle.record(d, tr);
    });
    if (v.undo) new Y.UndoManager(d.getXmlFragment('default')); // as y-tiptap's yUndoPlugin: it keeps what its user deletes
    p.ownIds.add(d.clientID);
    p.doc = d;
  };

  // Lifetime 1.
  const live1 = new Y.Doc();
  live1.transact(() => live1.getXmlFragment('default').insert(0, Array.from({ length: 6 }, () => paragraph(r, 4))));
  let stored = Y.encodeStateAsUpdate(live1);
  live1.on('update', (u: Uint8Array, origin: unknown) => {
    for (const p of peers) if (p !== origin) p.inbox.push(u);
  });
  const n = 2 + Math.floor(r() * (v.stress ? 5 : 3));
  for (let i = 0; i < n; i++) {
    const p: CrashPeer = {
      user: `user-${i}`,
      doc: null as never,
      ownIds: new Set(),
      outbox: [],
      inbox: [],
      rtt: v.wide ? 30 + Math.floor(r() * 371) : 60 + Math.floor(r() * 51),
      clock: 0,
      unresolved: 0,
      retries: 0,
      landed: false,
      terminal: null,
      unprovable: false,
      blockers: [],
    };
    mountDoc(p, live1);
    peers.push(p);
  }
  const ops = 20 + Math.floor(r() * 40);
  for (let op = 0; op < ops; op++) {
    const p = peers[Math.floor(r() * n)];
    crashEdit(r, p.doc, v, m);
    if (r() < 0.7) for (const u of p.outbox.splice(0)) Y.applyUpdate(live1, u, p);
    for (const q of peers) if (q.inbox.length && r() < 0.6) for (const u of q.inbox.splice(0)) Y.applyUpdate(q.doc, u, 'remote');
    if (r() < (v.stress ? 0.02 : 0.06)) stored = Y.encodeStateAsUpdate(live1); // a debounced store
  }
  // The crash: whatever live1 held past `stored` is gone, and so is every broadcast still in flight.
  for (const p of peers) {
    p.inbox.length = 0;
    for (let k = Math.floor(r() * 3); k > 0; k--) crashEdit(r, p.doc, v, m); // typed while disconnected
    if (r() < 0.25) {
      tally.remounts++;
      mountDoc(p, p.doc); // a reload: a new client id over the local copy, which keeps the old id's unsent edits
      if (r() < 0.5) crashEdit(r, p.doc, v, m);
    }
    p.outbox.length = 0; // the Step2 carries them
  }
  recording = false;

  // Lifetime 2.
  const live = new Y.Doc() as Y.Doc & { name: string; awareness: { meta: Map<number, { clock: number }> } };
  live.name = DOC_NAME;
  Y.applyUpdate(live, stored);
  tally.splits += oracle.check(live, null);
  live.awareness = { meta: new Map() };
  if (peers.some((p) => [...p.ownIds].some((id) => Y.getState(live.store, id) > 0))) tally.storedPrefix++;
  let now = 1_000_000;
  const logs: string[] = [];
  const queue: Array<{ at: number; seq: number; run: () => void }> = [];
  let seq = 0;
  const schedule = (at: number, run: () => void) => queue.push({ at, seq: seq++, run });
  const ledger = mode === 'today' ? new CorpusLedger(true, 0, 0) : new CorpusLedger(mode === 'now');
  const retryMs = mode === 'today' ? TODAY_RETRY_MS : UNRESOLVED_RETRY_MS;
  const guard = new CollabUpdateGuard({
    mode: 'enforce',
    logger: { warn: (line: string) => logs.push(line) },
    limitLog: new SocketLimitLog({ warn: (line: string) => logs.push(line) }),
    now: () => now,
    claimLedger: ledger,
    // #827's probe on the simulated clock (it runs between frames, as on the server)
    schedule: (fn, ms) => {
      let armed = true;
      schedule(now + ms, () => armed && fn());
      return { cancel: () => (armed = false) };
    },
  });
  // Every refusal line is read (the claim word): no per-minute suppression in a corpus that refuses dozens of frames.
  (guard as unknown as { logLines: { perKey: number } }).logLines.perKey = Infinity;
  const check = (conn: Conn, frame: Uint8Array): { reason: string; stage?: string; claim?: string } | null => {
    const logged = logs.length;
    try {
      guard.check({ connection: conn, document: live, update: frame, context: conn.context });
      return null;
    } catch (err: any) {
      const line = logs.slice(logged).find((l) => l.startsWith('COLLAB_UPDATE_REFUSED'));
      const fields = line ? JSON.parse(line.slice(line.indexOf('{'))) : {};
      return { reason: `${err?.code} ${err?.reason}`, stage: fields.stage, claim: fields.claim };
    }
  };
  /** Peers whose announced id this update writes new clocks at. */
  const newClocksAt = (update: Uint8Array): Set<number> => {
    const out = new Set<number>();
    for (const s of Y.decodeUpdate(update).structs) if (s.id.clock + s.length > Y.getState(live.store, s.id.client)) out.add(s.id.client);
    return out;
  };

  const attempt = (p: CrashPeer) => () => {
    const conn: Conn = { readOnly: false, webSocket: { close: () => undefined }, context: { user: { id: p.user } } };
    p.clock++;
    const refused =
      check(conn, step1Frame(p.doc)) ??
      check(conn, awarenessFrame([{ clientID: p.doc.clientID, clock: p.clock, state: { user: { name: p.user } } }]));
    if (refused) {
      p.terminal = `connect: ${refused.reason}`;
      return;
    }
    live.awareness.meta.set(p.doc.clientID, { clock: p.clock });
    const sv = Y.encodeStateVector(live); // the server's Step1, answered one round trip later
    schedule(now + p.rtt, () => step2(p, conn, sv));
  };
  const step2 = (p: CrashPeer, conn: Conn, sv: Uint8Array) => {
    const reply = Y.encodeStateAsUpdate(p.doc, sv);
    const written = newClocksAt(reply);
    const refused = check(conn, syncFrame(reply, SYNC.Step2));
    if (!refused) {
      Y.applyUpdate(live, reply, { source: 'connection', connection: conn }); // #840: 4.7.1's origin for a client frame
      tally.splits += oracle.check(live, p.doc);
      p.landed = true;
      p.unresolved = 0; // sync-acked
      tally.landed++;
      if ([...written].some((id) => !p.ownIds.has(id))) tally.relays++;
      if (p.retries) tally.recovered++;
      return;
    }
    p.blockers = peers.filter((q) => q !== p && q.clock > 0 && written.has(q.doc.clientID));
    if (refused.reason === `${COLLAB_REFUSAL_CODE} ${UNRESOLVED_REASON}` && p.unresolved < retryMs.length) {
      const wait = retryMs[p.unresolved++];
      p.retries++;
      // collab-access.ts collabRetryDelay with the step's floor (half the wait); the first retry is immediate
      const delay = wait === 0 ? 0 : Math.max(Math.round(wait / 2), Math.round(wait * (0.5 + 0.5 * jitter())));
      schedule(now + p.rtt + delay, attempt(p)); // the close reaches it, it waits, and its new Auth reaches the server
      return;
    }
    p.terminal = `${refused.reason}${refused.stage ? ` (${refused.stage})` : ''}`;
    p.claim = refused.claim;
    p.unprovable = p.blockers.some((q) =>
      unprovableCopy(reply, Y.encodeStateAsUpdate(q.doc, sv), q.doc.clientID, Y.getState(live.store, q.doc.clientID)),
    );
  };

  for (const p of peers) schedule(now + Math.floor(r() * (v.stress ? 150 : 500)), attempt(p)); // jittered reconnects after the crash
  while (queue.length) {
    queue.sort((x, y) => x.at - y.at || x.seq - y.seq);
    const ev = queue.shift()!;
    now = ev.at;
    ev.run();
    await new Promise<void>((resolve) => setImmediate(resolve)); // the next macrotask: the guard clears its in-flight frames
  }
  tally.attested += logs.filter((l) => l.startsWith('COLLAB_RELAY_ATTESTED ')).length;
  tally.claims += ledger.recorded;
  tally.txs += oracle.txs.length;
  tally.mixed += oracle.mixed;
  tally.heldChecks += oracle.heldChecks;
  return { live, peers, retryMs };
}

async function crashCorpus(v: CrashVariant, mode: CrashMode): Promise<CrashTally> {
  const tally: CrashTally = {
    peers: 0,
    landed: 0,
    blocked: 0,
    blockedEditors: [],
    words: {},
    splits: 0,
    attested: 0,
    claims: 0,
    retries: 0,
    maxRetries: 0,
    recovered: 0,
    relays: 0,
    storedPrefix: 0,
    remounts: 0,
    txs: 0,
    mixed: 0,
    heldChecks: 0,
  };
  for (let seed = 1; seed <= CRASH_SEEDS; seed++) {
    const { live, peers, retryMs } = await crashSeed(seed, v, mode, tally);
    tally.peers += peers.length;
    for (const p of peers) {
      expect({ seed, user: p.user, finished: p.landed !== (p.terminal !== null) }).toEqual({ seed, user: p.user, finished: true });
      expect(p.retries).toBeLessThanOrEqual(retryMs.length);
      tally.retries += p.retries;
      tally.maxRetries = Math.max(tally.maxRetries, p.retries);
      if (p.terminal === null) continue;
      tally.blocked++;
      tally.blockedEditors.push(`${seed}:${p.user}`);
      tally.words[p.claim ?? '-'] = (tally.words[p.claim ?? '-'] ?? 0) + 1;
    }
    // Today: every block is the #842 cycle (refused as an unproven owner's id, by an owner that itself never landed).
    // Now: only the documented residual (unprovableResidual).
    const explained =
      mode === 'today'
        ? (p: CrashPeer) => p.terminal === `${COLLAB_REFUSAL_CODE} ${UNRESOLVED_REASON} (unproven-owner)`
        : unprovableResidual;
    const unexplained = peers.filter((p) => p.terminal !== null && !explained(p)).map((p) => `${p.user}: ${p.terminal} claim=${p.claim} unprovable=${p.unprovable}`);
    expect({ variant: v.name, mode, seed, unexplained }).toEqual({ variant: v.name, mode, seed, unexplained: [] });
    // every landed editor's edits (its own and those it was relayed) are in live, and it converges with live
    for (const p of peers.filter((q) => q.landed)) {
      const missing = Y.decodeUpdate(Y.encodeStateAsUpdate(p.doc, Y.encodeStateVector(live)));
      expect({ seed, user: p.user, structs: missing.structs.length }).toEqual({ seed, user: p.user, structs: 0 });
      Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(live, Y.encodeStateVector(p.doc)), 'remote');
      expect(contentOf(p.doc)).toEqual(contentOf(live));
    }
    expect(renderLikeABrowser(live)).toMatchObject({ deleted: false, threw: false });
  }
  return tally;
}

describe('#781 lineage, #842: a lost lifetime\'s edits come back through the guard (crash corpus)', () => {
  it('the corpus retries `unresolved` on the client\'s schedule (collab-access.ts COLLAB_UNRESOLVED_RETRY_MS)', () => {
    const source = readFileSync(join(__dirname, '../../../../client/src/features/editor-ux/collab-access.ts'), 'utf8');
    const literal = /COLLAB_UNRESOLVED_RETRY_MS:\s*readonly number\[\]\s*=\s*\[([^\]]*)\]/.exec(source);
    expect(literal).not.toBeNull();
    expect(literal![1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => Number(s.replace(/_/g, '')))).toEqual(UNRESOLVED_RETRY_MS);
    // and its jitter: half to all of each wait (collabRetryDelay with the step's floor, half the wait)
    expect(source).toMatch(/retryMinMs: Math\.round\(wait \/ 2\)/);
  });

  it('anti-vacuity: the atomicity oracle sees half a move in live (either half), and nothing in a whole landing or none', () => {
    const base = basePage('alpha beta');
    const mover = new Y.Doc();
    Y.applyUpdate(mover, Y.encodeStateAsUpdate(base.doc), 'remote');
    mover.clientID = 777;
    const recorded = new AtomicityOracle();
    mover.on('afterTransaction', (tr: Y.Transaction) => tr.local && recorded.record(mover, tr));
    const t = (mover.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    mover.transact(() => {
      t.delete(6, 4); // "beta" cut ...
      t.insert(0, 'beta '); // ... and pasted in front: one transaction
    });
    expect(recorded.mixed).toBe(1);
    const move = Y.encodeStateAsUpdate(mover, Y.encodeStateVector(base.doc));
    const oracle = () => {
      const o = new AtomicityOracle();
      o.txs.push(...recorded.txs.map((tx) => ({ ...tx, split: false })));
      return o;
    };
    const liveWith = (...updates: Uint8Array[]) => {
      const d = new Y.Doc();
      Y.applyUpdate(d, Y.encodeStateAsUpdate(base.doc));
      for (const u of updates) Y.applyUpdate(d, u);
      return d;
    };
    // the delete without the re-insert, landed by a sender that held the move (a partial landing of its frame)
    const deleteOnly = Y.diffUpdate(move, Y.encodeStateVector(new Map([[777, Number.MAX_SAFE_INTEGER]])));
    expect(oracle().check(liveWith(deleteOnly), mover)).toBe(1);
    // the re-insert without the delete, whoever landed it
    expect(oracle().check(liveWith(encodeStructs(blocksOf(move).blocks)), null)).toBe(1);
    // whole, or none of it
    expect(oracle().check(liveWith(move), mover)).toBe(0);
    expect(oracle().check(liveWith(), null)).toBe(0);
  });

  it.each(CRASH_VARIANTS)(
    `$name: ${CRASH_SEEDS} seeded crashes, today vs now: blocked editors, atomicity, recovery`,
    async (v) => {
      const today = await crashCorpus(v, 'today');
      const now = await crashCorpus(v, 'now');
      const noBudget = await crashCorpus(v, 'no-budget');
      const row = (t: CrashTally) => ({
        blocked: `${t.blocked}/${t.peers}`,
        splits: t.splits,
        attested: t.attested,
        claims: t.claims,
        retries: t.retries,
        maxRetries: t.maxRetries,
        ...(t.blocked && t.claims ? { words: t.words } : {}),
      });
      if (process.env.CONFLICT_SCAN_TALLY) {
        console.log(`CRASH_CORPUS_TALLY ${JSON.stringify({ variant: v.name, today: row(today), now: row(now), noBudget: { blocked: noBudget.blocked }, txs: now.txs, mixed: now.mixed })}`);
      }
      // Atomicity: no transaction is ever split in live, today or now.
      expect({ today: today.splits, now: now.splits, noBudget: noBudget.splits }).toEqual({ today: 0, now: 0, noBudget: 0 });
      // Blocked editors.
      if (v.blocked === 'none') expect(now.blockedEditors).toEqual([]);
      else expect(now.blocked).toBeLessThanOrEqual(Math.floor(v.blocked * now.peers));
      // The guess budget costs honest recovery nothing: the same editors are blocked without it.
      expect(noBudget.blockedEditors).toEqual(now.blockedEditors);
      expect(noBudget.words.burned).toBeUndefined(); // (the budget really was off: no relayer was ever refused as burned)
      // Anti-vacuity: the corpus has the #842 cycle today; now owner claims are recorded and attest relays, and
      // retries recover editors; stored prefixes, relays, reloads over a local copy; the oracle checked held
      // transactions, and moves really are one transaction that deletes and inserts.
      expect(today.blocked).toBeGreaterThan(0);
      expect(today.attested + today.claims).toBe(0);
      expect(now.blocked).toBeLessThan(today.blocked);
      for (const [k, n] of Object.entries({ attested: now.attested, claims: now.claims, recovered: now.recovered, relays: now.relays, storedPrefix: now.storedPrefix, remounts: now.remounts, heldChecks: now.heldChecks })) {
        expect({ [k]: n > 0 }).toEqual({ [k]: true });
      }
      expect(now.storedPrefix).toBeLessThan(CRASH_SEEDS);
      if (v.moves) expect(now.mixed).toBeGreaterThan(now.txs / 10);
    },
    600_000,
  );
});
