import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { Logger } from '@nestjs/common';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';
import { COMPACTION_ARM_DELAY_MS, COMPACTION_MIN_INTERVAL_MS } from './doc-bounds';
import { isReloadStable } from './order-parity';
import { authFrame, FakeSocket, MSG, RemoteClient, renderLikeABrowser, step1Frame, SYNC, syncFrame } from './collab-ingress.testkit';
import { rawUpdate, type RawStruct } from './conflict-scan.testkit';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { COLLAB_PAGE_COMPACTING_REASON } from './collab-reasons';
import { COLLAB_TRY_LATER_CODE, CollabUpdateGuard, TRY_LATER_REASON } from './update-guard';
import { awaitCompaction, lineageEpoch, setCompactionClockForTests } from '../page-write/compaction-registry';
import { resetLoadTripsForTests } from '../page-write/compaction';

/**
 * #840 T3 and T9's Hocuspocus row, end to end (ADR 0036 #840 amendment): the guard AND the persistence seam (#122) in
 * one real Hocuspocus 4.7.1 over real Postgres, fed by fake sockets.
 *
 * The attack (the joiner evidence, reproduced byte for byte: 54 B, 100 B, 23 B): three crafted frames, each schema-valid
 * in live order, after which every RELOAD of the page orders the honest list item's children with a bulletList first
 * (`listItem: paragraph block*` broken). A browser opening that reload (y-tiptap `initProseMirrorDoc`) deletes the
 * honest list, and the delete syncs. Before #840 a joiner's Step2, a restart and a store all served that reload.
 *
 * Asserted: the guard accepts all three frames (they are valid where live applies them); the join (or the store)
 * detects the instability; no joiner is served the unstable state (1013); the page heals into the next epoch; what a
 * joiner is then served renders with 0 deletes and is live's pre-heal content; the blame (the order strike) lands on
 * the crafted author only. And the crash row: an unstable store commits, the process stops before any compaction, a
 * restart serves live's pre-crash content with 0 deletes.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG #840 order heal end to end', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'order_heal_pg_spec';
const USERS: Record<string, { id: string; name: string; readOnly?: boolean }> = {
  attacker: { id: uuid(9401), name: 'Attacker' },
  editor: { id: uuid(9402), name: 'Editor' },
  reader: { id: uuid(9403), name: 'Reader', readOnly: true },
  joiner: { id: uuid(9404), name: 'Joiner', readOnly: true },
};
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
const json = (doc: Y.Doc) => TiptapTransformer.fromYdoc(doc, 'default');

/** The honest page: client 96's bulletList > listItem > paragraph "honest text" (96:0, 96:1, 96:2), then client 97's paragraph. */
function honestPage(): Uint8Array {
  const a = new Y.Doc();
  a.clientID = 96;
  a.transact(() => {
    const [bl, li, p, t] = [new Y.XmlElement('bulletList'), new Y.XmlElement('listItem'), new Y.XmlElement('paragraph'), new Y.XmlText()];
    a.getXmlFragment('default').insert(0, [bl]);
    bl.insert(0, [li]);
    li.insert(0, [p]);
    p.insert(0, [t]);
    t.insert(0, 'honest text');
  });
  const b = new Y.Doc();
  b.clientID = 97;
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  b.transact(() => {
    const [p, t] = [new Y.XmlElement('paragraph'), new Y.XmlText()];
    b.getXmlFragment('default').insert(1, [p]);
    p.insert(0, [t]);
    t.insert(0, 'other honest block');
  });
  return Y.encodeStateAsUpdate(b);
}

const el = (name: string) => new Y.ContentType(new Y.XmlElement(name));
const at = (origin: RawStruct['origin'], right: RawStruct['right'], content: RawStruct['content'], parent?: RawStruct['parent']): RawStruct => ({ origin, right, content, parent });

/** The joiner evidence's F1-F3 (`~` = the frame deletes its own item). Valid in live order at every step. */
const F1 = rawUpdate(
  [{ client: 11, clock: 0, structs: [at([96, 2], [96, 2], el('bulletList')), at(null, [96, 2], el('paragraph')), at([11, 1], null, el('paragraph'))] }],
  [{ client: 11, ranges: [[0, 2]] }],
);
const F2 = rawUpdate(
  [
    {
      client: 42,
      clock: 0,
      structs: [
        at([11, 1], [11, 0], el('bulletList')),
        at(null, [96, 2], el('paragraph')),
        at(null, null, el('paragraph'), [96, 1]),
        at(null, null, el('listItem'), [42, 0]),
        at(null, null, el('paragraph'), [42, 3]),
        at(null, null, new Y.ContentType(new Y.XmlText()), [42, 4]),
        at(null, null, new Y.ContentString('nested'), [42, 5]),
      ],
    },
  ],
  [{ client: 42, ranges: [[2, 1]] }],
);
const F3 = rawUpdate([{ client: 79, clock: 0, structs: [at(null, [11, 2], el('paragraph'))] }], [{ client: 79, ranges: [[0, 1]] }]);

/** The Yjs updates a socket was sent (Step2 and Update, Sync or SyncReply), applied to an empty document: what that client holds. */
function received(sock: FakeSocket): Y.Doc {
  const doc = new Y.Doc();
  for (const m of sock.sent) {
    const dec = decoding.createDecoder(m);
    decoding.readVarString(dec);
    const type = decoding.readVarUint(dec);
    if (type !== MSG.Sync && type !== MSG.SyncReply) continue;
    const subtype = decoding.readVarUint(dec);
    if (subtype === SYNC.Step2 || subtype === SYNC.Update) Y.applyUpdate(doc, decoding.readVarUint8Array(dec));
  }
  return doc;
}

const listItemKids = (doc: Y.Doc) => ((doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlElement).toArray().map((c) => (c as Y.XmlElement).nodeName);

d('#840 T3 + T9: a reload-unstable page through the guard and the store, on real Postgres', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let restoreClock: () => void;
  let now = 9_000_000;
  let armed = true;
  let seq = 0;
  let pageId: string;
  let DOC: string;
  let lines: string[];
  const sockets: FakeSocket[] = [];
  const nodes: Hocuspocus[] = [];

  const row = async () => (await pg<{ content: unknown; ydoc: Buffer }[]>`select content, ydoc from pages where id = ${pageId}`)[0];
  const heal = async () => (await pg<{ epoch: number }[]>`select epoch from ccc_page_heal_image where page_id = ${pageId}`)[0] ?? null;
  const divergence = () => lines.filter((l) => l.startsWith('COLLAB_ORDER_DIVERGENCE ')).map((l) => JSON.parse(l.slice('COLLAB_ORDER_DIVERGENCE '.length)));

  /** One collab node: the guard first (probes off: the join and the store are the detectors here), auth, the real persistence. */
  function node() {
    const pageRepo = new PageRepo(db as never, {} as never, { emit: () => true } as never);
    const queue = { add: jest.fn(async () => undefined) } as never;
    const persistence = new PersistenceExtension(
      pageRepo,
      db as never,
      queue,
      queue,
      queue,
      { addContributors: jest.fn(async () => undefined) } as never,
      { syncPageTransclusions: jest.fn(async () => undefined), syncPageReferences: jest.fn(async () => undefined) } as never,
    );
    const auth = {
      async onAuthenticate(data: any) {
        const user = USERS[data.token];
        if (!user) throw new Error('denied');
        if (user.readOnly) data.connectionConfig.readOnly = true;
        return { user: { id: user.id, name: user.name } };
      },
    };
    const guard = new CollabUpdateGuard({ logger: { warn: (m: string) => lines.push(m) }, schedule: () => ({ cancel: () => undefined }) });
    const hocuspocus = new Hocuspocus({ quiet: true, extensions: [new CollabUpdateGuardExtension(guard), auth, persistence], debounce: 60_000, maxDebounce: 60_000 } as never);
    nodes.push(hocuspocus);
    const handlers = new CollaborationHandler().getHandlers(hocuspocus);
    const connect = async (token: string) => {
      const sock = new FakeSocket();
      sockets.push(sock);
      sock.connect(hocuspocus);
      sock.deliver(authFrame(token, DOC));
      const deadline = Date.now() + 5_000;
      while (!sock.closed && !hocuspocus.documents.get(DOC)?.getConnections().some((c) => c.webSocket === (sock as never))) {
        if (Date.now() > deadline) throw new Error(`connection ${token} was not established`);
        await new Promise((r) => setTimeout(r, 5));
      }
      await settle();
      return sock;
    };
    /** A joiner: connect, send SyncStep1, and wait for the answer (a Step2, or a close). */
    const join = async (token: string) => {
      const sock = await connect(token);
      sock.deliver(step1Frame(new Y.Doc(), DOC));
      await settle();
      return sock;
    };
    const live = () => hocuspocus.documents.get(DOC);
    /** The page left memory: its last store and the unload (and any compaction it ran) are done. */
    const unloaded = async () => {
      const deadline = Date.now() + 10_000;
      while (hocuspocus.documents.has(DOC)) {
        if (Date.now() > deadline) throw new Error('the page never unloaded');
        await new Promise((r) => setTimeout(r, 5));
      }
      await awaitCompaction(pageId);
      await settle();
    };
    return { hocuspocus, handlers, guard, connect, join, live, unloaded };
  }

  /** Budgets the guard keeps per (user, page): the order strikes. */
  const strikesOf = (guard: CollabUpdateGuard, user: string): number =>
    ((guard as any).userDocBudgets.get(`${USERS[user].id}\u0000${DOC}`)?.strikes ?? []).length;

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(appPg);
    await pg`
      create table pages (
        id uuid primary key, slug_id varchar, title varchar, icon varchar, cover_photo varchar, position varchar,
        content jsonb, ydoc bytea, text_content text, tsv tsvector,
        parent_page_id uuid, creator_id uuid, last_updated_by_id uuid, space_id uuid not null, workspace_id uuid not null,
        is_locked boolean not null default false, is_base boolean not null default false, contributor_ids uuid[],
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
      )`;
  });

  beforeEach(async () => {
    lines = [];
    const capture = (m: unknown) => void lines.push(String(m));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined); // Hocuspocus logs every CLOSE
    now += 2 * COMPACTION_MIN_INTERVAL_MS;
    armed = true;
    restoreClock = setCompactionClockForTests({ now: () => now, uptimeMs: () => (armed ? COMPACTION_ARM_DELAY_MS + 1 : 0) });
    resetLoadTripsForTests();
    pageId = uuid(8_400_000 + ++seq);
    DOC = `page.${pageId}`;
    const seed = honestPage();
    const seeded = new Y.Doc();
    Y.applyUpdate(seeded, seed);
    await pg`
      insert into pages (id, slug_id, title, space_id, workspace_id, creator_id, last_updated_by_id, contributor_ids,
                         content, ydoc, text_content, created_at)
      values (${pageId}, 'slug', 'Title', ${uuid(50)}, ${uuid(100)}, ${USERS.editor.id}, ${USERS.editor.id},
              array[${USERS.editor.id}::uuid], ${pg.json(json(seeded) as never)}, ${Buffer.from(seed)}, 'honest text', '2020-01-01')`;
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close(1000, 'test over');
    await settle();
    for (const hp of nodes.splice(0)) hp.closeConnections();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await awaitCompaction(pageId);
    restoreClock();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  /** The attack through the guard: F1-F3 from the attacker's socket, an honest edit from the editor's. Returns live. */
  async function attack(n: ReturnType<typeof node>) {
    const editor = await n.connect('editor');
    const attacker = await n.connect('attacker');
    const live = n.live()!;
    expect(isReloadStable(live).stable).toBe(true); // precondition: the honest page is stable
    const honest = new RemoteClient(live).edit(live, (f) => ((f.get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'edited '));
    editor.deliver(syncFrame(honest, SYNC.Update, MSG.Sync, DOC));
    await settle();
    for (const f of [F1, F2, F3]) {
      attacker.deliver(syncFrame(f, SYNC.Update, MSG.Sync, DOC));
      await settle();
    }
    // The guard accepts all three: each is schema-valid where live applies it.
    expect([attacker.closed, attacker.closeReasons(), editor.closed]).toEqual([null, [], null]);
    expect(Y.getState(live.store, 79)).toBe(1);
    expect(JSON.stringify(json(live))).toContain('edited other honest block'); // the honest edit applied too
    expect(listItemKids(live)[0]).toBe('paragraph'); // live order: valid
    expect(isReloadStable(live).stable).toBe(false); // every reload: not
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(live));
    expect(listItemKids(reload)[0]).toBe('bulletList');
    expect(renderLikeABrowser(live).deleted).toBe(true); // the control: a browser opening a reload deletes the honest list
    return { editor, attacker, live, content: json(live) };
  }

  /** A joiner after the heal: served the next epoch, reload-stable, 0 deletes on render, live's pre-heal content. */
  async function expectHealedJoin(n: ReturnType<typeof node>, content: unknown) {
    const joiner = await n.join('joiner');
    expect(joiner.closed).toBeNull();
    const served = received(joiner);
    expect(lineageEpoch(served)).toBe(1); // epoch + 1: older copies go behind #827's notice
    expect(isReloadStable(served).stable).toBe(true);
    expect(renderLikeABrowser(served)).toMatchObject({ deleted: false, threw: false }); // y-tiptap emits 0 deletes
    expect(json(served)).toEqual(content); // live's pre-heal content, honest list included
    expect(JSON.stringify(json(served))).toContain('honest text');
    expect(await heal()).toBeNull();
  }

  it('T3, the join detects it: the joiner gets 1013 (never the unstable state), the page heals to epoch 1, blame lands on the attacker only', async () => {
    const n = node();
    const { editor, attacker, live, content } = await attack(n);
    const reader = await n.join('reader');
    // The joiner is answered 1013 before any Step2 (the try-later refusal, or the drain the heal starts closing it first):
    // it holds nothing of the page.
    expect(reader.closed?.code).toBe(COLLAB_TRY_LATER_CODE);
    expect([TRY_LATER_REASON, COLLAB_PAGE_COMPACTING_REASON]).toContain(reader.closed?.reason);
    expect(received(reader).getXmlFragment('default').length).toBe(0);
    expect(divergence()).toEqual(expect.arrayContaining([expect.objectContaining({ page: pageId, where: 'join', outcome: 'unstable', suspects: [USERS.attacker.id] })]));
    expect(strikesOf(n.guard, 'attacker')).toBe(1);
    expect(strikesOf(n.guard, 'editor')).toBe(0);
    // The heal: the writers drain (1013, compacting), the last store keeps every item (raw bytes + heal image), and the
    // unload compacts from live into epoch 1, dropping the heal row in its swap.
    expect(editor.closed).toEqual({ code: COLLAB_TRY_LATER_CODE, reason: COLLAB_PAGE_COMPACTING_REASON });
    expect(attacker.closed).toEqual({ code: COLLAB_TRY_LATER_CODE, reason: COLLAB_PAGE_COMPACTING_REASON });
    expect(live.getConnectionsCount()).toBe(0);
    await n.unloaded();
    const stores = divergence().filter((e) => e.where === 'store');
    expect(stores.length).toBeGreaterThan(0);
    expect(stores.every((e) => e.outcome === 'heal_image' && e.suspects.length === 0)).toBe(true);
    expect(lineageEpoch(loadedRow((await row()).ydoc))).toBe(1);
    await expectHealedJoin(n, content);
  });

  it('T3, the store detects it: an unstable store drains the page, and the next joiner is served the healed epoch', async () => {
    const n = node();
    const { editor, attacker, content } = await attack(n);
    await expect(n.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: true });
    expect(divergence()[0]).toEqual(expect.objectContaining({ where: 'store', outcome: 'heal_image', suspects: [] }));
    expect(editor.closed).toEqual({ code: COLLAB_TRY_LATER_CODE, reason: COLLAB_PAGE_COMPACTING_REASON });
    expect(attacker.closed).toEqual({ code: COLLAB_TRY_LATER_CODE, reason: COLLAB_PAGE_COMPACTING_REASON });
    await n.unloaded();
    expect(divergence().every((e) => e.where === 'store' && e.outcome === 'heal_image')).toBe(true); // nothing else found it
    // The store cannot name a client id's user: nobody is struck on its finding alone.
    expect([strikesOf(n.guard, 'attacker'), strikesOf(n.guard, 'editor')]).toEqual([0, 0]);
    await expectHealedJoin(n, content);
  });

  it('T9 (Hocuspocus row): an unstable store commits, the process stops before any compaction, a restart serves live\'s content with 0 deletes', async () => {
    const n = node();
    const { content, live } = await attack(n);
    // The crash: compaction is not armed through the store and the stop, so nothing drains or compacts at the unload.
    armed = false;
    await expect(n.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: true });
    const committed = await row();
    expect(Buffer.from(committed.ydoc)).toEqual(Buffer.from(Y.encodeStateAsUpdate(live))); // I1: live's raw bytes, every item
    expect(listItemKids(loadedRow(committed.ydoc))[0]).toBe('bulletList'); // served as they are, every load shows the reload order…
    expect(renderLikeABrowser(loadedRow(committed.ydoc)).deleted).toBe(true); // …and a browser deletes the honest list
    try {
      for (const s of sockets) s.close(1006, '');
      await n.unloaded();
    } finally {
      armed = true;
    }
    expect(Buffer.from((await row()).ydoc)).toEqual(Buffer.from(committed.ydoc));
    expect(await heal()).toEqual({ epoch: 1 });
    // The restart: a new node over the same database heals from the image at the first load.
    await expectHealedJoin(node(), content);
    expect(divergence().map((e) => [e.where, e.outcome])).toEqual([
      ['store', 'heal_image'],
      ['load', 'healed'],
    ]);
  });
});

function loadedRow(bytes: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}
