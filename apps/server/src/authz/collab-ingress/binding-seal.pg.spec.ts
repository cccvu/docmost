import * as postgres from 'postgres';
import { createHash } from 'node:crypto';
import { Kysely } from 'kysely';
import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';
import * as bindingSeal from '../page-write/binding-seal';
import { sealLifetimeOf, setSealBarrierMsForTests } from '../page-write/binding-seal';
import { kyselyCompactionStore } from '../page-write/compaction';
import * as healImage from '../page-write/heal-image';
import { installHealImageTableAtBoot } from '../page-write/heal-image.installer';
import { COLLAB_PAGE_COMPACTING_REASON } from './collab-reasons';
import { authFrame, awarenessFrame, FakeSocket, MSG, RemoteClient, SYNC, syncFrame } from './collab-ingress.testkit';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { CollabUpdateGuard, UNRESOLVED_REASON } from './update-guard';

/**
 * #793 on real Postgres (ADR 0036 #793 amendment): the binding seal (page-write/binding-seal.ts) through Hocuspocus 4.7.1,
 * the real CollabUpdateGuardExtension, PersistenceExtension and CollaborationHandler, PageRepo, postgres.js and Postgres.
 * A node is one Hocuspocus; two nodes are two document lifetimes. A clean unload is `closeConnections` (the deploy
 * drain's path: store, unload, `afterUnloadDocument`); a crash is a node abandoned with its document resident. U owns
 * client id V; M is another editor of the page; A is a co-editor holding live's state.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG binding seal (#793)', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'binding_seal_pg_spec';
const PAGE_ID = uuid(793);
const DOC = `page.${PAGE_ID}`;
const USERS: Record<string, { id: string; name: string }> = {
  attacker: { id: uuid(901), name: 'M' },
  editor: { id: uuid(902), name: 'U' },
  peer: { id: uuid(903), name: 'A' },
};
const V = 1001; // U's client id
const A_ID = 2002;
const P_ID = 3003; // announced, never written
const REFUSED = (rule: string) => `ccc:collab-update-refused:${rule}`;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
const textOf = (el: Y.XmlElement): Y.XmlText => el.toArray().find((c) => c instanceof Y.XmlText) as Y.XmlText;
const textOfDoc = (doc: Y.Doc) => JSON.stringify(TiptapTransformer.fromYdoc(doc, 'default'));
const announce = (id: number, clock = 1) => awarenessFrame([{ clientID: id, clock, state: { user: {} } }], DOC);
async function waitFor(what: string, ok: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

d('the binding seal across document lifetimes (#793)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  const sockets: FakeSocket[] = [];
  const nodes: Hocuspocus[] = [];

  const row = async () => (await pg<{ content: any; ydoc: Buffer | null }[]>`select content, ydoc from pages where id = ${PAGE_ID}`)[0];
  const rowDoc = async () => {
    const doc = new Y.Doc();
    const r = await row();
    if (r.ydoc) Y.applyUpdate(doc, new Uint8Array(r.ydoc));
    return doc;
  };
  const sealRow = async () =>
    (
      await pg<{ lifetime_id: string; epoch: number | null; row_sha: string | null; entries: Array<[number, string, number]> | null }[]>`
        select lifetime_id, epoch, row_sha, entries from ccc_collab_binding_seal where page_id = ${PAGE_ID}`
    )[0];

  /** One collab node: the guard first, a token-auth stand-in, the real persistence, and any `extra` extensions. */
  function node(extra: object[] = []) {
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
    const hocuspocus = new Hocuspocus({
      quiet: true,
      extensions: [new CollabUpdateGuardExtension(guard), auth, persistence, ...extra],
      debounce: 60_000,
      maxDebounce: 60_000,
    } as never);
    nodes.push(hocuspocus);
    const handlers = new CollaborationHandler().getHandlers(hocuspocus);
    const connect = async (token: string, sock = new FakeSocket()) => {
      if (!sockets.includes(sock)) sockets.push(sock);
      if (!sock.listenerCount('message')) sock.connect(hocuspocus);
      sock.deliver(authFrame(token, DOC));
      await waitFor(`connection ${token}`, () => !!hocuspocus.documents.get(DOC)?.getConnections().some((c) => c.webSocket === (sock as never)));
      await settle();
      return sock;
    };
    const live = () => hocuspocus.documents.get(DOC)!;
    /** Every unload hook of the page has run (the seal committed). */
    const unloaded = () =>
      waitFor('the unload', () => !hocuspocus.documents.has(DOC) && !(hocuspocus as unknown as { unloadingDocuments: Map<string, unknown> }).unloadingDocuments.has(DOC));
    /** The deploy drain's path: every connection closed, the store, the unload. */
    const drain = async () => {
      hocuspocus.closeConnections(DOC);
      await unloaded();
    };
    const type = async (sock: FakeSocket, client: RemoteClient, text: string, at = 0) => {
      sock.deliver(syncFrame(client.edit(live(), (f) => textOf(f.get(0) as Y.XmlElement).insert(at, text)), SYNC.Update, MSG.Sync, DOC));
      await settle();
    };
    const flush = () => expect(handlers.flushPageContent(DOC, { withDigest: true })).resolves.toMatchObject({ flushed: true });
    return { hocuspocus, guard, connect, live, unloaded, drain, type, flush };
  }

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
    // The boot install (the persistence's onApplicationBootstrap): also the handle a page with no stored ydoc seals by.
    await installHealImageTableAtBoot(db as never, { log: () => undefined, warn: () => undefined, error: () => undefined });
  });

  /** The page, with a stored ydoc (`seed`) or none (a fresh page). */
  async function seedPage(withYdoc = true) {
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
              ${withYdoc ? pg.json(TiptapTransformer.fromYdoc(seed, 'default')) : null},
              ${withYdoc ? Buffer.from(Y.encodeStateAsUpdate(seed)) : null}, 'seed text', '2020-01-01')`;
  }

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined); // Hocuspocus logs every CLOSE
    await seedPage();
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close(1000, 'test over');
    await settle();
    for (const h of nodes.splice(0)) h.closeConnections();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  /** Lifetime 1, ended by a drain: U announces V and types `U-stored `; P only announces P_ID. */
  async function sealedLifetime() {
    const n1 = node();
    const uSock = await n1.connect('editor');
    const pSock = await n1.connect('peer');
    uSock.deliver(announce(V));
    pSock.deliver(announce(P_ID));
    await settle();
    const u = new RemoteClient(n1.live(), V);
    await n1.type(uSock, u, 'U-stored ');
    await n1.flush();
    await n1.drain();
    return { u };
  }

  it('a drain seals U\'s proven id (never an id only announced); the next node refuses M\'s awareness at V (4422), answers M\'s forgery unresolved, and U\'s offline edits land', async () => {
    const { u } = await sealedLifetime();
    const stored = await rowDoc();
    expect(await sealRow()).toMatchObject({ epoch: 0, row_sha: sha((await row()).ydoc!), entries: [[V, USERS.editor.id, Y.getState(stored.store, V)]] });
    u.doc.transact(() => textOf(u.fragment.get(0) as Y.XmlElement).insert(0, 'U-after ')); // offline

    const n2 = node();
    await n2.connect('peer'); // A, idle: keeps the document resident while M's sessions are closed
    const mSock = await n2.connect('attacker');
    mSock.deliver(announce(V, 9));
    await settle();
    expect(mSock.closeReasons()).toEqual([REFUSED('foreign-client')]);
    await n2.connect('attacker', mSock);
    mSock.deliver(syncFrame(new RemoteClient(n2.live(), V).edit(n2.live(), (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'FORGED ')), SYNC.Update, MSG.Sync, DOC));
    await settle();
    expect(mSock.closeReasons()).toEqual([REFUSED('foreign-client'), UNRESOLVED_REASON]);
    expect(textOfDoc(n2.live())).not.toContain('FORGED');

    const uSock2 = await n2.connect('editor');
    uSock2.deliver(announce(V, 2), syncFrame(Y.encodeStateAsUpdate(u.doc, Y.encodeStateVector(n2.live())), SYNC.Step2, MSG.Sync, DOC));
    await settle();
    expect(uSock2.closeReasons()).toEqual([]);
    await n2.flush();
    expect(JSON.stringify((await row()).content)).toContain('"text":"U-after U-stored seed text"');
  });

  it('a net-zero tail (typed, then deleted: the store writes no ydoc) is not restored, so A\'s replay of it lands', async () => {
    const n1 = node();
    const uSock = await n1.connect('editor');
    const aSock = await n1.connect('peer');
    uSock.deliver(announce(V));
    aSock.deliver(announce(A_ID));
    await settle();
    const u = new RemoteClient(n1.live(), V);
    await n1.type(uSock, u, 'U-stored ');
    await n1.flush();
    const written = (await row()).ydoc!;
    await n1.type(uSock, u, 'zz');
    uSock.deliver(syncFrame(u.edit(n1.live(), (f) => textOf(f.get(0) as Y.XmlElement).delete(0, 2)), SYNC.Update, MSG.Sync, DOC));
    await settle();
    const a = new RemoteClient(n1.live(), A_ID); // A holds the tail (relayed to it)
    const tailClock = Y.getState(n1.live().store, V);
    await n1.drain();
    // preconditions: the final store wrote no ydoc, and the seal took live's clock (past the row's)
    expect(Buffer.from((await row()).ydoc!).equals(Buffer.from(written))).toBe(true);
    expect(Y.getState((await rowDoc()).store, V)).toBeLessThan(tailClock);
    expect((await sealRow()).entries).toEqual([[V, USERS.editor.id, tailClock]]);

    const n2 = node();
    const aSock2 = await n2.connect('peer');
    aSock2.deliver(announce(A_ID), syncFrame(Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(n2.live())), SYNC.Step2, MSG.Sync, DOC));
    await settle();
    expect(aSock2.closeReasons()).toEqual([]);
    expect(Y.getState(n2.live().store, V)).toBe(tailClock);
  });

  it('a crash (no unload) after a clean seal: the crashed lifetime\'s load consumed it, so the next restores nothing and A\'s relay of U\'s unstored tail lands', async () => {
    await sealedLifetime();
    const n1 = node(); // loads, claims (consumes the seal), then dies inside the store debounce
    const uSock = await n1.connect('editor');
    const aSock = await n1.connect('peer');
    uSock.deliver(announce(V));
    aSock.deliver(announce(A_ID));
    await settle();
    const u = new RemoteClient(n1.live(), V);
    await n1.type(uSock, u, 'U-lost ');
    const a = new RemoteClient(n1.live(), A_ID);
    expect(JSON.stringify((await row()).content)).not.toContain('U-lost'); // never stored
    expect((await sealRow()).entries).toBeNull(); // only n1's claim

    const n2 = node();
    const aSock2 = await n2.connect('peer');
    aSock2.deliver(announce(A_ID), syncFrame(Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(n2.live())), SYNC.Step2, MSG.Sync, DOC));
    await settle();
    expect(aSock2.closeReasons()).toEqual([]);
    expect(textOfDoc(n2.live())).toContain('U-lost');
  });

  it('a join during the unload\'s beforeUnloadDocument aborts it: nothing is sealed, and after a crash A\'s relay lands', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    const slow = {
      async beforeUnloadDocument() {
        held = true;
        await gate;
      },
    };
    const n1 = node([slow]);
    const uSock = await n1.connect('editor');
    uSock.deliver(announce(V));
    await settle();
    const u = new RemoteClient(n1.live(), V);
    await n1.type(uSock, u, 'U-stored ');
    await n1.flush();
    uSock.close(1000, 'leaves'); // the last connection: the unload starts and waits in beforeUnloadDocument
    await waitFor('the unload to start', () => held);
    const aSock = await n1.connect('peer'); // joins the resident document
    release();
    await settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(n1.hocuspocus.documents.has(DOC)).toBe(true); // the unload was aborted
    expect((await sealRow()).entries).toBeNull();
    // the lifetime goes on: U's later edit (from a new connection) reaches A, then the node dies unstored
    const uSock2 = await n1.connect('editor');
    uSock2.deliver(announce(V, 2));
    await n1.type(uSock2, u, 'U-lost ');
    const a = new RemoteClient(n1.live(), A_ID);
    aSock.deliver(announce(A_ID));
    await settle();

    const n2 = node();
    const aSock2 = await n2.connect('peer');
    aSock2.deliver(announce(A_ID, 2), syncFrame(Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(n2.live())), SYNC.Step2, MSG.Sync, DOC));
    await settle();
    expect(aSock2.closeReasons()).toEqual([]);
    expect(textOfDoc(n2.live())).toContain('U-lost');
  });

  /** Gate every seal commit: each starts only once released. */
  function gatedCommits() {
    const real = bindingSeal.commitSealRow;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const commits: Array<Promise<number>> = [];
    jest.spyOn(bindingSeal, 'commitSealRow').mockImplementation((...args) => {
      const p = gate.then(() => real(...args));
      commits.push(p);
      return p;
    });
    return { release, commits };
  }

  /** Lifetime 1 on `n1`: U announces V, types and stores, then leaves; resolves once its commit has started. */
  async function leaveAfterStore(n1: ReturnType<typeof node>, commits: Array<Promise<number>>) {
    const uSock = await n1.connect('editor');
    uSock.deliver(announce(V));
    await settle();
    await n1.type(uSock, new RemoteClient(n1.live(), V), 'U-stored ');
    await n1.flush();
    uSock.close(1000, 'leaves');
    await waitFor('the old commit to start', () => commits.length === 1);
    expect(n1.hocuspocus.documents.has(DOC)).toBe(false); // destroyed; its afterUnloadDocument waits on the commit
  }

  it('a same-node fast reload (Hocuspocus loads it before the old afterUnloadDocument ends): the claim waits for the old commit and restores V', async () => {
    const { release, commits } = gatedCommits();
    const n1 = node();
    await leaveAfterStore(n1, commits);
    setTimeout(release, 150); // the old commit lands while the new load waits on it
    await n1.connect('editor'); // the same node loads a new lifetime
    await expect(commits[0]).resolves.toBe(1);
    const stored = await rowDoc();
    expect(sealLifetimeOf(n1.live())!.restored).toEqual([[V, USERS.editor.id, Y.getState(stored.store, V)]]);
    expect(n1.guard.isAwarenessOnly(n1.live(), V)).toBe(true);
    expect((await sealRow())).toMatchObject({ lifetime_id: sealLifetimeOf(n1.live())!.lifetimeId, entries: null });
  });

  it('past the barrier bound the claim goes ahead: the late commit writes 0 rows (its lifetime_id), nothing stale is left', async () => {
    const restoreBarrier = setSealBarrierMsForTests(50);
    try {
      const { release, commits } = gatedCommits();
      const n1 = node();
      await leaveAfterStore(n1, commits);
      await n1.connect('editor'); // claims after the 50 ms bound
      const mine = sealLifetimeOf(n1.live())!.lifetimeId;
      expect(sealLifetimeOf(n1.live())!.restored).toEqual([]);
      expect((await sealRow()).lifetime_id).toBe(mine);
      release();
      await expect(commits[0]).resolves.toBe(0);
      expect(await sealRow()).toMatchObject({ lifetime_id: mine, entries: null });
    } finally {
      restoreBarrier();
    }
  });

  it('a lifetime that only viewed (its empty Step2 moves the generation, nothing stores) still seals: the next node refuses M at V', async () => {
    await sealedLifetime();
    const sealed = (await sealRow()).entries;
    const n1 = node();
    const viewer = await n1.connect('peer');
    viewer.deliver(announce(A_ID), syncFrame(Y.encodeStateAsUpdate(n1.live(), Y.encodeStateVector(n1.live())), SYNC.Step2, MSG.Sync, DOC));
    await settle();
    expect(viewer.closeReasons()).toEqual([]);
    await n1.drain();
    expect((await sealRow()).entries).toEqual(sealed); // V restored, still bound: sealed again

    const n2 = node();
    await n2.connect('peer');
    const mSock = await n2.connect('attacker');
    mSock.deliver(announce(V, 9));
    await settle();
    expect(mSock.closeReasons()).toEqual([REFUSED('foreign-client')]);
  });

  it('a final store that fails: the ids live advanced past the row are not restored (an honest relay of that tail lands), the others are', async () => {
    const W = 4004; // A's id
    const n1 = node();
    const uSock = await n1.connect('editor');
    const aSock = await n1.connect('peer');
    uSock.deliver(announce(V));
    aSock.deliver(announce(W));
    await settle();
    const u = new RemoteClient(n1.live(), V);
    await n1.type(uSock, u, 'U-stored ');
    const a = new RemoteClient(n1.live(), W);
    await n1.type(aSock, a, 'A-stored ');
    await n1.flush();
    await n1.type(uSock, u, 'U-unstored ');
    a.sync(n1.live()); // A holds U's unstored tail
    jest.spyOn(healImage, 'prepareStore').mockRejectedValueOnce(new Error('store down'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await n1.drain();
    const stored = await rowDoc();
    expect(JSON.stringify((await row()).content)).not.toContain('U-unstored'); // precondition: the store failed
    const entries = (await sealRow()).entries!;
    expect(entries.find(([id]) => id === V)![2]).toBeGreaterThan(Y.getState(stored.store, V)); // V advanced past the row
    expect(entries.find(([id]) => id === W)![2]).toBe(Y.getState(stored.store, W));

    const n2 = node();
    const aSock2 = await n2.connect('peer');
    expect(sealLifetimeOf(n2.live())!.restored).toEqual([[W, USERS.peer.id, Y.getState(stored.store, W)]]);
    aSock2.deliver(announce(W, 2), syncFrame(Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(n2.live())), SYNC.Step2, MSG.Sync, DOC));
    await settle();
    expect(aSock2.closeReasons()).toEqual([]);
    expect(textOfDoc(n2.live())).toContain('U-unstored');
    const mSock = await n2.connect('attacker');
    mSock.deliver(syncFrame(new RemoteClient(n2.live(), W).edit(n2.live(), (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'FORGED ')), SYNC.Update, MSG.Sync, DOC));
    await settle();
    expect(mSock.closeReasons()).toEqual([UNRESOLVED_REASON]);
  });

  it('a claim that fails is try-later; the next load claims', async () => {
    const bytes = new Uint8Array((await row()).ydoc!);
    jest.spyOn(bindingSeal, 'claimSealRow').mockRejectedValueOnce(new Error('lock timeout'));
    await expect(healImage.loadStableYdoc(new Y.Doc(), PAGE_ID, bytes, db as never)).rejects.toMatchObject({ reason: COLLAB_PAGE_COMPACTING_REASON });
    const doc = new Y.Doc();
    await healImage.loadStableYdoc(doc, PAGE_ID, bytes, db as never);
    expect((await sealRow()).lifetime_id).toBe(sealLifetimeOf(doc)!.lifetimeId);
  });

  it('compaction\'s swap (the epoch moves) deletes the page\'s seal in its transaction', async () => {
    await sealedLifetime();
    expect((await sealRow()).entries).not.toBeNull();
    const current = new Uint8Array((await row()).ydoc!);
    const next = Y.encodeStateAsUpdate(new Y.Doc());
    await expect(kyselyCompactionStore(db as never).swapYdoc(PAGE_ID, next, { covered: sha(current) })).resolves.toMatchObject({ swapped: true });
    expect(await sealRow()).toBeUndefined();
  });

  it('a page with no stored ydoc (a fresh page) seals through the boot handle; the next node answers M\'s forgery unresolved', async () => {
    await seedPage(false);
    const n1 = node();
    const uSock = await n1.connect('editor');
    uSock.deliver(announce(V));
    await settle();
    expect(sealLifetimeOf(n1.live())).toMatchObject({ claimed: false });
    const u = new RemoteClient(n1.live(), V);
    const paragraph = (text: string) => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText(text)]);
      return p;
    };
    uSock.deliver(syncFrame(u.edit(n1.live(), (f) => f.insert(0, [paragraph('U-stored')])), SYNC.Update, MSG.Sync, DOC));
    await settle();
    expect(uSock.closeReasons()).toEqual([]);
    await n1.flush();
    await n1.drain();
    expect((await sealRow()).entries).toEqual([[V, USERS.editor.id, Y.getState((await rowDoc()).store, V)]]);

    const n2 = node();
    const mSock = await n2.connect('attacker');
    mSock.deliver(syncFrame(new RemoteClient(n2.live(), V).edit(n2.live(), (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'FORGED ')), SYNC.Update, MSG.Sync, DOC));
    await settle();
    expect(mSock.closeReasons()).toEqual([UNRESOLVED_REASON]);
  });
});
