import 'reflect-metadata';
import { Kysely, PostgresDialect, CamelCasePlugin } from 'kysely';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PublicDiscoveryService } from './public-discovery.service';
import { PublicDiscoveryRepo, PublicPageListRow } from './public-discovery.repo';
import { PublicDiscoveryController } from './public-discovery.controller';
import { ListPublicPagesDto } from './dto';
import { Workspace } from '@docmost/db/types/entity.types';

/**
 * CCC authorization integration test — the anonymous public-content DISCOVERY surface.
 *
 * INTENDED behavior (issue #26 + architecture "authorization is server-side, deny-by-default"): a
 * signed-out visitor may DISCOVER only pages that are already explicitly public — an owner-opted
 * (`search_indexing=true`), non-restricted, sharing-enabled share — never a restricted, private, or
 * cross-tenant page, and never page content/PII. The endpoint changes the anonymously-viewable set by
 * zero; every listed page is already served by the existing share read path.
 *
 * Pure unit specs (no DB, no containers), mirroring the direct-construction style of
 * authz/page-restriction/page-restriction.service.spec.ts. The security-critical SQL filter is locked
 * OFFLINE by compiling the query (real Kysely + CamelCasePlugin, no connection) and asserting every
 * gate is present; the runtime round-trip is proven live (see docs/progress.md verification).
 */

const WS_ID = '33333333-3333-4333-8333-333333333333';

const workspaceOf = (id: string) => ({ id }) as unknown as Workspace;

function makeRow(over: Partial<PublicPageListRow> = {}): PublicPageListRow {
  return {
    id: 'share-row-id',
    shareKey: 'abc123',
    pageId: 'page-1',
    slugId: 'slug-1',
    title: 'Public Handbook',
    icon: null,
    spaceName: 'Docs',
    spaceSlug: 'docs',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    ...over,
  };
}

describe('PublicDiscoveryService — page-size clamping', () => {
  it.each`
    input        | expected
    ${undefined} | ${20}
    ${NaN}       | ${20}
    ${0}         | ${1}
    ${-5}        | ${1}
    ${3.9}       | ${3}
    ${20}        | ${20}
    ${50}        | ${50}
    ${51}        | ${50}
    ${200}       | ${50}
  `('clamps $input -> $expected', ({ input, expected }) => {
    expect(PublicDiscoveryService.clampPerPage(input as number)).toBe(expected);
  });
});

describe('PublicDiscoveryService.listPublicPages', () => {
  function makeService(items: PublicPageListRow[], meta = { hasNextPage: false, nextCursor: null }) {
    const repo = {
      listPublicPages: jest.fn().mockResolvedValue({ items, meta }),
    } as unknown as jest.Mocked<PublicDiscoveryRepo>;
    return { service: new PublicDiscoveryService(repo), repo };
  }

  it('passes the CLAMPED page size and cursor down to the repo, scoped to the workspace', async () => {
    const { service, repo } = makeService([]);
    await service.listPublicPages({ limit: 999, cursor: 'cur' }, WS_ID);
    expect(repo.listPublicPages).toHaveBeenCalledWith({
      workspaceId: WS_ID,
      perPage: 50, // 999 clamped to MAX_PER_PAGE
      cursor: 'cur',
    });
  });

  it('projects ONLY public-safe fields — never the share row id, page content, creator, or comments', async () => {
    const { service } = makeService([makeRow()]);
    const res = await service.listPublicPages({}, WS_ID);
    const item = res.items[0] as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(
      ['createdAt', 'icon', 'pageId', 'shareKey', 'slugId', 'spaceName', 'spaceSlug', 'title', 'updatedAt'].sort(),
    );
    // explicit belt-and-suspenders: no internal / sensitive keys leak
    for (const forbidden of ['id', 'content', 'textContent', 'creatorId', 'creator', 'email']) {
      expect(item).not.toHaveProperty(forbidden);
    }
    expect(res.meta).toEqual({ hasNextPage: false, nextCursor: null });
  });

  it('FAILS CLOSED — a repo/DB error propagates (never a wrong empty 200)', async () => {
    const repo = {
      listPublicPages: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as jest.Mocked<PublicDiscoveryRepo>;
    const service = new PublicDiscoveryService(repo);
    await expect(service.listPublicPages({}, WS_ID)).rejects.toThrow('db down');
  });
});

describe('PublicDiscoveryRepo — the authorization filter is present in the SQL (offline lock)', () => {
  // Compile-only Kysely: mirrors the app's CamelCasePlugin so column names match production; never
  // opens a connection (the fake pool is never touched — .compile() needs no driver).
  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool: {} as any }),
    plugins: [new CamelCasePlugin()],
  });
  const repo = new PublicDiscoveryRepo(db as any);
  const compiled = repo.buildListQuery(WS_ID).compile();
  const sql = compiled.sql.toLowerCase();

  it('walks the restriction markers via a recursive CTE and EXCLUDES restricted pages', () => {
    expect(sql).toContain('with recursive');
    expect(sql).toContain('locked_pages');
    expect(sql).toContain('not exists');
    expect(sql).toContain('page_access');
  });

  it('lists only owner-opted, discoverable shares (search_indexing = true)', () => {
    expect(sql).toContain('search_indexing');
  });

  it('enforces the isSharingAllowed gate at BOTH the workspace and the space', () => {
    const disabledChecks = sql.split("->> 'disabled'").length - 1;
    expect(disabledChecks).toBe(2);
  });

  it('excludes soft-deleted shares and pages', () => {
    expect(sql).toContain('deleted_at');
  });

  it('hard-scopes the query to a single tenant (workspace_id parameter)', () => {
    expect(sql).toContain('workspace_id');
    expect(compiled.parameters).toContain(WS_ID);
  });
});

describe('ListPublicPagesDto validation', () => {
  const build = (obj: unknown) => plainToInstance(ListPublicPagesDto, obj);

  it('accepts an empty body and a valid page/cursor', async () => {
    expect(await validate(build({}))).toHaveLength(0);
    expect(await validate(build({ limit: 10, cursor: 'abc' }))).toHaveLength(0);
  });

  it('rejects a non-positive, fractional, or non-integer limit', async () => {
    expect((await validate(build({ limit: 0 }))).length).toBeGreaterThan(0);
    expect((await validate(build({ limit: -1 }))).length).toBeGreaterThan(0);
    expect((await validate(build({ limit: 1.5 }))).length).toBeGreaterThan(0);
    expect((await validate(build({ limit: 'x' }))).length).toBeGreaterThan(0);
  });

  it('rejects an over-long cursor', async () => {
    expect((await validate(build({ cursor: 'a'.repeat(2049) }))).length).toBeGreaterThan(0);
  });
});

describe('PublicDiscoveryController', () => {
  it('marks the list handler @Public() so the fail-closed JwtAuthGuard admits anonymous callers', () => {
    expect(
      Reflect.getMetadata('isPublic', PublicDiscoveryController.prototype.list),
    ).toBe(true);
  });

  it('delegates to the service with the middleware-resolved workspace id', async () => {
    const service = {
      listPublicPages: jest.fn().mockResolvedValue({ items: [], meta: {} }),
    } as unknown as jest.Mocked<PublicDiscoveryService>;
    const controller = new PublicDiscoveryController(service);
    const dto: ListPublicPagesDto = { limit: 5 };
    await controller.list(dto, workspaceOf(WS_ID));
    expect(service.listPublicPages).toHaveBeenCalledWith(dto, WS_ID);
  });
});
