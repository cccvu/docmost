import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { PageService } from '../../core/page/services/page.service';
import type { HttpAuthzClient } from '../http-authz.client';
import { BreadcrumbsRedactionInterceptor } from './breadcrumbs-redaction.interceptor';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';

// PageService imports the collab gateway, whose lib0/hocuspocus ESM graph jest cannot load; the path driven here
// never touches it (the same stub the other PageService pg specs use).
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

/**
 * Real-Postgres proof of the #574 breadcrumbs cut, on the REAL upstream query: `PageService.getPageBreadCrumbs` runs
 * its recursive CTE against Postgres, its result is wrapped exactly as `TransformHttpResponseInterceptor` wraps it,
 * and `BreadcrumbsRedactionInterceptor` runs on that with a stubbed PDP. So an upstream change to the row shape, the
 * self row or the chain the query returns is caught here, not only against hand-written fixtures. Self-skips without
 * AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG breadcrumbs redaction gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'native_routes_breadcrumbs_pg_spec';
const WS = uuid(100);
const S1 = uuid(50);
const USER = uuid(900);

class PageController {
  getPageBreadcrumbs() {}
}

type Row = { id: string; slugId: string; title: string; parentPageId: string | null; [k: string]: unknown };
type Wrapped = { data: Row[]; success: boolean; status: number };

d('BreadcrumbsRedactionInterceptor on the real getPageBreadCrumbs query', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let pages: PageService;
  /** What the stubbed PDP answers for `filterResources(view)`: the viewable ids, or an error. */
  let pdp: Set<string> | Error;
  const filterResources = jest.fn(async (_s: unknown, _p: string, _t: string, ids: string[]) => {
    if (pdp instanceof Error) throw pdp;
    return ids.filter((id) => (pdp as Set<string>).has(id));
  });
  const interceptor = () =>
    new BreadcrumbsRedactionInterceptor('remote', { filterResources } as unknown as HttpAuthzClient);

  const page = (n: number, parent: number | null, opts: { trashed?: boolean } = {}) => pg`
    insert into pages (id, slug_id, title, workspace_id, space_id, parent_page_id, position, deleted_at)
    values (${uuid(n)}, ${`slug${n}`}, ${`Title ${n}`}, ${WS}, ${S1}, ${parent === null ? null : uuid(parent)}, 'a0',
            ${opts.trashed ? new Date() : null})`;

  /** The handler's real output, wrapped as the response interceptor wraps it. */
  const upstream = async (pageId: string): Promise<Wrapped> => ({
    data: (await pages.getPageBreadCrumbs(pageId)) as unknown as Row[],
    success: true,
    status: 200,
  });

  const redact = (body: Wrapped, requestedPageId: string) => {
    const ctx = {
      getType: () => 'http',
      getClass: () => PageController,
      getHandler: () => PageController.prototype.getPageBreadcrumbs,
      switchToHttp: () => ({ getRequest: () => ({ body: { pageId: requestedPageId }, user: { user: { id: USER } } }) }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(body) };
    return lastValueFrom(interceptor().intercept(ctx, next)) as Promise<Wrapped>;
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    await pg`create table spaces (id uuid primary key, name varchar, workspace_id uuid not null, deleted_at timestamptz)`;
    // The pages columns the breadcrumb query selects and filters on, as in the Docmost migrations.
    await pg`
      create table pages (
        id uuid primary key, slug_id varchar, title varchar, icon varchar, cover_photo varchar, position varchar,
        parent_page_id uuid references pages (id) on delete cascade, creator_id uuid, last_updated_by_id uuid,
        space_id uuid not null references spaces (id) on delete cascade, workspace_id uuid not null,
        is_locked boolean not null default false, is_base boolean not null default false, contributor_ids uuid[],
        content jsonb, text_content text, ydoc bytea,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz, deleted_by_id uuid
      )`;
    await pg`insert into spaces (id, workspace_id) values (${S1}, ${WS})`;

    pages = new PageService(
      {} as never,
      {} as never,
      {} as never,
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { emit: () => true } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  beforeEach(async () => {
    filterResources.mockClear();
    // root(1) → 2 → 3 → self(4), plus a sibling(5) under 3 so the leaf is not simply "the row with no children".
    await page(1, null);
    await page(2, 1);
    await page(3, 2);
    await page(4, 3);
    await page(5, 3);
  });

  afterEach(async () => {
    await pg`delete from pages`;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  const ids = (body: Wrapped) => body.data.map((r) => r.id);
  /** Upstream's own order for the rows kept (the redaction never reorders). */
  const keptInUpstreamOrder = (body: Wrapped, keep: number[]) =>
    ids(body).filter((id) => keep.map(uuid).includes(id));

  it('the real query returns the requested page and every live ancestor (the leak being closed)', async () => {
    const body = await upstream(uuid(4));
    expect([...ids(body)].sort()).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
    expect(JSON.stringify(body)).toContain('Title 1');
  });

  it('full chain viewable: the response is the handler body, untouched (byte-identical)', async () => {
    pdp = new Set([uuid(1), uuid(2), uuid(3)]);
    const body = await upstream(uuid(4));
    const before = JSON.stringify(body);
    const out = await redact(body, uuid(4));
    expect(out).toBe(body);
    expect(JSON.stringify(out)).toBe(before);
    expect(filterResources).toHaveBeenCalledTimes(1);
    expect([...filterResources.mock.calls[0][3]].sort()).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it('cut at the parent: [self] with its parent withheld, no ancestor title on the wire', async () => {
    pdp = new Set([uuid(1), uuid(2)]);
    const out = await redact(await upstream(uuid(4)), uuid(4));
    expect(ids(out)).toEqual([uuid(4)]);
    expect(out.data[0].parentPageId).toBeNull();
    expect(out.data[0].title).toBe('Title 4');
    for (const hidden of ['Title 1', 'Title 2', 'Title 3', uuid(1), uuid(2), uuid(3), 'slug3']) {
      expect(JSON.stringify(out)).not.toContain(hidden);
    }
    expect([out.success, out.status]).toEqual([true, 200]);
  });

  it('cut mid-chain: the run below the hidden page only, even though the root above is viewable', async () => {
    pdp = new Set([uuid(1), uuid(3)]);
    const body = await upstream(uuid(4));
    const out = await redact(body, uuid(4));
    expect(ids(out)).toEqual(keptInUpstreamOrder(body, [3, 4]));
    expect(out.data.find((r) => r.id === uuid(3))?.parentPageId).toBeNull();
    expect(out.data.find((r) => r.id === uuid(4))?.parentPageId).toBe(uuid(3));
    expect(JSON.stringify(out)).not.toContain('Title 1');
    expect(JSON.stringify(out)).not.toContain('Title 2');
  });

  it('requested by slug: the same cut', async () => {
    pdp = new Set([uuid(1), uuid(3)]);
    // The controller resolves the slug to the page, then queries by its id.
    const body = await upstream(uuid(4));
    const out = await redact(body, 'slug4');
    expect(ids(out)).toEqual(keptInUpstreamOrder(body, [3, 4]));
  });

  it('PDP error: fails closed to [self]', async () => {
    pdp = new Error('pdp down');
    const out = await redact(await upstream(uuid(4)), uuid(4));
    expect(ids(out)).toEqual([uuid(4)]);
    expect(out.data[0].parentPageId).toBeNull();
  });

  it('a trashed ancestor already ends the upstream walk; the top kept row keeps its parent id when nothing is cut', async () => {
    await pg`update pages set deleted_at = now() where id = ${uuid(2)}`;
    pdp = new Set([uuid(3)]);
    const body = await upstream(uuid(4));
    expect([...ids(body)].sort()).toEqual([uuid(3), uuid(4)]);
    const out = await redact(body, uuid(4));
    expect(out).toBe(body);
  });

  it('a trashed requested page: the query returns [] and it passes through', async () => {
    await pg`update pages set deleted_at = now() where id = ${uuid(4)}`;
    pdp = new Set();
    const body = await upstream(uuid(4));
    expect(body.data).toEqual([]);
    expect(await redact(body, uuid(4))).toBe(body);
    expect(filterResources).not.toHaveBeenCalled();
  });
});
