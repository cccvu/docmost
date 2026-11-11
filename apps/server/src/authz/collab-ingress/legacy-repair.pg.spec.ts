import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';
import * as driftLog from '../page-write/collab-drift-log';
import { hasStoreFailure } from '../page-write/store-failure-registry';
import { authFrame, FakeSocket, MSG, RemoteClient, SYNC, syncFrame } from './collab-ingress.testkit';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { planLegacyRepair } from './legacy-repair';
import { CollabUpdateGuard } from './update-guard';

/**
 * #781 lineage (ADR 0036 amendment) on real Postgres: the load repair of legacy values (legacy-repair.ts) behind the REAL
 * store path (Hocuspocus 4.7.1, the real PersistenceExtension, CollaborationHandler's settle, PageRepo, Postgres).
 * The repair runs with skipStoreHooks, so a load alone stores nothing (the persistence extension reads
 * `lastContext.user.id`, which a repair has none of: dropping skipStoreHooks fails that store), the settle stays clean,
 * the next lifetime repairs the same row again, and a writer's store persists exactly one repaired copy.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG collab legacy repair (#781)', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'collab_legacy_repair_pg_spec';
const PAGE_ID = uuid(782);
const DOC = `page.${PAGE_ID}`;
const USERS: Record<string, { id: string; name: string }> = {
  editor: { id: uuid(902), name: 'Editor' },
  reader: { id: uuid(903), name: 'Reader' },
};
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

/** A pre-#781 row: a table whose first cell spans "100%", and a link whose href is a number. Built in Yjs: no rule ran. */
function legacyYdoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const p = (text: string, attrs?: Record<string, unknown>) => {
      const el = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.applyDelta([attrs ? { insert: text, attributes: attrs } : { insert: text }]);
      el.insert(0, [t]);
      return el;
    };
    const cell = (span?: unknown) => {
      const c = new Y.XmlElement('tableCell');
      if (span !== undefined) c.setAttribute('colspan', span as never);
      c.insert(0, [p('cell')]);
      return c;
    };
    const row = (...cells: Y.XmlElement[]) => {
      const r = new Y.XmlElement('tableRow');
      r.insert(0, cells);
      return r;
    };
    const table = new Y.XmlElement('table');
    table.insert(0, [row(cell('100%'), cell(1)), row(cell(1), cell(1))]);
    doc.getXmlFragment('default').insert(0, [p('see '), table, p('here', { link: { href: 123 } })]);
  });
  return doc;
}

d('the collab legacy repair behind the real store (#781)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  const sockets: FakeSocket[] = [];
  const nodes: Hocuspocus[] = [];
  let storeFailures: string[];

  const row = async () => (await pg<{ content: any; ydoc: Buffer }[]>`select content, ydoc from pages where id = ${PAGE_ID}`)[0];

  /** One collab node with the guard extension (and its load repair) first, a token stand-in, and the real persistence. */
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
        return { user };
      },
    };
    const logs: string[] = [];
    const guard = new CollabUpdateGuard({ logger: { warn: () => undefined } });
    const extension = new CollabUpdateGuardExtension(guard, { logger: { warn: (m) => logs.push(m) } });
    const hocuspocus = new Hocuspocus({ quiet: true, extensions: [extension, auth, persistence], debounce: 60_000, maxDebounce: 60_000 } as never);
    nodes.push(hocuspocus);
    const handlers = new CollaborationHandler().getHandlers(hocuspocus);
    const connect = async (token: string) => {
      const sock = new FakeSocket();
      sockets.push(sock);
      sock.connect(hocuspocus);
      sock.deliver(authFrame(token, DOC));
      const deadline = Date.now() + 5_000;
      while (!hocuspocus.documents.get(DOC)?.getConnections().some((c) => c.webSocket === (sock as never))) {
        if (Date.now() > deadline) throw new Error(`connection ${token} was not established`);
        await new Promise((r) => setTimeout(r, 5));
      }
      await settle();
      return sock;
    };
    /** Every connection closed: with nothing to store, Hocuspocus (unloadImmediately) unloads the document. */
    const disconnectAll = async () => {
      for (const s of sockets.splice(0)) s.close(1000, 'done');
      const deadline = Date.now() + 5_000;
      while (hocuspocus.documents.has(DOC)) {
        if (Date.now() > deadline) throw new Error('the document did not unload');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const live = () => hocuspocus.documents.get(DOC)!;
    return { hocuspocus, handlers, connect, disconnectAll, live, logs };
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
  });

  beforeEach(async () => {
    storeFailures = [];
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(driftLog, 'logStoreFailure').mockImplementation((_logger, _pageId, err) => {
      storeFailures.push(String((err as Error)?.message ?? err));
    });
    const seed = legacyYdoc();
    await pg`delete from pages`;
    await pg`
      insert into pages (id, slug_id, title, space_id, workspace_id, creator_id, last_updated_by_id, contributor_ids,
                         content, ydoc, text_content, created_at)
      values (${PAGE_ID}, 'slug', 'Title', ${uuid(50)}, ${uuid(100)}, ${uuid(902)}, ${uuid(902)}, array[${uuid(902)}::uuid],
              ${pg.json(TiptapTransformer.fromYdoc(seed, 'default'))}, ${Buffer.from(Y.encodeStateAsUpdate(seed))},
              'see cell cell cell cell here', '2020-01-01')`;
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

  it('a load repairs in memory and stores nothing; the settle is clean; the next lifetime repairs the same row again', async () => {
    const before = await row();
    const n = node();
    await n.connect('reader');
    expect(planLegacyRepair(n.live()).report).toMatchObject({ attrs: 0, marks: 0 }); // repaired in memory
    expect(n.logs.filter((l) => l.startsWith('COLLAB_LEGACY_REPAIRED'))).toHaveLength(1);
    await expect(n.handlers.flushPageContent(DOC, { withDigest: true })).resolves.toMatchObject({ flushed: true });
    expect(hasStoreFailure(n.live())).toBe(false);
    expect(storeFailures).toEqual([]);
    await n.disconnectAll();
    let after = await row();
    expect(Buffer.from(after.ydoc).equals(Buffer.from(before.ydoc))).toBe(true); // nothing stored

    // Lifetime 2: the same unrepaired row, repaired again (in memory only).
    const n2 = node();
    await n2.connect('reader');
    expect(n2.logs.filter((l) => l.startsWith('COLLAB_LEGACY_REPAIRED'))).toHaveLength(1);
    await n2.disconnectAll();
    after = await row();
    expect(Buffer.from(after.ydoc).equals(Buffer.from(before.ydoc))).toBe(true);
    expect(storeFailures).toEqual([]);
  });

  it('a writer who synced an earlier lifetime edits in a later one: one repaired copy is stored, nothing duplicated', async () => {
    const first = node();
    await first.connect('reader');
    const browser = new RemoteClient(first.live(), 4242); // synced lifetime 1 (its repair included)
    await first.disconnectAll();

    const second = node();
    const sock = await second.connect('editor');
    const live = second.live();
    // The browser's remount echo of lifetime 1, then a real edit.
    sock.deliver(syncFrame(Y.encodeStateAsUpdate(browser.doc, Y.encodeStateVector(live)), SYNC.Step2, MSG.Sync, DOC));
    await settle();
    browser.sync(live);
    const edit = browser.edit(live, (f) => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('typed')]);
      f.insert(f.length, [p]);
    });
    sock.deliver(syncFrame(edit, SYNC.Update, MSG.Sync, DOC));
    await settle();
    expect(sock.closeReasons()).toEqual([]);
    await expect(second.handlers.flushPageContent(DOC, { withDigest: true })).resolves.toMatchObject({ flushed: true });
    expect(storeFailures).toEqual([]);

    const stored = await row();
    const json = JSON.stringify(stored.content);
    expect(json).not.toContain('100%');
    expect(json).not.toContain('"href":123');
    expect(json.match(/"text":"here"/g)).toHaveLength(1);
    expect(json).toContain('"text":"typed"');
    // The stored ydoc is the repaired document: a fresh load has nothing left to repair.
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, new Uint8Array(stored.ydoc));
    expect(planLegacyRepair(reloaded).report).toMatchObject({ attrs: 0, marks: 0 });
  });
});
