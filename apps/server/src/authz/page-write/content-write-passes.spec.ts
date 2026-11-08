// #731: how much whole-page work ONE content write does on the engine's event loop, counted exactly — so a regression
// is a red test, never a timing flake. The REAL stack: Hocuspocus 3.4.4 (its DirectConnection, debouncer and load
// path), the real PersistenceExtension and CollaborationHandler, real yjs, the real tiptap transformer and content
// builder. Only the database (an in-memory `pages` row with jsonb/bytea round-trip semantics) and the queues are fakes.
//
// Counted per write: store hooks invoked vs stores that ran (a run reads the row under its lock), `updatePage`,
// PAGE-SIZED `Y.encodeStateAsUpdate` / `Y.applyUpdate` / `Y.diffUpdate` (through the yjs module, from every caller,
// Hocuspocus included), `fromYdoc` and `toYdoc`.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { isDeepStrictEqual } from 'node:util';

const mockTx = { inside: false };
jest.mock('@docmost/db/utils', () => ({
  executeTx: async (_db: unknown, cb: (trx: unknown) => Promise<unknown>) => {
    mockTx.inside = true;
    try {
      return await cb({});
    } finally {
      mockTx.inside = false;
    }
  },
}));

import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';
import { stableHash } from './stable-hash';

const PAGE_ID = '99999999-9999-4999-8999-999999999999';
const DOC = `page.${PAGE_ID}`;
const USER = { id: 'api-user', name: 'API' } as never;
/** Anything at least this large is a whole-page pass (the fixture's ydoc is ~10× this; ledgers and vectors ≪ it). */
const PAGE_BYTES = 20_000;

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: Json[] };
const page = (label: string, n = 1500): Json => ({
  type: 'doc',
  content: Array.from({ length: n }, (_, i) => ({
    type: 'paragraph',
    content: [
      { type: 'text', text: `${label} paragraph ${i} ` },
      { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' and a link', marks: [{ type: 'link', attrs: { href: `https://e.com/${i}` } }] },
    ],
  })),
});

/** The `pages` row: content is jsonb (a JSON round trip), ydoc is bytea (a copy). */
function fakeDb(initial: Json) {
  const seed = TiptapTransformer.toYdoc(initial as never, 'default', tiptapExtensions);
  const row = {
    id: PAGE_ID,
    slugId: 'slug',
    workspaceId: 'w1',
    spaceId: 's1',
    creatorId: 'creator',
    createdAt: new Date('2020-01-01').toISOString(),
    contributorIds: [] as string[],
    content: JSON.parse(JSON.stringify(TiptapTransformer.fromYdoc(seed, 'default'))),
    ydoc: Buffer.from(Y.encodeStateAsUpdate(seed)) as Buffer | null,
  };
  const failures: Array<boolean> = []; // queued outcomes for the next updatePage calls: true = throw
  const findById = jest.fn(async (_id: string, _opts?: { withLock?: boolean }) => ({
    ...row,
    content: JSON.parse(JSON.stringify(row.content)),
    ydoc: row.ydoc ? Buffer.from(row.ydoc) : null,
  }));
  const updatePage = jest.fn(async (values: { content: unknown; ydoc: Buffer; contributorIds?: string[] }) => {
    if (failures.shift()) throw new Error('db blip');
    row.content = JSON.parse(JSON.stringify(values.content));
    row.ydoc = Buffer.from(values.ydoc);
    if (values.contributorIds) row.contributorIds = values.contributorIds;
  });
  return { row, findById, updatePage, failNext: (...outcomes: boolean[]) => failures.push(...outcomes) };
}

function stack(initial: Json) {
  const db = fakeDb(initial);
  const queue = { add: jest.fn(async () => undefined) } as never;
  const persistence = new PersistenceExtension(
    { findById: db.findById, updatePage: db.updatePage } as never,
    {} as never,
    queue,
    queue,
    queue,
    { addContributors: jest.fn(async () => undefined) } as never,
    { syncPageTransclusions: jest.fn(async () => undefined), syncPageReferences: jest.fn(async () => undefined) } as never,
  );
  const storeHook = jest.spyOn(persistence, 'onStoreDocument');
  const loadHook = jest.spyOn(persistence, 'onLoadDocument');
  const hocuspocus = new Hocuspocus({ quiet: true, extensions: [persistence], debounce: 60_000, maxDebounce: 60_000 } as never);
  const handlers = new CollaborationHandler().getHandlers(hocuspocus);
  return { db, hocuspocus, handlers, storeHook, loadHook, persistence };
}

/** Exact whole-page pass counters, reset per measured write. */
function passCounter() {
  const big = (n: number | undefined) => (n ?? 0) >= PAGE_BYTES;
  const c = { encode: 0, apply: 0, diff: 0, fromYdoc: 0, toYdoc: 0 };
  const enc = Y.encodeStateAsUpdate;
  const app = Y.applyUpdate;
  const dif = Y.diffUpdate;
  const from = TiptapTransformer.fromYdoc.bind(TiptapTransformer);
  const to = TiptapTransformer.toYdoc.bind(TiptapTransformer);
  jest.spyOn(Y, 'encodeStateAsUpdate').mockImplementation((...a: Parameters<typeof enc>) => {
    const out = enc(...a);
    if (big(out.length)) c.encode++;
    return out;
  });
  jest.spyOn(Y, 'applyUpdate').mockImplementation((...a: Parameters<typeof app>) => {
    if (big(a[1]?.length)) c.apply++;
    return app(...a);
  });
  jest.spyOn(Y, 'diffUpdate').mockImplementation((...a: Parameters<typeof dif>) => {
    if (big(a[0]?.length)) c.diff++;
    return dif(...a);
  });
  jest.spyOn(TiptapTransformer, 'fromYdoc').mockImplementation(((...a: Parameters<typeof from>) => (c.fromYdoc++, from(...a))) as never);
  jest.spyOn(TiptapTransformer, 'toYdoc').mockImplementation(((...a: Parameters<typeof to>) => (c.toYdoc++, to(...a))) as never);
  return {
    counts: c,
    reset: () => Object.keys(c).forEach((k) => ((c as Record<string, number>)[k] = 0)),
  };
}

/** Let Hocuspocus's post-store `setTimeout(unload, 0)` and the unload hooks run. */
const settleTimers = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const lockedReads = (db: ReturnType<typeof fakeDb>) => db.findById.mock.calls.filter((c) => c[1]?.withLock).length;
const rowHas = (db: ReturnType<typeof fakeDb>, text: string) => JSON.stringify(db.row.content).includes(text);

describe('#731 whole-page passes per content write (real Hocuspocus 3.4.4)', () => {
  let passes: ReturnType<typeof passCounter>;
  beforeEach(() => {
    passes = passCounter();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the installed @hocuspocus/server is 3.4.4 (the load-in-place and two-store analysis is of that source: re-review on a bump)', () => {
    const pkg = JSON.parse(readFileSync(join(dirname(require.resolve('@hocuspocus/server')), '..', 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@hocuspocus/server');
    expect(pkg.version).toBe('3.4.4');
  });

  it('NON-RESIDENT replace: one load apply, one store that runs (the second is skipped), one encode, one fromYdoc', async () => {
    const s = stack(page('A'));
    passes.reset();
    await expect(
      s.handlers.conditionalUpdatePageContent(DOC, { prosemirrorJson: page('B'), operation: 'replace', user: USER }),
    ).resolves.toEqual({ applied: true });
    await settleTimers();

    expect(s.loadHook).toHaveBeenCalledTimes(1);
    expect(await s.loadHook.mock.results[0].value).toBeUndefined(); // filled in place: nothing for Hocuspocus to re-apply
    expect(s.storeHook).toHaveBeenCalledTimes(2); // transact() + disconnect()
    expect(lockedReads(s.db)).toBe(1); // …of which ONE ran
    expect(s.db.updatePage).toHaveBeenCalledTimes(1);
    expect(passes.counts).toEqual({ encode: 1, apply: 1, diff: 0, fromYdoc: 1, toYdoc: 0 });
    // (before #731: encode 4, apply 3, diff 2, fromYdoc 2, toYdoc 1, two stores ran)
    expect(rowHas(s.db, 'B paragraph 1499')).toBe(true);
    expect(rowHas(s.db, 'A paragraph')).toBe(false);
    expect(s.hocuspocus.documents.has(DOC)).toBe(false); // unloaded as before
  });

  it('RESIDENT CAS replace (settle, then write — twice): no apply, no diff, one store run per write', async () => {
    const s = stack(page('A'));
    const keeper = await s.hocuspocus.openDirectConnection(DOC, { user: USER }); // an open editor keeps the page resident
    const doc = s.hocuspocus.documents.get(DOC)!;
    for (const label of ['B', 'C']) {
      s.storeHook.mockClear();
      s.db.findById.mockClear();
      s.db.updatePage.mockClear();
      passes.reset();
      const settled = await s.handlers.flushPageContent(DOC, { withDigest: true });
      expect(settled).toMatchObject({ flushed: true });
      const clientsBefore = new Set(doc.store.clients.keys());
      await expect(
        s.handlers.conditionalUpdatePageContent(DOC, {
          prosemirrorJson: page(label),
          operation: 'replace',
          user: USER,
          expectedContentHash: (settled as { contentDigest: string }).contentDigest,
        }),
      ).resolves.toEqual({ applied: true });
      expect(s.storeHook).toHaveBeenCalledTimes(2);
      expect(lockedReads(s.db)).toBe(1);
      expect(s.db.updatePage).toHaveBeenCalledTimes(1);
      // fromYdoc: the settle's digest (reused by the pre-check and the CAS) + the one store's serialization.
      // The reconcile reads the bytes this document last loaded or wrote: a memo hit, no diff.
      expect(passes.counts).toEqual({ encode: 1, apply: 0, diff: 0, fromYdoc: 2, toYdoc: 0 });
      // (before #731: encode 3, apply 1, diff 2, fromYdoc 3, toYdoc 1, two stores ran)
      // Each replace's structs sit under ONE new client id (insertAsOwnClient), never the document's own, whose struct
      // array would otherwise collect every replace and tombstone and make each later transaction slower (3–4×).
      const added = [...doc.store.clients.keys()].filter((c) => !clientsBefore.has(c));
      expect(added).toHaveLength(1);
      expect(added[0]).not.toBe(doc.clientID);
      expect(rowHas(s.db, `${label} paragraph 1499`)).toBe(true);
    }
    // The live document and the row agree, and the live digest equals the reloaded row's.
    expect(stableHash(TiptapTransformer.fromYdoc(doc, 'default'))).toBe(stableHash(s.db.row.content));
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, s.db.row.ydoc!);
    expect(isDeepStrictEqual(TiptapTransformer.fromYdoc(reloaded, 'default'), TiptapTransformer.fromYdoc(doc, 'default'))).toBe(true);
    await keeper.disconnect();
  });

  it('a FAILED transact() store is retried by disconnect()\'s store: both run, the write answers applied', async () => {
    const s = stack(page('A'));
    s.db.failNext(true); // the first updatePage throws, the retry succeeds
    passes.reset();
    await expect(
      s.handlers.conditionalUpdatePageContent(DOC, { prosemirrorJson: page('B'), operation: 'replace', user: USER }),
    ).resolves.toEqual({ applied: true });
    expect(s.storeHook).toHaveBeenCalledTimes(2);
    expect(lockedReads(s.db)).toBe(2); // the retry ran in full
    expect(s.db.updatePage).toHaveBeenCalledTimes(2);
    expect(passes.counts.diff).toBe(0); // the row did not change between them: still the memoized load bytes
    expect(rowHas(s.db, 'B paragraph 1499')).toBe(true);
  });

  it('both stores fail → applied_unconfirmed (R4), and the failed state never lets a later store skip', async () => {
    const s = stack(page('A'));
    const keeper = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    s.db.failNext(true, true);
    await expect(
      s.handlers.conditionalUpdatePageContent(DOC, { prosemirrorJson: page('B'), operation: 'replace', user: USER }),
    ).resolves.toEqual({ applied: false, reason: 'applied_unconfirmed' });
    expect(lockedReads(s.db)).toBe(2);
    expect(rowHas(s.db, 'A paragraph')).toBe(true); // nothing persisted
    // The settle runs the next store in full (not skipped) and persists what the live document holds.
    s.db.findById.mockClear();
    await keeper.transact(() => undefined); // keeper's store: a store with no new transaction since the failure
    expect(lockedReads(s.db)).toBe(1);
    expect(rowHas(s.db, 'B paragraph 1499')).toBe(true);
    await keeper.disconnect();
  });

  it('the native updatePageContent: the same single store (a failed one still answers write_outcome_unknown)', async () => {
    const s = stack(page('A'));
    await s.handlers.updatePageContent(DOC, { prosemirrorJson: page('B', 10), operation: 'append', user: USER });
    expect(s.storeHook).toHaveBeenCalledTimes(2);
    expect(lockedReads(s.db)).toBe(1);
    expect(rowHas(s.db, 'B paragraph 9')).toBe(true);
    expect(rowHas(s.db, 'A paragraph 1499')).toBe(true);
    await settleTimers();
    const t = stack(page('A'));
    t.db.failNext(true, true);
    const err = await t.handlers
      .updatePageContent(DOC, { prosemirrorJson: page('B'), operation: 'replace', user: USER })
      .catch((e) => e);
    expect(err?.getResponse?.()).toMatchObject({ code: 'write_outcome_unknown' });
  });

  it('an edit that lands while the transact() store awaits the database makes disconnect()\'s store run and persist it', async () => {
    const s = stack(page('A'));
    const keeper = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    const doc = s.hocuspocus.documents.get(DOC)!;
    const original = s.db.updatePage.getMockImplementation()!;
    s.db.updatePage.mockImplementationOnce(async (values) => {
      // A peer's keystroke arrives during the write's I/O.
      doc.transact(() => doc.getXmlFragment('default').insert(0, [new Y.XmlText('typed meanwhile')]));
      return original(values);
    });
    await expect(
      s.handlers.conditionalUpdatePageContent(DOC, { prosemirrorJson: page('B'), operation: 'replace', user: USER }),
    ).resolves.toEqual({ applied: true });
    expect(s.storeHook).toHaveBeenCalledTimes(2);
    expect(lockedReads(s.db)).toBe(2); // the second store ran
    expect(s.db.updatePage).toHaveBeenCalledTimes(2);
    expect(rowHas(s.db, 'typed meanwhile')).toBe(true);
    await keeper.disconnect();
  });

  it('an out-of-band row write between two writes is a memo MISS: diffed and folded in, never lost', async () => {
    const s = stack(page('A', 800));
    const keeper = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    const doc = s.hocuspocus.documents.get(DOC)!;
    // Another writer (another lineage) adds content straight to the row.
    const other = new Y.Doc();
    Y.applyUpdate(other, s.db.row.ydoc!);
    const big = TiptapTransformer.toYdoc(page('OOB', 800) as never, 'default', tiptapExtensions);
    other.getXmlFragment('default').insert(0, [new Y.XmlText('out-of-band ')]);
    Y.applyUpdate(other, Y.encodeStateAsUpdate(big));
    s.db.row.ydoc = Buffer.from(Y.encodeStateAsUpdate(other));
    passes.reset();
    await expect(
      s.handlers.conditionalUpdatePageContent(DOC, { prosemirrorJson: page('B', 10), operation: 'append', user: USER }),
    ).resolves.toEqual({ applied: true });
    expect(passes.counts.diff).toBe(1); // the transact store diffed the changed bytes; the disconnect store was skipped
    expect(rowHas(s.db, 'out-of-band')).toBe(true);
    expect(rowHas(s.db, 'B paragraph 9')).toBe(true);
    expect(TiptapTransformer.fromYdoc(doc, 'default').content.length).toBeGreaterThan(800);
    await keeper.disconnect();
  });

  it('a refused write (stale digest) after the connection opened still never skips a store it needs', async () => {
    // The in-transaction CAS refuses; the doc's transaction ran (an empty one), so the store runs as before (a no-op
    // deep-equal), and disconnect()'s store is skipped.
    const s = stack(page('A', 50));
    await expect(
      s.handlers.conditionalUpdatePageContent(DOC, {
        prosemirrorJson: page('B', 5),
        operation: 'replace',
        user: USER,
        expectedContentHash: 'stale',
      }),
    ).resolves.toEqual({ applied: false, reason: 'precondition' });
    expect(s.storeHook).toHaveBeenCalledTimes(2);
    expect(lockedReads(s.db)).toBe(1);
    expect(s.db.updatePage).toHaveBeenCalledTimes(0); // the row already held it
  });

  // #731: a write that LOADS the page yields one macrotask between the load and the transaction (two event-loop blocks,
  // not one); a write to a RESIDENT page never yields there (#282: nothing between the pre-check and the transaction).
  const orderAroundOpen = (s: ReturnType<typeof stack>) => {
    const order: string[] = [];
    const open = s.hocuspocus.openDirectConnection.bind(s.hocuspocus);
    jest.spyOn(s.hocuspocus, 'openDirectConnection').mockImplementation(async (name: string, ctx?: unknown) => {
      const conn = await open(name, ctx);
      order.push('opened');
      setImmediate(() => order.push('macrotask'));
      let first = true;
      conn.document!.on('beforeTransaction', () => first && (first = false, order.push('transaction')));
      return conn;
    });
    return order;
  };

  it('NON-RESIDENT: one macrotask between the load and the transaction; the CAS still decides inside it', async () => {
    const s = stack(page('A', 50));
    const order = orderAroundOpen(s);
    await expect(
      s.handlers.conditionalUpdatePageContent(DOC, { prosemirrorJson: page('B', 5), operation: 'replace', user: USER }),
    ).resolves.toEqual({ applied: true });
    expect(order).toEqual(['opened', 'macrotask', 'transaction']);
    // A stale digest on a page that had to load is still refused by the in-transaction compare, nothing applied.
    await settleTimers();
    const t = stack(page('A', 50));
    const order2 = orderAroundOpen(t);
    await expect(
      t.handlers.conditionalUpdatePageContent(DOC, {
        prosemirrorJson: page('B', 5),
        operation: 'replace',
        user: USER,
        expectedContentHash: 'stale',
      }),
    ).resolves.toEqual({ applied: false, reason: 'precondition' });
    expect(order2).toEqual(['opened', 'macrotask', 'transaction']);
    expect(rowHas(t.db, 'B paragraph')).toBe(false);
  });

  it('RESIDENT: no macrotask between opening and the transaction (the #282 window is unchanged)', async () => {
    const s = stack(page('A', 50));
    const keeper = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    const order = orderAroundOpen(s);
    const settled = (await s.handlers.flushPageContent(DOC, { withDigest: true })) as { contentDigest: string };
    await expect(
      s.handlers.conditionalUpdatePageContent(DOC, {
        prosemirrorJson: page('B', 5),
        operation: 'replace',
        user: USER,
        expectedContentHash: settled.contentDigest,
      }),
    ).resolves.toEqual({ applied: true });
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['opened', 'transaction', 'macrotask']);
    await keeper.disconnect();
  });

  it('load in place equals the pre-#731 load (return a doc, Hocuspocus re-encodes and applies it), and the legacy content-only row still converts', async () => {
    const s = stack(page('A', 200));
    const conn = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    const loaded = s.hocuspocus.documents.get(DOC)!;
    const before = new Y.Doc();
    const tmp = new Y.Doc();
    Y.applyUpdate(tmp, new Uint8Array(s.db.row.ydoc!));
    Y.applyUpdate(before, Y.encodeStateAsUpdate(tmp));
    expect(Buffer.from(Y.encodeStateAsUpdate(loaded)).equals(Buffer.from(Y.encodeStateAsUpdate(before)))).toBe(true);
    await conn.disconnect();
    await settleTimers();

    const legacy = stack(page('L', 20));
    legacy.db.row.ydoc = null;
    const c2 = await legacy.hocuspocus.openDirectConnection(DOC, {});
    const ldoc = legacy.hocuspocus.documents.get(DOC)!;
    expect(TiptapTransformer.fromYdoc(ldoc, 'default')).toEqual(legacy.db.row.content);
    await c2.disconnect();
  });
});
