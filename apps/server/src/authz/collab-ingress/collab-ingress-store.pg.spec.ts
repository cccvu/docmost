import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';
import * as driftLog from '../page-write/collab-drift-log';
import { hasStoreFailure } from '../page-write/store-failure-registry';
import { isDuplicateWriteKey, recordWriteKey, scopedWriteKey, WRITE_IDEM_MAP } from '../page-write/write-idem';
import { authFrame, awarenessFrame, FakeSocket, MSG, readServerFrame, RemoteClient, SYNC, syncFrame } from './collab-ingress.testkit';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { CollabUpdateGuard, UNRESOLVED_REASON } from './update-guard';

/**
 * #781 on real Postgres (ADR 0036): the REAL store path (Hocuspocus 4.7.1, the real PersistenceExtension and
 * CollaborationHandler settle, PageRepo, postgres.js, Postgres) with the collab update guard in front of it, fed by fake
 * WebSocket clients. Control arms apply the same bytes with no guard and show the damage: a store that fails on every
 * attempt (the #773-style wedge) and a forged or deleted `/v1` idempotency-ledger entry. Treatment arms show the CLOSE,
 * a store that succeeds, the row intact, and a client that replays its refused state (y-indexeddb) refused again.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG collab ingress guard (#781)', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'collab_ingress_store_pg_spec';
const PAGE_ID = uuid(781);
const DOC = `page.${PAGE_ID}`;
const USERS: Record<string, { id: string; name: string }> = {
  attacker: { id: uuid(901), name: 'Attacker' },
  editor: { id: uuid(902), name: 'Editor' },
  peer: { id: uuid(903), name: 'Peer' },
  writer: { id: uuid(904), name: 'Writer' },
};
const REFUSED = (rule: string) => `ccc:collab-update-refused:${rule}`;
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
const textOf = (el: Y.XmlElement): Y.XmlText => el.toArray().find((c) => c instanceof Y.XmlText) as Y.XmlText;
/** A server-side `/v1` write's origin, as Hocuspocus 4.x's `DirectConnection.transact` sets it: a local origin carrying the
 *  caller's context, so Hocuspocus debounces a store with that context. */
const V1_WRITE = { source: 'local' as const, context: { user: USERS.editor } };

d('the collab store behind the ingress guard (#781)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  const sockets: FakeSocket[] = [];
  const nodes: Hocuspocus[] = [];

  const row = async () =>
    (await pg<{ content: any; ydoc: Buffer }[]>`select content, ydoc from pages where id = ${PAGE_ID}`)[0];

  /** One collab node: Hocuspocus with (or without) the guard first, a token-auth stand-in, and the real persistence. */
  function node(withGuard: boolean) {
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
        return { user };
      },
    };
    const guard = new CollabUpdateGuard({ logger: { warn: () => undefined } });
    const extensions: any[] = withGuard ? [new CollabUpdateGuardExtension(guard), auth, persistence] : [auth, persistence];
    const hocuspocus = new Hocuspocus({ quiet: true, extensions, debounce: 60_000, maxDebounce: 60_000 } as never);
    nodes.push(hocuspocus);
    const handlers = new CollaborationHandler().getHandlers(hocuspocus);
    const connect = async (token: string, sock = new FakeSocket()) => {
      if (!sockets.includes(sock)) sockets.push(sock);
      if (!sock.listenerCount('message')) sock.connect(hocuspocus);
      sock.deliver(authFrame(token, DOC));
      // The document loads from Postgres: wait for real I/O, not only for the event loop to turn.
      const deadline = Date.now() + 5_000;
      // Hocuspocus 4.x keys a document's connections by Connection, not by socket.
      while (!hocuspocus.documents.get(DOC)?.getConnections().some((c) => c.webSocket === (sock as never))) {
        if (Date.now() > deadline) throw new Error(`connection ${token} was not established`);
        await new Promise((r) => setTimeout(r, 5));
      }
      await settle();
      return sock;
    };
    const live = () => hocuspocus.documents.get(DOC)!;
    return { hocuspocus, handlers, connect, live, persistence };
  }

  let storeFailures: string[];

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
    storeFailures = [];
    jest.spyOn(console, 'error').mockImplementation(() => undefined); // Hocuspocus logs every CLOSE
    jest.spyOn(driftLog, 'logStoreFailure').mockImplementation((_logger, _pageId, err) => {
      storeFailures.push(String((err as Error)?.message ?? err));
    });
    const seed = TiptapTransformer.toYdoc(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'seed text' }] }] } as never,
      'default',
      tiptapExtensions,
    );
    await pg`delete from pages`;
    await pg`
      insert into pages (id, slug_id, title, space_id, workspace_id, creator_id, last_updated_by_id, contributor_ids,
                         content, ydoc, text_content, created_at)
      values (${PAGE_ID}, 'slug', 'Title', ${uuid(50)}, ${uuid(100)}, ${uuid(902)}, ${uuid(902)}, array[${uuid(902)}::uuid],
              ${pg.json(TiptapTransformer.fromYdoc(seed, 'default'))}, ${Buffer.from(Y.encodeStateAsUpdate(seed))},
              'seed text', '2020-01-01')`;
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close(1000, 'test over');
    await settle();
    for (const h of nodes.splice(0)) h.closeConnections();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  /** A value that is not an XmlElement/XmlText inside `default`: the server's fromYdoc throws on it at every store. */
  const wedge = (live: Y.Doc) => new RemoteClient(live).edit(live, (f) => f.insert(1, [{ evil: 1 } as never]));

  it('case 2 control: with no guard, a non-element child in default fails every store and the settle answers error', async () => {
    const n = node(false);
    const sock = await n.connect('attacker');
    sock.deliver(syncFrame(wedge(n.live()), SYNC.Update, MSG.Sync, DOC));
    await settle();
    await expect(n.handlers.flushPageContent(DOC, { withDigest: true })).resolves.toMatchObject({ flushed: false, reason: 'error' });
    expect(hasStoreFailure(n.live())).toBe(true);
    expect(storeFailures.length).toBeGreaterThan(0);
  });

  it('case 2 treatment: refused before it applies; the store, the settle and the row are intact; a replay is refused again', async () => {
    const n = node(true);
    const attacker = await n.connect('attacker');
    const peer = await n.connect('peer');
    const live = n.live();
    const bad = wedge(live);
    const peerFramesBefore = peer.sent.length;
    attacker.deliver(syncFrame(bad, SYNC.Update, MSG.Sync, DOC));
    await settle();
    expect(attacker.closeReasons()).toEqual([REFUSED('child-kind')]);
    // y-indexeddb replay: the client re-authenticates on the same socket and sends its (refused) state as Step2.
    await n.connect('attacker', attacker);
    attacker.deliver(syncFrame(bad, SYNC.Step2, MSG.Sync, DOC));
    await settle();
    expect(attacker.closeReasons()).toEqual([REFUSED('child-kind'), REFUSED('child-kind')]);
    expect(peer.sent.slice(peerFramesBefore).filter((m) => readServerFrame(m).type === MSG.Sync)).toEqual([]);

    // An honest edit still stores.
    const editor = await n.connect('editor');
    editor.deliver(syncFrame(new RemoteClient(live).edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(9, ' and more')), SYNC.Update, MSG.Sync, DOC));
    await settle();
    await expect(n.handlers.flushPageContent(DOC, { withDigest: true })).resolves.toMatchObject({ flushed: true });
    expect(storeFailures).toEqual([]);
    const stored = JSON.stringify((await row()).content);
    expect(stored).toContain('"text":"seed text and more"');
    expect(stored).not.toContain('evil');
  });

  it('the /v1 idempotency ledger: control erases another writer\'s key; treatment refuses and the key stays', async () => {
    const VICTIM = scopedWriteKey('victim', 'victim-key'); // entries are digests (write-idem.ts)
    for (const withGuard of [false, true]) {
      const n = node(withGuard);
      const sock = await n.connect('attacker');
      const live = n.live();
      live.transact(() => recordWriteKey(live, VICTIM, Date.now()), V1_WRITE);
      const del = new RemoteClient(live).edit(live, (_f, doc) => doc.getMap(WRITE_IDEM_MAP).delete(VICTIM.entry));
      sock.deliver(syncFrame(del, SYNC.Update, MSG.Sync, DOC));
      await settle();
      await expect(n.handlers.flushPageContent(DOC)).resolves.toMatchObject({ flushed: true });
      if (!withGuard) {
        expect(isDuplicateWriteKey(live, VICTIM)).toBe(false); // control: a client erased another's write key
        for (const s of sockets.splice(0)) s.close(1000, 'next arm');
        await settle();
        continue;
      }
      expect(sock.closeReasons()).toEqual([REFUSED('root')]);
      expect(isDuplicateWriteKey(live, VICTIM)).toBe(true);
    }
  });

  it('a writer\'s y-indexeddb remount after a keyed /v1 write (its ledger entry stored) is applied, a no-op', async () => {
    const n = node(true);
    const first = await n.connect('editor');
    const live = n.live();
    // A real keyed write changes content with its key (a content-neutral write is not stored: persistence skips an
    // unchanged row, and the ledger entry would never reach it).
    live.transact(() => {
      textOf(live.getXmlFragment('default').get(0) as Y.XmlElement).insert(9, ' v1');
      recordWriteKey(live, scopedWriteKey('u', 'api-key'), Date.now());
    }, V1_WRITE);
    await expect(n.handlers.flushPageContent(DOC)).resolves.toMatchObject({ flushed: true });
    // precondition: the ROW holds the ledger entry (else this is the crash residual below, a different case)
    const stored = new Y.Doc();
    Y.applyUpdate(stored, new Uint8Array((await row()).ydoc));
    expect(isDuplicateWriteKey(stored, scopedWriteKey('u', 'api-key'))).toBe(true);
    // The browser's local copy holds the server's ledger item; a remount sends the whole copy back as an Update.
    const browser = new RemoteClient(live);
    const echo = Y.encodeStateAsUpdate(browser.doc);
    expect(Y.decodeUpdate(echo).structs.some((st) => st instanceof Y.Item && (st.parent as unknown) === WRITE_IDEM_MAP)).toBe(true);
    const rowBefore = await row();
    const remount = await n.connect('editor');
    const sentBefore = remount.sent.length;
    remount.deliver(syncFrame(echo, SYNC.Update, MSG.Sync, DOC));
    await settle();
    expect(remount.closeReasons()).toEqual([]);
    expect(first.closeReasons()).toEqual([]);
    // Hocuspocus answered SyncStatus(true): the Update was applied (a no-op), not refused
    const statuses = remount.sent.slice(sentBefore).filter((m) => readServerFrame(m).type === MSG.SyncStatus);
    expect(statuses.map((m) => m[m.length - 1])).toEqual([1]);
    expect(isDuplicateWriteKey(live, scopedWriteKey('u', 'api-key'))).toBe(true);
    await expect(n.handlers.flushPageContent(DOC)).resolves.toMatchObject({ flushed: true });
    const rowAfter = await row();
    expect(Buffer.from(rowAfter.ydoc).equals(Buffer.from(rowBefore.ydoc))).toBe(true);
    expect(rowAfter.content).toEqual(rowBefore.content);
    // and the remounted editor's next edit stores
    remount.deliver(syncFrame(new RemoteClient(live).edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(9, ' and more')), SYNC.Update, MSG.Sync, DOC));
    await settle();
    await expect(n.handlers.flushPageContent(DOC, { withDigest: true })).resolves.toMatchObject({ flushed: true });
    expect(remount.closeReasons()).toEqual([]);
    expect(storeFailures).toEqual([]);
    expect(JSON.stringify((await row()).content)).toContain('"text":"seed text and more v1"');
  });

  it('residual (ADR 0036): a browser holding a ledger entry the crashed node never stored is refused on reconnect', async () => {
    const API_KEY = scopedWriteKey('editor', 'api-key');
    const first = node(true);
    const browserSock = await first.connect('editor');
    const live = first.live();
    live.transact(() => recordWriteKey(live, API_KEY, Date.now()), V1_WRITE); // broadcast before the debounced store
    const browser = new RemoteClient(live);
    expect(isDuplicateWriteKey(browser.doc, API_KEY)).toBe(true);
    expect(browserSock.closeReasons()).toEqual([]);
    // The node crashes inside the store debounce: no store ran, the row lacks the entry. A fresh node loads the row.
    const stored = new Y.Doc();
    Y.applyUpdate(stored, new Uint8Array((await row()).ydoc));
    expect(isDuplicateWriteKey(stored, API_KEY)).toBe(false);
    const second = node(true);
    const sock = await second.connect('editor');
    const live2 = second.live();
    sock.deliver(syncFrame(Y.encodeStateAsUpdate(browser.doc, Y.encodeStateVector(second.live())), SYNC.Step2, MSG.Sync, DOC));
    await settle();
    expect(sock.closeReasons()).toEqual([REFUSED('root')]);
    expect(isDuplicateWriteKey(live2, API_KEY)).toBe(false);
  });

  it.each([
    ['a stored prefix (B typed before the last store and after it: the common case)', true],
    ['no stored prefix (every edit of B\'s was lost)', false],
  ])('#781 lineage crash, %s: B announces first, A\'s relay is unresolved, A reconnects once, the row holds B\'s edits', async (_name, storedPrefix) => {
    const B_ID = 1001;
    const A_ID = 2002;
    const first = node(true);
    const bSock = await first.connect('editor');
    const live = first.live();
    const b = new RemoteClient(live, B_ID);
    const typeB = async (text: string) => {
      bSock.deliver(syncFrame(b.edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, text)), SYNC.Update, MSG.Sync, DOC));
      await settle();
    };
    if (storedPrefix) {
      await typeB('B-stored ');
      await expect(first.handlers.flushPageContent(DOC, { withDigest: true })).resolves.toMatchObject({ flushed: true });
    }
    await typeB('B-lost ');
    expect(JSON.stringify(TiptapTransformer.fromYdoc(live, 'default'))).toContain('B-lost');
    const a = new RemoteClient(live, A_ID); // A holds B's edit: the first node relayed it
    // The node crashes inside the store debounce: the row lacks `B-lost`. B keeps typing while disconnected.
    expect(JSON.stringify((await row()).content)).not.toContain('B-lost');
    b.doc.transact(() => textOf(b.fragment.get(0) as Y.XmlElement).insert(0, 'B-after '));

    const second = node(true);
    const bSock2 = await second.connect('editor');
    const aSock2 = await second.connect('peer');
    const live2 = second.live();
    expect(Y.getState(live2.store, B_ID) > 0).toBe(storedPrefix); // precondition: the row holds B's id or not
    bSock2.deliver(awarenessFrame([{ clientID: B_ID, clock: 1, state: { user: {} } }], DOC)); // B's startSync awareness
    await settle();
    const relay = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(live2));
    aSock2.deliver(awarenessFrame([{ clientID: A_ID, clock: 1, state: { user: {} } }], DOC), syncFrame(relay, SYNC.Step2, MSG.Sync, DOC));
    await settle();
    expect(aSock2.closeReasons()).toEqual([UNRESOLVED_REASON]);
    expect(JSON.stringify(TiptapTransformer.fromYdoc(live2, 'default'))).not.toContain('B-lost'); // never applied
    bSock2.deliver(syncFrame(Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(live2)), SYNC.Step2, MSG.Sync, DOC));
    await settle();
    // A's provider reconnects once on the same socket: a new Auth, its awareness, the same Step2 (now all known clocks)
    await second.connect('peer', aSock2);
    aSock2.deliver(awarenessFrame([{ clientID: A_ID, clock: 2, state: { user: {} } }], DOC), syncFrame(relay, SYNC.Step2, MSG.Sync, DOC));
    await settle();
    expect(aSock2.closeReasons()).toEqual([UNRESOLVED_REASON]);
    expect(bSock2.closeReasons()).toEqual([]);
    await expect(second.handlers.flushPageContent(DOC, { withDigest: true })).resolves.toMatchObject({ flushed: true });
    expect(storeFailures).toEqual([]);
    expect(JSON.stringify((await row()).content)).toContain(`"text":"B-after B-lost ${storedPrefix ? 'B-stored ' : ''}seed text"`);
  });

  it('#842 MUTUAL crash: each Step2 relays the other\'s lost edits; the first is unresolved, the second lands on the first\'s claim, the retry lands, the row holds both', async () => {
    const B_ID = 1001; // writer
    const A_ID = 2002; // peer
    const first = node(true);
    const bSock = await first.connect('writer');
    const aSock = await first.connect('peer');
    const live = first.live();
    const b = new RemoteClient(live, B_ID);
    const a = new RemoteClient(live, A_ID);
    bSock.deliver(syncFrame(b.edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'B-lost ')), SYNC.Update, MSG.Sync, DOC));
    await settle();
    a.sync(live); // the first node relays B's edit to A ...
    aSock.deliver(syncFrame(a.edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'A-lost ')), SYNC.Update, MSG.Sync, DOC));
    await settle();
    b.sync(live); // ... and A's to B
    expect(JSON.stringify(TiptapTransformer.fromYdoc(live, 'default'))).toContain('A-lost B-lost');
    // Lifetime 1 is abandoned unstored (the process dies inside the store debounce). Both keep typing while disconnected.
    expect(JSON.stringify((await row()).content)).not.toMatch(/A-lost|B-lost/);
    a.doc.transact(() => textOf(a.fragment.get(0) as Y.XmlElement).insert(0, 'A-after '));
    b.doc.transact(() => textOf(b.fragment.get(0) as Y.XmlElement).insert(0, 'B-after '));

    const second = node(true);
    const bSock2 = await second.connect('writer');
    const aSock2 = await second.connect('peer');
    const live2 = second.live();
    expect([Y.getState(live2.store, A_ID), Y.getState(live2.store, B_ID)]).toEqual([0, 0]); // nothing of theirs is stored
    // both providers' startSync awareness first, then the two crossed Step2s (each answers the server's Step1)
    bSock2.deliver(awarenessFrame([{ clientID: B_ID, clock: 1, state: { user: {} } }], DOC));
    aSock2.deliver(awarenessFrame([{ clientID: A_ID, clock: 1, state: { user: {} } }], DOC));
    await settle();
    const aStep2 = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(live2));
    const bStep2 = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(live2));
    // precondition: crossed (each writes new clocks at the other's announced, unproven id)
    const writes = (u: Uint8Array) => new Set(Y.decodeUpdate(u).structs.map((st) => st.id.client));
    expect([writes(aStep2).has(B_ID), writes(bStep2).has(A_ID)]).toEqual([true, true]);
    aSock2.deliver(syncFrame(aStep2, SYNC.Step2, MSG.Sync, DOC));
    await settle();
    expect(aSock2.closeReasons()).toEqual([UNRESOLVED_REASON]); // B's id is unproven and no claim of B's exists yet
    bSock2.deliver(syncFrame(bStep2, SYNC.Step2, MSG.Sync, DOC));
    await settle();
    // B's relay of A's lost edit equals A's claim (A's own refused frame): it lands, though A's id is still unproven
    expect(bSock2.closeReasons()).toEqual([]);
    const afterB = JSON.stringify(TiptapTransformer.fromYdoc(live2, 'default'));
    expect(afterB).toContain('A-lost');
    expect(afterB).not.toContain('A-after'); // A's own new edit is not B's to relay: only A's retry brings it
    // A's provider retries at once (collab-access.ts COLLAB_UNRESOLVED_RETRY_MS[0]): a new Auth on the same socket, its
    // awareness, and a Step2 answering the server's new Step1
    await second.connect('peer', aSock2);
    aSock2.deliver(
      awarenessFrame([{ clientID: A_ID, clock: 2, state: { user: {} } }], DOC),
      syncFrame(Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(live2)), SYNC.Step2, MSG.Sync, DOC),
    );
    await settle();
    expect(aSock2.closeReasons()).toEqual([UNRESOLVED_REASON]); // no refusal was final
    expect(bSock2.closeReasons()).toEqual([]);
    expect(Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(live2)).length).toBe(Y.encodeStateAsUpdate(new Y.Doc()).length); // A converged
    expect(Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(live2)).length).toBe(Y.encodeStateAsUpdate(new Y.Doc()).length); // B converged
    await expect(second.handlers.flushPageContent(DOC, { withDigest: true })).resolves.toMatchObject({ flushed: true });
    expect(storeFailures).toEqual([]);
    const stored = await pg<{ content: unknown; last_updated_by_id: string; contributor_ids: string[] }[]>`
      select content, last_updated_by_id, contributor_ids from pages where id = ${PAGE_ID}`;
    const text = JSON.stringify(stored[0].content);
    for (const lost of ['A-lost', 'B-lost', 'A-after', 'B-after', 'seed text']) expect({ lost, stored: text.includes(lost) }).toEqual({ lost, stored: true });
    expect(stored[0].content).toEqual(TiptapTransformer.fromYdoc(live2, 'default')); // the row is live
    expect(stored[0].last_updated_by_id).toBe(USERS.peer.id); // A's retry was the last change
    expect([...stored[0].contributor_ids].sort()).toEqual([USERS.editor.id, USERS.peer.id, USERS.writer.id].sort()); // the creator, both editors
  });
});
