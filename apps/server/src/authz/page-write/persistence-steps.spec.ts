// #731 F2/F3: the persistence seam's load reads `content` only for a legacy row, and its store yields a loop turn
// between its page-sized steps, never inside the snapshot. The REAL stack (Hocuspocus 4.7.1, PersistenceExtension,
// CollaborationHandler, yjs, the tiptap transformer); only the `pages` row and the queues are fakes, as in
// content-write-passes.spec.ts.
const mockTx = { inside: false, preparing: false };
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
import * as util from '../../collaboration/collaboration.util';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';
import * as reconcile from './reconcile-store';
import * as healImage from './heal-image';
import { findPageRowForLoad } from './persistence-steps';
import { markSuperseded, registerInflight } from './compaction-registry';
import { hasStoreFailure } from './store-failure-registry';
import { memoryHealStore } from './heal-image.testkit';
import { replicaLogOf } from '../collab-ingress/exact-replica-registry';
import { isReloadStable, strictOrderDiff } from '../collab-ingress/order-parity';
import { rawUpdate } from '../collab-ingress/conflict-scan.testkit';
import * as compaction from './compaction';

/** #840: the guard's replica log of `doc` is trusted and rebuilds it exactly (each load branch attached its bytes). */
const replicaLogRebuilds = (doc: Y.Doc) => {
  const log = replicaLogOf(doc);
  return log !== null && strictOrderDiff(log.rebuild(), doc) === null;
};

const PAGE_ID = '99999999-9999-4999-8999-999999999999';
const DOC = `page.${PAGE_ID}`;
const USER = { id: 'api-user', name: 'API' } as never;

type Json = { type: string; content?: Json[]; text?: string };
const page = (label: string, n = 40): Json => ({
  type: 'doc',
  content: Array.from({ length: n }, (_, i) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: `${label} paragraph ${i}` }],
  })),
});

/** The `pages` row: content is jsonb (a JSON round trip), ydoc is bytea (a copy). */
function stack(initial: Json) {
  const seed = TiptapTransformer.toYdoc(initial as never, 'default', util.tiptapExtensions);
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
  const findById = jest.fn(
    async (_id: string, opts?: { withLock?: boolean; includeContent?: boolean; includeYdoc?: boolean }) => {
      const out: Record<string, unknown> = { ...row };
      delete out.content;
      delete out.ydoc;
      if (opts?.includeContent) out.content = JSON.parse(JSON.stringify(row.content));
      if (opts?.includeYdoc) out.ydoc = row.ydoc ? Buffer.from(row.ydoc) : null;
      return out;
    },
  );
  const updatePage = jest.fn(async (values: { content: unknown; ydoc: Buffer }) => {
    row.content = JSON.parse(JSON.stringify(values.content));
    row.ydoc = Buffer.from(values.ydoc);
  });
  const queue = { add: jest.fn(async () => undefined) } as never;
  const persistence = new PersistenceExtension(
    { findById, updatePage } as never,
    memoryHealStore(row) as never, // #840: the heal rows (none: every page here is order-stable)
    queue,
    queue,
    queue,
    { addContributors: jest.fn(async () => undefined) } as never,
    { syncPageTransclusions: jest.fn(async () => undefined), syncPageReferences: jest.fn(async () => undefined) } as never,
  );
  const hocuspocus = new Hocuspocus({ quiet: true, extensions: [persistence], debounce: 60_000, maxDebounce: 60_000 } as never);
  const handlers = new CollaborationHandler().getHandlers(hocuspocus);
  return { row, findById, updatePage, hocuspocus, handlers };
}

const lockedReads = (s: ReturnType<typeof stack>) => s.findById.mock.calls.filter((c) => c[1]?.withLock).length;
const rowHas = (s: ReturnType<typeof stack>, text: string) => JSON.stringify(s.row.content).includes(text);
/** The row's `content` is exactly what its `ydoc` holds (one snapshot, #390). */
const rowAgrees = (s: ReturnType<typeof stack>) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, new Uint8Array(s.row.ydoc!));
  return JSON.stringify(TiptapTransformer.fromYdoc(d, 'default')) === JSON.stringify(s.row.content);
};
const settleTimers = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => jest.restoreAllMocks());

describe('findPageRowForLoad (#731 F2)', () => {
  it('a row with a ydoc: one read, without content', async () => {
    const findById = jest.fn(async () => ({ id: 'p', ydoc: Buffer.from([1]) }));
    await expect(findPageRowForLoad(findById, 'p')).resolves.toEqual({ id: 'p', ydoc: Buffer.from([1]) });
    expect(findById.mock.calls).toEqual([['p', { includeYdoc: true }]]);
  });

  it('a legacy row (no ydoc): read again with its content, and that read is the answer', async () => {
    const findById = jest
      .fn()
      .mockResolvedValueOnce({ id: 'p', ydoc: null })
      .mockResolvedValueOnce({ id: 'p', ydoc: null, content: { type: 'doc' } });
    await expect(findPageRowForLoad(findById, 'p')).resolves.toEqual({ id: 'p', ydoc: null, content: { type: 'doc' } });
    expect(findById.mock.calls).toEqual([
      ['p', { includeYdoc: true }],
      ['p', { includeContent: true, includeYdoc: true }],
    ]);
  });

  it('no row: not read again; a row that changed between the reads is answered as the second read saw it', async () => {
    const missing = jest.fn(async () => undefined);
    await expect(findPageRowForLoad(missing, 'p')).resolves.toBeUndefined();
    expect(missing).toHaveBeenCalledTimes(1);
    const gained = jest
      .fn()
      .mockResolvedValueOnce({ id: 'p', ydoc: null })
      .mockResolvedValueOnce({ id: 'p', ydoc: Buffer.from([2]), content: { type: 'doc' } });
    await expect(findPageRowForLoad(gained, 'p')).resolves.toMatchObject({ ydoc: Buffer.from([2]) });
    const deleted = jest.fn().mockResolvedValueOnce({ id: 'p', ydoc: null }).mockResolvedValueOnce(undefined);
    await expect(findPageRowForLoad(deleted, 'p')).resolves.toBeUndefined();
  });
});

describe('findPageRowForLoad waits for the page\'s compaction in flight (#827)', () => {
  it('reads the row only once the compaction settled (it rewrites the ydoc), even a failed one', async () => {
    let settle!: (v?: unknown) => void;
    let fail!: (e: unknown) => void;
    registerInflight('p827', new Promise((resolve) => (settle = resolve)));
    const findById = jest.fn(async () => ({ id: 'p827', ydoc: Buffer.from([1]) }));
    const load = findPageRowForLoad(findById, 'p827');
    await settleTimers();
    expect(findById).not.toHaveBeenCalled();
    settle();
    await expect(load).resolves.toMatchObject({ id: 'p827' });
    registerInflight('p827b', new Promise((_r, reject) => (fail = reject)));
    const other = findPageRowForLoad(findById, 'p827b');
    fail(new Error('compaction failed'));
    await expect(other).resolves.toMatchObject({ id: 'p827' });
    // another page never waits
    findById.mockClear();
    registerInflight('p827c', new Promise(() => undefined));
    await findPageRowForLoad(findById, 'p827d');
    expect(findById).toHaveBeenCalledTimes(1);
  });
});

describe('PersistenceExtension.onStoreDocument skips a superseded document (#827, seam #122)', () => {
  it('a copy a compaction superseded never stores; its settle fails closed', async () => {
    const s = stack(page('seed', 3));
    const conn = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    const doc = s.hocuspocus.documents.get(DOC)!;
    let settled: unknown;
    try {
      doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]); // unsaved: the next store would run
      markSuperseded(doc, 1);
      settled = await s.handlers.flushPageContent(DOC, { withDigest: true });
    } finally {
      await conn.disconnect(); // always: an open connection keeps jest from exiting
      await settleTimers();
    }
    expect(settled).toEqual({ flushed: false, reason: 'error' });
    expect(lockedReads(s)).toBe(0);
    expect(s.updatePage).not.toHaveBeenCalled();
    expect(hasStoreFailure(doc)).toBe(true);
  });
});

describe('PersistenceExtension.onLoadDocument (#731 F2, seam #122)', () => {
  it('loading a page with a ydoc never selects its content, and loads the same document as before', async () => {
    const s = stack(page('A'));
    const conn = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    const loads = s.findById.mock.calls.filter((c) => !c[1]?.withLock);
    expect(loads).toEqual([[PAGE_ID, { includeYdoc: true }]]);
    const doc = s.hocuspocus.documents.get(DOC)!;
    const expected = new Y.Doc();
    Y.applyUpdate(expected, new Uint8Array(s.row.ydoc!));
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(Buffer.from(Y.encodeStateAsUpdate(expected)))).toBe(true);
    expect(replicaLogRebuilds(doc)).toBe(true); // #840: the row's bytes
    await conn.disconnect();
  });

  it('a legacy content-only row still converts its content (read with the content, then toYdoc)', async () => {
    const s = stack(page('L', 20));
    s.row.ydoc = null;
    const conn = await s.hocuspocus.openDirectConnection(DOC, {});
    const loads = s.findById.mock.calls.filter((c) => !c[1]?.withLock);
    expect(loads).toEqual([
      [PAGE_ID, { includeYdoc: true }],
      [PAGE_ID, { includeContent: true, includeYdoc: true }],
    ]);
    expect(TiptapTransformer.fromYdoc(s.hocuspocus.documents.get(DOC)!, 'default')).toEqual(s.row.content);
    expect(replicaLogRebuilds(s.hocuspocus.documents.get(DOC)!)).toBe(true); // #840: the exact update it applied
    await conn.disconnect();
  });

  it('a page with neither ydoc nor content loads empty; a missing page loads empty', async () => {
    const s = stack(page('E', 1));
    s.row.ydoc = null;
    s.row.content = null;
    const conn = await s.hocuspocus.openDirectConnection(DOC, {});
    expect(s.hocuspocus.documents.get(DOC)!.isEmpty('default')).toBe(true);
    expect(replicaLogRebuilds(s.hocuspocus.documents.get(DOC)!)).toBe(true); // #840: the empty document's own encoding
    await conn.disconnect();
    await settleTimers();
    const t = stack(page('M', 1));
    t.findById.mockResolvedValueOnce(undefined as never);
    const c2 = await t.hocuspocus.openDirectConnection(DOC, {});
    expect(t.findById).toHaveBeenCalledTimes(1);
    expect(t.hocuspocus.documents.get(DOC)!.isEmpty('default')).toBe(true);
    expect(replicaLogRebuilds(t.hocuspocus.documents.get(DOC)!)).toBe(true);
    await c2.disconnect();
  });
});

describe('PersistenceExtension.onStoreDocument yields (#731 F3)', () => {
  /**
   * Records the store's steps (inside its transaction) and, after each, queues a macrotask marker `~`. A marker
   * between two steps means the store yielded between them; consecutive markers collapse to one.
   */
  function recordSteps(s: ReturnType<typeof stack>, hooks: Partial<Record<string, () => void>> = {}) {
    const order: string[] = [];
    // #840: the snapshot (and its order check) runs before the row lock, in heal-image's prepareStore.
    const prepare = healImage.prepareStore;
    jest.spyOn(healImage, 'prepareStore').mockImplementation(async (...a) => {
      mockTx.preparing = true;
      try {
        return await prepare(...a);
      } finally {
        mockTx.preparing = false;
      }
    });
    const step = (name: string) => {
      if (!mockTx.inside && !mockTx.preparing) return;
      order.push(name);
      hooks[name]?.();
      setImmediate(() => order[order.length - 1] !== '~' && order.push('~'));
    };
    const find = s.findById.getMockImplementation()!;
    s.findById.mockImplementation(async (id, opts) => {
      if (opts?.withLock) step('lockedRead');
      return find(id, opts);
    });
    const rec = reconcile.reconcileRowIntoDoc;
    jest.spyOn(reconcile, 'reconcileRowIntoDoc').mockImplementation((...a) => (step('reconcile'), rec(...a)));
    const from = TiptapTransformer.fromYdoc.bind(TiptapTransformer);
    jest.spyOn(TiptapTransformer, 'fromYdoc').mockImplementation(((...a: Parameters<typeof from>) => {
      const out = from(...a);
      step('fromYdoc');
      return out;
    }) as never);
    const enc = Y.encodeStateAsUpdate;
    jest.spyOn(Y, 'encodeStateAsUpdate').mockImplementation((...a: Parameters<typeof enc>) => {
      const out = enc(...a);
      step('encode');
      return out;
    });
    const text = util.jsonToText;
    jest.spyOn(util, 'jsonToText').mockImplementation((...a: Parameters<typeof text>) => {
      const out = text(...a);
      step('jsonToText');
      return out;
    });
    const upd = s.updatePage.getMockImplementation()!;
    s.updatePage.mockImplementation(async (v) => (step('updatePage'), upd(v)));
    return order;
  }

  /** A peer's keystroke, as a websocket frame would apply it: its own transaction on the live document. */
  const typeInto = (doc: Y.Doc, text: string) =>
    doc.transact(() => doc.getXmlFragment('default').insert(0, [new Y.XmlText(text)]));

  it('order: ONE synchronous snapshot (generation, fromYdoc, encode) before the lock (#840) → locked read → yield → reconcile → yield → jsonToText → yield → write', async () => {
    const s = stack(page('A'));
    const keeper = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    const order = recordSteps(s);
    await expect(
      s.handlers.conditionalUpdatePageContent(DOC, { prosemirrorJson: page('B', 3), operation: 'append', user: USER }),
    ).resolves.toEqual({ applied: true });
    // ONE store ran (disconnect()'s was skipped): exactly these steps, the markers exactly at the three yields. #840:
    // the snapshot is taken before the row lock and written, because the locked row is the bytes the document covered.
    expect(order).toEqual(['fromYdoc', 'encode', 'lockedRead', '~', 'reconcile', '~', 'jsonToText', '~', 'updatePage']);
    expect(rowAgrees(s)).toBe(true);
    await keeper.disconnect();
  });

  it('an edit landing during the snapshot is never between fromYdoc and the encode: the row agrees with itself and the next store persists it', async () => {
    // The edit is queued while fromYdoc runs. With nothing yielding before the encode it lands in the yield after the
    // snapshot: the stored content and ydoc are the same snapshot, and the edit (newer than the recorded generation)
    // makes disconnect()'s store run. A yield added between fromYdoc and the encode would store a ydoc holding the
    // edit beside a content without it (this spec goes red).
    const s = stack(page('A'));
    const keeper = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    const doc = s.hocuspocus.documents.get(DOC)!;
    let armed = true;
    let rowAfterFirstStore: boolean | undefined;
    recordSteps(s, {
      fromYdoc: () => armed && ((armed = false), setImmediate(() => typeInto(doc, 'typed during snapshot'))),
    });
    const upd = s.updatePage.getMockImplementation()!;
    s.updatePage.mockImplementationOnce(async (v) => {
      await upd(v);
      rowAfterFirstStore = rowAgrees(s);
    });
    await expect(
      s.handlers.conditionalUpdatePageContent(DOC, { prosemirrorJson: page('B', 3), operation: 'append', user: USER }),
    ).resolves.toEqual({ applied: true });
    expect(rowAfterFirstStore).toBe(true);
    expect(lockedReads(s)).toBe(2); // the edit came after the snapshot: the second store was not skipped
    expect(rowHas(s, 'typed during snapshot')).toBe(true);
    expect(rowAgrees(s)).toBe(true);
    await keeper.disconnect();
  });

  it.each([
    // #840: the snapshot is taken before the lock, so an edit in any of the store's yields is newer than it.
    ['the yield after the locked read (before the reconcile)', 'lockedRead', 2],
    ['the yield after the snapshot', 'encode', 2],
    ['the yield after jsonToText', 'jsonToText', 2],
  ])('an edit landing in %s is persisted, and a store after the snapshot is never skipped over it', async (_l, at, stores) => {
    const s = stack(page('A'));
    const keeper = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    const doc = s.hocuspocus.documents.get(DOC)!;
    let armed = true;
    recordSteps(s, { [at]: () => armed && ((armed = false), setImmediate(() => typeInto(doc, `typed at ${at}`))) });
    await expect(
      s.handlers.conditionalUpdatePageContent(DOC, { prosemirrorJson: page('B', 3), operation: 'append', user: USER }),
    ).resolves.toEqual({ applied: true });
    // After the snapshot (#840: every yield is), the generation recorded is the snapshot's, older than the edit, so
    // disconnect()'s store runs and persists it.
    expect(lockedReads(s)).toBe(stores);
    expect(rowHas(s, `typed at ${at}`)).toBe(true);
    expect(rowHas(s, 'B paragraph 2')).toBe(true);
    expect(rowAgrees(s)).toBe(true);
    // And the row now covers the live document: the next store has nothing new and is skipped.
    s.findById.mockClear();
    await keeper.transact(() => undefined); // a store hook with no transaction since the last store
    expect(lockedReads(s)).toBe(0);
    expect(s.updatePage).toHaveBeenCalledTimes(stores);
    await keeper.disconnect();
  });
});

describe('PersistenceExtension.onStoreDocument keeps the order check out of the row lock (#840 review item 4)', () => {
  /** Records, around the locked read, the store's reloads (`Y.applyUpdate` on a document it made) and image builds. */
  function recordAroundLock(s: ReturnType<typeof stack>) {
    const order: string[] = [];
    const find = s.findById.getMockImplementation()!;
    s.findById.mockImplementation(async (id, opts) => {
      if (opts?.withLock) order.push('lockedRead');
      return find(id, opts);
    });
    let storing = false;
    const store = s.updatePage.getMockImplementation()!;
    s.updatePage.mockImplementation(async (v) => {
      order.push('write');
      return store(v);
    });
    const apply = Y.applyUpdate;
    jest.spyOn(Y, 'applyUpdate').mockImplementation((...a: Parameters<typeof apply>) => {
      if (storing) order.push('apply');
      return apply(...a);
    });
    const build = compaction.buildCompacted;
    jest.spyOn(compaction, 'buildCompacted').mockImplementation((...a: Parameters<typeof build>) => {
      if (storing) order.push('buildImage');
      return build(...a);
    });
    const onStore = PersistenceExtension.prototype.onStoreDocument;
    jest.spyOn(PersistenceExtension.prototype, 'onStoreDocument').mockImplementation(async function (this: PersistenceExtension, ...a) {
      storing = true;
      try {
        return await onStore.apply(this, a);
      } finally {
        storing = false;
      }
    });
    return order;
  }

  it('a stable store: its reload runs before the lock; nothing page-sized runs under it', async () => {
    const s = stack(page('A'));
    const keeper = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    const order = recordAroundLock(s);
    await keeper.transact((d) => d.getXmlFragment('default').insert(0, [new Y.XmlText('more')]));
    await expect(s.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: true });
    expect(order).toEqual(['apply', 'lockedRead', 'write']);
    expect(rowAgrees(s)).toBe(true);
    await keeper.disconnect();
  });

  it('an unstable store: its reload and its heal image are built before the lock; the write and the heal row go in one transaction', async () => {
    const s = stack(page('A', 1));
    const keeper = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    const doc = s.hocuspocus.documents.get(DOC)!;
    const text = (doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const start = (text as unknown as { _start: Y.Item })._start.id;
    const order = recordAroundLock(s);
    await keeper.transact((d) =>
      Y.applyUpdate(d, rawUpdate([{ client: start.client + 1, clock: 0, structs: [{ origin: [start.client, start.clock + 5], right: [start.client, start.clock + 3], content: new Y.ContentString('XYZ') }] }])),
    );
    expect(isReloadStable(doc).stable).toBe(false); // precondition
    order.length = 0; // the frame's own apply above is not the store's
    await expect(s.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: true });
    // reload (1), the image build and its decode check (buildCompacted + its own check applies), its reload-stability check
    const lock = order.indexOf('lockedRead');
    expect(lock).toBeGreaterThan(0);
    expect(order.slice(0, lock)).toContain('buildImage');
    expect(order.slice(lock)).toEqual(['lockedRead', 'write']);
    await keeper.disconnect();
  });
});
