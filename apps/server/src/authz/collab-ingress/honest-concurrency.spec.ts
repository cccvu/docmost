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
import { basePage, rawUpdate, unguardedSteps, type RawStruct } from './conflict-scan.testkit';
import { compactionRequest } from '../page-write/compaction-registry';
import { PAGE_MAX_YDOC_BYTES } from '../page-write/page-size';
import { C_MAX, E_MAX } from './doc-bounds';
import { SocketLimitLog } from './socket-limit-log';
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
    return deliver(peer, syncFrame(update, subtype), () => Y.applyUpdate(live, update, peer.conn));
  };

  live.on('update', (u: Uint8Array, origin: unknown) => {
    for (const p of peers) if (p.conn !== origin && r() < 0.9) p.inbox.push(u); // broadcast, delivered late
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
 * #781 lineage (ADR 0036 §4): a lifetime that lost its editors' last edits (the process died inside the store debounce)
 * gets them back from whichever browser resends them first: the author's own Step2, or a peer's that the dead lifetime
 * relayed them to. Lifetime 1 runs unguarded (it is not under test) with debounced stores at random points; then the
 * crash, edits typed while disconnected, and reloads over the local copy (a new client id). Lifetime 2 is guarded, and
 * each provider's connect is split as 4.7.1 sends it: Auth, Step1 and its own awareness on a jittered reconnect, then its
 * Step2 one round trip later (an answer to the server's Step1). The client's rule is modelled: `unresolved` reconnects
 * once (the close and a new Auth, one round trip), and a second one before a Step2 lands is final.
 *
 * Property: no terminal refusal, and every lost edit back in live, except the pinned residual (relay-binding.spec.ts):
 * editors whose Step2s each carry another's unproven id block each other, and whoever waits on them. Timing assumption,
 * stated: an author's round trip is at most twice a relayer's (60–110 ms here), so the author's Step2 lands before the
 * relayer's one retry (relay-binding.spec.ts pins what happens when it does not).
 */
const CRASH_SEEDS = 120;
const crashSeen = { peers: 0, landed: 0, storedPrefix: 0, relays: 0, mirrorRecovered: 0, remounts: 0, mutuallyBlocked: 0 };

type CrashPeer = {
  user: string;
  doc: Y.Doc;
  ownIds: Set<number>;
  outbox: Uint8Array[];
  inbox: Uint8Array[];
  rtt: number;
  clock: number;
  retried: boolean;
  unresolved: number;
  landed: boolean;
  terminal: string | null;
  blockers: CrashPeer[];
};

/** A light honest edit (lifetime 1 and the outage): typing, a short delete, a new paragraph. */
function crashEdit(r: () => number, d: Y.Doc): void {
  const f = d.getXmlFragment('default');
  const ts = texts(f);
  d.transact(() => {
    const x = r();
    if (x < 0.7 && ts.length) {
      const t = ts[Math.floor(r() * ts.length)];
      t.insert(Math.floor(r() * (t.length + 1)), WORDS[Math.floor(r() * WORDS.length)]);
    } else if (x < 0.85 && ts.length) {
      const t = ts[Math.floor(r() * ts.length)];
      if (t.length) t.delete(Math.floor(r() * t.length), 1);
    } else {
      f.insert(Math.floor(r() * (f.length + 1)), [paragraph(r, 2)]);
    }
  });
}

function crashSeed(seed: number) {
  const r = rng(seed * 7919);
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
  const n = 2 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const p: CrashPeer = {
      user: `user-${i}`,
      doc: null as never,
      ownIds: new Set(),
      outbox: [],
      inbox: [],
      rtt: 60 + Math.floor(r() * 51),
      clock: 0,
      retried: false,
      unresolved: 0,
      landed: false,
      terminal: null,
      blockers: [],
    };
    mountDoc(p, live1);
    peers.push(p);
  }
  const ops = 20 + Math.floor(r() * 40);
  for (let op = 0; op < ops; op++) {
    const p = peers[Math.floor(r() * n)];
    crashEdit(r, p.doc);
    if (r() < 0.7) for (const u of p.outbox.splice(0)) Y.applyUpdate(live1, u, p);
    for (const q of peers) if (q.inbox.length && r() < 0.6) for (const u of q.inbox.splice(0)) Y.applyUpdate(q.doc, u, 'remote');
    if (r() < 0.06) stored = Y.encodeStateAsUpdate(live1); // a debounced store
  }
  // The crash: whatever live1 held past `stored` is gone, and so is every broadcast still in flight.
  for (const p of peers) {
    p.inbox.length = 0;
    for (let k = Math.floor(r() * 3); k > 0; k--) crashEdit(r, p.doc); // typed while disconnected
    if (r() < 0.25) {
      crashSeen.remounts++;
      mountDoc(p, p.doc); // a reload: a new client id over the local copy, which keeps the old id's unsent edits
      if (r() < 0.5) crashEdit(r, p.doc);
    }
    p.outbox.length = 0; // the Step2 carries them
  }

  // Lifetime 2.
  const live = new Y.Doc() as Y.Doc & { name: string; awareness: { meta: Map<number, { clock: number }> } };
  live.name = DOC_NAME;
  Y.applyUpdate(live, stored);
  live.awareness = { meta: new Map() };
  if (peers.some((p) => [...p.ownIds].some((id) => Y.getState(live.store, id) > 0))) crashSeen.storedPrefix++;
  let now = 1_000_000;
  const logs: string[] = [];
  const guard = new CollabUpdateGuard({
    mode: 'enforce',
    logger: { warn: (m: string) => logs.push(m) },
    limitLog: new SocketLimitLog({ warn: (m: string) => logs.push(m) }),
    now: () => now,
  });
  const queue: Array<{ at: number; seq: number; run: () => void }> = [];
  let seq = 0;
  const schedule = (at: number, run: () => void) => queue.push({ at, seq: seq++, run });
  const check = (conn: Conn, frame: Uint8Array): { reason: string; stage?: string } | null => {
    const logged = logs.length;
    try {
      guard.check({ connection: conn, document: live, update: frame, context: conn.context });
      return null;
    } catch (err: any) {
      const line = logs.slice(logged).find((l) => l.startsWith('COLLAB_UPDATE_REFUSED'));
      const stage = line ? JSON.parse(line.slice(line.indexOf('{'))).stage : undefined;
      return { reason: `${err?.code} ${err?.reason}`, stage };
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
      Y.applyUpdate(live, reply, conn);
      p.landed = true;
      p.retried = false; // sync-acked
      crashSeen.landed++;
      if ([...written].some((id) => !p.ownIds.has(id))) crashSeen.relays++;
      if (p.unresolved) crashSeen.mirrorRecovered++;
      return;
    }
    p.blockers = peers.filter((q) => q !== p && q.clock > 0 && written.has(q.doc.clientID));
    if (refused.reason === `${COLLAB_REFUSAL_CODE} ${UNRESOLVED_REASON}` && !p.retried) {
      p.retried = true;
      p.unresolved++;
      schedule(now + p.rtt, attempt(p)); // the close reaches it, and its new Auth reaches the server
      return;
    }
    p.terminal = `${refused.reason}${refused.stage ? ` (${refused.stage})` : ''}`;
  };

  for (const p of peers) schedule(now + Math.floor(r() * 500), attempt(p)); // jittered reconnects after the crash
  while (queue.length) {
    queue.sort((x, y) => x.at - y.at || x.seq - y.seq);
    const ev = queue.shift()!;
    now = ev.at;
    ev.run();
  }
  return { live, peers };
}

describe('#781 lineage: a lost lifetime\'s edits come back through the guard (crash corpus)', () => {
  it(`${CRASH_SEEDS} seeded crashes of 2–4 editors: no terminal refusal outside the pinned mutual-block residual, nothing lost`, () => {
    for (let seed = 1; seed <= CRASH_SEEDS; seed++) {
      const { live, peers } = crashSeed(seed);
      crashSeen.peers += peers.length;
      const terminal = peers.filter((p) => p.terminal !== null);
      // The residual: refused as an unproven owner's id, by an owner that itself never landed (a block cycle).
      const residual = (p: CrashPeer) =>
        p.terminal === `${COLLAB_REFUSAL_CODE} ${UNRESOLVED_REASON} (unproven-owner)` && p.blockers.some((q) => q.terminal !== null);
      expect({ seed, unexplained: terminal.filter((p) => !residual(p)).map((p) => `${p.user}: ${p.terminal}`) }).toEqual({ seed, unexplained: [] });
      crashSeen.mutuallyBlocked += terminal.length;
      for (const p of peers) {
        expect(p.landed !== (p.terminal !== null)).toBe(true); // every editor finished one way or the other
        expect(p.unresolved).toBeLessThanOrEqual(1);
      }
      // every landed editor's edits (its own and those it was relayed) are in live, and it converges with live
      for (const p of peers.filter((q) => q.landed)) {
        const missing = Y.decodeUpdate(Y.encodeStateAsUpdate(p.doc, Y.encodeStateVector(live)));
        expect({ seed, user: p.user, structs: missing.structs.length }).toEqual({ seed, user: p.user, structs: 0 });
        Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(live, Y.encodeStateVector(p.doc)), 'remote');
        expect(contentOf(p.doc)).toEqual(contentOf(live));
      }
      expect(renderLikeABrowser(live)).toMatchObject({ deleted: false, threw: false });
    }
    if (process.env.CONFLICT_SCAN_TALLY) console.log(JSON.stringify(crashSeen));
    // anti-vacuity: stored prefixes and never-seen ids, relays that landed, the mirror ordering recovered by its one
    // retry, reloads over a local copy; and the residual shape occurs (fixing it makes this 0: then assert that instead)
    for (const [k, v] of Object.entries(crashSeen)) expect({ [k]: v > 0 }).toEqual({ [k]: true });
    expect(crashSeen.storedPrefix).toBeLessThan(CRASH_SEEDS);
    expect(crashSeen.landed).toBeGreaterThan(crashSeen.mutuallyBlocked);
  });
});
