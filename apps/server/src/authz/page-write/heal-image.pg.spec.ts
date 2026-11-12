import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import * as Y from 'yjs';
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';
import { basePage, rawUpdate } from '../collab-ingress/conflict-scan.testkit';
import { deadlineExceeded, overrideDeadlineForTests } from '../collab-ingress/deadline';
import { COMPACTION_ARM_DELAY_MS, COMPACTION_MIN_INTERVAL_MS } from '../collab-ingress/doc-bounds';
import { replicaLogOf } from '../collab-ingress/exact-replica-registry';
import { isReloadStable, strictOrderDiff } from '../collab-ingress/order-parity';
import { compactionStoreOf, isPageCompactingRefusal, resetLoadTripsForTests } from './compaction';
import { awaitCompaction, compactionRequest, lineageEpoch, setCompactionClockForTests } from './compaction-registry';
import { liveContentDigest } from './doc-version';
import { healStoreOf } from './heal-image';
import { recordWriteKey } from './write-idem';

/**
 * #840 T9, the crash matrix on real Postgres (the plan's "Crash safety" table, ADR 0036 #840 amendment). The real path:
 * Hocuspocus 4.7.1, the real PersistenceExtension (seam #122: the store's order check and heal row, the stable load),
 * CollaborationHandler's settle, PageRepo, the heal and compaction stores, Postgres. A page is made reload-unstable as a
 * crafted frame does it (S1 in a paragraph: live shows "abcXYZdefgh", every reload of it "abcdefghXYZ" and back). A
 * crash is the process stopping where the row says (a rolled-back store, a committed one with no compaction after
 * it); a restart is a new Hocuspocus over the same database. Each row asserts the invariants:
 *   I1 no loss: the committed row holds every item live had (its state vector covers live's);
 *   I2 no unstable serve: what a load serves is reload-stable and shows the content live showed;
 *   I3 lossless heal: a heal serves the verified image (live's ADR 0019 digest, the next epoch), never JSON or a reload;
 *   I4 atomic writes: the raw bytes and the heal row commit together or not at all.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG heal image crash matrix (#840)', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'heal_image_pg_spec';
const USER = { id: uuid(900), name: 'Editor' } as never;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');
const json = (doc: Y.Doc) => TiptapTransformer.fromYdoc(doc, 'default');
const textOf = (doc: Y.Doc) => JSON.stringify(json(doc)).match(/"text":"([^"]*)"/)?.[1];

/** The seed page (one paragraph, "abcdefgh", one struct by client 1) and S1's frame against it (client `client`). */
function seed() {
  const b = basePage('abcdefgh');
  const frame = (client = 2, text = 'XYZ') =>
    rawUpdate([{ client, clock: 0, structs: [{ origin: [1, b.first + 5], right: [1, b.first + 3], content: new Y.ContentString(text) }] }]);
  return { bytes: Y.encodeStateAsUpdate(b.doc), content: json(b.doc), frame };
}

/** A stable state with more in it (another node's write): the seed plus a paragraph. */
function stableOther(text: string): Uint8Array {
  const b = basePage('abcdefgh');
  b.doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText(text)]);
    b.doc.getXmlFragment('default').insert(1, [p]);
  });
  return Y.encodeStateAsUpdate(b.doc);
}

/** `doc`'s state vector covers every client clock in `sv` (I1). */
function covers(doc: Y.Doc, sv: Uint8Array): boolean {
  for (const [client, clock] of Y.decodeStateVector(sv)) if (Y.getState(doc.store, client) < clock) return false;
  return true;
}
const loaded = (bytes: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
};

d('heal image crash matrix on real Postgres (#840)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let restoreClock: () => void;
  let now = 5_000_000;
  let armed = true;
  let pageSeq = 0;
  let pageId: string;
  let DOC: string;
  let lines: string[];
  const open: Array<{ disconnect(): Promise<void> }> = [];

  const row = async () =>
    (await pg<{ content: unknown; ydoc: Buffer; updatedAt: Date }[]>`
      select content, ydoc, updated_at as "updatedAt" from pages where id = ${pageId}`)[0];
  const heal = async () =>
    (await pg<{ image: Buffer | null; rowSha: string; epoch: number }[]>`
      select image, row_sha as "rowSha", epoch from ccc_page_heal_image where page_id = ${pageId}`)[0] ?? null;
  const writeYdoc = (bytes: Uint8Array) => pg`update pages set ydoc = ${Buffer.from(bytes)} where id = ${pageId}`;

  function stack() {
    const pageRepo = new PageRepo(db as never, {} as never, { emit: () => true } as never);
    const queue = { add: jest.fn(async () => undefined) } as never;
    const transclusion = { syncPageTransclusions: jest.fn(async () => undefined), syncPageReferences: jest.fn(async () => undefined) };
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
    return { hocuspocus, handlers, pageRepo, persistence };
  }

  /** Open the page on `s`; the connection is closed after the test (or by the caller). */
  async function openPage(s: ReturnType<typeof stack>) {
    const conn = await s.hocuspocus.openDirectConnection(DOC, { user: USER });
    open.push(conn);
    return { conn, doc: s.hocuspocus.documents.get(DOC)! };
  }

  /** The load's answer: the served document, or the refusal it threw. */
  async function tryOpen(s: ReturnType<typeof stack>): Promise<{ doc: Y.Doc | null; refused: unknown }> {
    try {
      return { doc: (await openPage(s)).doc, refused: null };
    } catch (err) {
      return { doc: null, refused: err };
    }
  }

  /** Make the open page reload-unstable (S1's frame, through the connection: one server-local transaction). */
  async function destabilize(conn: { transact(fn: (d: Y.Doc) => void): Promise<void> }, frame: Uint8Array) {
    await conn.transact((d) => Y.applyUpdate(d, frame));
  }

  /** The process stops: nothing compacts at the unload (compaction not armed while the connection closes). */
  async function crash(conn: { disconnect(): Promise<void> }) {
    armed = false;
    try {
      await conn.disconnect();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    } finally {
      armed = true;
    }
  }

  const divergence = () => lines.filter((l) => l.startsWith('COLLAB_ORDER_DIVERGENCE ')).map((l) => JSON.parse(l.slice(24)));

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
    // The boot install (in every mode: the extension's own onApplicationBootstrap), then once more: idempotent.
    await stack().persistence.onApplicationBootstrap();
    await stack().persistence.onApplicationBootstrap();
  });

  beforeEach(async () => {
    lines = [];
    const capture = (m: unknown) => void lines.push(String(m));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    now += 2 * COMPACTION_MIN_INTERVAL_MS;
    armed = true;
    restoreClock = setCompactionClockForTests({ now: () => now, uptimeMs: () => (armed ? COMPACTION_ARM_DELAY_MS + 1 : 0) });
    resetLoadTripsForTests();
    pageId = uuid(840_000 + ++pageSeq);
    DOC = `page.${pageId}`;
  });

  afterEach(async () => {
    for (const conn of open.splice(0)) await conn.disconnect().catch(() => undefined);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await awaitCompaction(pageId);
    restoreClock();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  const insert = async (content: unknown, ydoc: Uint8Array | null) => {
    await pg`
      insert into pages (id, slug_id, title, space_id, workspace_id, creator_id, last_updated_by_id, contributor_ids,
                         content, ydoc, text_content, updated_at)
      values (${pageId}, 'slug', 'Title', ${uuid(50)}, ${uuid(100)}, ${uuid(900)}, ${uuid(900)}, array[${uuid(900)}::uuid],
              ${pg.json(content as never)}, ${ydoc ? Buffer.from(ydoc) : null}, 'text', '2020-01-01T00:00:00.123456Z')`;
  };

  /**
   * An unstable store that commits on `s`: returns pre-crash live (its content, digest and state vector) and the
   * committed row's bytes.
   */
  async function unstableCommit(s: ReturnType<typeof stack>) {
    const sd = seed();
    await insert(sd.content, sd.bytes);
    const { conn, doc } = await openPage(s);
    await destabilize(conn, sd.frame());
    expect(isReloadStable(doc).stable).toBe(false); // precondition: live is unstable
    expect(textOf(doc)).toBe('abcXYZdefgh');
    await expect(s.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: true });
    const live = { json: json(doc), digest: liveContentDigest(doc), sv: Y.encodeStateVector(doc) };
    return { conn, doc, live, sd };
  }

  /** I2 + I3 on a load that healed: the image is what is served and stored, and it is live's content at epoch + 1. */
  async function expectHealed(served: Y.Doc, live: { json: unknown; digest: string }, image: Buffer) {
    expect(isReloadStable(served).stable).toBe(true); // I2
    expect(json(served)).toEqual(live.json); // I2
    expect(liveContentDigest(served)).toBe(live.digest); // I3: the verified image, live's ADR 0019 digest
    expect(lineageEpoch(served)).toBe(1); // the epoch bump puts an older copy behind #827's notice
    expect(Buffer.from((await row()).ydoc)).toEqual(image); // the CAS wrote exactly the image
    expect(await heal()).toBeNull(); // …and deleted the heal row in the same transaction
    // The guard's replica log starts from the exact bytes applied: it rebuilds the served document exactly.
    expect(strictOrderDiff(replicaLogOf(served)!.rebuild(), served)).toBeNull();
  }

  // --- the store

  it('an unstable store writes the raw bytes AND a verified heal image in one transaction (I1, I4)', async () => {
    const s = stack();
    const { doc, live } = await unstableCommit(s);
    const r = await row();
    const h = await heal();
    expect(h).not.toBeNull();
    expect(h!.rowSha).toBe(sha(r.ydoc)); // the image names exactly the bytes it accompanies
    expect(h!.epoch).toBe(1);
    expect(Buffer.from(r.ydoc)).toEqual(Buffer.from(Y.encodeStateAsUpdate(doc))); // raw bytes, no item lost (I1)
    expect(covers(loaded(r.ydoc), live.sv)).toBe(true);
    expect(r.content).toEqual(live.json); // live-order content
    const image = loaded(h!.image!);
    expect(isReloadStable(image).stable).toBe(true);
    expect(liveContentDigest(image)).toBe(live.digest);
    expect(compactionRequest(doc)).toMatchObject({ reason: 'order_divergence', drain: true });
    expect(divergence()).toEqual([expect.objectContaining({ page: pageId, where: 'store', outcome: 'heal_image', suspects: [] })]);
  });

  it('no crash: the drained unload compacts from live and drops the heal row in the CAS transaction', async () => {
    const s = stack();
    const { conn, live } = await unstableCommit(s);
    await conn.disconnect();
    await awaitCompaction(pageId);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(await heal()).toBeNull();
    const served = loaded((await row()).ydoc);
    expect(lineageEpoch(served)).toBe(1);
    expect(isReloadStable(served).stable).toBe(true);
    expect(json(served)).toEqual(live.json);
  });

  it('an unstable store whose content is unchanged still writes its bytes, so the heal row names them (updated_at untouched)', async () => {
    const s = stack();
    const { conn, doc } = await unstableCommit(s);
    const before = await row();
    await conn.transact((d) => recordWriteKey(d, `${uuid(900)}\u0000key-1`, 1234)); // ydoc changes, content does not
    await expect(s.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: true });
    const after = await row();
    expect(after.content).toEqual(before.content);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(Buffer.from(after.ydoc)).toEqual(Buffer.from(Y.encodeStateAsUpdate(doc)));
    expect((await heal())!.rowSha).toBe(sha(after.ydoc));
  });

  it('a stable store deletes a heal row it finds (the row it heals is gone)', async () => {
    const sd = seed();
    await insert(sd.content, sd.bytes);
    const s = stack();
    const { conn } = await openPage(s);
    await pg`insert into ccc_page_heal_image (page_id, image, row_sha, epoch) values (${pageId}, null, 'stale', 1)`;
    await conn.transact((d) => (d.getXmlFragment('default').get(0) as Y.XmlElement).insert(1, [new Y.XmlText('more')]));
    await expect(s.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: true });
    expect(await heal()).toBeNull();
    expect(divergence()).toEqual([]);
  });

  it('a stable store with unchanged content over an unstable row writes its bytes before it drops the heal row (I2)', async () => {
    const s = stack();
    const { conn, doc, live } = await unstableCommit(s);
    // Live becomes stable with the same content: the paragraph's text is retyped honestly as it shows.
    await conn.transact((d) => {
      const paragraph = d.getXmlFragment('default').get(0) as Y.XmlElement;
      paragraph.delete(0, 1);
      paragraph.insert(0, [new Y.XmlText('abcXYZdefgh')]);
    });
    expect(isReloadStable(doc).stable).toBe(true); // precondition
    expect(json(doc)).toEqual(live.json); // …and its content is what the row holds
    await expect(s.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: true });
    await crash(conn);
    expect(await heal()).toBeNull();

    const { doc: served } = await tryOpen(stack());
    expect(json(served!)).toEqual(live.json); // I2: not the reload order of the row the heal row named
    expect(isReloadStable(served!).stable).toBe(true);
    expect(Buffer.from((await row()).ydoc)).toEqual(Buffer.from(Y.encodeStateAsUpdate(doc))); // the stable bytes
  });

  // --- the crash table

  it('crash before the unstable store commits: the previous row stays, with no heal row (I4); the restart serves it', async () => {
    const sd = seed();
    await insert(sd.content, sd.bytes);
    const s = stack();
    jest.spyOn(s.pageRepo, 'updatePage').mockRejectedValue(new Error('the process stops before the commit'));
    const { conn } = await openPage(s);
    await destabilize(conn, sd.frame());
    await expect(s.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: false, reason: 'error' });
    await crash(conn);
    expect(Buffer.from((await row()).ydoc)).toEqual(Buffer.from(sd.bytes)); // the heal upsert rolled back with it
    expect(await heal()).toBeNull();

    const { doc: served } = await tryOpen(stack());
    expect(served).not.toBeNull();
    expect(isReloadStable(served!).stable).toBe(true); // I2
    expect(json(served!)).toEqual(sd.content); // the last committed state: only the debounce window is lost (as today)
    expect(covers(served!, Y.encodeStateVector(loaded(sd.bytes)))).toBe(true); // I1
  });

  it('crash before a later store commits: the previous row and ITS heal row stay valid; the restart heals from it', async () => {
    const s = stack();
    const { conn, doc, live } = await unstableCommit(s);
    const committed = await row();
    const h = await heal();
    jest.spyOn(s.pageRepo, 'updatePage').mockRejectedValue(new Error('the process stops before the commit'));
    await conn.transact((d) => (d.getXmlFragment('default').get(0) as Y.XmlElement).insert(1, [new Y.XmlText('lost')]));
    expect(textOf(doc)).not.toBe(textOf(loaded(committed.ydoc)));
    await expect(s.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: false, reason: 'error' });
    await crash(conn);
    expect(Buffer.from((await row()).ydoc)).toEqual(Buffer.from(committed.ydoc));
    expect(await heal()).toEqual(h); // still valid by row_sha

    const { doc: served } = await tryOpen(stack());
    await expectHealed(served!, live, h!.image!);
  });

  it('crash after the unstable store commits: once armed, the load CASes the image in, drops the heal row and serves it', async () => {
    const s = stack();
    const { conn, live } = await unstableCommit(s);
    await crash(conn);
    const committed = await row();
    const h = await heal();
    expect(h!.rowSha).toBe(sha(committed.ydoc));
    expect(covers(loaded(committed.ydoc), live.sv)).toBe(true); // I1 at the crash point

    // Not armed (a pre-#827 task may still serve the page): try-later, nothing written.
    armed = false;
    const early = await tryOpen(stack());
    armed = true;
    expect(isPageCompactingRefusal(early.refused)).toBe(true);
    expect(Buffer.from((await row()).ydoc)).toEqual(Buffer.from(committed.ydoc));
    expect(await heal()).toEqual(h);

    const { doc: served } = await tryOpen(stack());
    await expectHealed(served!, live, h!.image!);
    expect(divergence().map((e) => [e.where, e.outcome])).toEqual([
      ['store', 'heal_image'],
      ['load', 'not_armed'],
      ['load', 'healed'],
    ]);
  });

  it('anti-vacuity: without the heal row write, the restart after a committed unstable store serves another order (I2 fails)', async () => {
    const s = stack();
    jest.spyOn(healStoreOf(db as never), 'put').mockImplementation(async () => undefined); // content changed: no ydoc to write here
    const { conn, live } = await unstableCommit(s);
    await crash(conn);
    expect(await heal()).toBeNull();
    const { doc: served } = await tryOpen(stack());
    expect(json(served!)).not.toEqual(live.json); // the reload order: what every joiner and restart saw before #840
    expect(textOf(served!)).toBe('abcdefghXYZ');
    expect(isReloadStable(served!).stable).toBe(false);
  });

  it('compaction at the unload fails: raw row + image stay (COLLAB_COMPACTION_FAILED); the restart heals from the image', async () => {
    const s = stack();
    const { conn, live } = await unstableCommit(s);
    const h = await heal();
    const swap = jest.spyOn(compactionStoreOf(db as never), 'swapYdoc').mockRejectedValueOnce(new Error('connection lost'));
    await conn.disconnect(); // drained: the unload compacts, and its swap fails
    await awaitCompaction(pageId);
    expect(swap).toHaveBeenCalledTimes(1);
    swap.mockRestore();
    expect(lines.some((l) => l.startsWith('COLLAB_COMPACTION_FAILED ') && l.includes('"order_divergence"'))).toBe(true);
    expect(await heal()).toEqual(h);

    const { doc: served } = await tryOpen(stack());
    await expectHealed(served!, live, h!.image!);
  });

  it('the load\'s CAS loses a race: it re-reads the row and never writes the image over the newer bytes', async () => {
    const s = stack();
    const { conn } = await unstableCommit(s);
    await crash(conn);
    const other = stableOther('another node');
    const store = compactionStoreOf(db as never);
    const swap = store.swapYdoc.bind(store);
    jest.spyOn(store, 'swapYdoc').mockImplementationOnce(async (...a) => {
      await writeYdoc(other); // a concurrent writer lands between the heal read and the swap
      return swap(...a);
    });
    const { doc: served } = await tryOpen(stack());
    expect(Buffer.from((await row()).ydoc)).toEqual(Buffer.from(other)); // the CAS missed: nothing overwritten
    expect(JSON.stringify(json(served!))).toContain('another node'); // the row as it is now (stable: served)
    expect(isReloadStable(served!).stable).toBe(true);
    expect(await heal()).toBeNull(); // stale now: dropped
    expect(divergence().map((e) => e.outcome)).toEqual(['heal_image', 'stale_dropped']);
  });

  it('the image cannot be built at the store: raw row + a heal row without an image; the page answers try-later and alerts', async () => {
    const sd = seed();
    await insert(sd.content, sd.bytes);
    const s = stack();
    const { conn, doc } = await openPage(s);
    await destabilize(conn, sd.frame());
    let calls = 0; // the store's deadlines: its reload (1), the image build (2)
    const restore = overrideDeadlineForTests((fn, ms) => {
      if (++calls === 2) throw deadlineExceeded(ms);
      return fn();
    });
    try {
      await expect(s.handlers.flushPageContent(DOC)).resolves.toEqual({ flushed: true });
    } finally {
      restore();
    }
    const sv = Y.encodeStateVector(doc);
    await crash(conn);
    const committed = await row();
    const h = await heal();
    expect(h).toMatchObject({ image: null, rowSha: sha(committed.ydoc), epoch: 1 });
    expect(covers(loaded(committed.ydoc), sv)).toBe(true); // I1: the raw bytes are kept for an operator
    expect(lines.some((l) => l.startsWith('COLLAB_COMPACTION_FAILED ') && l.includes('"heal_image"'))).toBe(true);

    const again = await tryOpen(stack());
    expect(isPageCompactingRefusal(again.refused)).toBe(true); // I2: unavailable, never served unstable
    expect(Buffer.from((await row()).ydoc)).toEqual(Buffer.from(committed.ydoc)); // nothing healed from a lossy source
    expect(await heal()).toEqual(h);
    expect(divergence().map((e) => e.outcome)).toEqual(['image_failed', 'image_missing']);
  });

  it('a stale heal row over STABLE bytes (a pre-#840 writer): served, and the stale row dropped', async () => {
    const s = stack();
    const { conn } = await unstableCommit(s);
    await crash(conn);
    const other = stableOther('pre-840 write');
    await writeYdoc(other);
    const { doc: served } = await tryOpen(stack());
    expect(JSON.stringify(json(served!))).toContain('pre-840 write');
    expect(isReloadStable(served!).stable).toBe(true);
    expect(await heal()).toBeNull();
    expect(Buffer.from((await row()).ydoc)).toEqual(Buffer.from(other));
  });

  it('a stale heal row over UNSTABLE bytes: try-later and alert; nothing is healed from the stale image', async () => {
    const s = stack();
    const { conn } = await unstableCommit(s);
    await crash(conn);
    const h = await heal();
    const other = seed();
    const elsewhere = loaded(other.bytes);
    Y.applyUpdate(elsewhere, other.frame(3, 'QQ'));
    const unstable = Y.encodeStateAsUpdate(elsewhere);
    expect(isReloadStable(loaded(unstable)).stable).toBe(false); // precondition
    await writeYdoc(unstable);
    const again = await tryOpen(stack());
    expect(isPageCompactingRefusal(again.refused)).toBe(true);
    expect(Buffer.from((await row()).ydoc)).toEqual(Buffer.from(unstable));
    expect(await heal()).toEqual(h);
    expect(lines.some((l) => l.startsWith('COLLAB_ORDER_DIVERGENCE ') && l.includes('"stale_unstable"'))).toBe(true);
  });

  it('a legacy unstable row (no heal row): served as today, compaction from that tree requested; then stable for good', async () => {
    const sd = seed();
    const live = loaded(sd.bytes);
    Y.applyUpdate(live, sd.frame());
    const legacy = Y.encodeStateAsUpdate(live);
    await insert(json(live), legacy);
    const s = stack();
    const { conn, doc } = await openPage(s);
    expect(textOf(doc)).toBe('abcdefghXYZ'); // the reload order users already see today
    expect(compactionRequest(doc)).toMatchObject({ reason: 'order_divergence', drain: false });
    expect(divergence()).toEqual([expect.objectContaining({ where: 'load', outcome: 'legacy' })]);
    const served = json(doc);
    expect(covers(doc, Y.encodeStateVector(live))).toBe(true); // I1: nothing of the row lost

    await conn.disconnect(); // the unload compacts from the loaded tree
    await awaitCompaction(pageId);
    const compacted = loaded((await row()).ydoc);
    expect(lineageEpoch(compacted)).toBe(1);
    expect(isReloadStable(compacted).stable).toBe(true);
    expect(json(compacted)).toEqual(served); // consistent everywhere from then on
  });
});
