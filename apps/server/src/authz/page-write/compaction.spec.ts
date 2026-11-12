// #827: automatic compaction and the bounded load (compaction.ts). Real yjs, real tiptap schema and conversion; the
// database is an in-memory CompactionStore (compaction.pg.spec.ts runs the Postgres one and the full Hocuspocus path).
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { Logger } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { COLLAB_PAGE_COMPACTING_REASON } from '../collab-ingress/collab-reasons';
import { ConflictScan, installConflictScanMeter } from '../collab-ingress/conflict-scan';
import { deadlineExceeded, overrideDeadlineForTests } from '../collab-ingress/deadline';
import { rawUpdate } from '../collab-ingress/conflict-scan.testkit';
import { liveStructure } from '../collab-ingress/live-structure';
import {
  assertDocWritable,
  buildCompacted,
  compactFromRow,
  compactOnUnload,
  CompactionDigestMismatchError,
  COMPACTION_TRY_LATER_CODE,
  type CompactableDocument,
  type CompactionRow,
  type CompactionStore,
  type SwapOptions,
  countStructs,
  ledgerOfDoc,
  loadStatsOf,
  loadStoredYdoc,
  PageCompactingException,
  pageIdOfDocumentName,
  readRowLineage,
  refusesGrowth,
  resetLoadTripsForTests,
  rethrowDirectOpenRefusal,
  skipStoreOfSuperseded,
  snapshotTree,
} from './compaction';
import {
  awaitCompaction,
  compactionRequest,
  isClosedForCompaction,
  isCompacting,
  isCompactionInflight,
  isPageFull,
  isSuperseded,
  LINEAGE_ROOT,
  lineageEpoch,
  markCompacting,
  markPageFull,
  markSuperseded,
  MalformedLineageError,
  requestCompaction,
  setCompactionClockForTests,
  supersededBy,
  writeLineage,
} from './compaction-registry';
import { COMPACTION_ARM_DELAY_MS, COMPACTION_MIN_INTERVAL_MS } from '../collab-ingress/doc-bounds';
import { coveredRowDigest, markRowCovered } from './reconcile-store';
import { stableHash } from './stable-hash';
import { hasStoreFailure, markStoredAt, storeGenerationOf } from './store-failure-registry';
import { storeSafeJson } from './store-safe-json';
import { serverSchema } from './prelim-content';
import { recordWriteKey, WRITE_IDEM_MAP } from './write-idem';
import { PageTooLargeException } from './page-size';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');
const md5 = (v: unknown) => (v == null ? null : createHash('md5').update(JSON.stringify(v)).digest('hex'));
const digestOf = (d: Y.Doc) => stableHash(storeSafeJson(TiptapTransformer.fromYdoc(d, 'default')));
const toYdoc = (json: unknown) => TiptapTransformer.toYdoc(json as never, 'default', tiptapExtensions);

let pageSeq = 0;
const nextPageId = () => `00000000-0000-4000-8000-${String(827_000 + ++pageSeq).padStart(12, '0')}`;

const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
/** Headings, marks, a link, a list, a code block, a table, and a lone surrogate (stored as U+FFFD, #773). */
const RICH = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
    para(text('plain '), text('bold', [{ type: 'bold' }]), text(' link', [{ type: 'link', attrs: { href: 'https://e.x' } }])),
    { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('one'))] }, { type: 'listItem', content: [para(text('two'))] }] },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;')] },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [para(text('h'))] }, { type: 'tableHeader', content: [para(text('k'))] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('1'))] }, { type: 'tableCell', content: [para(text('2'))] }] },
      ],
    },
    para(text('half \ud83d emoji')),
  ],
};

/** A live page that went through `rounds` full replaces, each by a fresh client (structs and client ids pile up). */
function churnedPage(rounds: number, json: unknown = RICH): Y.Doc {
  const live = new Y.Doc();
  Y.applyUpdate(live, Y.encodeStateAsUpdate(toYdoc(json)));
  for (let i = 0; i < rounds; i++) {
    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(live));
    const f = editor.getXmlFragment('default');
    editor.transact(() => {
      f.delete(0, f.length);
      Y.applyUpdate(editor, Y.encodeStateAsUpdate(toYdoc(json)));
    });
    Y.applyUpdate(live, Y.encodeStateAsUpdate(editor, Y.encodeStateVector(live)));
  }
  return live;
}

/** An in-memory pages row with the Postgres store's compare-and-swap. */
function memoryStore(row: CompactionRow | null) {
  const calls = { read: 0, swap: 0 };
  const store: CompactionStore & { row: CompactionRow | null; calls: typeof calls; beforeSwap?: () => void } = {
    row,
    calls,
    async readRow() {
      calls.read++;
      return store.row ? { ...store.row } : null;
    },
    async swapYdoc(_pageId: string, next: Uint8Array, o: SwapOptions) {
      calls.swap++;
      store.beforeSwap?.();
      const r = store.row;
      if (!r?.ydoc || sha(r.ydoc) !== o.covered) return { swapped: false, why: 'cas_miss' as const };
      if (o.contentHash !== undefined && md5(r.content) !== o.contentHash) return { swapped: false, why: 'cas_miss' as const };
      if (o.stillCurrent && !o.stillCurrent()) return { swapped: false, why: 'changed' as const };
      const before = r.ydoc.length;
      store.row = { ...r, ydoc: next };
      return { swapped: true, beforeBytes: before };
    },
  };
  return store;
}

/** A resident document as Hocuspocus hands it to `beforeUnloadDocument`: no connection, its last store current. */
function resident(live: Y.Doc, pageId: string, stored: Uint8Array = Y.encodeStateAsUpdate(live)) {
  const doc = live as CompactableDocument & { closed: unknown[] };
  const closed: unknown[] = [];
  Object.assign(doc, {
    name: `page.${pageId}`,
    closed,
    getConnectionsCount: () => doc.connections.size,
    connections: new Map(),
  });
  markRowCovered(doc, stored);
  markStoredAt(doc, storeGenerationOf(doc));
  return doc;
}

const joiner = (doc: CompactableDocument & { closed: unknown[] }) => ({
  close: (event: unknown) => {
    doc.closed.push(event);
    doc.connections.delete(joinerRef);
  },
});
let joinerRef: ReturnType<typeof joiner>;

let restoreClock: () => void;
let now = 1_000_000;
let logged: string[];
/** A compaction line (collab-ingress/compaction-log.ts): the token, one space, one JSON object. */
const logLine = (line: string): Record<string, unknown> => {
  const space = line.indexOf(' ');
  return { token: line.slice(0, space), ...JSON.parse(line.slice(space + 1)) };
};
beforeEach(() => {
  logged = [];
  const capture = (line: unknown) => {
    logged.push(String(line));
  };
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
  now += 2 * COMPACTION_MIN_INTERVAL_MS; // no rate limit carried between tests
  restoreClock = setCompactionClockForTests({ now: () => now, uptimeMs: () => COMPACTION_ARM_DELAY_MS + 1 });
  resetLoadTripsForTests();
});
afterEach(() => {
  restoreClock();
  jest.restoreAllMocks();
});

describe('buildCompacted (#827)', () => {
  it('rebuilds the visible content exactly (the ADR 0019 digest), with the ledger and the next epoch, and sheds history', () => {
    const live = churnedPage(30);
    recordWriteKey(live, 'user\u0000key-a', 1000);
    recordWriteKey(live, 'user\u0000key-b', 2000);
    const before = countStructs(live);
    const expected = digestOf(live);

    const built = buildCompacted({ tree: snapshotTree(live.getXmlFragment('default')) }, ledgerOfDoc(live), 1, 42, { digest: expected });

    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, built.update);
    expect(digestOf(loaded)).toBe(expected);
    expect(built.digest).toBe(expected);
    expect(lineageEpoch(loaded)).toBe(1);
    expect(loaded.getMap(LINEAGE_ROOT).get('at')).toBe(42);
    expect(ledgerOfDoc(loaded)).toEqual([
      { key: 'user\u0000key-a', ts: 1000 },
      { key: 'user\u0000key-b', ts: 2000 },
    ]);
    // the history is gone: one client id for the content and the lineage, far fewer structs
    expect(built.counts).toEqual(countStructs(loaded));
    expect(built.counts.clients).toBe(1);
    expect(before.clients).toBeGreaterThan(30);
    expect(built.counts.structs).toBeLessThan(before.structs / 4);
  });

  it('aborts when the rebuilt page would not reproduce the source digest (never writes changed content)', () => {
    const live = churnedPage(1);
    const tree = { tree: snapshotTree(live.getXmlFragment('default')) };
    expect(() => buildCompacted(tree, [], 1, 0, { digest: 'another-digest' })).toThrow(CompactionDigestMismatchError);
    const json = { json: storeSafeJson(TiptapTransformer.fromYdoc(live, 'default')) };
    expect(() => buildCompacted(json, [], 1, 0, { content: { type: 'doc', content: [para(text('other'))] } })).toThrow(
      CompactionDigestMismatchError,
    );
  });

  it('copies the live tree as stored: an element without its default attributes, or with ones the schema drops, keeps its digest', () => {
    const live = churnedPage(2);
    const bare = new Y.XmlElement('paragraph'); // what any client can send: no default attributes
    bare.insert(0, [new Y.XmlText('bare')]);
    const odd = new Y.XmlElement('paragraph');
    odd.setAttribute('notInSchema', 'kept' as never);
    live.getXmlFragment('default').insert(0, [bare, odd]);
    const expected = digestOf(live);
    // anti-vacuity: a rebuild through the schema would change it
    expect(digestOf(toYdoc(storeSafeJson(TiptapTransformer.fromYdoc(live, 'default'))))).not.toBe(expected);
    const built = buildCompacted({ tree: snapshotTree(live.getXmlFragment('default')) }, [], 1, 0, { digest: expected });
    expect(built.digest).toBe(expected);
  });

  it('an empty page compacts to an empty page (a page of deleted content still sheds its ids)', () => {
    const live = churnedPage(5, { type: 'doc', content: [] });
    const built = buildCompacted({ tree: snapshotTree(live.getXmlFragment('default')) }, [], 3, 0, { digest: digestOf(live) });
    expect(built.epoch).toBe(3);
    expect(built.counts.clients).toBe(1);
  });
});

describe('readRowLineage (#827): the ledger and epoch from stored bytes, nothing integrated', () => {
  it('reads what compaction wrote', () => {
    const live = churnedPage(2);
    const built = buildCompacted({ tree: snapshotTree(live.getXmlFragment('default')) }, [{ key: 'k', ts: 7 }], 4, 0, {
      digest: digestOf(live),
    });
    const r = readRowLineage(built.update);
    expect(r).toMatchObject({ epoch: 4, ledger: [{ key: 'k', ts: 7 }], ledgerUnresolved: 0, clients: 1 });
  });

  it('follows re-set and pruned ledger keys through their origin chains (other clients included), and skips deletions', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('default');
    recordWriteKey(doc, 'a', 1, 100, 10);
    recordWriteKey(doc, 'b', 2, 100, 10);
    // another client prunes 'a' (age) and sets it again: its new entry carries no parent, only an origin
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    recordWriteKey(other, 'c', 500, 100, 10); // prunes a (1) and b (2)
    recordWriteKey(other, 'a', 501, 100, 10);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
    doc.getMap(WRITE_IDEM_MAP).set('c', 502); // a re-set by the first client, over the other's entry

    const fromBytes = readRowLineage(Y.encodeStateAsUpdate(doc));
    const sort = (l: Array<{ key: string; ts: number }>) => [...l].sort((x, y) => x.key.localeCompare(y.key));
    expect(sort(fromBytes.ledger)).toEqual(sort(ledgerOfDoc(doc)));
    expect(sort(fromBytes.ledger)).toEqual([
      { key: 'a', ts: 501 },
      { key: 'c', ts: 502 },
    ]);
    expect(fromBytes.epoch).toBe(0); // never compacted
  });

  it('refuses a lineage root compaction cannot have written', () => {
    const doc = new Y.Doc();
    doc.getMap(LINEAGE_ROOT).set('epoch', 'two');
    expect(() => readRowLineage(Y.encodeStateAsUpdate(doc))).toThrow(MalformedLineageError);
  });
});

describe('loadStoredYdoc (#827): the bounded load', () => {
  const meter = installConflictScanMeter();
  /** The inversion fixture's load steps, counted unbounded on a scratch document. */
  const loadSteps = (bytes: Uint8Array) => {
    const scratch = new Y.Doc();
    const scan = new ConflictScan(scratch, false, Infinity);
    meter.metered(scan, () => Y.applyUpdate(scratch, bytes));
    return scan.steps;
  };
  /**
   * Load-order inversion (#827 vector c): client 500 places M siblings from a to
   * e, client 900000 reverse-types N items between c and d. Each frame is cheap live; a load integrates 900000 first,
   * so each sibling walks all N.
   */
  const inverted = (MN = 100) => {
    const doc = new Y.Doc();
    doc.clientID = 1;
    doc.getText('t').insert(0, 'acde');
    const L = Array.from({ length: MN }, () => ({ origin: [1, 0] as [number, number], right: [1, 3] as [number, number], content: new Y.ContentString('l') }));
    const H = Array.from({ length: MN }, (_, i) => ({
      origin: [1, 1] as [number, number],
      right: (i ? [900000, i - 1] : [1, 2]) as [number, number],
      content: new Y.ContentString('h'),
    }));
    Y.applyUpdate(doc, rawUpdate([{ client: 500, clock: 0, structs: L }]));
    Y.applyUpdate(doc, rawUpdate([{ client: 900000, clock: 0, structs: H }]));
    return Y.encodeStateAsUpdate(doc);
  };

  it('an honest page loads, its bytes are covered (#731) and its counts recorded', () => {
    const live = churnedPage(3);
    const bytes = Y.encodeStateAsUpdate(live);
    const doc = new Y.Doc();
    const store = memoryStore(null);
    loadStoredYdoc(doc, nextPageId(), bytes, store);
    expect(digestOf(doc)).toBe(digestOf(live));
    expect(coveredRowDigest(doc)).toBe(sha(bytes));
    expect(loadStatsOf(doc)).toMatchObject(countStructs(doc));
    expect(compactionRequest(doc)).toBeNull();
    expect(store.calls.read).toBe(0);
  });

  it('a load over its walk budget throws the compacting refusal (no message), and compacts the page from its row', async () => {
    const bytes = inverted();
    const steps = loadSteps(bytes);
    expect(steps).toBeGreaterThan(100 * 100); // anti-vacuity: the fixture's load walks M·N
    const pageId = nextPageId();
    const content = storeSafeJson(TiptapTransformer.fromYdoc(new Y.Doc(), 'default'));
    const store = memoryStore({ content, ydoc: bytes, contentHash: md5(content) });

    let thrown: unknown;
    const cut = new Y.Doc();
    try {
      loadStoredYdoc(cut, pageId, bytes, store, { steps: Math.floor(steps / 2), deadlineMs: 60_000 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toEqual({ reason: COLLAB_PAGE_COMPACTING_REASON });
    // the walk was cut at the budget (enforced), not counted to its end and refused after
    const full = new Y.Doc();
    Y.applyUpdate(full, bytes);
    expect(countStructs(cut).structs).toBeLessThan(countStructs(full).structs);
    expect(logged.map(logLine)).toEqual([
      { token: 'COLLAB_PAGE_COMPACTION', event: 'load_refused', pageId, why: 'steps', steps: expect.any(Number), bytes: bytes.length, ms: expect.any(Number) },
      { token: 'COLLAB_PAGE_COMPACTION', event: 'requested', pageId, reason: 'load_trip', drain: false },
    ]);
    expect(thrown).not.toHaveProperty('message');
    expect(isCompactionInflight(pageId)).toBe(true);
    await awaitCompaction(pageId);
    // The build's source is the row's `content` (the store writes it and the ydoc from one snapshot); this fixture's is
    // an empty page.
    expect(store.calls.swap).toBe(1);
    expect(readRowLineage(store.row!.ydoc!).epoch).toBe(1);
    // the compacted row loads with no walk at all
    const next = new Y.Doc();
    loadStoredYdoc(next, pageId, store.row!.ydoc!, store, { steps: 10, deadlineMs: 60_000 });
    expect(loadStatsOf(next)!.steps).toBe(0);
  });

  it('a page whose load tripped its walk budget is refused at once on the next load, without a second walk', () => {
    restoreClock();
    restoreClock = setCompactionClockForTests({ now: () => now, uptimeMs: () => 0 }); // not armed: nothing compacts
    const bytes = inverted();
    const steps = loadSteps(bytes);
    const pageId = nextPageId();
    const store = memoryStore(null);
    const bounds = { steps: Math.floor(steps / 2), deadlineMs: 60_000 };
    expect(() => loadStoredYdoc(new Y.Doc(), pageId, bytes, store, bounds)).toThrow();
    const runs: number[] = [];
    const restore = overrideDeadlineForTests((fn, ms) => {
      runs.push(ms);
      return fn();
    });
    try {
      expect(() => loadStoredYdoc(new Y.Doc(), pageId, bytes, store, bounds)).toThrow();
      expect(runs).toEqual([]); // refused before the apply
      // other bytes for the page (a store wrote) are tried again
      const live = churnedPage(1);
      loadStoredYdoc(new Y.Doc(), pageId, Y.encodeStateAsUpdate(live), store, bounds);
      expect(runs).toHaveLength(1);
    } finally {
      restore();
    }
    expect(store.calls).toEqual({ read: 0, swap: 0 }); // before arming nothing is read or written
  });

  it('a deadline trip refuses the load; one trip may be a stall (tried again), the second strike refuses at once', () => {
    restoreClock();
    restoreClock = setCompactionClockForTests({ now: () => now, uptimeMs: () => 0 });
    const bytes = Y.encodeStateAsUpdate(churnedPage(1));
    const pageId = nextPageId();
    const store = memoryStore(null);
    let calls = 0;
    const restore = overrideDeadlineForTests((_fn, ms) => {
      calls++;
      throw deadlineExceeded(ms);
    });
    try {
      for (let i = 0; i < 3; i++) {
        expect(() => loadStoredYdoc(new Y.Doc(), pageId, bytes, store)).toThrow(
          expect.objectContaining({ reason: COLLAB_PAGE_COMPACTING_REASON }) as never,
        );
      }
      expect(calls).toBe(2);
    } finally {
      restore();
    }
  });

  it('any other failure of the load is rethrown as is (a malformed row fails the load, as before)', () => {
    const store = memoryStore(null);
    expect(() => loadStoredYdoc(new Y.Doc(), nextPageId(), new Uint8Array([1, 2, 3, 250]), store)).toThrow();
    expect(store.calls.read).toBe(0);
  });

  it('a page past a soft step cap asks for compaction at its next unload; at the cap too (past it the walk trips)', () => {
    const bytes = inverted();
    const steps = loadSteps(bytes);
    const soft = new Y.Doc();
    loadStoredYdoc(soft, nextPageId(), bytes, memoryStore(null), { steps: Math.ceil(steps / 0.9), deadlineMs: 60_000 });
    expect(compactionRequest(soft)).toEqual({ reason: 'load_steps', userId: null, drain: false });
    // the cap is a hard bound past it (capVerdict: strictly over), where the meter trips and the load is refused
    const exact = new Y.Doc();
    loadStoredYdoc(exact, nextPageId(), bytes, memoryStore(null), { steps, deadlineMs: 60_000 });
    expect(compactionRequest(exact)).toEqual({ reason: 'load_steps', userId: null, drain: false });
    expect(() => loadStoredYdoc(new Y.Doc(), nextPageId(), bytes, memoryStore(null), { steps: steps - 1, deadlineMs: 60_000 })).toThrow(
      expect.objectContaining({ reason: COLLAB_PAGE_COMPACTING_REASON }) as never,
    );
  });

  describe('the structure caps follow the update guard: only when compaction would bring the page under the soft caps', () => {
    const STEPS = 1e9; // never the reason here
    const load = (bytes: Uint8Array, caps: { structs: number; clientIds: number; children: number }) => {
      const doc = new Y.Doc();
      loadStoredYdoc(doc, nextPageId(), bytes, memoryStore(null), { steps: STEPS, deadlineMs: 60_000, caps });
      return doc;
    };
    // A page whose history is most of it: every round deleted the whole page and wrote it again (and added a client id).
    const churned = churnedPage(10);
    const churnedBytes = Y.encodeStateAsUpdate(churned);
    const total = countStructs(churned);
    const live = liveStructure(churned);
    // A page with no history at all: every struct is visible, so compaction would keep every one.
    const fresh = toYdoc({ type: 'doc', content: Array.from({ length: 40 }, (_, i) => para(text(`p${i}`, [{ type: 'bold' }]), text(' x'))) });
    const freshBytes = Y.encodeStateAsUpdate(fresh);
    const freshTotal = countStructs(fresh);
    const roomy = 1e9;

    it('the fixtures are what the cases need (anti-vacuity)', () => {
      expect(live.structs).toBeLessThan(Math.floor(total.structs * 0.8)); // under a soft cap set at the total
      expect(total.clients).toBeGreaterThanOrEqual(10);
      expect(liveStructure(fresh).structs).toBe(freshTotal.structs);
      expect(liveStructure(fresh).children).toBe(40);
    });

    it('history past the structs cap: requested (and drained at the hard cap), with the live counts logged', () => {
      const lines: string[] = [];
      const spy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void lines.push(String(m)));
      try {
        const hard = load(churnedBytes, { structs: total.structs - 1, clientIds: roomy, children: roomy });
        expect(compactionRequest(hard)).toEqual({ reason: 'structs', userId: null, drain: true });
        expect(isPageFull(hard)).toBe(false);
        const atCap = load(churnedBytes, { structs: total.structs, clientIds: roomy, children: roomy });
        expect(compactionRequest(atCap)).toEqual({ reason: 'structs', userId: null, drain: false }); // a hard cap is strictly past it
        const soft = load(churnedBytes, { structs: Math.ceil(total.structs / 0.9), clientIds: roomy, children: roomy });
        expect(compactionRequest(soft)).toEqual({ reason: 'structs', userId: null, drain: false });
      } finally {
        spy.mockRestore();
      }
      expect(lines.some((l) => l.includes('"event":"requested"') && l.includes(`"liveStructs":${live.structs}`))).toBe(true);
    });

    it('history past the client-ids cap: requested (compaction leaves one id)', () => {
      const doc = load(churnedBytes, { structs: roomy, clientIds: total.clients - 1, children: roomy });
      expect(compactionRequest(doc)).toEqual({ reason: 'client_ids', userId: null, drain: true });
    });

    it('visible content past the structs cap: neither requested nor drained (compaction would keep every struct), marked page-full', () => {
      const past = load(freshBytes, { structs: freshTotal.structs - 1, clientIds: roomy, children: roomy });
      expect(compactionRequest(past)).toBeNull();
      expect(isPageFull(past)).toBe(true); // an API append/prepend answers page_too_large (refusesGrowth)
      expect(refusesGrowth(past, 'append')).toBe(true);
      expect(refusesGrowth(past, 'replace')).toBe(false);
      const near = load(freshBytes, { structs: Math.ceil(freshTotal.structs / 0.9), clientIds: roomy, children: roomy });
      expect(compactionRequest(near)).toBeNull();
      expect(isPageFull(near)).toBe(false);
    });

    it('past a hard cap before compaction can start (not armed): requested for the next unload, never drained (joins are served)', () => {
      restoreClock();
      restoreClock = setCompactionClockForTests({ now: () => now, uptimeMs: () => COMPACTION_ARM_DELAY_MS - 1 });
      const doc = load(churnedBytes, { structs: total.structs - 1, clientIds: roomy, children: roomy });
      expect(compactionRequest(doc)).toEqual({ reason: 'structs', userId: null, drain: false });
      expect(isClosedForCompaction(doc)).toBe(false);
    });

    it('history past a hard cap, compacted within the interval: page-full, not drained (no compaction may start yet)', () => {
      const recent = churnedPage(10);
      writeLineage(recent, 1, now - 1_000);
      const bytes = Y.encodeStateAsUpdate(recent);
      const doc = load(bytes, { structs: countStructs(recent).structs - 1, clientIds: roomy, children: roomy });
      expect(isPageFull(doc)).toBe(true);
      expect(isClosedForCompaction(doc)).toBe(false);
    });

    it('history past a cap but live children past the soft children cap: not requested (compaction keeps every child)', () => {
      const children = live.children;
      expect(children).toBeGreaterThan(1);
      const caps = { structs: total.structs - 1, clientIds: total.clients - 1, children: Math.ceil(children / 0.8) };
      expect(compactionRequest(load(churnedBytes, caps))).toBeNull();
      // One child of headroom more and it helps again: the children bound is what decided.
      expect(compactionRequest(load(churnedBytes, { ...caps, children: Math.ceil(children / 0.8) + 2 }))).toEqual({
        reason: 'structs',
        userId: null,
        drain: true,
      });
    });

    it('the step caps still request whatever the live structure (compaction rewrites the struct order)', () => {
      const bytes = inverted(); // every struct visible: past a structs cap compaction would not help
      const structs = countStructs((() => { const d = new Y.Doc(); Y.applyUpdate(d, bytes); return d; })()).structs;
      const doc = new Y.Doc();
      loadStoredYdoc(doc, nextPageId(), bytes, memoryStore(null), {
        steps: Math.ceil(loadSteps(bytes) / 0.9),
        deadlineMs: 60_000,
        caps: { structs, clientIds: roomy, children: roomy },
      });
      expect(liveStructure(doc).structs).toBe(structs);
      expect(compactionRequest(doc)).toEqual({ reason: 'load_steps', userId: null, drain: false });
    });
  });
});

describe('compactOnUnload (#827)', () => {
  const request = { reason: 'structs' as const, userId: 'u1', drain: false };

  function setup(rounds = 10) {
    const live = churnedPage(rounds);
    recordWriteKey(live, 'u\u0000k', 123);
    const pageId = nextPageId();
    const stored = Y.encodeStateAsUpdate(live);
    const content = storeSafeJson(TiptapTransformer.fromYdoc(live, 'default'));
    const store = memoryStore({ content, ydoc: stored, contentHash: md5(content) });
    const doc = resident(live, pageId, stored);
    return { live, doc, pageId, store, expected: digestOf(live) };
  }

  it('compacts a requested document nobody holds: the row gets the next lineage, same content; the copy is superseded', async () => {
    const { doc, pageId, store, expected } = setup();
    requestCompaction(doc, request);
    await compactOnUnload(doc, store);

    expect(isSuperseded(doc)).toBe(true);
    expect(supersededBy(doc)).toBe(1);
    expect(isCompacting(doc)).toBe(false);
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, store.row!.ydoc!);
    expect(digestOf(loaded)).toBe(expected);
    expect(lineageEpoch(loaded)).toBe(1);
    expect(ledgerOfDoc(loaded)).toEqual([{ key: 'u\u0000k', ts: 123 }]);
    expect(countStructs(loaded).clients).toBe(1);
    expect(isCompactionInflight(pageId)).toBe(false);
    // one line, its token first (check-infra-config §14 reads the first word), then one JSON object (compaction-log.ts)
    expect(logged.map(logLine)).toEqual([
      {
        token: 'COLLAB_PAGE_COMPACTION',
        event: 'done',
        pageId,
        reason: 'structs',
        from: 'unload',
        fromEpoch: 0,
        toEpoch: 1,
        structsBefore: expect.any(Number),
        structsAfter: expect.any(Number),
        clientIdsBefore: expect.any(Number),
        clientIdsAfter: 1,
        bytesBefore: expect.any(Number),
        bytesAfter: expect.any(Number),
        ms: expect.any(Number),
      },
    ]);
    // a superseded copy never stores again; its settle fails closed
    expect(skipStoreOfSuperseded(doc)).toBe(true);
    expect(hasStoreFailure(doc)).toBe(true);
  });

  it('a page opened and left without an edit (never stored) compacts from the bytes it loaded; one edited since does not', async () => {
    const live = churnedPage(6);
    const stored = Y.encodeStateAsUpdate(live);
    const content = storeSafeJson(TiptapTransformer.fromYdoc(live, 'default'));
    for (const edited of [false, true]) {
      const store = memoryStore({ content, ydoc: stored, contentHash: md5(content) });
      const doc = new Y.Doc() as CompactableDocument;
      Object.assign(doc, { name: `page.${nextPageId()}`, getConnectionsCount: () => 0, connections: new Map() });
      loadStoredYdoc(doc, pageIdOfDocumentName(doc.name)!, stored, store);
      if (edited) doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
      requestCompaction(doc, request);
      await compactOnUnload(doc, store);
      expect([edited, isSuperseded(doc), store.calls.swap]).toEqual([edited, !edited, edited ? 0 : 1]);
    }
  });

  it('closes a socket that joined while it compacted, try-later (1013, the guard\'s code)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(COMPACTION_TRY_LATER_CODE).toBe(require('../collab-ingress/update-guard').COLLAB_TRY_LATER_CODE);
    const { doc, store } = setup();
    requestCompaction(doc, request);
    store.beforeSwap = () => {
      joinerRef = joiner(doc);
      doc.connections.set(joinerRef as never, {});
    };
    await compactOnUnload(doc, store);
    expect(doc.closed).toEqual([{ code: 1013, reason: COLLAB_PAGE_COMPACTING_REASON }]);
    expect(doc.getConnectionsCount()).toBe(0);
  });

  it('does nothing unless requested, unheld, stored, and allowed to start', async () => {
    const cases: Array<[string, (s: ReturnType<typeof setup>) => void]> = [
      ['not requested', () => undefined],
      ['held by a connection', (s) => {
        requestCompaction(s.doc, request);
        s.doc.connections.set({ close: () => undefined } as never, {});
      }],
      ['its last store is not current (an edit since)', (s) => {
        requestCompaction(s.doc, request);
        s.doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
      }],
      ['not armed (the process is young)', (s) => {
        requestCompaction(s.doc, request);
        restoreClock();
        restoreClock = setCompactionClockForTests({ now: () => now, uptimeMs: () => COMPACTION_ARM_DELAY_MS - 1 });
      }],
      ['already compacting', (s) => {
        requestCompaction(s.doc, request);
        markCompacting(s.doc);
      }],
    ];
    for (const [why, arrange] of cases) {
      const s = setup(2);
      arrange(s);
      await compactOnUnload(s.doc, s.store);
      expect([why, s.store.calls]).toEqual([why, { read: 0, swap: 0 }]);
      expect([why, isSuperseded(s.doc)]).toEqual([why, false]);
    }
  });

  it('a page compacts at most once per interval', async () => {
    const a = setup(2);
    requestCompaction(a.doc, request);
    await compactOnUnload(a.doc, a.store);
    expect(isSuperseded(a.doc)).toBe(true);
    // the same page, loaded again right away and over a cap again
    const again = resident(churnedPage(2), a.pageId);
    requestCompaction(again, request);
    await compactOnUnload(again, a.store);
    expect(a.store.calls.swap).toBe(1);
    expect(isSuperseded(again)).toBe(false);
  });

  it('the row moved meanwhile (compare-and-swap miss): nothing written, the document serves again', async () => {
    const { doc, store } = setup();
    requestCompaction(doc, request);
    store.beforeSwap = () => {
      store.row = { ...store.row!, ydoc: Y.encodeStateAsUpdate(churnedPage(1)) };
    };
    const rowBefore = store.row!.ydoc;
    await compactOnUnload(doc, store);
    expect(isSuperseded(doc)).toBe(false);
    expect(isCompacting(doc)).toBe(false);
    expect(store.row!.ydoc).not.toBe(rowBefore);
    expect(readRowLineage(store.row!.ydoc!).epoch).toBe(0);
  });

  it('the document changed before the write committed: rolled back, not superseded', async () => {
    const { doc, store } = setup();
    requestCompaction(doc, request);
    store.beforeSwap = () => doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    await compactOnUnload(doc, store);
    expect(isSuperseded(doc)).toBe(false);
    expect(readRowLineage(store.row!.ydoc!).epoch).toBe(0);
  });

  it('a build that runs out of time writes nothing and never throws', async () => {
    const { doc, store } = setup();
    requestCompaction(doc, request);
    const restore = overrideDeadlineForTests((_fn, ms) => {
      throw deadlineExceeded(ms);
    });
    try {
      await expect(compactOnUnload(doc, store)).resolves.toBeUndefined();
    } finally {
      restore();
    }
    expect(store.calls.swap).toBe(0);
    expect(isCompacting(doc)).toBe(false);
    expect(isSuperseded(doc)).toBe(false);
    expect(logged.map(logLine)).toEqual([{ token: 'COLLAB_COMPACTION_FAILED', pageId: expect.any(String), reason: 'structs', why: 'deadline' }]);
  });

  it('a compacted document compacts to the epoch after its own', async () => {
    const live = churnedPage(1);
    const pageId = nextPageId();
    const first = buildCompacted({ tree: snapshotTree(live.getXmlFragment('default')) }, [], 6, 0, { digest: digestOf(live) });
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, first.update);
    const content = storeSafeJson(TiptapTransformer.fromYdoc(reloaded, 'default'));
    const store = memoryStore({ content, ydoc: first.update, contentHash: md5(content) });
    const doc = resident(reloaded, pageId, first.update);
    requestCompaction(doc, request);
    await compactOnUnload(doc, store);
    expect(supersededBy(doc)).toBe(7);
  });
});

describe('compactFromRow (#827): the row content is the source', () => {
  it('rebuilds from content, keeps the ledger read from the bytes, and moves to the next epoch', async () => {
    const live = churnedPage(8);
    recordWriteKey(live, 'u\u0000k', 9);
    writeLineage(live, 2, 0);
    const content = storeSafeJson(TiptapTransformer.fromYdoc(live, 'default'));
    const store = memoryStore({ content, ydoc: Y.encodeStateAsUpdate(live), contentHash: md5(content) });
    await expect(compactFromRow(store, nextPageId(), 'load_trip')).resolves.toBe('done');
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, store.row!.ydoc!);
    expect(digestOf(loaded)).toBe(stableHash(content));
    expect(lineageEpoch(loaded)).toBe(3);
    expect(ledgerOfDoc(loaded)).toEqual([{ key: 'u\u0000k', ts: 9 }]);
  });

  it('content the conversion fills in (default attributes) still compacts: the same document through the schema', async () => {
    const raw = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }; // no default attrs
    expect(stableHash(raw)).not.toBe(digestOf(toYdoc(raw))); // anti-vacuity: the conversion fills in defaults
    const bytes = Y.encodeStateAsUpdate(toYdoc(raw));
    const store = memoryStore({ content: raw, ydoc: bytes, contentHash: md5(raw) });
    await expect(compactFromRow(store, nextPageId(), 'load_trip')).resolves.toBe('done');
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, store.row!.ydoc!);
    expect(TiptapTransformer.fromYdoc(loaded, 'default')).toMatchObject({ content: [{ type: 'paragraph', content: [{ text: 'x' }] }] });
  });

  it('content with several nodes of a type and no attrs (API content, stored verbatim) compacts: shared defaults are no cycle', async () => {
    // ProseMirror gives every node built without attrs its type's ONE defaultAttrs object, and toJSON hands that object
    // out as is; stableStringify collapses an object it has seen before to null. Found live (yjs-adversarial inversion
    // --pairs 4): the page tripped its load, its row compaction failed digest_mismatch, and it stayed try-later for good.
    const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const raw = { type: 'doc', content: [para('a'), para('b'), para('c')] };
    const pm = serverSchema().nodeFromJSON(raw).toJSON() as { content: Array<{ attrs: unknown }> };
    expect(pm.content[0].attrs).toBe(pm.content[1].attrs); // anti-vacuity: the defaults object is shared
    const bytes = Y.encodeStateAsUpdate(toYdoc(raw));
    const store = memoryStore({ content: raw, ydoc: bytes, contentHash: md5(raw) });
    await expect(compactFromRow(store, nextPageId(), 'load_trip')).resolves.toBe('done');
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, store.row!.ydoc!);
    expect(TiptapTransformer.fromYdoc(loaded, 'default')).toMatchObject({ content: [para('a'), para('b'), para('c')] });
  });

  it('content the schema cannot read aborts: nothing written', async () => {
    const raw = { type: 'doc', content: [{ type: 'noSuchNode' }] };
    const store = memoryStore({ content: raw, ydoc: Y.encodeStateAsUpdate(churnedPage(1)), contentHash: md5(raw) });
    await expect(compactFromRow(store, nextPageId(), 'load_trip')).resolves.toBe('failed');
    expect(store.calls.swap).toBe(0);
  });

  it('a row with no ydoc is skipped; one with no content fails; a content change meanwhile is a CAS miss', async () => {
    await expect(compactFromRow(memoryStore({ content: null, ydoc: null, contentHash: null }), nextPageId(), 'load_trip')).resolves.toBe('skipped');
    const bytes = Y.encodeStateAsUpdate(churnedPage(1));
    await expect(compactFromRow(memoryStore({ content: null, ydoc: bytes, contentHash: null }), nextPageId(), 'load_trip')).resolves.toBe('failed');
    const live = churnedPage(1);
    const content = storeSafeJson(TiptapTransformer.fromYdoc(live, 'default'));
    const store = memoryStore({ content, ydoc: Y.encodeStateAsUpdate(live), contentHash: md5(content) });
    store.beforeSwap = () => {
      store.row = { ...store.row!, content: { type: 'doc', content: [] } };
    };
    await expect(compactFromRow(store, nextPageId(), 'load_trip')).resolves.toBe('skipped');
  });
});

describe('the write gate (#827, seam #2)', () => {
  it('a document compacting, draining or superseded takes no direct write: a retryable 503 engine_busy', () => {
    const cases: Array<(d: Y.Doc) => void> = [
      (d) => markCompacting(d),
      (d) => requestCompaction(d, { reason: 'structs', userId: null, drain: true }),
      (d) => markSuperseded(d, 3),
    ];
    for (const arrange of cases) {
      const d = new Y.Doc();
      expect(() => assertDocWritable(d)).not.toThrow();
      arrange(d);
      let err: unknown;
      try {
        assertDocWritable(d);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PageCompactingException);
      expect((err as PageCompactingException).getStatus()).toBe(503);
      expect((err as PageCompactingException).getResponse()).toMatchObject({ code: 'engine_busy' });
    }
    // a request without drain (the next unload) does not refuse writes
    const soft = new Y.Doc();
    requestCompaction(soft, { reason: 'structs', userId: null, drain: false });
    expect(() => assertDocWritable(soft)).not.toThrow();
  });

  it('a full page refuses growth only: append/prepend, never a replace', () => {
    const d = new Y.Doc();
    expect(refusesGrowth(d, 'append')).toBe(false);
    markPageFull(d);
    expect(['append', 'prepend', 'replace', undefined].map((op) => refusesGrowth(d, op))).toEqual([true, true, false, false]);
    expect(new PageTooLargeException().getResponse()).toMatchObject({ code: 'page_too_large' });
  });

  it('a direct connection whose load was refused as compacting is the 503; anything else is rethrown as is', () => {
    expect(() => rethrowDirectOpenRefusal({ reason: COLLAB_PAGE_COMPACTING_REASON })).toThrow(PageCompactingException);
    const other = new Error('boom');
    expect(() => rethrowDirectOpenRefusal(other)).toThrow(other);
    expect(() => rethrowDirectOpenRefusal({ reason: 'ccc:collab-something-else' })).toThrow(
      expect.objectContaining({ reason: 'ccc:collab-something-else' }) as never,
    );
  });

  it('pageIdOfDocumentName accepts only page.<uuid>', () => {
    expect(pageIdOfDocumentName('page.00000000-0000-4000-8000-000000000001')).toBe('00000000-0000-4000-8000-000000000001');
    expect(pageIdOfDocumentName('page.x')).toBeNull();
    expect(pageIdOfDocumentName('space.00000000-0000-4000-8000-000000000001')).toBeNull();
  });
});
