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
import * as driftLog from './collab-drift-log';
import { hasStoreFailure } from './store-failure-registry';

/**
 * #773 on real Postgres: a raw Yjs update — what a crafted collab WebSocket client sends, not the editor UI — that puts
 * a lone UTF-16 surrogate into a mark attribute value and a mark attribute KEY (Yjs keeps both: a format value is
 * escaped JSON) and U+0000 into text and an element attribute (valid UTF-8, so it survives everywhere) used to make
 * every store of the page fail: jsonb refuses `\ud83d` (22P02) and `\u0000` (22P05), text refuses 0x00 (22021).
 * The REAL store path: Hocuspocus 4.7.1 (its update handling, debouncer and DirectConnection), the real
 * PersistenceExtension and CollaborationHandler settle, the real PageRepo and `executeTx`, the postgres.js driver and a
 * real Postgres. Only the queues, the contributor history and the transclusion service are fakes.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG collab store of lone surrogates and NUL (#773)', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'persistence_store_unicode_pg_spec';
const PAGE_ID = uuid(773);
const DOC = `page.${PAGE_ID}`;
const USER = { id: uuid(900), name: 'Editor' } as never;
const R = '\uFFFD';
const HIGH = '\ud83d';
const LOW = '\ude00';
const EMOJI = '\ud83d\ude00'; // a paired surrogate (U+1F600)
/** A WebSocket client's update arrives with its Connection as the transaction origin (Hocuspocus 4.x's
 *  `ConnectionTransactionOrigin`), so Hocuspocus debounces a store with that connection's context. */
const REMOTE = { source: 'connection' as const, connection: { context: { user: USER }, socketId: 'crafted-client' } };

type Json = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: Json[]; content?: Json[] };

/** Every string and key well-formed and NUL-free. */
const storable = (v: unknown): boolean => {
  const ok = (s: string) => (s as string & { isWellFormed(): boolean }).isWellFormed() && !s.includes('\0');
  if (typeof v === 'string') return ok(v);
  if (Array.isArray(v)) return v.every(storable);
  if (v && typeof v === 'object') return Object.entries(v).every(([k, x]) => ok(k) && storable(x));
  return true;
};
const texts = (doc: Json): Json[] =>
  doc.type === 'text' ? [doc] : (doc.content ?? []).flatMap(texts);
const textNode = (doc: Json, startsWith: string): Json | undefined => texts(doc).find((t) => t.text?.startsWith(startsWith));

/** Edit a copy of `resident` as a separate client would, and apply only the diff to `resident` as a remote update. */
function remoteUpdate(resident: Y.Doc, edit: (fragment: Y.XmlFragment) => void): void {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(resident));
  client.transact(() => edit(client.getXmlFragment('default')));
  Y.applyUpdate(resident, Y.encodeStateAsUpdate(client, Y.encodeStateVector(resident)), REMOTE);
  client.destroy();
}

/** The poisoned paragraph: a lone surrogate in a link href and in a textStyle KEY, NUL in text and in an element
 *  attribute, a lone low surrogate in a mark value, and a paired emoji as the control that must survive intact. */
const poison = (fragment: Y.XmlFragment): void => {
  const p = new Y.XmlElement('paragraph');
  fragment.insert(fragment.length, [p]);
  p.setAttribute('textAlign', 'center\0');
  const t = new Y.XmlText();
  p.insert(0, [t]);
  t.insert(0, 'link', { link: { href: `x${HIGH}` } });
  t.insert(t.length, ' nul\0text ', {});
  t.insert(t.length, 'styled', { textStyle: { [HIGH]: 'v', color: `red${LOW}` } });
  t.insert(t.length, ` emoji ${EMOJI}`, {});
};

d('the collab store on real Postgres (#773)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  const live: Array<{ disconnect(): Promise<void> }> = [];

  const row = async () =>
    (await pg<{ content: Json; textContent: string; ydoc: Buffer; updatedAt: Date; tsv: string }[]>`
      select content, text_content as "textContent", ydoc, updated_at as "updatedAt", tsv::text as tsv
      from pages where id = ${PAGE_ID}`)[0];

  function stack() {
    const pageRepo = new PageRepo(db as never, {} as never, { emit: () => true } as never);
    const updatePage = jest.spyOn(pageRepo, 'updatePage');
    const findById = jest.spyOn(pageRepo, 'findById');
    const queue = { add: jest.fn(async () => undefined) } as never;
    const transclusion = {
      syncPageTransclusions: jest.fn(async (_p: string, _w: string, _json: unknown) => undefined),
      syncPageReferences: jest.fn(async (_p: string, _w: string, _json: unknown) => undefined),
    };
    const persistence = new PersistenceExtension(
      pageRepo,
      db as never,
      queue,
      queue,
      queue,
      { addContributors: jest.fn(async () => undefined) } as never,
      transclusion as never,
    );
    const hocuspocus = new Hocuspocus({ quiet: true, extensions: [persistence], debounce: 60_000, maxDebounce: 60_000 } as never);
    const handlers = new CollaborationHandler().getHandlers(hocuspocus);
    const lockedReads = () => findById.mock.calls.filter((c) => c[1]?.withLock).length;
    const open = async () => {
      const conn = await hocuspocus.openDirectConnection(DOC, { user: USER });
      live.push(conn);
      return hocuspocus.documents.get(DOC)!;
    };
    return { persistence, hocuspocus, handlers, updatePage, lockedReads, transclusion, open };
  }

  /** Every store failure the extension logged (`COLLAB_STORE_FAILED`), as the Postgres error code or the message. */
  let storeFailures: string[];

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(appPg);
    // Every column PageRepo.findById selects and updatePage sets, typed as in the Docmost migrations, plus the search
    // trigger that reads text_content (without the unaccent extension).
    await pg`
      create table pages (
        id uuid primary key, slug_id varchar, title varchar, icon varchar, cover_photo varchar, position varchar,
        content jsonb, ydoc bytea, text_content text, tsv tsvector,
        parent_page_id uuid, creator_id uuid, last_updated_by_id uuid, space_id uuid not null, workspace_id uuid not null,
        is_locked boolean not null default false, is_base boolean not null default false, contributor_ids uuid[],
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
      )`;
    await pg.unsafe(`
      create function pages_tsvector_trigger() returns trigger as $$
      begin
        new.tsv := setweight(to_tsvector('english', coalesce(new.title, '')), 'A') ||
                   setweight(to_tsvector('english', coalesce(new.text_content, '')), 'B');
        return new;
      end
      $$ language plpgsql`);
    await pg.unsafe(`create trigger pages_tsvector_update before insert or update on pages
                     for each row execute function pages_tsvector_trigger()`);
  });

  beforeEach(async () => {
    storeFailures = [];
    jest.spyOn(driftLog, 'logStoreFailure').mockImplementation((_logger, _pageId, err) => {
      storeFailures.push(String((err as { code?: string })?.code ?? (err as Error)?.message ?? err));
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
      values (${PAGE_ID}, 'slug', 'Title', ${uuid(50)}, ${uuid(100)}, ${uuid(900)}, ${uuid(900)}, array[${uuid(900)}::uuid],
              ${pg.json(TiptapTransformer.fromYdoc(seed, 'default'))}, ${Buffer.from(Y.encodeStateAsUpdate(seed))},
              'seed text', '2020-01-01')`;
  });

  afterEach(async () => {
    for (const conn of live.splice(0)) await conn.disconnect();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); // Hocuspocus's post-store unload timer
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  it('a raw update with lone surrogates and NUL stores: the row, text_content and the transclusion input are storable', async () => {
    const s = stack();
    const doc = await s.open();
    remoteUpdate(doc, poison);

    // The poison is really in the live document (the anti-vacuity half): Yjs kept the lone surrogate and the NUL.
    // A deep copy: y-prosemirror hands back Yjs's own format objects, which a later read would otherwise share.
    const raw = structuredClone(TiptapTransformer.fromYdoc(doc, 'default')) as Json;
    expect(textNode(raw, 'link')?.marks?.[0]).toEqual({ type: 'link', attrs: { href: `x${HIGH}` } });
    expect(storable(raw)).toBe(false);
    expect(s.hocuspocus.debouncer.isDebounced(`onStoreDocument-${DOC}`)).toBe(true); // the remote update queued a store

    const settled = await s.handlers.flushPageContent(DOC, { withDigest: true });
    expect(storeFailures).toEqual([]);
    expect(hasStoreFailure(doc)).toBe(false);
    expect(settled).toMatchObject({ flushed: true, contentDigest: expect.any(String) });
    expect(s.updatePage).toHaveBeenCalledTimes(1);

    const r = await row();
    expect(storable(r.content)).toBe(true);
    const para = r.content.content![1];
    expect(para.attrs?.textAlign).toBe(`center${R}`);
    expect(textNode(r.content, 'link')?.marks).toEqual([{ type: 'link', attrs: { href: `x${R}` } }]);
    expect(textNode(r.content, ' nul')?.text).toBe(` nul${R}text `);
    expect(textNode(r.content, 'styled')?.marks).toEqual([{ type: 'textStyle', attrs: { [R]: 'v', color: `red${R}` } }]);
    expect(textNode(r.content, ' emoji')?.text).toBe(` emoji ${EMOJI}`); // a paired surrogate is kept
    expect(r.textContent.includes('\0')).toBe(false);
    expect(r.textContent).toContain(`nul${R}text`);
    expect(r.textContent).toContain(EMOJI);
    expect(r.tsv).toContain("'seed'");
    // The store normalized a copy: the live document still holds the raw value (a normalizer that wrote into Yjs's
    // format objects would have edited the live document in memory).
    expect(TiptapTransformer.fromYdoc(doc, 'default')).toEqual(raw);
    // The bytes keep the raw state: a reload holds what the live document holds.
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, new Uint8Array(r.ydoc));
    expect(TiptapTransformer.fromYdoc(reloaded, 'default')).toEqual(raw);

    // The post-store transclusion sync got the normalized JSON, the same as the row.
    const calls = s.transclusion.syncPageTransclusions.mock.calls;
    const synced = calls[calls.length - 1]?.[2];
    expect(storable(synced)).toBe(true);
    expect(synced).toEqual(r.content);
  });

  it('the next store compares normalized against normalized: an edit to malformed characters only is `unchanged`', async () => {
    const s = stack();
    const doc = await s.open();
    remoteUpdate(doc, poison);
    const first = await s.handlers.flushPageContent(DOC, { withDigest: true });
    const before = await row();
    expect(s.updatePage).toHaveBeenCalledTimes(1);

    // Another lone surrogate in the same href: the live document changes, its stored projection does not.
    remoteUpdate(doc, (f) => ((f.get(1) as Y.XmlElement).get(0) as Y.XmlText).format(0, 4, { link: { href: `x\ud83e` } }));
    expect(textNode(TiptapTransformer.fromYdoc(doc, 'default') as Json, 'link')?.marks?.[0].attrs?.href).toBe('x\ud83e');
    const readsBefore = s.lockedReads();
    // The ADR 0019 digest hashes the same projection the store writes, so the version does not move either: a version
    // handed out now still matches after the store reports `unchanged` and the document reloads from the old bytes.
    await expect(s.handlers.flushPageContent(DOC, { withDigest: true })).resolves.toEqual(first);

    expect(storeFailures).toEqual([]);
    expect(s.lockedReads()).toBe(readsBefore + 1); // the store RAN (not the one-store-per-write skip)…
    expect(s.updatePage).toHaveBeenCalledTimes(1); // …and found the row already holds it: no second write
    expect((await row()).updatedAt).toEqual(before.updatedAt);
  });

  it('a later ordinary edit to the poisoned page stores', async () => {
    const s = stack();
    const doc = await s.open();
    remoteUpdate(doc, poison);
    await s.handlers.flushPageContent(DOC);

    remoteUpdate(doc, (f) => ((f.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(9, ' and more', {}));
    await expect(s.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: true });

    expect(storeFailures).toEqual([]);
    expect(s.updatePage).toHaveBeenCalledTimes(2);
    const r = await row();
    expect(storable(r.content)).toBe(true);
    expect(textNode(r.content, 'seed')?.text).toBe('seed text and more');
    expect(textNode(r.content, 'link')?.marks?.[0].attrs?.href).toBe(`x${R}`);
  });

  it('a reload from the row converges: the store of the reloaded document is `unchanged`', async () => {
    const first = stack();
    const doc = await first.open();
    remoteUpdate(doc, poison);
    const settledBefore = await first.handlers.flushPageContent(DOC, { withDigest: true });
    for (const conn of live.splice(0)) await conn.disconnect();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(first.hocuspocus.documents.has(DOC)).toBe(false);
    const stored = await row();

    const second = stack(); // a fresh node: the document loads from the row's (raw) ydoc bytes
    const reloaded = await second.open();
    expect(storable(TiptapTransformer.fromYdoc(reloaded, 'default'))).toBe(false); // the raw value is still live
    await second.persistence.onStoreDocument({ documentName: DOC, document: reloaded, lastContext: { user: USER } } as never);

    expect(storeFailures).toEqual([]);
    expect(hasStoreFailure(reloaded)).toBe(false);
    expect(second.lockedReads()).toBe(1);
    expect(second.updatePage).not.toHaveBeenCalled();
    const after = await row();
    expect(after.updatedAt).toEqual(stored.updatedAt);
    expect(after.content).toEqual(stored.content);
    // The version survives the unload: the reloaded document's digest is the one handed out before.
    await expect(second.handlers.flushPageContent(DOC, { withDigest: true })).resolves.toEqual(settledBefore);
  });

  // The shape is attacker-controlled too (#773 security review): each of these reached Postgres raw, or made
  // JSON.stringify throw, on every store and every settle, before the store followed what JSON.stringify writes.
  it.each<[string, (p: Y.XmlElement) => void, unknown]>([
    [
      'an element attribute named __proto__ (Yjs builds attrs by assignment, so it re-prototypes them) beside a NUL',
      (p) => {
        p.setAttribute('__proto__', {} as never);
        p.setAttribute('textAlign', 'center\0');
      },
      `center${R}`,
    ],
    [
      'an object attribute value with an own __proto__ key (lib0 readAny re-prototypes it) holding a NUL',
      (p) => p.setAttribute('textAlign', JSON.parse('{"__proto__":{},"a":"x\\u0000"}')),
      { a: `x${R}` },
    ],
    [
      'a Y.Map attribute value (serialized through its toJSON) holding a NUL',
      (p) => {
        const m = new Y.Map();
        p.setAttribute('textAlign', m as never);
        m.set('a', 'x\0');
      },
      { a: `x${R}` },
    ],
    ['a BigInt attribute value (JSON.stringify throws on one)', (p) => p.setAttribute('textAlign', BigInt(10) as never), '10'],
  ])('%s: the store and the settle succeed, and the next store is `unchanged`', async (_name, setAttrs, stored) => {
    const s = stack();
    const doc = await s.open();
    remoteUpdate(doc, (f) => {
      const p = new Y.XmlElement('paragraph');
      f.insert(f.length, [p]);
      setAttrs(p);
    });

    const settled = await s.handlers.flushPageContent(DOC, { withDigest: true });
    expect(storeFailures).toEqual([]);
    expect(hasStoreFailure(doc)).toBe(false);
    expect(settled).toMatchObject({ flushed: true, contentDigest: expect.any(String) });
    expect(s.updatePage).toHaveBeenCalledTimes(1);
    const r = await row();
    expect(storable(r.content)).toBe(true);
    expect(r.content.content![1].attrs?.textAlign).toEqual(stored);

    // It converges: the same live state stores as `unchanged` and keeps its version.
    await s.persistence.onStoreDocument({ documentName: DOC, document: doc, lastContext: { user: USER } } as never);
    expect(storeFailures).toEqual([]);
    expect(s.updatePage).toHaveBeenCalledTimes(1);
    await expect(s.handlers.flushPageContent(DOC, { withDigest: true })).resolves.toEqual(settled);
  });
});
