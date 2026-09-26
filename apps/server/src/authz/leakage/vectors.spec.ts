import { Test } from '@nestjs/testing';
import { Kysely, PostgresDialect, CamelCasePlugin } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { FavoriteService } from '../../core/favorite/services/favorite.service';
import { FavoriteRepo, FavoriteType } from '@docmost/db/repos/favorite/favorite.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import { PdpSpaceMemberRepo } from '../pdp-space-member.repo';
import { PdpSearchService } from '../search/pdp-search.service';
import { SearchService } from '../../core/search/search.service';
import { PublicDiscoveryRepo } from '../public-discovery/public-discovery.repo';
import { LabelRepo } from '@docmost/db/repos/label/label.repo';
import { LabelService } from '../../core/label/label.service';
import { CursoredRow, PdpLabelRepo, authorizedKeysetPage } from '../pdp-label.repo';
import { DatabaseModule } from '../../database/database.module';
import {
  labelRepoProvider,
  pagePermissionRepoProvider,
  spaceMemberRepoProvider,
} from '../mode/repo-providers';

/**
 * CCC authorization integration test (fork compatibility suite) — per-vector leakage coverage (§8/§9,
 * "one absence test per §8 row"). Two layers:
 *
 *  1. A REAL service-wiring proof (favorites) — a confidential page/space handed to the service does
 *     not survive its PDP post-filter (the vector funnels through the primitive; primitives.spec then
 *     proves the primitive itself excludes it). Backlinks have their own upstream wiring spec.
 *  2. A COVERAGE MATRIX mapping every §8 vector to the exact PDP repo override it routes through, and
 *     asserting that override is actually DEFINED on our subclass (an own-property) — so removing an
 *     override (a silent leak) fails this test. No vector is left implicit.
 */
describe('Indirect-leakage vectors — favorites service wiring (representative real service)', () => {
  let service: FavoriteService;
  let favoriteRepo: jest.Mocked<Partial<FavoriteRepo>>;
  let pagePermissionRepo: jest.Mocked<Partial<PagePermissionRepo>>;
  let spaceMemberRepo: jest.Mocked<Partial<SpaceMemberRepo>>;

  const userId = 'u1';
  const CONF_PAGE = 'conf-page';
  const CONF_SPACE = 'conf-space';

  beforeEach(async () => {
    favoriteRepo = { getFavoriteIds: jest.fn() };
    pagePermissionRepo = { filterAccessiblePageIds: jest.fn() };
    spaceMemberRepo = { getUserSpaceIds: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        FavoriteService,
        { provide: FavoriteRepo, useValue: favoriteRepo },
        { provide: PagePermissionRepo, useValue: pagePermissionRepo },
        { provide: SpaceMemberRepo, useValue: spaceMemberRepo },
      ],
    }).compile();
    service = module.get(FavoriteService);
  });

  it('a confidential PAGE favorite is filtered out by the PDP primitive', async () => {
    favoriteRepo.getFavoriteIds!.mockResolvedValue({ items: ['a', CONF_PAGE, 'b'] } as any);
    // The PDP denies the confidential page.
    pagePermissionRepo.filterAccessiblePageIds!.mockResolvedValue(['a', 'b']);

    const result: any = await service.getFavoriteIds(userId, 'w1', FavoriteType.PAGE);

    expect(result.items).toEqual(['a', 'b']);
    expect(result.items).not.toContain(CONF_PAGE);
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({ pageIds: ['a', CONF_PAGE, 'b'], userId });
  });

  it('a confidential SPACE favorite is filtered out by the PDP reverse index', async () => {
    favoriteRepo.getFavoriteIds!.mockResolvedValue({ items: ['s-ok', CONF_SPACE] } as any);
    spaceMemberRepo.getUserSpaceIds!.mockResolvedValue(['s-ok']); // PDP omits the confidential space

    const result: any = await service.getFavoriteIds(userId, 'w1', FavoriteType.SPACE);

    expect(result.items).toEqual(['s-ok']);
    expect(result.items).not.toContain(CONF_SPACE);
    expect(spaceMemberRepo.getUserSpaceIds).toHaveBeenCalledWith(userId);
  });
});

describe('Indirect-leakage vectors — §8 coverage matrix (every vector maps to a PDP override)', () => {
  const own = {
    page: new Set(Object.getOwnPropertyNames(PdpPagePermissionRepo.prototype)),
    space: new Set(Object.getOwnPropertyNames(PdpSpaceMemberRepo.prototype)),
    label: new Set(Object.getOwnPropertyNames(PdpLabelRepo.prototype)),
  };
  type Repo = keyof typeof own;
  const isOverridden = (repo: Repo, method: string) => own[repo].has(method);

  // Each §8/§9 row -> the PDP repo primitive its callers funnel through (verified against the caller
  // map). If a primitive stops being overridden, that vector silently falls back to local tables — so
  // this asserts the override still exists.
  const COVERAGE: Array<{ vector: string; repo: Repo; primitive: string }> = [
    { vector: 'search (page)',                       repo: 'page',  primitive: 'filterAccessiblePageIds' },
    { vector: 'search suggestions / mention picker', repo: 'page',  primitive: 'filterAccessiblePageIds' },
    { vector: 'backlinks / related pages',           repo: 'page',  primitive: 'filterAccessiblePageIds' },
    { vector: 'transclusion previews',               repo: 'page',  primitive: 'filterAccessiblePageIds' },
    { vector: 'favorites (page)',                     repo: 'page',  primitive: 'filterAccessiblePageIds' },
    { vector: 'labels',                               repo: 'page',  primitive: 'filterAccessiblePageIds' },
    { vector: 'notifications feed',                   repo: 'page',  primitive: 'filterAccessiblePageIds' },
    { vector: 'exports (pages/mentions/attachments)', repo: 'page',  primitive: 'filterAccessiblePageIds' },
    { vector: 'recent/created/deleted/tree listings', repo: 'page',  primitive: 'filterAccessiblePageIds' },
    { vector: 'sidebar tree (with canEdit)',          repo: 'page',  primitive: 'filterAccessiblePageIdsWithPermissions' },
    { vector: 'page history / revisions',             repo: 'page',  primitive: 'canUserAccessPage' },
    { vector: 'attachments (download / RAG / export)', repo: 'page', primitive: 'canUserAccessPage' },
    // #524: everything that asks "restricted, and can this user view/edit it?" — then falls back to the space role
    // when the answer is "unrestricted". A trashed or unprojected page in a restricted section must not read as that.
    { vector: 'page read/edit (info by id or slug, update, restore, move, move-to-space)', repo: 'page', primitive: 'canUserEditPage' },
    { vector: 'collab websocket connect',              repo: 'page',  primitive: 'canUserEditPage' },
    { vector: 'comment edit/delete, attachment upload, share create', repo: 'page', primitive: 'canUserEditPage' },
    { vector: 'mention/comment/update notifications', repo: 'page',  primitive: 'getUserIdsWithPageAccess' },
    { vector: 'favorites (space)',                     repo: 'space', primitive: 'getUserSpaceIds' },
    { vector: 'digest/verification notifications',     repo: 'space', primitive: 'getUserIdsWithSpaceAccess' },
    { vector: 'CASL / collab space role',              repo: 'space', primitive: 'getUserSpaceRoles' },
    // #615: the native label lists paginate over PDP-viewable pages (upstream scoped them to space membership
    // only, so a label on a restricted page was listed by name). Each gates its windows through
    // page.filterAccessiblePageIds.
    { vector: 'label names (native vocabulary / picker)', repo: 'label', primitive: 'findLabels' },
    { vector: 'pages by label (+ its paging meta)',       repo: 'label', primitive: 'findPagesByLabelId' },
    { vector: 'label usage count (/labels/info)',         repo: 'label', primitive: 'getLabelPageCountForUser' },
  ];

  it.each(COVERAGE)('$vector -> $repo.$primitive is PDP-overridden', ({ repo, primitive }) => {
    expect(isOverridden(repo, primitive)).toBe(true);
  });

  it('documents the full mapping (no silent gaps)', () => {
    const distinct = new Set(COVERAGE.map((c) => `${c.repo}.${c.primitive}`));
    // The whole indirect backbone reduces to these eleven PDP-overridden primitives.
    expect([...distinct].sort()).toEqual([
      'label.findLabels',
      'label.findPagesByLabelId',
      'label.getLabelPageCountForUser',
      'page.canUserAccessPage',
      'page.canUserEditPage',
      'page.filterAccessiblePageIds',
      'page.filterAccessiblePageIdsWithPermissions',
      'page.getUserIdsWithPageAccess',
      'space.getUserIdsWithSpaceAccess',
      'space.getUserSpaceIds',
      'space.getUserSpaceRoles',
    ]);
  });
});

describe('Label-name vector (#615) — a label only on hidden pages never reaches the native label lists', () => {
  // The candidate SQL, the label rounds and upstream shape parity are proven on real Postgres in
  // authz/pdp-label.repo.pg.spec.ts. This pins the vector here: the confidential label is absent from the page AND
  // from every cursor (a cursor is base64 of the row's sort keys: one cut from a hidden row spells its name).
  const CONF = 'layoffs-2027';
  const labels = ['alpha', 'beta', CONF, 'gamma', 'zeta'].map((name) => ({
    id: `id-${name}`,
    name,
    $cursor: Buffer.from(new URLSearchParams({ name, id: `id-${name}` }).toString()).toString('base64url'),
  }));
  const fetchWindow = async (b: { perPage: number; cursor?: string }) => {
    const from = b.cursor ? labels.findIndex((l) => l.$cursor === b.cursor) + 1 : 0;
    const items = labels.slice(from, from + b.perPage);
    return { items, meta: { hasNextPage: from + b.perPage < labels.length } };
  };
  // The PDP finds no viewable page carrying the confidential label.
  const gate = async (rows: CursoredRow<{ id: string; name: string }>[]) => ({
    allowed: new Set(rows.filter((r) => r.name !== CONF).map((r) => r.id)),
    cost: rows.length,
    undecided: new Set<string>(),
  });
  const decoded = (c: string | null) => (c ? Buffer.from(c, 'base64url').toString('utf8') : '');

  it('is absent from every page of the vocabulary and from every cursor', async () => {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await authorizedKeysetPage({
        perPage: 1,
        metaLimit: 1,
        cursor,
        window: 2,
        budget: 100,
        fetchWindow,
        gate,
        onTruncated: jest.fn(),
      });
      names.push(...page.items.map((l) => l.name));
      expect(decoded(page.meta.nextCursor)).not.toContain(CONF);
      expect(decoded(page.meta.prevCursor)).not.toContain(CONF);
      if (!page.meta.hasNextPage) break;
      cursor = page.meta.nextCursor as string;
    }
    expect(names).toEqual(['alpha', 'beta', 'gamma', 'zeta']);
  });

  it('seam #1: DatabaseModule binds all three repo tokens to the mode-selected providers (never the stock classes)', () => {
    // Pins the REAL module (not a hand-built provider list): an upstream bump that brings back the stock
    // `LabelRepo,` (or either authorization repo) in database.module.ts would silently restore the leak in
    // remote mode, while every other spec stays green.
    const providers: unknown[] = Reflect.getMetadata('providers', DatabaseModule);
    const exported: unknown[] = Reflect.getMetadata('exports', DatabaseModule);
    for (const selected of [labelRepoProvider, spaceMemberRepoProvider, pagePermissionRepoProvider]) {
      expect(providers).toContain(selected);
    }
    for (const stock of [LabelRepo, SpaceMemberRepo, PagePermissionRepo]) {
      expect(providers).not.toContain(stock);
      // Still exported by token, so every consumer resolves the mode-selected instance.
      expect(exported).toContain(stock);
    }
    // No second registration of a token anywhere in the providers list (a later entry would win in Nest).
    const tokens = providers.map((p: any) => (p && typeof p === 'object' && 'provide' in p ? p.provide : p));
    for (const stock of [LabelRepo, SpaceMemberRepo, PagePermissionRepo]) {
      expect(tokens.filter((t) => t === stock)).toHaveLength(1);
    }
    expect(PdpLabelRepo.prototype).toBeInstanceOf(LabelRepo);
  });

  it('LabelService keeps the authorized page and its meta (its own post-filter can only narrow)', async () => {
    const authorized = {
      items: [{ id: 'p1' }, { id: 'p2' }],
      meta: { limit: 2, hasNextPage: true, hasPrevPage: false, nextCursor: 'c-p2', prevCursor: null },
    };
    const labelRepo = { findPagesByLabelId: jest.fn().mockResolvedValue(authorized) };
    const pagePermissionRepo = { filterAccessiblePageIds: jest.fn().mockResolvedValue(['p1', 'p2']) };
    const module = await Test.createTestingModule({
      providers: [
        LabelService,
        { provide: LabelRepo, useValue: labelRepo },
        { provide: PagePermissionRepo, useValue: pagePermissionRepo },
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: {} },
      ],
    }).compile();
    const result = await module
      .get(LabelService)
      .findPagesByLabel('l1', 'u1', { pagination: { limit: 2 } as any });
    expect(result).toEqual(authorized);
  });
});

describe('Search is filter-then-retrieve (Phase 5) — PdpSearchService overrides the entry points', () => {
  const searchOwn = new Set(Object.getOwnPropertyNames(PdpSearchService.prototype));

  // Search routes its page post-filter through `page.filterAccessiblePageIds` (rows above), but the
  // upstream SearchService applies LIMIT/OFFSET *before* that gate (retrieve-then-filter). The fix lives
  // in PdpSearchService, bound to the SearchService token in core/search/search.module.ts (seam #5). If
  // an override is dropped, search silently reverts to under-returning truncation — so assert both.
  it.each(['searchPage', 'searchSuggestions'])(
    'PdpSearchService overrides %s',
    (method) => {
      expect(searchOwn.has(method)).toBe(true);
    },
  );

  it('PdpSearchService is a SearchService (the rebind is type-compatible)', () => {
    expect(PdpSearchService.prototype).toBeInstanceOf(SearchService);
  });
});

describe('Anonymous public-content discovery vector (issue #26) — restricted pages never enumerated', () => {
  // The signed-out front-page list is a NEW anonymous surface (not a PDP repo override). Its leakage
  // gate lives in a single SQL filter; the deep matrix is in
  // authz/public-discovery/public-discovery.service.spec.ts. This documents the vector in the leakage
  // suite so it is never implicit: the enumeration must exclude restricted pages and list only
  // owner-opted, discoverable shares. Compiled offline (no DB connection), mirroring the app plugin.
  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool: {} as any }),
    plugins: [new CamelCasePlugin()],
  });
  const sql = new PublicDiscoveryRepo(db as any)
    .buildListQuery('w1')
    .compile()
    .sql.toLowerCase();

  it('excludes any page that is restricted or under a restricted ancestor', () => {
    expect(sql).toContain('with recursive');
    expect(sql).toContain('page_access');
    expect(sql).toContain('not exists');
  });

  it('lists only owner-opted discoverable shares (search_indexing) with sharing enabled', () => {
    expect(sql).toContain('search_indexing');
    expect(sql.split("->> 'disabled'").length - 1).toBe(2);
  });
});
