import * as Y from 'yjs';
import {
  compactionRequest,
  isDraining,
  markCompacting,
  markPageFull,
  markSuperseded,
  requestCompaction,
  setCompactionClockForTests,
  writeLineage,
} from '../page-write/compaction-registry';
import { awarenessFrame, DOC_NAME, MSG, processCpuMs, RemoteClient, SYNC, syncFrame, typedFrame, step1Frame } from './collab-ingress.testkit';
import { buildCompacted, snapshotTree } from '../page-write/compaction';
import { liveContentDigest } from '../page-write/doc-version';
import { COLLAB_PAGE_COMPACTING_REASON, epochStaleReason } from './collab-reasons';
import { ConflictScan, CONFLICT_SCAN_STEPS_PER_FRAME, installConflictScanMeter } from './conflict-scan';
import { basePage, rawUpdate, type RawStruct } from './conflict-scan.testkit';
import { deadlineExceeded, isDeadlineExceeded, runWithDeadline, type DeadlineRunner } from './deadline';
import { COMPACTION_ARM_DELAY_MS, PROBE_DEBOUNCE_MS, PROBE_MIN_INTERVAL_MS, readerStep2ChargeMs, softCap } from './doc-bounds';
import { SocketLimitLog } from './socket-limit-log';
import {
  COLLAB_REFUSAL_CODE,
  COLLAB_TRY_LATER_CODE,
  CollabUpdateGuard,
  SOCKET_REFUSAL_BUDGET,
  TRY_LATER_REASON,
  USER_COLLAB_CPU_BURST_MS,
  type CollabGuardOptions,
} from './update-guard';

/**
 * #827 (ADR 0036): every Yjs stall path the issue lists, through a real CollabUpdateGuard. Each vector has a CONTROL arm
 * (the same bytes with no guard: the work really stalls, or the page really grows a cost) and a TREATMENT arm (refused,
 * closed 1013, or the page drained to compact, within the bound). Timed vectors run the real vm deadline at a small
 * T, sized so the unguarded control takes several times T on any runner. Costs are measured in the worker's CPU time
 * (`processCpuMs`), never wall time: on a shared CI runner (#567) a wait for a core is not Yjs work, and a ratio of two
 * wall times measured minutes apart is the runner's load, not the vector's.
 */
const REFUSED = (rule: string) => `ccc:collab-update-refused:${rule}`;
const TRY_LATER = 'try-later';
const COMPACTING = 'compacting';
const ms = processCpuMs;

type Conn = { readOnly: boolean; webSocket: { close: jest.Mock }; context: { user: { id: string } }; params: URLSearchParams };

/** A live page, a guard, and Hocuspocus's apply after a pass (origin `{ source: 'connection' }`, as 4.7.1 applies it). */
function setup(seed: Y.Doc | null, opts: CollabGuardOptions = {}) {
  const live = new Y.Doc() as Y.Doc & { name: string; getConnections: () => Conn[] };
  live.name = DOC_NAME;
  if (seed) Y.applyUpdate(live, Y.encodeStateAsUpdate(seed));
  const conns: Conn[] = [];
  live.getConnections = () => conns;
  const logs: string[] = [];
  const limitLogs: string[] = [];
  const guard = new CollabUpdateGuard({
    mode: 'enforce',
    logger: { warn: (m: string) => logs.push(m) },
    limitLog: new SocketLimitLog({ warn: (m: string) => limitLogs.push(m) }),
    cpuNow: processCpuMs, // the budget charged in CPU time: a busy runner's waits are no user's debt
    ...opts,
  });
  const conn = (id: string, readOnly = false, query = ''): Conn => {
    const c = { readOnly, webSocket: { close: jest.fn() }, context: { user: { id } }, params: new URLSearchParams(query) };
    conns.push(c);
    return c;
  };
  const deliver = (c: Conn, frame: Uint8Array, apply?: Uint8Array): string => {
    try {
      guard.check({ connection: c, document: live, update: frame, context: c.context, requestParameters: c.params });
    } catch (err: any) {
      if (err?.code === COLLAB_TRY_LATER_CODE) {
        expect(c.webSocket.close).toHaveBeenLastCalledWith(COLLAB_TRY_LATER_CODE, err.reason); // the socket first
        return err.reason === COLLAB_PAGE_COMPACTING_REASON ? COMPACTING : (expect(err.reason).toBe(TRY_LATER_REASON), TRY_LATER);
      }
      expect(err).toEqual({ code: COLLAB_REFUSAL_CODE, reason: expect.any(String) });
      return err.reason;
    }
    if (apply) Y.applyUpdate(live, apply, { source: 'connection', connection: c });
    return 'applied';
  };
  const send = (c: Conn, update: Uint8Array, subtype: number = SYNC.Update) => deliver(c, syncFrame(update, subtype), update);
  const state = () => Buffer.from(Y.encodeStateAsUpdate(live));
  return { live, guard, logs, limitLogs, conn, deliver, send, state };
}

/** A copy of `doc` with `update` applied, no guard: the control arm. Returns the apply's CPU time, ms. */
function unguarded(doc: Y.Doc, update: Uint8Array): number {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const t0 = ms();
  Y.applyUpdate(copy, update);
  return ms() - t0;
}

/** The walk steps a full load of `doc`'s state makes (the #816 meter, count mode). */
function loadSteps(doc: Y.Doc): number {
  const meter = installConflictScanMeter(Y);
  const fresh = new Y.Doc();
  const scan = new ConflictScan(fresh, false, Number.POSITIVE_INFINITY);
  const state = Y.encodeStateAsUpdate(doc);
  meter.metered(scan, () => Y.applyUpdate(fresh, state));
  return scan.steps;
}

const settle = () => new Promise((r) => setImmediate(r));
const textOf = (doc: Y.Doc, n = 0) => (doc.getXmlFragment('default').get(n) as Y.XmlElement).get(0) as Y.XmlText;

/** A paragraph of `text` with a bold run, by `client`. */
function paragraphPage(client: number, text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = client;
  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    doc.getXmlFragment('default').insert(0, [p]);
    p.insert(0, [t]);
    t.insert(0, text);
    t.format(0, 1, { bold: true });
  });
  return doc;
}
/** The update `edit` makes on a replica of `base` under client id `client`. */
function editAs(base: Y.Doc, client: number, edit: (doc: Y.Doc) => void): Uint8Array {
  const r = new RemoteClient(base, client);
  return r.edit(base, (_f, d) => edit(d));
}
const paragraphs = (n: number, text = 'p'): Y.Doc => {
  const doc = new Y.Doc();
  doc.clientID = 1;
  doc.transact(() => {
    const ps = Array.from({ length: n }, () => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, text);
      return p;
    });
    doc.getXmlFragment('default').insert(0, ps);
  });
  return doc;
};
const addParagraph = (base: Y.Doc, client: number, at = 0) =>
  editAs(base, client, (d) => {
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('new')]);
    d.getXmlFragment('default').insert(at, [p]);
  });

let restoreClock: () => void = () => undefined;
const armed = () => {
  restoreClock = setCompactionClockForTests({ now: () => Date.now(), uptimeMs: () => COMPACTION_ARM_DELAY_MS + 1 });
};
afterEach(() => {
  restoreClock();
  restoreClock = () => undefined;
  jest.restoreAllMocks();
});

describe('#827 (a) formatting cleanup after a remote delete: an 8-byte frame, seconds of Yjs', () => {
  // D unmerged reverse-typed structs next to T tombstones in a formatted paragraph; a remote delete of the D makes
  // Yjs's formatting cleanup walk D·(D+T). The #816 meter counts integrate walks, and this frame integrates nothing.
  const D = 1000;
  const T_TOMBSTONES = 20_000;
  const FRAME_MS = 60;
  const build = () => {
    const doc = paragraphPage(5, 'ab');
    doc.transact(() => {
      for (let i = 0; i < T_TOMBSTONES; i++) textOf(doc).insert(1, 'x');
    });
    doc.transact(() => textOf(doc).delete(1, T_TOMBSTONES));
    doc.transact(() => {
      for (let i = 0; i < D; i++) textOf(doc).insert(1, 'y');
    });
    return { doc, frame: editAs(doc, 6, (d) => textOf(d).delete(1, D)) };
  };

  it('control: the frame is a few bytes, walks no conflict steps, and stalls the apply many times T', () => {
    const { doc, frame } = build();
    expect(frame.length).toBeLessThan(32);
    expect(unguarded(doc, frame)).toBeGreaterThan(3 * FRAME_MS);
  });

  it('treatment: cut at T, the first time 1013 frame_deadline, the repeat 4422 apply-deadline; live never applies it', () => {
    const { doc, frame } = build();
    // The real vm deadline, recorded: which bound each run had and whether the vm cut it
    const runs: Array<{ ms: number; cut: boolean }> = [];
    const recorded: DeadlineRunner = (fn, bound) => {
      try {
        const out = runWithDeadline(fn, bound);
        runs.push({ ms: bound, cut: false });
        return out;
      } catch (err) {
        runs.push({ ms: bound, cut: isDeadlineExceeded(err) });
        throw err;
      }
    };
    const s = setup(doc, { deadlines: { frame: FRAME_MS }, runWithDeadline: recorded });
    const before = s.state();
    expect(s.send(s.conn('vandal'), frame)).toBe(TRY_LATER);
    // cut, never paid in full: the frame's apply ran under T and the vm stopped it (the control runs it to the end)
    expect(runs.filter((r) => r.cut)).toEqual([{ ms: FRAME_MS, cut: true }]);
    expect(s.limitLogs.some((l) => l.includes('"limit":"frame_deadline"'))).toBe(true);
    // the provider reconnects and resends the same Step2: deterministic, so now a refusal
    expect(s.send(s.conn('vandal'), frame)).toBe(REFUSED('apply-deadline'));
    expect(runs.filter((r) => r.cut)).toEqual([{ ms: FRAME_MS, cut: true }, { ms: FRAME_MS, cut: true }]);
    expect(s.state().equals(before)).toBe(true);
    // another user's honest edit still passes (the discarded shadow is rebuilt)
    expect(s.send(s.conn('peer'), editAs(s.live, 77, (d) => textOf(d).insert(0, 'k')))).toBe('applied');
  });

  it('an accepted frame in between clears the strike: a one-off stall stays a retryable 1013', () => {
    const { doc, frame } = build();
    const s = setup(doc, { deadlines: { frame: FRAME_MS } });
    expect(s.send(s.conn('u'), frame)).toBe(TRY_LATER);
    expect(s.send(s.conn('u'), editAs(s.live, 78, (d) => textOf(d).insert(0, 'k')))).toBe('applied');
    expect(s.send(s.conn('u'), frame)).toBe(TRY_LATER);
  });
});

describe('#827 (b) struct splits: ascending delete ranges each split before thousands of trailing structs', () => {
  const S_AFTER = 50_000;
  const RANGES = 20_000;
  const FRAME_MS = 40;
  const build = () => {
    const doc = paragraphPage(5, 'x'.repeat(2 * RANGES + 10));
    const end = 2 * RANGES + 10;
    doc.transact(() => {
      for (let i = 0; i < S_AFTER; i++) textOf(doc).insert(end, 'y'); // reverse-typed: never merged
    });
    const frame = editAs(doc, 6, (d) => {
      for (let i = RANGES - 1; i >= 1; i--) textOf(d).delete(2 * i, 1);
    });
    return { doc, frame };
  };

  it('control: the ranges ascend (they pass delete-order), and the apply stalls many times T', () => {
    const { doc, frame } = build();
    const decoded = Y.decodeUpdate(frame).ds.clients.get(5)!;
    for (let i = 1; i < decoded.length; i++) expect(decoded[i].clock).toBeGreaterThanOrEqual(decoded[i - 1].clock + decoded[i - 1].len);
    expect(unguarded(doc, frame)).toBeGreaterThan(3 * FRAME_MS);
  });

  it('treatment: cut at T (1013), refused apply-deadline on the resend', () => {
    const { doc, frame } = build();
    const s = setup(doc, { deadlines: { frame: FRAME_MS } });
    const before = s.state();
    expect(s.send(s.conn('vandal'), frame)).toBe(TRY_LATER);
    expect(s.send(s.conn('vandal'), frame)).toBe(REFUSED('apply-deadline'));
    expect(s.state().equals(before)).toBe(true);
  });
});

/** `a c d e` by client 1 in a paragraph; the ids of its characters. */
function acde() {
  const b = basePage('acde');
  const at = (i: number): [number, number] => [1, b.first + i];
  return { doc: b.doc, a: at(0), c: at(1), d: at(2), e: at(3) };
}
const ch = (origin: [number, number], right: [number, number], s = 'z'): RawStruct => ({ origin, right, content: new Y.ContentString(s) });

describe('#827 (c) load-order inversion: two cheap frames make every later load walk M·N', () => {
  const MN = 1000;
  const CAP = 200_000; // the step budget for this page (W_MAX scaled down)
  const frames = () => {
    const p = acde();
    const L = rawUpdate([{ client: 500, clock: 0, structs: Array.from({ length: MN }, () => ch(p.a, p.e, 'l')) }]);
    const H = rawUpdate([{ client: 900_000, clock: 0, structs: Array.from({ length: MN }, (_, i) => ch(p.c, i ? [900_000, i - 1] : p.d, 'h')) }]);
    return { ...p, L, H };
  };

  it('control: each frame passes the per-frame meter, and a load of the result walks M·N steps', () => {
    const f = frames();
    const s = setup(f.doc);
    expect(s.send(s.conn('vandal'), f.L)).toBe('applied');
    expect(s.send(s.conn('vandal'), f.H)).toBe('applied');
    expect(loadSteps(f.doc)).toBeLessThan(10);
    expect(loadSteps(s.live)).toBeGreaterThanOrEqual(MN * MN);
    expect(MN * MN).toBeLessThan(CONFLICT_SCAN_STEPS_PER_FRAME + 1); // no single frame was over the #816 cap
  });

  it('treatment: the probe loads a scratch copy under the budget, never swaps it in, and drains the page to compact', async () => {
    armed();
    const f = frames();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const s = setup(f.doc, { caps: { steps: CAP }, schedule: (fn, ms) => (timers.push({ fn, ms }), { cancel: () => undefined }) });
    const editor = s.conn('editor');
    expect(s.send(s.conn('vandal'), f.L)).toBe('applied');
    expect(s.send(s.conn('vandal'), f.H)).toBe('applied');
    expect(timers).toHaveLength(1); // armed once by the growth, not per frame
    expect(timers[0].ms).toBe(PROBE_DEBOUNCE_MS);
    const shadow = s.guard.shadowOf(s.live);
    timers[0].fn();
    await settle(); // probes run one per macrotask
    expect(s.guard.shadowOf(s.live)).toBe(shadow); // never swapped in
    expect(compactionRequest(s.live)).toMatchObject({ reason: 'probe', drain: true });
    expect(editor.webSocket.close).toHaveBeenCalledWith(COLLAB_TRY_LATER_CODE, COLLAB_PAGE_COMPACTING_REASON);
    expect(s.logs.some((l) => l.startsWith('COLLAB_PAGE_COMPACTION') && l.includes('"reason":"probe"'))).toBe(true);
    // the next frame, from anyone, waits for the compaction
    expect(s.send(s.conn('peer'), editAs(s.live, 77, (d) => textOf(d).insert(0, 'k')))).toBe(COMPACTING);
  });

  it('the probe is charged to everyone who grew the page since the last one', () => {
    armed();
    const f = frames();
    let cpu = 0;
    const s = setup(f.doc, { caps: { steps: CAP }, cpuNow: () => cpu, now: () => 1_000_000, schedule: () => ({ cancel: () => undefined }) });
    expect(s.send(s.conn('a'), f.L)).toBe('applied');
    expect(s.send(s.conn('b'), f.H)).toBe('applied');
    const [a, b, c] = ['a', 'b', 'c'].map((u) => s.guard.cpuBalance(u));
    const real = Y.encodeStateAsUpdate;
    jest.spyOn(Y, 'encodeStateAsUpdate').mockImplementation((...args: Parameters<typeof Y.encodeStateAsUpdate>) => {
      cpu += 300; // the probe's work, on the guard's CPU clock
      return real(...args);
    });
    expect(s.guard.probeNow(s.live)).toBe(true);
    expect(s.guard.cpuBalance('a')).toBe(a - 300);
    expect(s.guard.cpuBalance('b')).toBe(b - 300);
    expect(s.guard.cpuBalance('c')).toBe(c);
  });

  it('later growth waits out the probe interval', () => {
    let now = 1_000_000;
    const timers: number[] = [];
    const s = setup(acde().doc, { now: () => now, schedule: (fn, ms) => (timers.push(ms), { cancel: () => undefined }) });
    expect(s.send(s.conn('a'), editAs(s.live, 70, (d) => textOf(d).insert(0, 'k')))).toBe('applied');
    expect(s.guard.probeNow(s.live)).toBe(true);
    now += 1_000;
    expect(s.send(s.conn('a'), editAs(s.live, 70, (d) => textOf(d).insert(0, 'k')))).toBe('applied');
    expect(timers).toEqual([PROBE_DEBOUNCE_MS, PROBE_MIN_INTERVAL_MS - 1_000]);
  });
});

describe('#827 (c) reorder: one 1-struct frame that walks nothing makes the next load walk K²', () => {
  const K = 1000;
  it('control: the trigger frame is one struct and 0 steps; the load goes from O(K) to K² steps', () => {
    const p = acde();
    const rev = (client: number) => rawUpdate([{ client, clock: 0, structs: Array.from({ length: K }, (_, i) => ch(p.a, i ? [client, i - 1] : p.e)) }]);
    const s = setup(p.doc);
    expect(s.send(s.conn('v'), rev(500))).toBe('applied');
    expect(s.send(s.conn('v'), rev(2))).toBe('applied');
    const before = loadSteps(s.live);
    const trigger = rawUpdate([{ client: 900_000, clock: 0, structs: [ch([2, K - 1], [2, K - 2])] }]);
    expect(s.send(s.conn('v'), trigger)).toBe('applied');
    expect(before).toBeLessThan(10 * K);
    expect(loadSteps(s.live)).toBeGreaterThan(K * K / 2);
  });

  it('treatment: the probe finds it and drains the page', () => {
    armed();
    const p = acde();
    const rev = (client: number) => rawUpdate([{ client, clock: 0, structs: Array.from({ length: K }, (_, i) => ch(p.a, i ? [client, i - 1] : p.e)) }]);
    const s = setup(p.doc, { caps: { steps: 100_000 }, schedule: () => ({ cancel: () => undefined }) });
    for (const f of [rev(500), rev(2), rawUpdate([{ client: 900_000, clock: 0, structs: [ch([2, K - 1], [2, K - 2])] }])]) {
      expect(s.send(s.conn('v'), f)).toBe('applied');
    }
    s.guard.probeNow(s.live);
    expect(isDraining(s.live)).toBe(true);
  });
});

describe('#827 a page past the load bounds is never rebuilt in a loop', () => {
  it('a rebuild over the step budget closes 1013 compacting, once per frame, and never retries the rebuild', () => {
    // not armed: nothing drains, so the second frame reaches the shadow step
    restoreClock = setCompactionClockForTests({ now: () => Date.now(), uptimeMs: () => 0 });
    const p = acde();
    const seed = new Y.Doc();
    Y.applyUpdate(seed, Y.encodeStateAsUpdate(p.doc));
    const MN = 600;
    Y.applyUpdate(seed, rawUpdate([{ client: 500, clock: 0, structs: Array.from({ length: MN }, () => ch(p.a, p.e, 'l')) }]));
    Y.applyUpdate(seed, rawUpdate([{ client: 900_000, clock: 0, structs: Array.from({ length: MN }, (_, i) => ch(p.c, i ? [900_000, i - 1] : p.d, 'h')) }]));
    expect(loadSteps(seed)).toBeGreaterThan(MN * MN); // control: the stored page's load walks M·N
    const s = setup(seed, { caps: { steps: 100_000 } });
    const [first, second] = [70, 71].map((id) => editAs(s.live, id, (d) => textOf(d).insert(0, 'k')));
    const spy = jest.spyOn(Y, 'encodeStateAsUpdate');
    expect(s.send(s.conn('a'), first)).toBe(COMPACTING);
    expect(compactionRequest(s.live)).toMatchObject({ reason: 'load_steps', drain: false });
    const rebuilds = spy.mock.calls.filter(([doc]) => doc === s.live).length;
    expect(s.send(s.conn('b'), second)).toBe(COMPACTING);
    expect(spy.mock.calls.filter(([doc]) => doc === s.live).length).toBe(rebuilds);
  });
});

describe('#827 (d) client ids: Yjs pays every id on every transaction, so the page caps them', () => {
  const CAP = 40;
  const withIds = (n: number) => {
    const b = basePage('hello world');
    Y.applyUpdate(b.doc, rawUpdate(Array.from({ length: n - 1 }, (_, i) => ({ client: 1000 + i, clock: 0, structs: [ch([1, b.first], [1, b.first + 1])] }))));
    return b.doc;
  };

  it('control: every transaction computes a state vector over every id the page holds', () => {
    const doc = withIds(CAP);
    const sizes: number[] = [];
    doc.on('beforeTransaction', (tr: Y.Transaction) => sizes.push(tr.beforeState.size));
    textOf(doc).insert(0, 'k');
    expect(sizes).toEqual([CAP]);
  });

  it('treatment: a frame bringing a new id past the cap closes 1013 compacting and drains; one at the cap passes; deletes pass', () => {
    armed();
    const s = setup(withIds(CAP - 1), { caps: { clientIds: CAP } });
    const other = s.conn('other');
    expect(s.send(s.conn('a'), editAs(s.live, 5000, (d) => textOf(d).insert(0, 'k')))).toBe('applied'); // CAP ids
    expect(s.send(s.conn('a'), editAs(s.live, 5000, (d) => textOf(d).insert(0, 'k')))).toBe('applied'); // a known id
    const before = s.state();
    expect(s.send(s.conn('a'), editAs(s.live, 5001, (d) => textOf(d).insert(0, 'k')))).toBe(COMPACTING);
    expect(s.state().equals(before)).toBe(true);
    expect(compactionRequest(s.live)).toMatchObject({ reason: 'client_ids', drain: true });
    expect(other.webSocket.close).toHaveBeenCalledWith(COLLAB_TRY_LATER_CODE, COLLAB_PAGE_COMPACTING_REASON);
  });

  it('past the soft cap compaction is requested for the next unload (no drain)', () => {
    armed();
    const s = setup(withIds(softCap(CAP)), { caps: { clientIds: CAP } });
    expect(s.send(s.conn('a'), editAs(s.live, 5000, (d) => textOf(d).insert(0, 'k')))).toBe('applied');
    expect(compactionRequest(s.live)).toMatchObject({ reason: 'client_ids', drain: false });
  });

  it('before compaction is armed (a rolling deploy) the growth waits 1013, but nothing drains', () => {
    restoreClock = setCompactionClockForTests({ now: () => Date.now(), uptimeMs: () => 0 });
    const s = setup(withIds(CAP), { caps: { clientIds: CAP } });
    const other = s.conn('other');
    expect(s.send(s.conn('a'), editAs(s.live, 5001, (d) => textOf(d).insert(0, 'k')))).toBe(COMPACTING);
    expect(compactionRequest(s.live)).toMatchObject({ drain: false });
    expect(other.webSocket.close).not.toHaveBeenCalled();
  });
});

describe('#827 the struct and children caps (an honest select-all over a huge page is E·S)', () => {
  it('control: a select-all delete costs superlinearly in the live children of one element', () => {
    const cost = (n: number) => {
      const doc = paragraphs(n);
      const frame = editAs(doc, 9, (d) => d.getXmlFragment('default').delete(0, n));
      return unguarded(doc, frame);
    };
    cost(1000); // warm
    // CPU time, the least of three runs each: a GC pause or a burst on the runner only ever adds to one run
    const least = (n: number) => Math.min(cost(n), cost(n), cost(n));
    const small = Math.max(0.5, least(2_000));
    expect(least(16_000)).toBeGreaterThan(8 * small); // 8x the children, more than 8x the time
  });

  it('a frame adding a child past the children cap is page-full and drains nothing (compaction keeps every live child); a delete over the cap passes', () => {
    armed();
    const s = setup(paragraphs(20), { caps: { children: 20 } });
    const other = s.conn('other');
    expect(s.send(s.conn('a'), addParagraph(s.live, 70))).toBe(REFUSED('page-full'));
    expect(compactionRequest(s.live)).toBeNull();
    expect(isDraining(s.live)).toBe(false);
    expect(other.webSocket.close).not.toHaveBeenCalled();
    const s2 = setup(paragraphs(25), { caps: { children: 20 } });
    expect(s2.send(s2.conn('a'), editAs(s2.live, 71, (d) => d.getXmlFragment('default').delete(0, 2)))).toBe('applied');
  });

  it('the struct count moves by what each frame touched (splits and merges included), exact against the store', () => {
    const s = setup(paragraphs(10, 'hello'));
    const exact = () => [...s.guard.shadowOf(s.live)!.store.clients.values()].reduce((n, a) => n + a.length, 0);
    const frames = [
      () => editAs(s.live, 70, (d) => textOf(d).insert(0, 'k')),
      () => editAs(s.live, 70, (d) => textOf(d, 3).insert(2, 'mid')), // splits client 1's 'hello'
      () => editAs(s.live, 71, (d) => textOf(d, 4).delete(1, 2)), // splits, deletes
      () => editAs(s.live, 71, (d) => textOf(d, 4).delete(0, 3)), // the rest of it: merges back
      () =>
        editAs(s.live, 72, (d) => {
          (d.getXmlFragment('default').get(5) as Y.XmlElement).setAttribute('textAlign', 'center');
          (d.getXmlFragment('default').get(5) as Y.XmlElement).setAttribute('textAlign', 'left');
        }),
      () => editAs(s.live, 72, (d) => (d.getXmlFragment('default').get(5) as Y.XmlElement).setAttribute('textAlign', 'right')),
      () => editAs(s.live, 73, (d) => d.getXmlFragment('default').delete(6, 3)),
    ];
    for (const f of frames) {
      expect(s.send(s.conn('a'), f())).toBe('applied');
      expect(s.guard.pageCounts(s.live)!.structs).toBe(exact());
    }
  });

  it('a frame growing the page past the struct cap with LIVE structs (no history to shed) is page-full and drains nothing', () => {
    armed();
    const base = paragraphs(10);
    const s = setup(base, { caps: { structs: 60 } });
    expect(s.send(s.conn('a'), editAs(s.live, 70, (d) => textOf(d).insert(0, 'k')))).toBe('applied');
    expect(s.guard.pageCounts(s.live)!.structs).toBeLessThan(40);
    const grow = editAs(s.live, 70, (d) => {
      for (let i = 0; i < 40; i++) textOf(d, i % 10).insert(1, 'q');
    });
    expect(s.send(s.conn('a'), grow)).toBe(REFUSED('page-full'));
    expect(compactionRequest(s.live)).toBeNull();
    // the history-heavy case drains: '#827 a hard cap drains only when compaction would bring the page under the soft caps'
  });

  it('page-full: still over a cap after compaction, growth is refused 4422 and deletes pass', () => {
    const s = setup(paragraphs(25), { caps: { children: 20 } });
    markPageFull(s.live);
    expect(s.send(s.conn('a'), addParagraph(s.live, 70))).toBe(REFUSED('page-full'));
    expect(s.send(s.conn('b'), editAs(s.live, 71, (d) => d.getXmlFragment('default').delete(0, 1)))).toBe('applied');
  });

  it('page-full: over a cap again within the compaction interval of its lineage is marked full, never drained', () => {
    armed();
    const seed = paragraphs(20);
    writeLineage(seed, 1, Date.now() - 60_000);
    const s = setup(seed, { caps: { children: 20 } });
    const c = s.conn('a', false, 'cccEpoch=1');
    expect(s.send(c, addParagraph(s.live, 70))).toBe(REFUSED('page-full'));
    expect(isDraining(s.live)).toBe(false);
  });
});

describe('#827 a hard cap drains only when compaction would bring the page under the soft caps', () => {
  /** A ~3 MiB paste into `base` by `client`: `n` paragraphs of `text` (prose: two bold runs each), n sized to the cap. */
  const paste = (base: Y.Doc, client: number, text: string, bold: boolean) => {
    let n = Math.floor((2.9 * 1024 * 1024) / (text.length + (bold ? 124 : 6)));
    for (;;) {
      const update = editAs(base, client, (d) => {
        const ps = Array.from({ length: n }, () => {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          p.insert(0, [t]);
          if (bold) {
            t.insert(0, text.slice(40));
            t.insert(0, text.slice(20, 40), { bold: true });
            t.insert(0, text.slice(6, 20));
            t.insert(0, text.slice(0, 6), { bold: true });
          } else t.insert(0, text);
          return p;
        });
        d.getXmlFragment('default').insert(0, ps);
      });
      if (update.length <= 3 * 1024 * 1024) return { update, n };
      n = Math.floor(n * 0.97);
    }
  };
  const NO_DEADLINE = { deadlines: { frame: 60_000, load: 60_000, probe: 60_000, mirror: 60_000 } };
  const prose = 'Honest prose is mostly sentences of ordinary length, with a word in bold here and there, and paragraphs of a few lines. '.repeat(2).slice(0, 150);

  it('an honest 3 MiB paste of prose (150-byte paragraphs) into an empty page is accepted at the real caps', () => {
    armed();
    const s = setup(paragraphs(1), NO_DEADLINE);
    const { update, n } = paste(s.live, 70, prose, true);
    expect(update.length).toBeGreaterThan(2.85 * 1024 * 1024);
    expect(n).toBeGreaterThan(10_000); // past the 10k E_MAX this used to refuse
    expect(s.send(s.conn('a'), update)).toBe('applied');
    expect(s.live.getXmlFragment('default').length).toBe(n + 1);
    expect(compactionRequest(s.live)).toBeNull(); // under every soft cap: nothing to compact
  });

  it('a pathological dense paste (3 MiB of 8-byte paragraphs) is page-full at the real caps, and nothing drains', () => {
    armed();
    const s = setup(paragraphs(1), NO_DEADLINE);
    const other = s.conn('other');
    const before = s.state();
    const { update, n } = paste(s.live, 70, 'abcdefgh', false);
    expect(n).toBeGreaterThan(14_000); // past E_MAX and S_MAX in live content: no compaction can shed it
    expect(s.send(s.conn('a'), update)).toBe(REFUSED('page-full'));
    expect(s.state().equals(before)).toBe(true);
    expect(compactionRequest(s.live)).toBeNull();
    expect(isDraining(s.live)).toBe(false);
    expect(other.webSocket.close).not.toHaveBeenCalled();
    // the page is not marked full: a smaller paste still lands
    expect(s.send(s.conn('b'), paste(s.live, 71, prose, true).update)).toBe('applied');
  });

  /** `edits` single-character inserts each deleted again: tombstones only, the visible page unchanged. */
  const withHistory = (edits: number, n = 5) => {
    const doc = paragraphs(n, 'hello');
    for (let i = 0; i < edits; i++) {
      textOf(doc, i % n).insert(0, 'x');
      textOf(doc, i % n).delete(0, 1);
    }
    return doc;
  };

  it('a history-heavy page over the struct cap drains, and its compaction brings the growth back under the soft cap', () => {
    armed();
    const CAP = 200;
    const seed = withHistory(150);
    const s = setup(seed, { caps: { structs: CAP } });
    const other = s.conn('other');
    expect(s.send(s.conn('a'), editAs(s.live, 70, (d) => textOf(d).insert(0, 'k')))).toBe('applied');
    expect(s.guard.pageCounts(s.live)!.structs).toBeGreaterThan(softCap(CAP)); // soft: requested for the unload
    expect(compactionRequest(s.live)).toMatchObject({ reason: 'structs', drain: false });
    const grow = (doc: Y.Doc, client: number) =>
      editAs(doc, client, (d) => {
        for (let i = 0; i < 60; i++) textOf(d, i % 5).insert(1, 'q');
      });
    expect(s.send(s.conn('a'), grow(s.live, 70))).toBe(COMPACTING);
    expect(compactionRequest(s.live)).toMatchObject({ reason: 'structs', drain: true });
    expect(other.webSocket.close).toHaveBeenCalledWith(COLLAB_TRY_LATER_CODE, COLLAB_PAGE_COMPACTING_REASON);
    // compaction (the unload's build) keeps the visible page only: the resent growth fits on the new lineage
    const built = buildCompacted({ tree: snapshotTree(s.live.getXmlFragment('default')) }, [], 1, Date.now(), { digest: liveContentDigest(s.live) });
    expect(built.counts.structs).toBeLessThan(40);
    const compacted = new Y.Doc();
    Y.applyUpdate(compacted, built.update);
    const after = setup(compacted, { caps: { structs: CAP } });
    expect(after.send(after.conn('a', false, 'cccEpoch=1'), grow(after.live, 72))).toBe('applied');
    expect(after.guard.pageCounts(after.live)!.structs).toBeLessThan(softCap(CAP));
  });

  it('control: a page whose LIVE structs are past the soft cap is never asked to compact (soft) or drained (hard): page-full', () => {
    armed();
    const CAP = 200;
    const s = setup(paragraphs(55, 'hello'), { caps: { structs: CAP } }); // 165 live structs, past softCap(200) = 160
    const other = s.conn('other');
    expect(s.send(s.conn('a'), editAs(s.live, 70, (d) => textOf(d).insert(0, 'k')))).toBe('applied');
    expect(compactionRequest(s.live)).toBeNull(); // past the soft cap, but compaction would shed nothing
    const grow = editAs(s.live, 70, (d) => {
      for (let i = 0; i < 40; i++) textOf(d, i).insert(1, 'q');
    });
    expect(s.send(s.conn('a'), grow)).toBe(REFUSED('page-full'));
    expect(isDraining(s.live)).toBe(false);
    expect(other.webSocket.close).not.toHaveBeenCalled();
  });

  it('control: a history-heavy page whose live CHILDREN are past their soft cap is page-full on a struct cap (compaction keeps them)', () => {
    armed();
    const s = setup(withHistory(150, 9), { caps: { structs: 200, children: 10 } }); // 9 live paragraphs ≥ softCap(10) = 8
    const other = s.conn('other');
    const grow = editAs(s.live, 70, (d) => {
      for (let i = 0; i < 60; i++) textOf(d, i % 9).insert(1, 'q');
    });
    expect(s.send(s.conn('a'), grow)).toBe(REFUSED('page-full'));
    expect(isDraining(s.live)).toBe(false);
    expect(other.webSocket.close).not.toHaveBeenCalled();
    // the same when the children come with the frame itself (the editor would resend them onto the compacted page)
    const t = setup(withHistory(150, 5), { caps: { structs: 200, children: 10 } });
    const growWithChildren = editAs(t.live, 70, (d) => {
      for (let i = 0; i < 40; i++) textOf(d, i % 5).insert(1, 'q');
      d.getXmlFragment('default').insert(0, Array.from({ length: 4 }, () => new Y.XmlElement('paragraph'))); // 9 children
    });
    expect(t.send(t.conn('a'), growWithChildren)).toBe(REFUSED('page-full'));
    expect(isDraining(t.live)).toBe(false);
  });
});

describe('#827 frame-too-large, before any decode', () => {
  it('a Step2 or Update payload over the cap is refused, writer or reader; the pre-pass never decodes it', () => {
    const s = setup(paragraphs(1), { maxFrameBytes: 1000 });
    const spy = jest.spyOn(Y, 'decodeUpdate');
    const big = editAs(s.live, 70, (d) => textOf(d).insert(0, 'z'.repeat(2000)));
    expect(big.length).toBeGreaterThan(1000);
    expect(s.send(s.conn('a'), big)).toBe(REFUSED('frame-too-large'));
    expect(s.send(s.conn('r', true), big, SYNC.Step2)).toBe(REFUSED('frame-too-large'));
    expect(spy).not.toHaveBeenCalled();
    expect(s.send(s.conn('a2'), editAs(s.live, 71, (d) => textOf(d).insert(0, 'z'.repeat(500))))).toBe('applied');
  });
});

describe('#827 QueryAwareness and the reader Step2', () => {
  it('QueryAwareness is refused message-type (the 4.7.1 provider never sends it)', () => {
    const s = setup(paragraphs(1));
    expect(s.deliver(s.conn('a', true), typedFrame(MSG.QueryAwareness))).toBe(REFUSED('message-type'));
  });

  it("a reader's Step2 is charged to its CPU debt by its size and the page's structs, never refused on size", () => {
    const s = setup(paragraphs(200), { now: () => 1_000_000 });
    const step2 = Y.encodeStateAsUpdate(new RemoteClient(s.live).doc);
    const structs = [...s.live.store.clients.values()].reduce((n, a) => n + a.length, 0);
    expect(s.send(s.conn('r', true), step2, SYNC.Step2)).toBe('applied');
    expect(s.guard.cpuBalance('r')).toBeCloseTo(USER_COLLAB_CPU_BURST_MS - readerStep2ChargeMs(step2.length, structs), 6);
    // a 2 MiB one (the guard never decodes a reader's Step2; 4.7.1 snapshot-checks it): charged ~170 ms, not refused
    const big = new Uint8Array(2 * 1024 * 1024);
    const before = s.guard.cpuBalance('r2');
    expect(s.send(s.conn('r2', true), big, SYNC.Step2)).toBe('applied');
    expect(before - s.guard.cpuBalance('r2')).toBeCloseTo(readerStep2ChargeMs(big.length, structs), 6);
    expect(readerStep2ChargeMs(big.length, structs)).toBeGreaterThan(100);
  });

  it('a reader in CPU debt waits 1013 user_collab_cpu', () => {
    const s = setup(paragraphs(10), { now: () => 1_000_000 });
    s.guard.chargeLoad('r', USER_COLLAB_CPU_BURST_MS + 1, 1_000_000);
    expect(s.send(s.conn('r', true), Y.encodeStateAsUpdate(s.live), SYNC.Step2)).toBe(TRY_LATER);
  });
});

describe('#827 the mirror: echoes skipped, server-local updates bounded', () => {
  it('an accepted frame is applied to the shadow once (its live echo is skipped); a local update is mirrored', () => {
    const s = setup(paragraphs(2));
    expect(s.send(s.conn('w'), editAs(s.live, 70, (d) => textOf(d).insert(0, 'a')))).toBe('applied'); // builds the shadow
    const shadow = s.guard.shadowOf(s.live)!;
    const spy = jest.spyOn(Y, 'applyUpdate');
    expect(s.send(s.conn('w'), editAs(s.live, 70, (d) => textOf(d).insert(0, 'b')))).toBe('applied');
    expect(spy.mock.calls.filter(([doc]) => doc === shadow)).toHaveLength(1); // the inspect, not the echo
    s.live.transact(() => textOf(s.live).insert(0, 'api'), { source: 'local' });
    expect(spy.mock.calls.filter(([doc]) => doc === shadow)).toHaveLength(2);
    expect(textOf(shadow).toString()).toBe(textOf(s.live).toString());
  });

  it('a connection update the guard never inspected leaves the shadow stale: rebuilt, and charged to no one', async () => {
    let cpu = 0;
    const s = setup(paragraphs(2), { cpuNow: () => cpu, now: () => 1_000_000 });
    expect(s.send(s.conn('w'), editAs(s.live, 70, (d) => textOf(d).insert(0, 'a')))).toBe('applied');
    await settle();
    const shadow = s.guard.shadowOf(s.live);
    Y.applyUpdate(s.live, editAs(s.live, 71, (d) => textOf(d).insert(0, 'x')), { source: 'connection', connection: {} });
    const real = Y.applyUpdate;
    jest.spyOn(Y, 'applyUpdate').mockImplementation((doc: Y.Doc, u: Uint8Array, o?: unknown) => {
      if (doc !== shadow && typeof o === 'symbol' && o.description === 'ccc-collab-mirror') cpu += 500; // a rebuild
      return real(doc, u, o);
    });
    const balance = s.guard.cpuBalance('w2');
    expect(s.send(s.conn('w2'), editAs(s.live, 72, (d) => textOf(d).insert(0, 'y')))).toBe('applied');
    expect(s.guard.shadowOf(s.live)).not.toBe(shadow);
    expect(s.guard.cpuBalance('w2')).toBeGreaterThan(balance - 500); // the rebuild was the server's
  });

  it('a local update the mirror cannot apply in time drops the shadow and drains the page to compact', async () => {
    armed();
    const MIRROR = 7;
    const runner: DeadlineRunner = (fn, ms) => {
      if (ms === MIRROR) throw deadlineExceeded(ms);
      return fn();
    };
    const s = setup(paragraphs(2), { runWithDeadline: runner, deadlines: { mirror: MIRROR } });
    const editor = s.conn('editor');
    expect(s.send(editor, editAs(s.live, 70, (d) => textOf(d).insert(0, 'a')))).toBe('applied');
    s.live.transact(() => textOf(s.live).insert(0, 'api'), { source: 'local' }); // the mirror never throws
    expect(s.guard.shadowOf(s.live)).toBeNull();
    await settle();
    expect(compactionRequest(s.live)).toMatchObject({ reason: 'mirror_deadline', drain: true, userId: null });
    expect(editor.webSocket.close).toHaveBeenCalledWith(COLLAB_TRY_LATER_CODE, COLLAB_PAGE_COMPACTING_REASON);
  });

  it('a frame accepted but never applied by live is caught at the flush from its own clocks', async () => {
    const s = setup(paragraphs(2));
    expect(s.send(s.conn('w'), editAs(s.live, 70, (d) => textOf(d).insert(0, 'a')))).toBe('applied');
    const ghost = editAs(s.live, 71, (d) => textOf(d).insert(0, 'g'));
    expect(s.deliver(s.conn('w'), syncFrame(ghost))).toBe('applied'); // passed, never applied to live
    const shadow = s.guard.shadowOf(s.live);
    await settle();
    expect(s.send(s.conn('w'), editAs(s.live, 72, (d) => textOf(d).insert(0, 'b')))).toBe('applied');
    expect(s.guard.shadowOf(s.live)).not.toBe(shadow); // rebuilt from live
    expect(textOf(s.guard.shadowOf(s.live)!).toString()).toBe(textOf(s.live).toString());
  });
});

describe('#827 the guard pays no O(client ids) of its own per frame', () => {
  it("the frame path iterates neither live's id map nor the shadow's beyond Yjs's own per-transaction state vectors", async () => {
    const b = basePage('hello');
    Y.applyUpdate(b.doc, rawUpdate(Array.from({ length: 500 }, (_, i) => ({ client: 1000 + i, clock: 0, structs: [ch([1, b.first], [1, b.first + 1])] }))));
    const s = setup(b.doc);
    expect(s.send(s.conn('w'), editAs(s.live, 70, (d) => textOf(d).insert(0, 'a')))).toBe('applied');
    await settle();
    const count = (map: Map<number, unknown>) => {
      const n = { v: 0 };
      for (const m of ['forEach', 'keys', 'values', 'entries', Symbol.iterator] as const) {
        const orig = (map as any)[m].bind(map);
        (map as any)[m] = (...a: unknown[]) => (n.v++, orig(...a));
      }
      return n;
    };
    // Yjs's own: a transact with an apply iterates the store twice (beforeState, afterState)
    const control = new Y.Doc();
    Y.applyUpdate(control, Y.encodeStateAsUpdate(s.guard.shadowOf(s.live)!));
    const frame = editAs(s.live, 70, (d) => textOf(d).insert(0, 'b'));
    const yjsOwn = count(control.store.clients as Map<number, unknown>);
    Y.transact(control, () => Y.applyUpdate(control, frame), null, false);
    const liveIters = count(s.live.store.clients as Map<number, unknown>);
    const shadowIters = count(s.guard.shadowOf(s.live)!.store.clients as Map<number, unknown>);
    s.guard.check({ connection: s.conn('w'), document: s.live, update: syncFrame(frame), context: { user: { id: 'w' } } });
    expect(liveIters.v).toBe(0);
    expect(shadowIters.v).toBe(yjsOwn.v);
    Y.applyUpdate(s.live, frame, { source: 'connection', connection: {} });
    const before = liveIters.v;
    await settle(); // the flush checks the frame's own clocks only
    expect(liveIters.v).toBe(before);
  });
});

describe('#827 the lineage epoch, on each connection\'s first frame', () => {
  it('a copy of another lineage is refused epoch-stale:<N>, writers and readers, before anything is answered', () => {
    const seed = paragraphs(2);
    writeLineage(seed, 3, 1);
    const s = setup(seed);
    expect(s.deliver(s.conn('w', false, 'cccEpoch=2'), step1Frame(s.live))).toBe(epochStaleReason(3));
    expect(s.deliver(s.conn('r', true, ''), step1Frame(s.live))).toBe(epochStaleReason(3)); // absent = 0
    expect(s.deliver(s.conn('x', false, 'cccEpoch=03'), step1Frame(s.live))).toBe(epochStaleReason(3)); // not canonical
    const ok = s.conn('w', false, 'cccEpoch=3');
    expect(s.deliver(ok, step1Frame(s.live))).toBe('applied');
    expect(s.send(ok, editAs(s.live, 70, (d) => textOf(d).insert(0, 'a')))).toBe('applied');
  });

  it('an unset epoch is 0: every pre-compaction page and copy passes', () => {
    const s = setup(paragraphs(1));
    expect(s.deliver(s.conn('w'), step1Frame(s.live))).toBe('applied');
    expect(s.deliver(s.conn('w', false, 'cccEpoch=0'), step1Frame(s.live))).toBe('applied');
    expect(s.deliver(s.conn('w', false, 'cccEpoch=1'), step1Frame(s.live))).toBe(epochStaleReason(0));
  });

  it('report mode too; later frames of the connection get the same answer; the socket refusal budget is untouched', () => {
    const seed = paragraphs(1);
    writeLineage(seed, 1, 1);
    const s = setup(seed, { mode: 'report' });
    const c = s.conn('w');
    expect(s.deliver(c, step1Frame(s.live))).toBe(epochStaleReason(1));
    expect(s.deliver(c, awarenessFrame([{ clientID: 9, state: {} }]))).toBe(epochStaleReason(1));
    // more stale sessions on one socket than the refusal budget: the socket stays up (an honest stale tab per page)
    const ws = { close: jest.fn() };
    for (let i = 0; i < SOCKET_REFUSAL_BUDGET + 1; i++) {
      const session = s.conn('w');
      session.webSocket = ws;
      expect(s.deliver(session, step1Frame(s.live))).toBe(epochStaleReason(1));
    }
    expect(ws.close).not.toHaveBeenCalled();
  });
});

describe('#827 a document closed for compaction takes no frame, in any mode', () => {
  it.each([
    ['compacting', (d: Y.Doc) => markCompacting(d)],
    ['superseded', (d: Y.Doc) => markSuperseded(d, 4)],
    ['draining', (d: Y.Doc) => requestCompaction(d, { reason: 'structs', userId: null, drain: true })],
  ])('%s: every frame closes 1013 compacting (report mode too); a provider detach still passes', (_what, close) => {
    for (const mode of ['enforce', 'report'] as const) {
      const s = setup(paragraphs(1), { mode });
      close(s.live);
      expect(s.deliver(s.conn('w'), step1Frame(s.live))).toBe(COMPACTING);
      expect(s.deliver(s.conn('r', true), awarenessFrame([{ clientID: 9, state: {} }]))).toBe(COMPACTING);
      expect(s.deliver(s.conn('w'), typedFrame(MSG.Close))).toBe('applied');
      expect(s.guard.admitJoin(s.live, 'w')).toBe(false);
    }
  });

  it('a page not closed admits joins; a non-resident one too', () => {
    const s = setup(paragraphs(1));
    expect(s.guard.admitJoin(s.live, 'w')).toBe(true);
    expect(s.guard.admitJoin(undefined, 'w')).toBe(true);
  });
});
