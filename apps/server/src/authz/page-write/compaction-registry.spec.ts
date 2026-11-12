import * as Y from 'yjs';
import { COMPACTION_ARM_DELAY_MS, COMPACTION_MIN_INTERVAL_MS } from '../collab-ingress/doc-bounds';
import * as reg from './compaction-registry';
import { WRITE_IDEM_MAP } from './write-idem';

/**
 * #827 (ADR 0036): the compaction registry. Per-document state keyed by the resident document (no cross-talk, nothing
 * held after it is gone), the per-page in-flight compaction a loader waits on, the arming delay that keeps compaction
 * off while a pre-#827 task may still serve a page, the per-page rate limit, and the lineage epoch.
 */
describe('#827 compaction registry: per-document state', () => {
  it('an unknown document is in no state', () => {
    const d = {};
    expect(reg.compactionRequest(d)).toBeNull();
    for (const f of [reg.isCompacting, reg.isDraining, reg.isSuperseded, reg.isPageFull, reg.isClosedForCompaction]) expect(f(d)).toBe(false);
    expect(reg.supersededBy(d)).toBeNull();
  });

  it('the first request wins; a later drain upgrades it; the return says when to log', () => {
    const d = {};
    expect(reg.requestCompaction(d, { reason: 'structs', userId: 'u1', drain: false })).toBe(true);
    expect(reg.requestCompaction(d, { reason: 'probe', userId: 'u2', drain: false })).toBe(false);
    expect(reg.compactionRequest(d)).toEqual({ reason: 'structs', userId: 'u1', drain: false });
    expect(reg.isDraining(d)).toBe(false);
    expect(reg.isClosedForCompaction(d)).toBe(false); // a soft request leaves the page open until the unload
    expect(reg.requestCompaction(d, { reason: 'client_ids', userId: null, drain: true })).toBe(true);
    expect(reg.compactionRequest(d)).toEqual({ reason: 'structs', userId: 'u1', drain: true });
    expect(reg.isDraining(d)).toBe(true);
    expect(reg.isClosedForCompaction(d)).toBe(true);
    expect(reg.requestCompaction(d, { reason: 'children', userId: null, drain: true })).toBe(false);
  });

  it('compacting closes the document until cleared; superseded is final and clears compacting', () => {
    const d = {};
    reg.markCompacting(d);
    expect(reg.isCompacting(d)).toBe(true);
    expect(reg.isClosedForCompaction(d)).toBe(true);
    reg.clearCompacting(d);
    expect(reg.isClosedForCompaction(d)).toBe(false);
    reg.markCompacting(d);
    reg.markSuperseded(d, 3);
    expect(reg.isCompacting(d)).toBe(false);
    expect(reg.isSuperseded(d)).toBe(true);
    expect(reg.supersededBy(d)).toBe(3);
    expect(reg.isClosedForCompaction(d)).toBe(true);
    reg.clearCompacting(d);
    expect(reg.isSuperseded(d)).toBe(true);
    reg.markSuperseded(d); // an unknown epoch keeps the known one
    expect(reg.supersededBy(d)).toBe(3);
  });

  it('page-full is per document and reversible; documents never share state', () => {
    const a = {};
    const b = {};
    reg.markPageFull(a);
    reg.markCompacting(a);
    reg.requestCompaction(a, { reason: 'load_trip', userId: null, drain: true });
    expect(reg.isPageFull(a)).toBe(true);
    expect([reg.isPageFull(b), reg.isCompacting(b), reg.isDraining(b), reg.compactionRequest(b)]).toEqual([false, false, false, null]);
    reg.markPageFull(a, false);
    expect(reg.isPageFull(a)).toBe(false);
  });

  it('the reasons are fixed words (they are logged as is)', () => {
    for (const r of reg.COMPACTION_REASONS) expect(r).toMatch(/^[a-z_]+$/);
  });
});

describe('#827 compaction registry: arming, rate limit and the in-flight compaction', () => {
  let clock = { now: 1_000_000_000, uptime: COMPACTION_ARM_DELAY_MS };
  let restore: () => void;
  beforeEach(() => {
    clock = { now: 1_000_000_000, uptime: COMPACTION_ARM_DELAY_MS };
    restore = reg.setCompactionClockForTests({ now: () => clock.now, uptimeMs: () => clock.uptime });
  });
  afterEach(() => restore());

  it('compaction is armed only after the process has been up COMPACTION_ARM_DELAY_MS (10 min)', () => {
    expect(COMPACTION_ARM_DELAY_MS).toBe(10 * 60_000);
    expect(reg.compactionArmed(0)).toBe(false);
    expect(reg.compactionArmed(COMPACTION_ARM_DELAY_MS - 1)).toBe(false);
    expect(reg.compactionArmed(COMPACTION_ARM_DELAY_MS)).toBe(true);
    clock.uptime = 5 * 60_000;
    expect(reg.compactionArmed()).toBe(false);
    expect(reg.canStartCompaction('page-early')).toBe(false);
    clock.uptime = COMPACTION_ARM_DELAY_MS + 1;
    expect(reg.compactionArmed()).toBe(true);
    expect(reg.canStartCompaction('page-early')).toBe(true);
  });

  it('a draining process starts no compaction (stopCompactions, the collab drain), armed or not', () => {
    clock.uptime = COMPACTION_ARM_DELAY_MS + 1;
    expect(reg.canStartCompaction('page-drain')).toBe(true);
    reg.stopCompactions();
    try {
      expect(reg.canStartCompaction('page-drain')).toBe(false);
      expect(reg.compactionArmed()).toBe(true); // a separate gate from the arm delay
    } finally {
      reg.resumeCompactionsForTests();
    }
    expect(reg.canStartCompaction('page-drain')).toBe(true);
  });

  it('a page-full mark with an end lapses then; one without holds until cleared', () => {
    const d = new Y.Doc();
    expect(reg.isPageFull(d)).toBe(false);
    reg.markPageFull(d, true, clock.now + 1_000);
    expect(reg.isPageFull(d)).toBe(true);
    clock.now += 1_000;
    expect(reg.isPageFull(d)).toBe(false);
    reg.markPageFull(d, true);
    clock.now += 10 * COMPACTION_MIN_INTERVAL_MS;
    expect(reg.isPageFull(d)).toBe(true);
    reg.markPageFull(d, false);
    expect(reg.isPageFull(d)).toBe(false);
  });

  it('pageFullUntil: a content verdict never lapses; an interval verdict lapses when the lineage\'s interval ends', () => {
    const d = new Y.Doc();
    reg.writeLineage(d, 1, clock.now - 60_000);
    expect(reg.compactedRecently(d)).toBe(true);
    expect(reg.pageFullUntil(d, { full: true, contentFull: true })).toBeNull();
    expect(reg.pageFullUntil(d, { full: true, contentFull: false })).toBe(clock.now - 60_000 + COMPACTION_MIN_INTERVAL_MS);
    expect(reg.pageFullUntil(d, { full: false, contentFull: false })).toBeNull();
    clock.now += COMPACTION_MIN_INTERVAL_MS;
    expect(reg.compactedRecently(d)).toBe(false);
    clock.uptime = 0;
    clock.now -= COMPACTION_MIN_INTERVAL_MS;
    expect(reg.compactedRecently(d)).toBe(false); // not armed: nothing compacted by this process counts yet
  });

  it('the real clock is process uptime (a fresh jest worker is not yet armed)', () => {
    restore();
    expect(reg.compactionArmed()).toBe(process.uptime() * 1000 >= COMPACTION_ARM_DELAY_MS);
    restore = reg.setCompactionClockForTests({ now: () => clock.now, uptimeMs: () => clock.uptime });
  });

  it('one in flight per page and per process; a loader awaits it, and it never rejects', async () => {
    let finish!: (v?: unknown) => void;
    let fail!: (e: unknown) => void;
    const first = new Promise((res, rej) => {
      finish = res;
      fail = rej;
    });
    void fail;
    expect(reg.canStartCompaction('p1')).toBe(true);
    const tracked = reg.registerInflight('p1', first);
    expect(reg.isCompactionInflight('p1')).toBe(true);
    expect(reg.canStartCompaction('p1')).toBe(false);
    expect(reg.canStartCompaction('p2')).toBe(false); // COMPACTIONS_IN_FLIGHT_MAX = 1
    expect(() => reg.registerInflight('p1', Promise.resolve())).toThrow(/in flight already/);
    let awaited = false;
    const loader = reg.awaitCompaction('p1').then(() => (awaited = true));
    await Promise.resolve();
    expect(awaited).toBe(false);
    finish();
    await loader;
    await tracked;
    expect(awaited).toBe(true);
    expect(reg.isCompactionInflight('p1')).toBe(false);
    await expect(reg.awaitCompaction('p1')).resolves.toBeUndefined();

    clock.now += COMPACTION_MIN_INTERVAL_MS;
    const failing = reg.registerInflight('p3', Promise.reject(new Error('build failed')));
    await expect(reg.awaitCompaction('p3')).resolves.toBeUndefined();
    await failing;
    expect(reg.isCompactionInflight('p3')).toBe(false);
  });

  it('a page compacts at most once per COMPACTION_MIN_INTERVAL_MS', async () => {
    await reg.registerInflight('p4', Promise.resolve());
    expect(reg.canStartCompaction('p4')).toBe(false);
    clock.now += COMPACTION_MIN_INTERVAL_MS - 1;
    expect(reg.canStartCompaction('p4')).toBe(false);
    expect(reg.canStartCompaction('p5')).toBe(true); // other pages are not limited by it
    clock.now += 1;
    expect(reg.canStartCompaction('p4')).toBe(true);
  });

  it('refuses a test clock outside jest', () => {
    const id = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;
    try {
      expect(() => reg.setCompactionClockForTests({ now: () => 0, uptimeMs: () => 0 })).toThrow(/jest only/);
    } finally {
      process.env.JEST_WORKER_ID = id;
    }
  });
});

describe('#827 the lineage epoch', () => {
  it('is 0 for a page with no lineage root, and reading it creates no root', () => {
    const d = new Y.Doc();
    d.getXmlFragment('default').insert(0, [new Y.XmlText('x')]);
    expect(reg.lineageEpoch(d)).toBe(0);
    expect(d.share.has(reg.LINEAGE_ROOT)).toBe(false);
  });

  it('is written by writeLineage and survives the stored bytes (a load reads it back)', () => {
    const d = new Y.Doc();
    reg.writeLineage(d, 4, 1_700_000_000_000);
    expect(reg.lineageEpoch(d)).toBe(4);
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, Y.encodeStateAsUpdate(d));
    expect(loaded.share.get(reg.LINEAGE_ROOT)?.constructor).not.toBe(Y.Map); // a load sees an untyped root at first
    expect(reg.lineageEpoch(loaded)).toBe(4);
    expect(loaded.getMap(reg.LINEAGE_ROOT).get('at')).toBe(1_700_000_000_000);
  });

  it('refuses a malformed epoch, and writeLineage refuses to write one', () => {
    for (const bad of [-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 2]) {
      const d = new Y.Doc();
      d.getMap(reg.LINEAGE_ROOT).set('epoch', bad);
      expect(() => reg.lineageEpoch(d)).toThrow(reg.MalformedLineageError);
    }
    for (const bad of [-1, 0.5, Number.NaN]) expect(() => reg.writeLineage(new Y.Doc(), bad, 0)).toThrow(RangeError);
  });

  it('is a root of its own, apart from the content and the idempotency ledger', () => {
    expect(reg.LINEAGE_ROOT).toBe('__ccc_lineage');
    expect(reg.LINEAGE_ROOT).not.toBe(WRITE_IDEM_MAP);
    expect(reg.LINEAGE_ROOT).not.toBe('default');
  });
});
