import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { serverSchema } from '../page-write/prelim-content';
import { compactionRequest, isDraining, registerInflight, setCompactionClockForTests } from '../page-write/compaction-registry';
import { COMPACTION_ARM_DELAY_MS, COMPACTION_MIN_INTERVAL_MS } from './doc-bounds';
import { contentOf, processCpuMs, RemoteClient, renderLikeABrowser, step1Frame, syncFrame } from './collab-ingress.testkit';
import { ConflictScan, CONFLICT_SCAN_STEPS_PER_FRAME, installConflictScanMeter } from './conflict-scan';
import { rawUpdate, type RawId, type RawStruct } from './conflict-scan.testkit';
import { checkElement } from './content-rules';
import { EXACT_REPLICA_CAPS, ExactReplicaLog } from './exact-replica';
import { attachReplicaLog, LOG_OUT_OF_ORDER, LOG_OVER_CAP, LOG_OVER_TOTAL, replicaLogDistrust, replicaLogOf, replicaLogTotal, setReplicaLogTotalForTests } from './exact-replica-registry';
import { isReloadStable, strictOrderDiff } from './order-parity';
import { SocketLimitLog } from './socket-limit-log';
import {
  COLLAB_REFUSAL_CODE,
  COLLAB_TRY_LATER_CODE,
  CollabUpdateGuard,
  ORDER_HOLD_MS,
  TRY_LATER_REASON,
  USER_COLLAB_CPU_BURST_MS,
  type DocCaps,
  type GuardDocument,
} from './update-guard';

/**
 * #840 (ADR 0036): the guard decides on an EXACT image of live. A shadow rebuilt by reload took the order a reload gives,
 * not live's, so (T1, the harm evidence's own frames) a 6-byte delete passed that left live's listItem invalid by the
 * guard's own rules, and a 16 KB frame was metered at 999 steps while live walked 20,000,999. Rebuilds now keep a reload
 * only when it strict-equals live and otherwise replay live's own inputs, verified by a strict compare (the tripwire).
 * Joiners are answered only when the page is reload-stable; unstable pages heal, and the users whose items contradict
 * their own origins are struck and, at two strikes, held at 1013 (T6). Every attack has a control arm on an unguarded
 * copy, and the reload rebuild's verdict is shown beside the exact one (T7's anti-vacuity: with the rebuild reverted to
 * a reload, the T1 specs fail; checked by mutation).
 */
const REFUSED = (rule: string) => `ccc:collab-update-refused:${rule}`;
const TRY_LATER = 'try-later';
const A = 1000; // the attacker's client id

type Conn = { readOnly: boolean; webSocket: { close: jest.Mock }; context: { user: { id: string } } };
let pages = 0;

function harness(opts: { base?: Y.Doc; bytes?: Uint8Array; attach?: boolean; caps?: Partial<DocCaps>; now?: () => number; cpuNow?: () => number; guard?: CollabUpdateGuard; name?: string } = {}) {
  const live = new Y.Doc() as GuardDocument & { name: string };
  live.name = opts.name ?? `page.00000000-0000-4000-8000-${String(++pages).padStart(12, '0')}`;
  const bytes = opts.bytes ?? Y.encodeStateAsUpdate(opts.base ?? listPage().doc);
  Y.applyUpdate(live, bytes);
  if (opts.attach) attachReplicaLog(live, bytes); // what the persistence load does
  const logs: string[] = [];
  const limitLogs: string[] = [];
  const guard =
    opts.guard ??
    new CollabUpdateGuard({
      mode: 'enforce',
      logger: { warn: (m: string) => logs.push(m) },
      limitLog: new SocketLimitLog({ warn: (m: string) => limitLogs.push(m) }),
      now: opts.now,
      cpuNow: opts.cpuNow,
      caps: opts.caps,
      schedule: () => ({ cancel: () => undefined }), // probes run only by `probeNow`
    });
  const conn = (id: string, readOnly = false): Conn => ({ readOnly, webSocket: { close: jest.fn() }, context: { user: { id } } });
  let lastLiveMs = 0;
  /** One frame through the guard; when it passes, applied as Hocuspocus 4.7.1 applies it (the connection as origin). */
  const deliver = (c: Conn, frame: Uint8Array, apply?: Uint8Array): string => {
    try {
      guard.check({ connection: c, document: live, update: frame, context: c.context });
    } catch (err: any) {
      if (err?.code === COLLAB_TRY_LATER_CODE && err?.reason === TRY_LATER_REASON) return TRY_LATER;
      expect(err).toEqual({ code: COLLAB_REFUSAL_CODE, reason: expect.any(String) });
      return err.reason;
    }
    if (apply) {
      const t0 = processCpuMs();
      Y.applyUpdate(live, apply, { source: 'connection', connection: c });
      lastLiveMs = processCpuMs() - t0;
    }
    return 'applied';
  };
  const send = (c: Conn, update: Uint8Array) => deliver(c, syncFrame(update), update);
  /** A provider opening the page: its Step1 (an empty state vector: a fresh tab). */
  const join = (c: Conn) => deliver(c, step1Frame(new Y.Doc()));
  const divergence = () => logs.filter((l) => l.startsWith('COLLAB_ORDER_DIVERGENCE ')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
  const limits = () => limitLogs.map((l) => JSON.parse(l.slice(l.indexOf('{'))).limit);
  return { live, guard, logs, limitLogs, conn, deliver, send, join, divergence, limits, liveMs: () => lastLiveMs };
}

/** `default` > [bulletList > listItem > paragraph "keep me", paragraph "other honest block"], by client 50. */
function listPage() {
  const doc = new Y.Doc();
  doc.clientID = 50;
  const f = doc.getXmlFragment('default');
  const [bl, li, p, t, q, qt] = [new Y.XmlElement('bulletList'), new Y.XmlElement('listItem'), new Y.XmlElement('paragraph'), new Y.XmlText(), new Y.XmlElement('paragraph'), new Y.XmlText()];
  doc.transact(() => {
    f.insert(0, [bl, q]);
    bl.insert(0, [li]);
    li.insert(0, [p]);
    p.insert(0, [t]);
    t.insert(0, 'keep me');
    q.insert(0, [qt]);
    qt.insert(0, 'other honest block');
  });
  return { doc, pA: idOf(p) };
}
const countStructs = (doc: Y.Doc) => [...doc.store.clients.values()].reduce((n, structs) => n + structs.length, 0);
const idOf = (type: Y.AbstractType<any>): RawId => [type._item!.id.client, type._item!.id.clock];
const el = (name: string) => new Y.ContentType(new Y.XmlElement(name));
const listItemOf = (doc: Y.Doc) => ((doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlElement);
const childNames = (doc: Y.Doc) => listItemOf(doc).toArray().map((c) => (c as Y.XmlElement).nodeName);
const reloadOf = (doc: Y.Doc) => {
  const r = new Y.Doc({ gc: doc.gc });
  Y.applyUpdate(r, Y.encodeStateAsUpdate(doc));
  return r;
};
const applied = (doc: Y.Doc, update: Uint8Array) => {
  Y.applyUpdate(doc, update);
  return doc;
};
/** An exact copy of live: its replay log rebuilt (a reload is NOT one: that is the point). */
const exactCopy = (live: Y.Doc) => {
  const copy = replicaLogOf(live)!.rebuild({ gc: live.gc });
  expect(strictOrderDiff(copy, live)).toBeNull();
  return copy;
};

/**
 * F1 (78 bytes, the harm evidence's frame): after the listItem's paragraph pA, a deleted run A:0-5, then a bulletList
 * with origin A:5 and rightOrigin A:3 (its own run: the rightOrigin's split shortens the struct the origin was read
 * from), its listItem > paragraph, and a paragraph between A:4 and A:5. Live: [pA, bulletList, paragraph]; a reload:
 * [pA, paragraph, bulletList]. Valid in both, unstable.
 */
function f1(pA: RawId, client = A): Uint8Array {
  return rawUpdate([
    {
      client,
      clock: 0,
      structs: [
        { origin: pA, right: null, content: new Y.ContentDeleted(6) },
        { origin: [client, 5], right: [client, 3], content: el('bulletList') },
        { origin: null, right: null, parent: [client, 6], content: el('listItem') },
        { origin: null, right: null, parent: [client, 7], content: el('paragraph') },
        { origin: [client, 4], right: [client, 5], content: el('paragraph') },
      ] as RawStruct[],
    },
  ]);
}
/** F2 (6 bytes): delete pA. On live the listItem is left [bulletList, paragraph]: invalid ("paragraph block*"). */
const f2 = (pA: RawId) => rawUpdate([], [{ client: pA[0], ranges: [[pA[1], 1]] }]);
/** A frame the SHADOW step refuses (a paragraph inside pA), so the shadow is left dirty and the next frame rebuilds it. */
const refusedInShadow = (live: Y.Doc) => new RemoteClient(live).edit(live, (f) => {
  const pA = ((f.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
  pA.insert(0, [new Y.XmlElement('paragraph')]);
});
/** FW: a comb of `n` paragraphs after A:5 (each after the last); on live it hangs after A:5, on a reload after A:6. */
const fw = (n: number, client = 2000) =>
  rawUpdate([{ client, clock: 0, structs: Array.from({ length: n }, (_, i): RawStruct => ({ origin: i ? [client, i - 1] : [A, 5], right: null, content: el('paragraph') })) }]);
/** FZ: `k` paragraphs between A:5 and A:6 (adjacent on a reload; on live the whole comb lies between): k x n steps on live. */
const fz = (k: number, client = 3000) =>
  rawUpdate([{ client, clock: 0, structs: Array.from({ length: k }, (): RawStruct => ({ origin: [A, 5], right: [A, 6], content: el('paragraph') })) }]);
/** An honest edit of the second root paragraph. */
const honestEdit = (live: Y.Doc, s = 'x') => new RemoteClient(live).edit(live, (f) => ((f.get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0, s));
/** Walk steps of `frame` on `doc` (applied; unbounded: the control arm's count). */
const stepsOn = (doc: Y.Doc, frame: Uint8Array) => {
  const scan = new ConflictScan(doc, false, Infinity);
  installConflictScanMeter(Y).metered(scan, () => Y.applyUpdate(doc, frame));
  return scan.steps;
};

describe('#840 T1: the harm sequence through the real guard', () => {
  it('F1, any refused frame, then a 6-byte delete: REFUSED schema (control: live is left invalid; the reload rebuild accepted it)', () => {
    const { doc: base, pA } = listPage();
    const s = harness({ base });
    expect(s.send(s.conn('attacker'), f1(pA))).toBe('applied');
    expect(f1(pA).length).toBe(78);
    expect(childNames(s.live)).toEqual(['paragraph', 'bulletList', 'paragraph']);
    expect(childNames(reloadOf(s.live))).toEqual(['paragraph', 'paragraph', 'bulletList']); // the old rebuild's order
    expect(s.send(s.conn('attacker'), refusedInShadow(s.live))).toBe(REFUSED('schema'));
    const F2 = f2(pA);
    expect(F2.length).toBe(6);
    // control: the reload rebuild's verdict (valid) and live's (invalid by the guard's own rules)
    expect(checkElement(listItemOf(applied(reloadOf(s.live), F2))).ok).toBe(true);
    const control = applied(exactCopy(s.live), F2);
    expect(checkElement(listItemOf(control))).toMatchObject({ ok: false, violation: { rule: 'schema', node: 'listItem' } });
    expect(childNames(control)).toEqual(['bulletList', 'paragraph']);
    // treatment
    const before = Y.encodeStateAsUpdate(s.live);
    expect(s.send(s.conn('attacker-2'), F2)).toBe(REFUSED('schema'));
    expect(Buffer.from(Y.encodeStateAsUpdate(s.live)).equals(Buffer.from(before))).toBe(true);
    expect(strictOrderDiff(s.guard.shadowOf(s.live)!, s.live)).not.toBeNull(); // it holds the refused F2: dirty again
    expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe('applied'); // and a co-editor goes on
    expect(strictOrderDiff(s.guard.shadowOf(s.live)!, s.live)).toBeNull(); // rebuilt exact (by replay: live is unstable)
    expect(s.divergence()).toEqual([]);
  });

  it('FZ over a 20,000-paragraph comb trips the 1M-step cap on the exact shadow; a smaller FZ is charged at least live\'s apply', () => {
    const { doc: base, pA } = listPage();
    const s = harness({ base, caps: { children: 1_000_000, structs: 1_000_000 }, now: () => 1_000_000, cpuNow: processCpuMs });
    expect(s.send(s.conn('attacker'), f1(pA))).toBe('applied');
    expect(s.send(s.conn('attacker'), refusedInShadow(s.live))).toBe(REFUSED('schema'));
    expect(s.send(s.conn('comb'), fw(20_000))).toBe('applied'); // the rebuild before it replays (live is unstable)
    const FZ = fz(1_000);
    expect(FZ.length).toBeLessThan(20_000); // ~18 KB
    // control: the same frame, metered on a reload (the old rebuild) and on an exact copy of live
    expect(stepsOn(reloadOf(s.live), fz(60))).toBeLessThan(100);
    expect(stepsOn(exactCopy(s.live), fz(60))).toBeGreaterThan(CONFLICT_SCAN_STEPS_PER_FRAME); // 60 x 20,000
    const before = Y.encodeStateVector(s.live);
    expect(s.send(s.conn('z'), FZ)).toBe(REFUSED('conflict-scan'));
    expect(Buffer.from(Y.encodeStateVector(s.live)).equals(Buffer.from(before))).toBe(true);
    expect(s.logs.find((l) => l.includes('"rule":"conflict-scan"'))).toMatch(/"steps":10000\d\d/);
    // 40 x 20,000 = 800,000 steps: under the cap, accepted; its sender pays for live's apply as well as the shadow's
    expect(s.send(s.conn('z2'), fz(40, 3100))).toBe('applied');
    const charged = USER_COLLAB_CPU_BURST_MS - s.guard.cpuBalance('z2');
    expect(s.liveMs()).toBeGreaterThan(5);
    expect(charged).toBeGreaterThanOrEqual(s.liveMs());
    expect(strictOrderDiff(exactCopy(s.live), s.live)).toBeNull();
  });
});

describe('#840 the rebuild: reload when it is live, replay otherwise, and the tripwire', () => {
  /** A paragraph "abcdef" (one struct by client 1) and S1: 'X' with origin 1:5 and rightOrigin 1:3. Live "abcXdef"; a
   *  reload "abcdefX"; a reload of that "abcXdef" again (S1 flips on every reload). */
  function s1Page() {
    const doc = new Y.Doc();
    doc.clientID = 1;
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    doc.transact(() => {
      doc.getXmlFragment('default').insert(0, [p]);
      p.insert(0, [t]);
      t.insert(0, 'abcdef');
    });
    const first = (t as any)._start.id.clock as number;
    const s1 = rawUpdate([{ client: 2, clock: 0, structs: [{ origin: [1, first + 5], right: [1, first + 3], content: new Y.ContentString('X') }] }]);
    return { doc, s1 };
  }
  const textOf = (doc: Y.Doc) => ((doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).toString();

  it('a page loaded from unstable bytes (a legacy row): with the load bytes attached its writers go on; with none, they wait and it heals', () => {
    const { doc, s1 } = s1Page();
    Y.applyUpdate(doc, s1);
    const stored = Y.encodeStateAsUpdate(doc);
    for (const attach of [true, false]) {
      const s = harness({ bytes: stored, attach });
      expect(textOf(s.live)).toBe('abcdefX');
      expect(isReloadStable(s.live).stable).toBe(false);
      const result = s.send(s.conn('editor'), honestEdit2(s.live));
      if (attach) {
        expect(result).toBe('applied');
        expect(strictOrderDiff(s.guard.shadowOf(s.live)!, s.live)).toBeNull();
        expect(s.divergence()).toEqual([]);
      } else {
        expect(result).toBe(TRY_LATER); // no exact shadow can be built: fail closed, retryable
        expect(s.limits()).toContain('order_divergence');
        expect(s.divergence()).toEqual([expect.objectContaining({ where: 'rebuild', outcome: 'log_untrusted', suspects: [] })]);
        expect(compactionRequest(s.live)).toMatchObject({ reason: 'order_divergence' });
        expect(s.send(s.conn('editor'), honestEdit2(s.live))).toBe(TRY_LATER); // until it heals
      }
    }
  });
  const honestEdit2 = (live: Y.Doc) => new RemoteClient(live).edit(live, (f) => ((f.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'y'));

  it('T7 (planted nondeterminism): a replay that differs from live fires the tripwire: writers and joiners wait, the page heals', () => {
    const { doc: base, pA } = listPage();
    const s = harness({ base });
    expect(s.send(s.conn('attacker'), f1(pA))).toBe('applied');
    expect(s.send(s.conn('attacker'), refusedInShadow(s.live))).toBe(REFUSED('schema'));
    const real = ExactReplicaLog.prototype.rebuild;
    const spy = jest.spyOn(ExactReplicaLog.prototype, 'rebuild').mockImplementation(function (this: ExactReplicaLog, opts, into) {
      const doc = real.call(this, opts, into);
      doc.getMap('planted').set('k', 1); // what a yjs bump that changed integration would look like: a replay that is not live
      return doc;
    });
    try {
      expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe(TRY_LATER);
      expect(s.divergence()).toEqual([expect.objectContaining({ where: 'rebuild', outcome: 'tripwire', suspects: ['attacker'] })]);
      expect(replicaLogDistrust(s.live)).toBe('tripwire');
      expect(s.join(s.conn('reader', true))).toBe(TRY_LATER);
      expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe(TRY_LATER);
      expect(compactionRequest(s.live)).toMatchObject({ reason: 'order_divergence' });
    } finally {
      spy.mockRestore();
    }
  });

  it('a reload-stable page rebuilds from a reload and advances the log\'s checkpoint (the log stays one store debounce long)', () => {
    const s = harness({ attach: true });
    for (let i = 0; i < 5; i++) expect(s.send(s.conn('editor'), honestEdit(s.live, `${i}`))).toBe('applied');
    expect(replicaLogOf(s.live)!.entries).toBe(5);
    expect(s.send(s.conn('attacker'), refusedInShadow(s.live))).toBe(REFUSED('schema'));
    expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe('applied');
    expect(replicaLogOf(s.live)!.entries).toBe(1); // the rebuild's reload was live: the checkpoint moved to it
    expect(strictOrderDiff(exactCopy(s.live), s.live)).toBeNull();
  });

  it('frames live applies out of the order the guard accepted them in: the shadow is rebuilt and verified before the next frame', () => {
    const s = harness({ attach: true });
    const [a, b] = [s.conn('a'), s.conn('b')];
    const fa = honestEdit(s.live, 'aaa');
    const fb = new RemoteClient(s.live).edit(s.live, (f) => (f.get(1) as Y.XmlElement).setAttribute('textAlign', 'center'));
    expect(s.deliver(a, syncFrame(fa))).toBe('applied'); // accepted, not applied yet
    expect(s.deliver(b, syncFrame(fb))).toBe('applied');
    Y.applyUpdate(s.live, fb, { source: 'connection', connection: b }); // b's first: not the order the shadow took
    Y.applyUpdate(s.live, fa, { source: 'connection', connection: a });
    expect(replicaLogDistrust(s.live)).toBe(LOG_OUT_OF_ORDER);
    const shadowBefore = s.guard.shadowOf(s.live);
    expect(s.join(s.conn('reader', true))).toBe('applied'); // a join re-verifies first too
    expect(s.guard.shadowOf(s.live)).not.toBe(shadowBefore); // rebuilt (its reload was live: the log re-armed)
    expect(replicaLogOf(s.live)).not.toBeNull();
    expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe('applied');
    expect(strictOrderDiff(s.guard.shadowOf(s.live)!, s.live)).toBeNull();
    expect(s.divergence()).toEqual([]);
  });

  it('the log never outgrows its cap: an entry that does not fit drops it, and the next frame checkpoints (stable) or heals (not)', () => {
    // Insert-then-delete keeps the page tiny while every inserted byte stays in the log: no cap of the page sees it.
    const MiB = 1024 * 1024;
    const s = harness({ attach: true, cpuNow: () => 0 });
    const editor = s.conn('editor');
    let peak = 0;
    let overs = 0;
    for (let i = 0; i < 10; i++) {
      const big = 'y'.repeat(MiB);
      const insert = () => honestEdit(s.live, big);
      const remove = () => new RemoteClient(s.live).edit(s.live, (f) => ((f.get(1) as Y.XmlElement).get(0) as Y.XmlText).delete(0, MiB));
      for (const frame of [insert, remove]) {
        expect(s.send(editor, frame())).toBe('applied');
        // past its caps the registry stops trusting it (its bytes go); the next frame re-arms it from a stable reload
        if (replicaLogDistrust(s.live) === LOG_OVER_CAP) overs++;
        peak = Math.max(peak, replicaLogOf(s.live)?.retained ?? 0);
      }
    }
    expect(overs).toBeGreaterThan(0); // anti-vacuity: it did reach the cap
    expect(peak).toBeGreaterThan(4 * MiB);
    expect(peak).toBeLessThanOrEqual(EXACT_REPLICA_CAPS.maxBytes); // retained, by capacity: no doubling past the cap
    expect(s.send(editor, honestEdit(s.live))).toBe('applied');
    expect(replicaLogOf(s.live)!.bytes).toBeLessThan(EXACT_REPLICA_CAPS.maxBytes);
    expect(strictOrderDiff(exactCopy(s.live), s.live)).toBeNull();
    expect(s.divergence()).toEqual([]);
  });
});

describe('#840 the process total of replay logs (#679: native memory)', () => {
  it('many pages growing past the total stay within it; each distrusted log re-arms at its next frame (stable) or the page heals (not)', () => {
    const KiB = 1024;
    const LIMIT = 512 * KiB;
    const restore = setReplicaLogTotalForTests(LIMIT);
    try {
      const logs: string[] = [];
      const guard = new CollabUpdateGuard({
        mode: 'enforce',
        logger: { warn: (m: string) => logs.push(m) },
        limitLog: new SocketLimitLog({ warn: () => undefined }),
        cpuNow: () => 0,
        schedule: () => ({ cancel: () => undefined }),
      });
      const stable = Array.from({ length: 10 }, () => harness({ attach: true, guard }));
      // a legacy unstable row, its load bytes attached: its writers go on (replay) until its log is distrusted
      const unstableRow = (() => {
        const doc = new Y.Doc();
        doc.clientID = 1;
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        doc.transact(() => {
          doc.getXmlFragment('default').insert(0, [p, new Y.XmlElement('paragraph')]);
          p.insert(0, [t]);
          t.insert(0, 'abcdef');
          (doc.getXmlFragment('default').get(1) as Y.XmlElement).insert(0, [new Y.XmlText()]);
        });
        const first = (t as any)._start.id.clock as number;
        Y.applyUpdate(doc, rawUpdate([{ client: 2, clock: 0, structs: [{ origin: [1, first + 5], right: [1, first + 3], content: new Y.ContentString('X') }] }]));
        return Y.encodeStateAsUpdate(doc);
      })();
      const shaky = harness({ bytes: unstableRow, attach: true, guard });
      expect(isReloadStable(shaky.live).stable).toBe(false);
      const pages = [...stable.map((p) => ({ p, size: 24 * KiB })), { p: shaky, size: 64 * KiB }];
      let peak = 0;
      let rearmed = 0;
      let healed = false;
      for (let round = 0; round < 12; round++) {
        for (const { p, size } of pages) {
          const editor = p.conn('editor');
          const was = replicaLogDistrust(p.live);
          const result = p.send(editor, honestEdit(p.live, 'w'.repeat(size)));
          peak = Math.max(peak, replicaLogTotal());
          if (was !== LOG_OVER_TOTAL) continue;
          // the frame after the distrust re-verified the page first
          if (p === shaky) {
            expect(result).toBe(TRY_LATER);
            const lines = logs.filter((l) => l.startsWith('COLLAB_ORDER_DIVERGENCE ')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
            expect(lines).toContainEqual(expect.objectContaining({ where: 'rebuild', outcome: 'log_over_total' }));
            expect(compactionRequest(p.live)).toMatchObject({ reason: 'order_divergence' });
            healed = true;
          } else {
            expect(result).toBe('applied');
            expect(replicaLogOf(p.live)).not.toBeNull(); // re-armed from the stable reload
            expect(strictOrderDiff(exactCopy(p.live), p.live)).toBeNull();
            rearmed++;
          }
        }
      }
      expect(rearmed).toBeGreaterThan(5); // anti-vacuity: the total was reached and stable pages re-armed
      expect(healed).toBe(true);
      expect(peak).toBeLessThanOrEqual(LIMIT);
    } finally {
      restore();
    }
  });
});

describe('#840 new rules: parent-split and keyed-split (#847) are refused 4422', () => {
  it('a keyed item holding two values (#847 M2): refused keyed-split (control: split by a delete, it wedges live\'s cleanup)', () => {
    const { doc: base } = listPage();
    const s = harness({ base });
    const q = s.live.getXmlFragment('default').get(1) as Y.XmlElement;
    const k1 = rawUpdate([{ client: 9, clock: 0, structs: [{ origin: null, right: null, parent: idOf(q), sub: 'textAlign', content: new Y.ContentAny(['left', 'center']) }] }]);
    const k2 = rawUpdate([], [{ client: 9, ranges: [[1, 1]] }]);
    // control: k1, then a delete of its second value, then an honest delete of the paragraph: Item.gc throws in cleanup
    const control = new Y.Doc();
    Y.applyUpdate(control, Y.encodeStateAsUpdate(s.live));
    Y.applyUpdate(control, k1);
    Y.applyUpdate(control, k2);
    expect(() => control.getXmlFragment('default').delete(1, 1)).toThrow();
    expect((control as any)._transactionCleanups.length).toBeGreaterThan(0); // wedged for good
    // treatment: both shapes, as two frames and as one
    expect(s.send(s.conn('attacker'), k1)).toBe(REFUSED('keyed-split'));
    const both = rawUpdate([{ client: 9, clock: 0, structs: [{ origin: null, right: null, parent: idOf(q), sub: 'textAlign', content: new Y.ContentAny(['left', 'center']) }] }], [{ client: 9, ranges: [[1, 1]] }]);
    expect(s.send(s.conn('attacker'), both)).toBe(REFUSED('keyed-split'));
    // honest attribute writes pass
    expect(s.send(s.conn('editor'), new RemoteClient(s.live).edit(s.live, (f) => (f.get(1) as Y.XmlElement).setAttribute('textAlign', 'center')))).toBe('applied');
    expect(s.live.getXmlFragment('default').delete(1, 1)).toBeUndefined();
  });

  it('an item re-sent with an origin in another text is linked beside the first: refused parent-split', () => {
    const base = new Y.Doc();
    base.clientID = 1;
    const [p, c, pt, ct] = [new Y.XmlElement('paragraph'), new Y.XmlElement('codeBlock'), new Y.XmlText(), new Y.XmlText()];
    base.transact(() => {
      base.getXmlFragment('default').insert(0, [p, c]);
      p.insert(0, [pt]);
      c.insert(0, [ct]);
      pt.insert(0, 'one');
      ct.insert(0, 'two');
    });
    const s = harness({ base });
    const q = new RemoteClient(s.live, 777);
    expect(s.send(s.conn('attacker'), q.edit(s.live, (f) => ((f.get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(3, 'q')))).toBe('applied');
    const o = (pt as any)._start.id as Y.ID; // 'one' is one struct
    const split = rawUpdate([{ client: 777, clock: 0, structs: [{ origin: [o.client, o.clock + 2], right: null, content: new Y.ContentString('zb') }] }]);
    expect(s.send(s.conn('attacker'), split)).toBe(REFUSED('parent-split'));
  });
});

describe('#840 the join gate: a joiner is answered only from a reload-stable page', () => {
  it('a stable page is answered; checked once per mutation of the page; F1 makes it unstable: 1013, logged, the sender struck, it heals', () => {
    const { doc: base, pA } = listPage();
    const s = harness({ base });
    const encode = jest.spyOn(Y, 'encodeStateAsUpdate');
    try {
      expect(s.join(s.conn('reader', true))).toBe('applied');
      const after = encode.mock.calls.length;
      expect(s.join(s.conn('reader-2', true))).toBe('applied');
      expect(encode.mock.calls.length).toBe(after); // cached: nothing changed since
      expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe('applied');
      expect(s.join(s.conn('reader-3', true))).toBe('applied');
      expect(encode.mock.calls.length).toBeGreaterThan(after); // a mutation: checked again
    } finally {
      encode.mockRestore();
    }
    expect(s.send(s.conn('attacker'), f1(pA))).toBe('applied');
    expect(s.guard.suspectsOf(s.live)).toEqual(['attacker']); // A:6's origin lies to its right
    expect(s.join(s.conn('reader', true))).toBe(TRY_LATER);
    expect(s.limits()).toContain('order_divergence');
    expect(s.divergence()).toEqual([expect.objectContaining({ where: 'join', outcome: 'unstable', suspects: ['attacker'] })]);
    expect(compactionRequest(s.live)).toMatchObject({ reason: 'order_divergence', userId: 'attacker' });
    expect(s.guard.suspectsOf(s.live)).toEqual([]); // struck once: the suspicion is spent
    expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe('applied'); // writers are not refused for it
  });

  it('a reconnect storm of empty Step2s (each a live transaction) leaves the join cached: nothing a joiner gets changed', async () => {
    const s = harness();
    expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe('applied');
    await new Promise((r) => setImmediate(r));
    expect(s.join(s.conn('reader', true))).toBe('applied');
    const empty = Y.encodeStateAsUpdate(new Y.Doc());
    const encodes = jest.spyOn(Y, 'encodeStateAsUpdate');
    try {
      for (let i = 0; i < 5; i++) {
        const writer = s.conn(`writer-${i}`);
        expect(s.deliver(writer, syncFrame(empty, 1), empty)).toBe('applied');
        expect(s.join(writer)).toBe('applied');
      }
      expect(encodes).not.toHaveBeenCalled();
      expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe('applied'); // a real change: checked again
      expect(s.join(s.conn('reader-2', true))).toBe('applied');
      expect(encodes).toHaveBeenCalled();
    } finally {
      encodes.mockRestore();
    }
  });

  it('the check covers the frames in flight (the joiner\'s Step2 is encoded after they apply): live alone is stable', () => {
    const { doc: base, pA } = listPage();
    const s = harness({ base });
    const attacker = s.conn('attacker');
    const frame = f1(pA);
    expect(s.deliver(attacker, syncFrame(frame))).toBe('applied'); // accepted, not applied yet
    expect(isReloadStable(s.live).stable).toBe(true);
    expect(s.join(s.conn('reader', true))).toBe(TRY_LATER);
    Y.applyUpdate(s.live, frame, { source: 'connection', connection: attacker });
    expect(isReloadStable(s.live).stable).toBe(false); // what the joiner would have been served
  });

  it('with a frame in flight both orders are checked: live unstable and the shadow stable is not answered either', () => {
    // A legacy unstable row (S1 in the first paragraph), its load bytes attached; a writer's frame deletes that paragraph.
    // Live plus the frame reloads stable, live alone does not: a joiner whose Step2 is encoded before the frame applies
    // builds a reload of live.
    const doc = new Y.Doc();
    doc.clientID = 1;
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    const q = new Y.XmlElement('paragraph');
    doc.transact(() => {
      doc.getXmlFragment('default').insert(0, [p, q]);
      p.insert(0, [t]);
      t.insert(0, 'abcdef');
      q.insert(0, [new Y.XmlText('other')]);
    });
    const first = (t as any)._start.id.clock as number;
    Y.applyUpdate(doc, rawUpdate([{ client: 2, clock: 0, structs: [{ origin: [1, first + 5], right: [1, first + 3], content: new Y.ContentString('X') }] }]));
    const s = harness({ bytes: Y.encodeStateAsUpdate(doc), attach: true });
    expect(isReloadStable(s.live).stable).toBe(false);
    const editor = s.conn('editor');
    const drop = new RemoteClient(s.live).edit(s.live, (f) => f.delete(0, 1));
    expect(s.deliver(editor, syncFrame(drop))).toBe('applied'); // accepted, not applied yet
    expect(isReloadStable(s.guard.shadowOf(s.live)!).stable).toBe(true); // live plus the frame: stable
    expect(s.join(s.conn('reader', true))).toBe(TRY_LATER); // live alone is not
    expect(s.divergence()).toEqual([expect.objectContaining({ where: 'join', outcome: 'unstable' })]);
    Y.applyUpdate(s.live, drop, { source: 'connection', connection: editor });
    // control: a stable page with an honest frame in flight is answered (both orders reload into themselves)
    const ok = harness();
    const writer = ok.conn('writer');
    const edit = honestEdit(ok.live);
    expect(ok.deliver(writer, syncFrame(edit))).toBe('applied');
    expect(ok.join(ok.conn('reader', true))).toBe('applied');
    Y.applyUpdate(ok.live, edit, { source: 'connection', connection: writer });
  });

  it('a join that must rebuild while a frame is in flight still checks live plus that frame (the rebuild\'s reload is live alone)', () => {
    const { doc: base, pA } = listPage();
    const s = harness({ base });
    const attacker = s.conn('attacker');
    const frame = f1(pA);
    expect(s.deliver(attacker, syncFrame(frame))).toBe('applied'); // accepted, not applied yet
    expect(s.deliver(s.conn('other'), syncFrame(refusedInShadow(s.live)))).toBe(REFUSED('schema')); // dirty: the join rebuilds
    expect(s.join(s.conn('reader', true))).toBe(TRY_LATER);
    Y.applyUpdate(s.live, frame, { source: 'connection', connection: attacker });
  });

  it('no suspects (a legacy unstable row): the joiner waits and the page heals; nobody is struck', () => {
    const doc = new Y.Doc();
    doc.clientID = 1;
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    doc.transact(() => {
      doc.getXmlFragment('default').insert(0, [p]);
      p.insert(0, [t]);
      t.insert(0, 'abcdef');
    });
    const first = (t as any)._start.id.clock as number;
    Y.applyUpdate(doc, rawUpdate([{ client: 2, clock: 0, structs: [{ origin: [1, first + 5], right: [1, first + 3], content: new Y.ContentString('X') }] }]));
    const stored = Y.encodeStateAsUpdate(doc);
    const s = harness({ bytes: stored, attach: true });
    expect(s.join(s.conn('reader', true))).toBe(TRY_LATER);
    expect(s.divergence()).toEqual([expect.objectContaining({ where: 'join', suspects: [] })]);
    expect(s.divergence()[0].structs).toBe(countStructs(s.live)); // live's, not the unmeasured shadow's 0
    expect(s.divergence()[0].structs).toBeGreaterThan(0);
    expect(s.guard.shadowOf(s.live)).toBeNull(); // checked on live itself (below)
  });

  it('a page only readers open builds no shadow: the join checks live itself, once per mutation', () => {
    const s = harness();
    expect(s.join(s.conn('reader', true))).toBe('applied');
    expect(s.guard.shadowOf(s.live)).toBeNull(); // no page-sized copy (nor its mirror) for a page nobody writes
    expect(replicaLogOf(s.live)).not.toBeNull(); // the stable join was a checkpoint (the log was never attached)
    const encodes = jest.spyOn(Y, 'encodeStateAsUpdate');
    try {
      expect(s.join(s.conn('reader-2', true))).toBe('applied');
      expect(encodes).not.toHaveBeenCalled(); // nothing changed: cached
      const root = s.live.getXmlFragment('default');
      root.insert(root.length, [new Y.XmlElement('paragraph')]); // a server-local write
      expect(s.join(s.conn('reader-3', true))).toBe('applied');
      expect(encodes).toHaveBeenCalledTimes(1);
    } finally {
      encodes.mockRestore();
    }
    expect(s.guard.shadowOf(s.live)).toBeNull();
    expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe('applied'); // the first writer frame builds it
    expect(s.guard.shadowOf(s.live)).not.toBeNull();
  });

  it('a join that rebuilds a dirty shadow is answered by that rebuild\'s reload (nothing in flight): no second reload', async () => {
    const s = harness();
    expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe('applied');
    await new Promise((r) => setImmediate(r)); // the flush: nothing in flight
    expect(s.send(s.conn('attacker'), refusedInShadow(s.live))).toBe(REFUSED('schema')); // the shadow is dirty
    const encodes = jest.spyOn(Y, 'encodeStateAsUpdate');
    try {
      expect(s.join(s.conn('reader', true))).toBe('applied');
      expect(encodes).toHaveBeenCalledTimes(1); // the rebuild's encode of live, and no reload of the new shadow
    } finally {
      encodes.mockRestore();
    }
    expect(strictOrderDiff(s.guard.shadowOf(s.live)!, s.live)).toBeNull();
  });

  it('the probe compares its reload with live: an unstable page is logged and heals; a stable one advances the checkpoint', async () => {
    const { doc: base, pA } = listPage();
    const s = harness({ base });
    const turn = () => new Promise((r) => setImmediate(r)); // a probe runs on its own macrotask: every frame applied
    for (let i = 0; i < 3; i++) expect(s.send(s.conn('editor'), honestEdit(s.live))).toBe('applied');
    await turn();
    expect(replicaLogOf(s.live)!.entries).toBe(3);
    expect(s.guard.probeNow(s.live)).toBe(true);
    expect(replicaLogOf(s.live)!.entries).toBe(0);
    expect(s.send(s.conn('attacker'), f1(pA))).toBe('applied');
    await turn();
    expect(s.guard.probeNow(s.live)).toBe(true);
    expect(s.divergence()).toEqual([expect.objectContaining({ where: 'probe', outcome: 'unstable', suspects: ['attacker'] })]);
    expect(compactionRequest(s.live)).toMatchObject({ reason: 'order_divergence' });
    expect(replicaLogOf(s.live)!.entries).toBe(1); // not advanced past an unstable state
  });
});

describe('#840 strikes: once per user per instability episode', () => {
  it('repeated joins in one episode strike each suspect once (the log lines still name them); a second episode strikes again', () => {
    let t = 3_000_000_000_000;
    const logs: string[] = [];
    const limitLogs: string[] = [];
    const guard = new CollabUpdateGuard({
      mode: 'enforce',
      logger: { warn: (m: string) => logs.push(m) },
      limitLog: new SocketLimitLog({ warn: (m: string) => limitLogs.push(m) }),
      now: () => t,
      schedule: () => ({ cancel: () => undefined }),
    });
    const name = 'page.00000000-0000-4000-8000-000000000841';
    const { doc: base, pA } = listPage();
    const s = harness({ base, guard, name });
    const lines = () => logs.filter((l) => l.startsWith('COLLAB_ORDER_DIVERGENCE ')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
    // episode 1: the page is unstable and cannot heal yet (the compaction cannot start), so joins keep finding it
    expect(s.send(s.conn('attacker'), f1(pA))).toBe('applied');
    expect(s.join(s.conn('reader', true))).toBe(TRY_LATER);
    for (let i = 0; i < 4; i++) {
      t += 1_000;
      // the same user a suspect again within the episode (an honest user can be, by an induced local-order difference)
      expect(s.send(s.conn('attacker'), f1(pA, A + 10 + i))).toBe('applied');
      expect(s.join(s.conn('reader', true))).toBe(TRY_LATER);
    }
    expect(lines().filter((l) => l.where === 'join')).toHaveLength(5);
    expect(lines().every((l) => l.suspects.includes('attacker'))).toBe(true);
    expect(s.send(s.conn('attacker'), honestEdit(s.live))).toBe('applied'); // one strike: not held
    expect(limitLogs.some((l) => l.includes('"limit":"order_strikes"'))).toBe(false);
    // episode 2: a heal (a new document for the page), destabilized again: the second strike holds the author
    const healed = prosemirrorJSONToYDoc(serverSchema(), contentOf(s.live), 'default');
    const s2 = harness({ bytes: Y.encodeStateAsUpdate(healed), attach: true, guard, name });
    const li = listItemOf(s2.live);
    expect(s2.send(s2.conn('attacker'), f1(idOf(li.get(0) as Y.XmlElement), A + 1))).toBe('applied');
    expect(s2.join(s2.conn('reader', true))).toBe(TRY_LATER);
    expect(s2.send(s2.conn('attacker'), honestEdit(s2.live))).toBe(TRY_LATER);
    expect(limitLogs.some((l) => l.includes('"limit":"order_strikes"'))).toBe(true);
  });
});

describe('#840 strikes: a stable verdict ends the episode', () => {
  it('unstable, then stable again on the same document (the crafted run deleted), then unstable: a new episode, a second strike', () => {
    const limitLogs: string[] = [];
    const guard = new CollabUpdateGuard({
      mode: 'enforce',
      logger: { warn: () => undefined },
      limitLog: new SocketLimitLog({ warn: (m: string) => limitLogs.push(m) }),
      schedule: () => ({ cancel: () => undefined }),
    });
    const { doc: base, pA } = listPage();
    const s = harness({ base, guard, name: 'page.00000000-0000-4000-8000-000000000842' });
    expect(s.send(s.conn('attacker'), f1(pA))).toBe('applied');
    expect(s.join(s.conn('reader', true))).toBe(TRY_LATER); // episode 1: struck once
    // an editor deletes the bullet list holding the crafted run: the page reloads into itself again
    expect(s.send(s.conn('editor'), new RemoteClient(s.live).edit(s.live, (f) => f.delete(0, 1)))).toBe('applied');
    expect(isReloadStable(s.live).stable).toBe(true);
    expect(s.join(s.conn('reader', true))).toBe('applied'); // stable: the episode is over
    const q = s.live.getXmlFragment('default').get(0) as Y.XmlElement;
    expect(s.send(s.conn('attacker'), f1(idOf(q), A + 1))).toBe('applied');
    expect(s.join(s.conn('reader', true))).toBe(TRY_LATER); // episode 2: the second strike
    expect(s.send(s.conn('attacker'), new RemoteClient(s.live).edit(s.live, (f) => ((f.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'a')))).toBe(TRY_LATER);
    expect(limitLogs.some((l) => l.includes('"limit":"order_strikes"'))).toBe(true);
  });
});

describe('#840 T6: destabilize-and-join, repeated', () => {
  it('heals are bounded by the per-page interval; after two strikes only the crafted author waits (1013); an honest co-editor keeps writing', async () => {
    let t = 2_000_000_000_000;
    const restore = setCompactionClockForTests({ now: () => t, uptimeMs: () => COMPACTION_ARM_DELAY_MS + 1 });
    try {
      const logs: string[] = [];
      const limitLogs: string[] = [];
      const guard = new CollabUpdateGuard({
        mode: 'enforce',
        logger: { warn: (m: string) => logs.push(m) },
        limitLog: new SocketLimitLog({ warn: (m: string) => limitLogs.push(m) }),
        now: () => t,
        schedule: () => ({ cancel: () => undefined }),
      });
      const name = 'page.00000000-0000-4000-8000-000000000840';
      const pageId = name.slice('page.'.length);
      const drains = () => logs.filter((l) => l.startsWith('COLLAB_PAGE_COMPACTION') && l.includes('"drain":true')).length;
      // round 1: the page heals (a drain), as a compaction from live would: a new document, a new lineage
      const { doc: base1, pA: pA1 } = listPage();
      const r1 = harness({ base: base1, guard, name });
      expect(r1.send(r1.conn('editor'), honestEdit(r1.live))).toBe('applied');
      expect(r1.send(r1.conn('attacker'), f1(pA1))).toBe('applied');
      expect(r1.join(r1.conn('reader', true))).toBe(TRY_LATER);
      expect(isDraining(r1.live)).toBe(true);
      expect(drains()).toBe(1);
      registerInflight(pageId, Promise.resolve(), t); // the compaction ran (#827's per-page interval starts)
      await new Promise((r) => setImmediate(r));
      t += 60_000;
      const healed = prosemirrorJSONToYDoc(serverSchema(), contentOf(r1.live), 'default');
      // round 2: destabilized again within the interval
      const r2 = harness({ bytes: Y.encodeStateAsUpdate(healed), attach: true, guard, name });
      expect(isReloadStable(r2.live).stable).toBe(true);
      const li = listItemOf(r2.live);
      expect(r2.send(r2.conn('editor'), honestEdit(r2.live))).toBe('applied');
      expect(r2.send(r2.conn('attacker'), f1(idOf(li.get(0) as Y.XmlElement), A + 1))).toBe('applied'); // one strike so far
      t += 60_000;
      expect(r2.join(r2.conn('reader', true))).toBe(TRY_LATER); // the second strike
      expect(isDraining(r2.live)).toBe(false); // no second heal within the interval: nothing drains
      expect(drains()).toBe(1);
      expect(compactionRequest(r2.live)).toMatchObject({ reason: 'order_divergence', drain: false }); // at the next unload
      // the crafted author's writer frames wait; the honest co-editor's apply, round after round
      for (let i = 0; i < 5; i++) {
        t += 1_000;
        expect(r2.send(r2.conn('attacker'), honestEdit(r2.live, 'a'))).toBe(TRY_LATER);
        expect(r2.send(r2.conn('editor'), honestEdit(r2.live, 'e'))).toBe('applied');
        expect(r2.join(r2.conn('reader', true))).toBe(TRY_LATER); // still unstable until it heals: joiners wait
      }
      expect(limitLogs.filter((l) => l.includes('"limit":"order_strikes"')).length).toBe(5);
      expect(r2.guard.suspectsOf(r2.live)).toEqual([]);
      expect(renderLikeABrowser(r2.live)).toMatchObject({ deleted: false, threw: false });
      // the hold lapses
      t += ORDER_HOLD_MS;
      expect(r2.send(r2.conn('attacker'), honestEdit(r2.live, 'a'))).toBe('applied');
      // and once the interval ended, the next instability drains again
      t += COMPACTION_MIN_INTERVAL_MS;
      expect(r2.join(r2.conn('reader', true))).toBe(TRY_LATER);
      expect(drains()).toBe(2);
    } finally {
      restore();
    }
  });
});

describe('#840 part 4: live\'s own apply is charged, and live far slower than the shadow re-verifies it', () => {
  it('the shadow apply once and live\'s apply once; past 4x + 50 ms: logged live_cost and rebuilt', () => {
    let cpu = 0;
    const s = harness({ now: () => 1_000_000, cpuNow: () => cpu });
    const real = Y.applyUpdate;
    let liveCost = 30;
    const spy = jest.spyOn(Y, 'applyUpdate').mockImplementation((doc: Y.Doc, update: Uint8Array, origin?: unknown) => {
      if (typeof origin === 'symbol' && origin.description === 'ccc-collab-inspect') cpu += 10;
      if (doc === s.live && (origin as { source?: unknown } | undefined)?.source === 'connection') {
        return Y.transact(doc, () => {
          cpu += liveCost;
          real(doc, update, origin);
        }, origin, false);
      }
      return real(doc, update, origin);
    });
    try {
      expect(s.send(s.conn('a'), honestEdit(s.live))).toBe('applied'); // builds the shadow (charged), then 10 + 30
      const first = USER_COLLAB_CPU_BURST_MS - s.guard.cpuBalance('a');
      expect(s.send(s.conn('a'), honestEdit(s.live))).toBe('applied');
      expect(USER_COLLAB_CPU_BURST_MS - s.guard.cpuBalance('a') - first).toBe(40);
      liveCost = 500; // > 4 x 10 + 50
      expect(s.send(s.conn('a'), honestEdit(s.live))).toBe('applied');
      expect(USER_COLLAB_CPU_BURST_MS - s.guard.cpuBalance('a') - first).toBe(40 + 510);
      expect(s.divergence()).toEqual([expect.objectContaining({ where: 'rebuild', outcome: 'live_cost', suspects: ['a'] })]);
      liveCost = 1;
      const shadowBefore = s.guard.shadowOf(s.live);
      expect(s.send(s.conn('b'), honestEdit(s.live))).toBe('applied');
      expect(s.guard.shadowOf(s.live)).not.toBe(shadowBefore); // rebuilt (and verified) before it was used again
    } finally {
      spy.mockRestore();
    }
  });
});
