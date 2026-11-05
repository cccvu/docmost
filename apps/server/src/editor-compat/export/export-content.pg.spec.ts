import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { bootstrapSchema, mkReadModelDb, mkReadModelPg, PG_URL, uuid } from '../../service-bridge/read-model-pg.testkit';
import { kyselyContentSource, loadExportContent } from './export-content';
import { ExportTooLargeException } from './export-limits';

/**
 * #699 — the content bound's SQL on a real Postgres: the stored size and the text size the driver parses, over an
 * explicit id set (`= any($1::uuid[])`, one parameter whatever the page count), and the content load. Self-skips
 * without AUTHZ_TEST_PG_URL. NOTE: the CI Postgres lane runs only src/(service-bridge|authz); run this one with
 * `AUTHZ_TEST_PG_URL=… pnpm exec jest src/editor-compat/export/export-content.pg.spec.ts`.
 */
const d = PG_URL ? describe : describe.skip;
const SCHEMA = 'editor_compat_export_content_pg_spec';

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

d('export content bound on real Postgres (#699)', () => {
  let pg: postgres.Sql;
  let db: Kysely<any>;

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 2);
    await pg`create table pages (id uuid primary key, content jsonb)`;
    db = mkReadModelDb(pg);
    // 1: small; 2: a large, highly compressible page (pglz); 3: not in the export set; 4: NULL content.
    await pg`insert into pages values (${uuid(1)}, ${pg.json({ type: 'doc', content: [para('hello')] })})`;
    await pg`insert into pages values (${uuid(2)}, ${pg.json({ type: 'doc', content: Array.from({ length: 4000 }, () => para('a'.repeat(200))) })})`;
    await pg`insert into pages values (${uuid(3)}, ${pg.json({ type: 'doc', content: Array.from({ length: 4000 }, () => para('b'.repeat(200))) })})`;
    await pg`insert into pages values (${uuid(4)}, null)`;
  });

  afterAll(async () => {
    await pg?.end({ timeout: 5 });
  });

  it('measures stored vs text over exactly the id set; compressible content is far smaller stored than as text', async () => {
    const src = kyselyContentSource(db);
    const ids = [uuid(1), uuid(2), uuid(4)];
    const stored = await src.storedBytes(ids);
    const text = await src.textBytes(ids);
    const [{ t }] = await pg`select sum(octet_length(content::text))::int as t from pages where id in (${uuid(1)}, ${uuid(2)})`;
    expect(text).toBe(t); // page 3 is not counted; NULL contributes nothing
    expect(stored).toBeGreaterThan(0);
    expect(text / stored).toBeGreaterThan(20); // why the text check exists
  });

  it('a set whose stored size fits but whose text does not is refused before its content is loaded', async () => {
    const pages = [{ id: uuid(1) }, { id: uuid(2) }];
    const stored = await kyselyContentSource(db).storedBytes(pages.map((p) => p.id));
    await expect(
      loadExportContent(db, pages, { contentBytes: stored * 2, maxEntries: 65_000 }),
    ).rejects.toBeInstanceOf(ExportTooLargeException);
    expect((pages[0] as any).content).toBeUndefined();
  });

  it('loads parsed content onto the given pages when the set fits', async () => {
    const pages = [{ id: uuid(4) }, { id: uuid(1) }];
    await loadExportContent(db, pages, { contentBytes: 1024 * 1024, maxEntries: 65_000 });
    expect((pages[0] as any).content).toBeNull();
    expect((pages[1] as any).content).toEqual({ type: 'doc', content: [para('hello')] });
  });
});
