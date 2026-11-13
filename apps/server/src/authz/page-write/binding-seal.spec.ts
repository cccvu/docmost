import * as Y from 'yjs';
import { createHash } from 'node:crypto';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { COLLAB_PAGE_COMPACTING_REASON } from '../collab-ingress/collab-reasons';
import { RemoteClient } from '../collab-ingress/collab-ingress.testkit';
import { CollabUpdateGuardExtension } from '../collab-ingress/collab-update-guard.extension';
import { CollabUpdateGuard } from '../collab-ingress/update-guard';
import {
  bindingSealLogSink,
  commitPendingSeal,
  noteSeal,
  resetBindingSealLogForTests,
  SEAL_ENTRIES_MAX,
  sealLifetimeOf,
  unclaimedLifetime,
  type SealEntry,
} from './binding-seal';
import { LINEAGE_ROOT } from './compaction-registry';
import { loadStableYdoc } from './heal-image';
import { memoryHealStore, type MemoryHealStore } from './heal-image.testkit';
import { serverSchema } from './prelim-content';

/**
 * #793 (ADR 0036 #793 amendment): the seal's claim, restore and commit (binding-seal.ts) against the in-memory store.
 * binding-seal.pg.spec.ts runs the same paths on Postgres through Hocuspocus 4.7.1; relay-binding.spec.ts pins the
 * guard's awareness-only adoption.
 */
const PAGE = '00000000-0000-4000-8000-000000000793';
const DOC = `page.${PAGE}`;
const V = 1001;
const W = 2002;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');
const typeAt0 = (c: RemoteClient, against: Y.Doc, text: string) =>
  c.edit(against, (f) => ((f.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, text));

/** A row where V and W each typed (their clocks in the row are `clocks`). */
function row() {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(serverSchema(), { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'base' }] }] }, 'default')));
  Y.applyUpdate(doc, typeAt0(new RemoteClient(doc, V), doc, 'v '));
  Y.applyUpdate(doc, typeAt0(new RemoteClient(doc, W), doc, 'w '));
  const bytes = Y.encodeStateAsUpdate(doc);
  return { bytes, clocks: { v: Y.getState(doc.store, V), w: Y.getState(doc.store, W) } };
}

const sealed = (store: MemoryHealStore, entries: SealEntry[], over: { rowSha?: string; epoch?: number } & { bytes: Uint8Array }) =>
  store.seals.set(PAGE, { lifetimeId: 'earlier', epoch: over.epoch ?? 0, rowSha: over.rowSha ?? sha(over.bytes), entries });

let lines: string[];
beforeEach(() => {
  resetBindingSealLogForTests();
  lines = [];
  jest.spyOn(bindingSealLogSink, 'warn').mockImplementation((line) => void lines.push(line));
});
afterEach(() => jest.restoreAllMocks());
const logged = () => lines.map((l) => JSON.parse(l.slice(l.indexOf('{'))));

async function load(store: MemoryHealStore, bytes: Uint8Array, clientID?: number) {
  const doc = new Y.Doc();
  if (clientID !== undefined) doc.clientID = clientID;
  await loadStableYdoc(doc, PAGE, bytes, store);
  return doc;
}

describe('the claim at load (loadStableYdoc)', () => {
  it('restores every entry whose row, epoch and clock match, and consumes the seal: the next load finds only a claim (unclean)', async () => {
    const { bytes, clocks } = row();
    const store = memoryHealStore({ ydoc: bytes });
    sealed(store, [[V, 'u', clocks.v], [W, 'a', clocks.w]], { bytes });
    const first = await load(store, bytes);
    expect(sealLifetimeOf(first)).toMatchObject({ pageId: PAGE, claimed: true, restored: [[V, 'u', clocks.v], [W, 'a', clocks.w]] });
    expect(lines).toEqual([]);
    const claim = store.seals.get(PAGE)!;
    expect(claim).toEqual({ lifetimeId: sealLifetimeOf(first)!.lifetimeId, epoch: null, rowSha: null, entries: null });
    // the first lifetime crashed (no seal committed): the second load restores nothing
    const second = await load(store, bytes);
    expect(sealLifetimeOf(second)!.restored).toEqual([]);
    expect(logged()).toEqual([{ pageId: PAGE, reason: 'unclean' }]);
    expect(store.seals.get(PAGE)!.lifetimeId).toBe(sealLifetimeOf(second)!.lifetimeId);
  });

  it('a clock that moved since the seal (a net-zero tail the store never wrote) is not restored; the others are', async () => {
    const { bytes, clocks } = row();
    const store = memoryHealStore({ ydoc: bytes });
    sealed(store, [[V, 'u', clocks.v + 2], [W, 'a', clocks.w]], { bytes });
    const doc = await load(store, bytes);
    expect(sealLifetimeOf(doc)!.restored).toEqual([[W, 'a', clocks.w]]);
    expect(logged()).toEqual([{ pageId: PAGE, reason: 'clock', entries: 2, restored: 1 }]);
  });

  it.each([
    ['no row', null, 'none'],
    ['an empty seal', 'empty', 'none'],
    ['another row\'s bytes', 'stale_sha', 'stale_sha'],
    ['another lineage epoch', 'epoch', 'epoch'],
  ] as const)('%s: nothing restored (%s)', async (_name, kind, reason) => {
    const { bytes, clocks } = row();
    const store = memoryHealStore({ ydoc: bytes });
    if (kind === 'empty') sealed(store, [], { bytes });
    if (kind === 'stale_sha') sealed(store, [[V, 'u', clocks.v]], { bytes, rowSha: sha(new Uint8Array([1])) });
    if (kind === 'epoch') sealed(store, [[V, 'u', clocks.v]], { bytes, epoch: 1 });
    const doc = await load(store, bytes);
    expect(sealLifetimeOf(doc)!.restored).toEqual([]);
    expect(logged()[0]).toMatchObject({ pageId: PAGE, reason });
  });

  it('a malformed lineage restores nothing (never guessed)', async () => {
    const { clocks } = row();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row().bytes);
    doc.getMap(LINEAGE_ROOT).set('epoch', 'x');
    const bytes = Y.encodeStateAsUpdate(doc);
    const store = memoryHealStore({ ydoc: bytes });
    sealed(store, [[V, 'u', clocks.v]], { bytes });
    expect(sealLifetimeOf(await load(store, bytes))!.restored).toEqual([]);
    expect(logged()).toEqual([{ pageId: PAGE, reason: 'epoch', entries: 1 }]);
  });

  it('never restores the new lifetime\'s own server id', async () => {
    const { bytes, clocks } = row();
    const store = memoryHealStore({ ydoc: bytes });
    sealed(store, [[V, 'u', clocks.v], [4242, 'x', 0]], { bytes });
    expect(sealLifetimeOf(await load(store, bytes, 4242))!.restored).toEqual([[V, 'u', clocks.v]]);
  });

  it('a claim that fails is try-later, logged', async () => {
    const { bytes } = row();
    const store = memoryHealStore({ ydoc: bytes });
    store.claimSeal = async () => {
      throw new Error('down');
    };
    await expect(load(store, bytes)).rejects.toMatchObject({ reason: COLLAB_PAGE_COMPACTING_REASON });
    expect(logged()).toEqual([{ pageId: PAGE, stage: 'claim' }]);
  });
});

describe('the adoption at afterLoadDocument', () => {
  it.each(['enforce', 'report'] as const)('%s mode: restored ids are bound awareness-only before the hook yields', async (mode) => {
    const { bytes, clocks } = row();
    const store = memoryHealStore({ ydoc: bytes });
    sealed(store, [[V, 'u', clocks.v]], { bytes });
    const doc = (await load(store, bytes)) as Y.Doc & { name: string };
    doc.name = DOC;
    const guard = new CollabUpdateGuard({ mode, logger: { warn: () => undefined } });
    const ext = new CollabUpdateGuardExtension(guard, { repair: () => ({ attrs: 0, marks: 0, spills: 0, skipped: 0, rules: [] }) as never });
    const done = ext.afterLoadDocument({ document: doc, documentName: DOC } as never);
    expect(guard.isAwarenessOnly(doc, V)).toBe(true); // synchronously, before the hook's first yield
    expect(guard.isAwarenessOnly(doc, W)).toBe(false); // not sealed
    await done;
  });
});

describe('the commit at unload', () => {
  it('commits only the claiming lifetime\'s seal: a later claim makes it write nothing', async () => {
    const { bytes, clocks } = row();
    const store = memoryHealStore({ ydoc: bytes });
    const first = await load(store, bytes);
    noteSeal(first, DOC, { epoch: 0, rowSha: sha(bytes), entries: [[V, 'u', clocks.v]] });
    expect(await commitPendingSeal(DOC)).toBe(1);
    expect(store.seals.get(PAGE)!.entries).toEqual([[V, 'u', clocks.v]]);
    expect(await commitPendingSeal(DOC)).toBe(0); // consumed
    // a same-node reload claims before the old lifetime commits
    const second = await load(store, bytes);
    noteSeal(second, DOC, { epoch: 0, rowSha: sha(bytes), entries: [] });
    await load(store, bytes); // a third lifetime claimed first
    expect(await commitPendingSeal(DOC)).toBe(0);
    expect(store.seals.get(PAGE)!.entries).toBeNull();
  });

  it('a document with no registered lifetime notes nothing; at most SEAL_ENTRIES_MAX entries, the newest', async () => {
    const { bytes } = row();
    noteSeal(new Y.Doc(), DOC, { epoch: 0, rowSha: sha(bytes), entries: [[V, 'u', 1]] });
    expect(await commitPendingSeal(DOC)).toBe(0);
    const store = memoryHealStore({ ydoc: bytes });
    const doc = await load(store, bytes);
    const many: SealEntry[] = Array.from({ length: SEAL_ENTRIES_MAX + 3 }, (_, i) => [10_000 + i, 'u', 1]);
    noteSeal(doc, DOC, { epoch: 0, rowSha: sha(bytes), entries: many });
    await commitPendingSeal(DOC);
    expect(store.seals.get(PAGE)!.entries).toEqual(many.slice(3));
  });

  it('a commit that fails never rejects: logged, and the next load is unclean', async () => {
    const { bytes } = row();
    const store = memoryHealStore({ ydoc: bytes });
    const doc = await load(store, bytes);
    store.commitSeal = async () => {
      throw new Error('down');
    };
    noteSeal(doc, DOC, { epoch: 0, rowSha: sha(bytes), entries: [] });
    await expect(commitPendingSeal(DOC)).resolves.toBe(0);
    expect(logged()).toEqual([{ pageId: PAGE, reason: 'none' }, { pageId: PAGE, stage: 'commit' }]);
  });

  it('a lifetime that loaded no stored ydoc seals insert-if-absent: never over a row a load already claimed', async () => {
    const { bytes, clocks } = row();
    const store = memoryHealStore({ ydoc: bytes });
    const fresh = new Y.Doc();
    expect(unclaimedLifetime(fresh, PAGE, null)).toBeUndefined(); // no boot handle: nothing registered
    const lifetime = { pageId: PAGE, lifetimeId: 'fresh', claimed: false, store, restored: [] };
    // through the store's own insert-if-absent (the boot handle's statements are pinned on Postgres)
    expect(await store.commitSeal(PAGE, lifetime.lifetimeId, false, { epoch: 0, rowSha: sha(bytes), entries: [[V, 'u', clocks.v]] })).toBe(1);
    expect(await store.commitSeal(PAGE, 'other', false, { epoch: 0, rowSha: sha(bytes), entries: [] })).toBe(0);
    expect(store.seals.get(PAGE)!.entries).toEqual([[V, 'u', clocks.v]]);
  });
});
