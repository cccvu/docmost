import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { HttpException } from '@nestjs/common';
import {
  PG_URL,
  uuid,
  fakeWorkspaceResolver,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
} from './read-model-pg.testkit';

// The real create parser is used for validate-content below; its module graph pulls in the collab WebSocket stack
// (lib0 ESM) that jest cannot parse, and parsing never touches it. Stub it.
jest.mock('../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { PageContentParser, ServicePageImportService, TITLE_CANDIDATES_MAX_SCAN } from './service-page-import.service';
import { PageService } from '../core/page/services/page.service';

/**
 * #616 page-import helpers on real Postgres:
 *   title-candidates — exact and `(n ≥ 2)` matches among the LIVE direct children of the parent (or of the space root)
 *   only: a trashed page, a child of another parent, a grandchild, a page in another space or workspace never
 *   matches; ids + indices only; a parent with more than 5000 live children → 503 list_too_broad (trashed children
 *   do not count);
 *   validate-content — through the real create parser; writes nothing.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG page-import helpers gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'service_page_import_pg_spec';
const WS = uuid(100);
const WS_OTHER = uuid(101);
const S1 = uuid(50);
const S2 = uuid(51);
const PARENT = uuid(1);
const OTHER_PARENT = uuid(2);

d('ServicePageImportService on real Postgres (#616)', () => {
  jest.setTimeout(30_000);
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: ServicePageImportService;

  const page = (id: string, title: string | null, parent: string | null, opts: { space?: string; ws?: string; trashed?: boolean } = {}) =>
    pg`insert into pages (id, title, space_id, parent_page_id, workspace_id, deleted_at)
       values (${id}, ${title}, ${opts.space ?? S1}, ${parent}, ${opts.ws ?? WS}, ${opts.trashed ? new Date() : null})`;
  const status = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e) => (e instanceof HttpException ? `${e.getStatus()}:${(e.getResponse() as { code?: string }).code}` : `error:${(e as Error).message}`),
    );

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 2);
    appPg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
    svc = new ServicePageImportService(
      db as never,
      fakeWorkspaceResolver(WS),
      new PageContentParser({ get: () => PageService.prototype } as never),
    );
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await pg`delete from pages`;
  });

  it('matches exact and `(n ≥ 2)` among the live direct children only; ids + indices, never titles', async () => {
    await page(PARENT, 'Parent', null);
    await page(OTHER_PARENT, 'Other parent', null);
    await page(uuid(10), 'Notes', PARENT); // exact
    await page(uuid(11), 'Notes (2)', PARENT); // suffix 2
    await page(uuid(12), 'Notes (7)', PARENT); // suffix 7
    await page(uuid(13), 'Notes (3)', PARENT, { trashed: true }); // trashed: never
    await page(uuid(14), 'Notes', OTHER_PARENT); // another parent: never
    await page(uuid(15), 'Notes', uuid(10)); // a grandchild: never
    await page(uuid(16), 'Notes', null); // the root: not this parent
    await page(uuid(17), 'Notes', PARENT, { space: S2 }); // another space: never
    await page(uuid(18), 'Notes', PARENT, { ws: WS_OTHER }); // another workspace: never
    await page(uuid(19), 'Notes (1)', PARENT); // n < 2
    await page(uuid(20), 'NOTES', PARENT); // case
    await page(uuid(21), null, PARENT); // untitled
    await page(uuid(22), 'Plan', PARENT);

    const res = await svc.titleCandidates({ spaceId: S1, parentPageId: PARENT, titles: ['Notes', 'Plan', 'Absent'] });
    expect(res).toEqual({
      matches: [
        { titleIdx: 0, pageId: uuid(10), suffix: null },
        { titleIdx: 0, pageId: uuid(11), suffix: 2 },
        { titleIdx: 0, pageId: uuid(12), suffix: 7 },
        { titleIdx: 1, pageId: uuid(22), suffix: null },
      ],
    });
    expect(JSON.stringify(res)).not.toMatch(/Notes|Plan/);
  });

  it('the space root (parentPageId null or omitted) compares the root pages of THAT space only', async () => {
    await page(uuid(30), 'Home', null);
    await page(uuid(31), 'Home (2)', null);
    await page(uuid(32), 'Home', null, { space: S2 });
    await page(uuid(33), 'Home', uuid(30));
    for (const parentPageId of [null, undefined]) {
      expect(await svc.titleCandidates({ spaceId: S1, parentPageId, titles: ['Home'] })).toEqual({
        matches: [
          { titleIdx: 0, pageId: uuid(30), suffix: null },
          { titleIdx: 0, pageId: uuid(31), suffix: 2 },
        ],
      });
    }
  });

  it('a parent with more than 5000 LIVE children → 503 list_too_broad; exactly 5000 (plus trashed ones) is fine', async () => {
    await page(PARENT, 'Parent', null);
    await pg`
      insert into pages (id, title, space_id, parent_page_id, workspace_id)
      select gen_random_uuid(), 'child ' || g, ${S1}, ${PARENT}, ${WS} from generate_series(1, ${TITLE_CANDIDATES_MAX_SCAN}) g`;
    await pg`
      insert into pages (id, title, space_id, parent_page_id, workspace_id, deleted_at)
      select gen_random_uuid(), 'gone ' || g, ${S1}, ${PARENT}, ${WS}, now() from generate_series(1, 50) g`;
    const at = await svc.titleCandidates({ spaceId: S1, parentPageId: PARENT, titles: ['child 7', 'gone 1'] });
    expect(at.matches).toHaveLength(1);
    expect(at.matches[0]).toMatchObject({ titleIdx: 0, suffix: null });

    await page(uuid(40), 'one too many', PARENT);
    expect(await status(svc.titleCandidates({ spaceId: S1, parentPageId: PARENT, titles: ['x'] }))).toBe('503:list_too_broad');
  });

  it('validate-content parses through the real create parser and writes nothing', async () => {
    const before = (await pg<{ c: number }[]>`select count(*)::int as c from pages`)[0].c;
    expect(
      await svc.validateContent({
        items: [
          { format: 'markdown', content: '# Heading\n\n- a\n- b' },
          { format: 'html', content: '<p>x</p><link rel="stylesheet" href="http://127.0.0.1:1/x.css">' },
          { format: 'markdown', content: '\n\n' },
        ],
      }),
    ).toEqual({
      results: [
        { idx: 0, ok: true },
        { idx: 1, ok: true },
        { idx: 2, ok: false, code: 'empty_content' },
      ],
    });
    expect((await pg<{ c: number }[]>`select count(*)::int as c from pages`)[0].c).toBe(before);
  });
});
