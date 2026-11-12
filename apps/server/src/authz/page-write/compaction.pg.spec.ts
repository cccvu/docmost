import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import * as Y from 'yjs';
import { Logger } from '@nestjs/common';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';
import { deadlineExceeded, overrideDeadlineForTests } from '../collab-ingress/deadline';
import { COMPACTION_ARM_DELAY_MS, COMPACTION_MIN_INTERVAL_MS } from '../collab-ingress/doc-bounds';
import { kyselyCompactionStore, ledgerOfDoc, PageCompactingException, readRowLineage, resetLoadTripsForTests } from './compaction';
import {
  awaitCompaction,
  clearCompacting,
  isSuperseded,
  lineageEpoch,
  markCompacting,
  markPageFull,
  requestCompaction,
  setCompactionClockForTests,
} from './compaction-registry';
import { PageTooLargeException } from './page-size';
import { liveContentDigest } from './doc-version';
import { recordWriteKey, scopedWriteKey } from './write-idem';
import { createHash } from 'node:crypto';

/**
 * #827 on real Postgres: compaction's compare-and-swap writes `pages.ydoc` and nothing else (no `updated_at`, `content`
 * or `text_content`, so the page ETag and history are untouched), refuses a row that moved, and rolls back when the
 * document changed. Then the real path: Hocuspocus 4.7.1, the real PersistenceExtension (seam #122: the bounded load,
 * `beforeUnloadDocument`) and CollaborationHandler (seam #2: the direct-write gate), PageRepo and Postgres. Only the
 * queues, the contributor history and the transclusion service are fakes.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG compaction (#827)', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'compaction_pg_spec';
const USER = { id: uuid(900), name: 'Editor' } as never;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');

const text = (t: string) => ({ type: 'text', text: t });
const page = (n: number) => ({
  type: 'doc',
  content: Array.from({ length: n }, (_, i) => ({ type: 'paragraph', content: [text(`paragraph ${i}`)] })),
});

/** A ydoc that went through `rounds` full replaces by fresh clients (history to shed), and its stored projection. */
function churned(rounds: number) {
  const live = new Y.Doc();
  Y.applyUpdate(live, Y.encodeStateAsUpdate(TiptapTransformer.toYdoc(page(5) as never, 'default', tiptapExtensions)));
  for (let i = 0; i < rounds; i++) {
    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(live));
    editor.transact(() => {
      const f = editor.getXmlFragment('default');
      f.delete(0, f.length);
      Y.applyUpdate(editor, Y.encodeStateAsUpdate(TiptapTransformer.toYdoc(page(5) as never, 'default', tiptapExtensions)));
    });
    Y.applyUpdate(live, Y.encodeStateAsUpdate(editor, Y.encodeStateVector(live)));
  }
  recordWriteKey(live, scopedWriteKey(uuid(900), 'key-1'), 1234);
  return { live, content: TiptapTransformer.fromYdoc(live, 'default') };
}

d('compaction on real Postgres (#827)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let restoreClock: () => void;
  let now = 5_000_000;
  let pageSeq = 0;
  let pageId: string;
  const live: Array<{ disconnect(): Promise<void> }> = [];

  const row = async () =>
    (await pg<{ content: unknown; textContent: string; ydoc: Buffer; updatedAt: Date; lastUpdatedById: string }[]>`
      select content, text_content as "textContent", ydoc, updated_at as "updatedAt", last_updated_by_id as "lastUpdatedById"
      from pages where id = ${pageId}`)[0];

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
    return { hocuspocus, handlers, updatePage: jest.spyOn(pageRepo, 'updatePage') };
  }

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(appPg);
    // Every column PageRepo.findById selects and updatePage sets, typed as in the Docmost migrations.
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
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    now += 2 * COMPACTION_MIN_INTERVAL_MS;
    restoreClock = setCompactionClockForTests({ now: () => now, uptimeMs: () => COMPACTION_ARM_DELAY_MS + 1 });
    resetLoadTripsForTests();
    pageId = uuid(827_000 + ++pageSeq);
  });

  afterEach(async () => {
    for (const conn of live.splice(0)) await conn.disconnect();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
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

  it('the swap writes ydoc only (updated_at, content and text_content untouched) and only over the bytes it named', async () => {
    const { live: doc, content } = churned(3);
    const bytes = Y.encodeStateAsUpdate(doc);
    await insert(content, bytes);
    const before = await row();
    const store = kyselyCompactionStore(db as never);

    const read = await store.readRow(pageId);
    expect(read).toMatchObject({ content, contentHash: expect.any(String) });
    expect(Buffer.from(read!.ydoc!)).toEqual(Buffer.from(bytes));

    const next = new Uint8Array([0, 0]);
    expect(await store.swapYdoc(pageId, next, { covered: 'not-the-digest' })).toEqual({ swapped: false, why: 'cas_miss' });
    expect(await store.swapYdoc(pageId, next, { covered: sha(bytes), contentHash: 'other' })).toEqual({ swapped: false, why: 'cas_miss' });
    expect(await store.swapYdoc(pageId, next, { covered: sha(bytes), stillCurrent: () => false })).toEqual({ swapped: false, why: 'changed' });
    expect(Buffer.from((await row()).ydoc)).toEqual(Buffer.from(bytes)); // the rollback held

    expect(await store.swapYdoc(pageId, next, { covered: sha(bytes), contentHash: read!.contentHash })).toEqual({
      swapped: true,
      beforeBytes: bytes.length,
    });
    const after = await row();
    expect(Buffer.from(after.ydoc)).toEqual(Buffer.from(next));
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.content).toEqual(before.content);
    expect(after.textContent).toBe(before.textContent);
    expect(after.lastUpdatedById).toBe(before.lastUpdatedById);
  });

  it('an unload compacts a requested page: the row holds the next lineage with the same content and ledger; updated_at stays', async () => {
    const { live: seed, content } = churned(10);
    await insert(content, Y.encodeStateAsUpdate(seed));
    const before = await row();
    const s = stack();

    const conn = await s.hocuspocus.openDirectConnection(`page.${pageId}`, { user: USER });
    const doc = s.hocuspocus.documents.get(`page.${pageId}`)!;
    const digest = liveContentDigest(doc);
    requestCompaction(doc, { reason: 'structs', userId: null, drain: false });
    await conn.disconnect(); // the last leave: store (current: nothing changed), then unload → beforeUnloadDocument
    await awaitCompaction(pageId);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    expect(isSuperseded(doc)).toBe(true);
    expect(s.hocuspocus.documents.has(`page.${pageId}`)).toBe(false);
    const after = await row();
    expect(readRowLineage(after.ydoc)).toMatchObject({ epoch: 1, clients: 1, ledger: [{ key: scopedWriteKey(uuid(900), 'key-1').entry, ts: 1234 }] });
    expect(after.ydoc.length).toBeLessThan(before.ydoc.length);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.content).toEqual(before.content);
    expect(s.updatePage).not.toHaveBeenCalled();

    // the next load serves the compacted lineage, with the digest a conditional write already holds
    const again = await s.hocuspocus.openDirectConnection(`page.${pageId}`, { user: USER });
    live.push(again);
    const reloaded = s.hocuspocus.documents.get(`page.${pageId}`)!;
    expect(lineageEpoch(reloaded)).toBe(1);
    expect(liveContentDigest(reloaded)).toBe(digest);
    expect(ledgerOfDoc(reloaded)).toEqual([{ key: scopedWriteKey(uuid(900), 'key-1').entry, ts: 1234 }]);
  });

  it('a load that trips answers the API a retryable 503 and compacts the row; the next load waits for it and serves it', async () => {
    const { live: seed, content } = churned(4);
    const bytes = Y.encodeStateAsUpdate(seed);
    await insert(content, bytes);
    const s = stack();

    // A stored page too costly to load: the load's deadline trips (simulated, the first deadline call only; the walk
    // budget is the deterministic arm, compaction.spec.ts). The direct write refuses before anything changes, and the
    // row compacts in the background (its build, the second deadline call, runs for real).
    let calls = 0;
    const restore = overrideDeadlineForTests((fn, ms) => {
      if (++calls === 1) throw deadlineExceeded(ms);
      return fn();
    });
    let refused: unknown;
    try {
      await s.handlers.updatePageContent(`page.${pageId}`, { prosemirrorJson: page(1), operation: 'append', user: USER });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(PageCompactingException);
    expect((refused as PageCompactingException).getStatus()).toBe(503);
    expect((refused as PageCompactingException).getResponse()).toMatchObject({ code: 'engine_busy' });
    expect(s.hocuspocus.documents.has(`page.${pageId}`)).toBe(false);

    await awaitCompaction(pageId);
    restore();
    expect(calls).toBe(2);
    expect(readRowLineage((await row()).ydoc).epoch).toBe(1);

    // the next write loads the compacted row (after waiting for it) and applies
    const outcome = await s.handlers.conditionalUpdatePageContent(`page.${pageId}`, {
      prosemirrorJson: page(1),
      operation: 'append',
      user: USER,
    });
    expect(outcome).toEqual({ applied: true });
    const after = await row();
    expect(readRowLineage(after.ydoc).epoch).toBe(1);
    expect((after.content as { content: unknown[] }).content).toHaveLength(6);
  });

  it('the conditional write on a page whose load trips answers error (a 503), never applied_unconfirmed', async () => {
    const { live: seed, content } = churned(1);
    await insert(content, Y.encodeStateAsUpdate(seed));
    const s = stack();
    restoreClock();
    restoreClock = setCompactionClockForTests({ now: () => now, uptimeMs: () => 0 }); // not armed: nothing is written
    const ydocBefore = (await row()).ydoc;
    const restore = overrideDeadlineForTests((_fn, ms) => {
      throw deadlineExceeded(ms);
    });
    try {
      const outcome = await s.handlers.conditionalUpdatePageContent(`page.${pageId}`, {
        prosemirrorJson: page(1),
        operation: 'append',
        user: USER,
      });
      expect(outcome).toEqual({ applied: false, reason: 'error' });
    } finally {
      restore();
    }
    expect(Buffer.from((await row()).ydoc)).toEqual(Buffer.from(ydocBefore));
  });

  it('seam #2: no direct write while the page compacts (503, nothing changed); a full page refuses growth, never a replace', async () => {
    const { live: seed, content } = churned(1);
    await insert(content, Y.encodeStateAsUpdate(seed));
    const s = stack();
    const holder = await s.hocuspocus.openDirectConnection(`page.${pageId}`, { user: USER }); // keeps it resident
    live.push(holder);
    const doc = s.hocuspocus.documents.get(`page.${pageId}`)!;
    const digest = liveContentDigest(doc);
    const write = (operation: string) =>
      s.handlers.updatePageContent(`page.${pageId}`, { prosemirrorJson: page(1), operation, user: USER });
    const conditional = (operation: string) =>
      s.handlers.conditionalUpdatePageContent(`page.${pageId}`, { prosemirrorJson: page(1), operation, user: USER });

    markCompacting(doc);
    await expect(write('append')).rejects.toBeInstanceOf(PageCompactingException);
    await expect(write('replace')).rejects.toBeInstanceOf(PageCompactingException);
    await expect(conditional('append')).resolves.toEqual({ applied: false, reason: 'error' }); // a 503, never unknown
    expect(liveContentDigest(doc)).toBe(digest);
    clearCompacting(doc);

    markPageFull(doc);
    await expect(write('append')).rejects.toBeInstanceOf(PageTooLargeException);
    await expect(conditional('prepend')).resolves.toEqual({ applied: false, reason: 'too_large' });
    expect(liveContentDigest(doc)).toBe(digest);
    await expect(conditional('replace')).resolves.toEqual({ applied: true }); // how a full page gets smaller
    expect(liveContentDigest(doc)).not.toBe(digest);
  });
});
