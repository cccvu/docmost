import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
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
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PdpShareRepo } from '../pdp-share.repo';
import { ShareController } from '../../core/share/share.controller';
import { AttachmentController } from '../../core/attachment/attachment.controller';
import { DatabaseModule } from '../../database/database.module';
import {
  labelRepoProvider,
  pagePermissionRepoProvider,
  shareRepoProvider,
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
    share: new Set(Object.getOwnPropertyNames(PdpShareRepo.prototype)),
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
    // Both CASL (SpaceAbilityFactory) and the collab connect derive the space role from getUserSpaceRoles. #542: the
    // role needs space#view (no view → no role → CASL 404 / collab Unauthorized), and admin needs edit + view.
    { vector: 'CASL / collab space role',              repo: 'space', primitive: 'getUserSpaceRoles' },
    // #615: the native label lists paginate over PDP-viewable pages (upstream scoped them to space membership
    // only, so a label on a restricted page was listed by name). Each gates its windows through
    // page.filterAccessiblePageIds.
    { vector: 'label names (native vocabulary / picker)', repo: 'label', primitive: 'findLabels' },
    { vector: 'pages by label (+ its paging meta)',       repo: 'label', primitive: 'findPagesByLabelId' },
    { vector: 'label usage count (/labels/info)',         repo: 'label', primitive: 'getLabelPageCountForUser' },
    // #660: the shares list took its spaces from the local mirror with no page check, so it listed the title of a
    // page restricted after it was shared. Spaces now come from the PDP and each window is gated by page view.
    { vector: 'shares list (POST /api/shares)',            repo: 'share', primitive: 'getShares' },
    // #335: expiry is enforced at READ time by the repo (the sweeper is cleanup only). Every public share read
    // resolves through one of these two: by id/key directly, or via getShareForPage's re-read of the resolved share.
    { vector: 'public share by id/key (/shares/info, /tree, transclusion host, share-search) — expiry', repo: 'share', primitive: 'findById' },
    { vector: 'getShareForPage re-read (page-info, SEO, /for-page, transclusion sources, files/public) — expiry', repo: 'share', primitive: 'findById' },
    { vector: 'share create reuses the page\'s existing share — never an expired one', repo: 'share', primitive: 'findByPageId' },
  ];

  it.each(COVERAGE)('$vector -> $repo.$primitive is PDP-overridden', ({ repo, primitive }) => {
    expect(isOverridden(repo, primitive)).toBe(true);
  });

  it('documents the full mapping (no silent gaps)', () => {
    const distinct = new Set(COVERAGE.map((c) => `${c.repo}.${c.primitive}`));
    // The whole indirect backbone reduces to these fourteen PDP-overridden primitives.
    expect([...distinct].sort()).toEqual([
      'label.findLabels',
      'label.findPagesByLabelId',
      'label.getLabelPageCountForUser',
      'page.canUserAccessPage',
      'page.canUserEditPage',
      'page.filterAccessiblePageIds',
      'page.filterAccessiblePageIdsWithPermissions',
      'page.getUserIdsWithPageAccess',
      'share.findById',
      'share.findByPageId',
      'share.getShares',
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

  it('seam #1: DatabaseModule binds all four repo tokens to the mode-selected providers (never the stock classes)', () => {
    // Pins the REAL module (not a hand-built provider list): an upstream bump that brings back the stock
    // `LabelRepo,` / `ShareRepo,` (or either authorization repo) in database.module.ts would silently restore the
    // leak (and, for shares, serve expired public shares) in remote mode, while every other spec stays green.
    const providers: unknown[] = Reflect.getMetadata('providers', DatabaseModule);
    const exported: unknown[] = Reflect.getMetadata('exports', DatabaseModule);
    for (const selected of [labelRepoProvider, spaceMemberRepoProvider, pagePermissionRepoProvider, shareRepoProvider]) {
      expect(providers).toContain(selected);
    }
    for (const stock of [LabelRepo, SpaceMemberRepo, PagePermissionRepo, ShareRepo]) {
      expect(providers).not.toContain(stock);
      // Still exported by token, so every consumer resolves the mode-selected instance.
      expect(exported).toContain(stock);
    }
    // No second registration of a token anywhere in the providers list (a later entry would win in Nest).
    const tokens = providers.map((p: any) => (p && typeof p === 'object' && 'provide' in p ? p.provide : p));
    for (const stock of [LabelRepo, SpaceMemberRepo, PagePermissionRepo, ShareRepo]) {
      expect(tokens.filter((t) => t === stock)).toHaveLength(1);
    }
    expect(PdpLabelRepo.prototype).toBeInstanceOf(LabelRepo);
    expect(PdpShareRepo.prototype).toBeInstanceOf(ShareRepo);
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
  const sql = new PublicDiscoveryRepo(db as any, 'remote')
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

  it('never lists a share in an archived space (#660) or an expired share (#335, remote)', () => {
    expect(sql).toContain('"spaces"."deleted_at" is null');
    expect(sql).toContain('from ccc_share_expiry cse where cse.share_id = shares.id');
  });
});

/**
 * Anonymous public-share vectors (#660, #334, #335). Every public share read is decided by one choke point —
 * `ShareService.getShareForPage` (sharing allowed incl. not archived, the REQUESTED page unrestricted, the share
 * re-read through `ShareRepo.findById`, the remote repo's expiry veto) — or reads the share by id/key through the
 * same repo token plus its own workspace/restriction checks. The controller-level gates are pinned here with real
 * controllers and stub collaborators; the predicates themselves, and the paths that only funnel through the choke
 * point (SEO, page-info, /for-page, transclusion), are proven over real rows in the pg specs named below — this
 * suite fails if one of those proofs is removed, so no vector is implicit.
 */
describe('Anonymous public-share vectors (#660/#334/#335) — every public read is "public NOW"', () => {
  const WS = 'ws-1';
  const SHARE = { id: 'sh-1', key: 'k1', pageId: 'p-1', spaceId: 'sp-1', workspaceId: WS };

  describe('POST /shares/info — workspace match + restricted-ancestor check, one 404 for every deny', () => {
    const make = (over: { share?: object | undefined; restricted?: boolean; sharingAllowed?: boolean } = {}) => {
      const shareRepo = { findById: jest.fn().mockResolvedValue('share' in over ? over.share : SHARE) };
      const pagePermissionRepo = { hasRestrictedAncestor: jest.fn().mockResolvedValue(over.restricted ?? false) };
      const shareService = { isSharingAllowed: jest.fn().mockResolvedValue(over.sharingAllowed ?? true) };
      const controller = new ShareController(
        shareService as any,
        shareRepo as any,
        {} as any,
        pagePermissionRepo as any,
        {} as any,
        {} as any,
        {} as any,
      );
      return { controller, pagePermissionRepo };
    };
    const info = (c: ShareController, ws = WS) => c.getShare({ shareId: SHARE.id } as any, { id: ws } as any);

    it('control: a live, unrestricted share in this workspace is answered', async () => {
      await expect(info(make().controller)).resolves.toBe(SHARE);
    });

    it.each([
      ['unknown (or expired: the repo veto)', { share: undefined }, WS],
      ['another workspace', {}, 'ws-other'],
      ['a (since-)restricted shared page', { restricted: true }, WS],
      ['sharing disabled or the space archived', { sharingAllowed: false }, WS],
    ])('%s → the same "Share not found"', async (_n, over, ws) => {
      const err = await info(make(over).controller, ws).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe('Share not found');
    });

    it('asks about the SHARED page (the share root), not the request', async () => {
      const { controller, pagePermissionRepo } = make();
      await info(controller);
      expect(pagePermissionRepo.hasRestrictedAncestor).toHaveBeenCalledWith(SHARE.pageId);
    });
  });

  describe('GET /files/public — the token alone never serves: the page must be public at use time (#334)', () => {
    const make = (publicNow: boolean) => {
      const tokenService = {
        verifyJwt: jest.fn().mockResolvedValue({ attachmentId: ATT, pageId: 'p-1', workspaceId: WS }),
      };
      const attachmentRepo = {
        findById: jest.fn().mockResolvedValue({ id: ATT, pageId: 'p-1', spaceId: 'sp-1', workspaceId: WS }),
      };
      const shareService = { getShareForPage: jest.fn().mockResolvedValue(publicNow ? SHARE : undefined) };
      const controller = new AttachmentController(
        {} as any, {} as any, {} as any, {} as any, {} as any,
        attachmentRepo as any, {} as any, tokenService as any, {} as any, {} as any,
        shareService as any,
      );
      const send = jest.spyOn(controller as any, 'sendFileResponse').mockResolvedValue('sent');
      return { controller, shareService, send };
    };
    const ATT = '0b9e9d1c-7d3e-4b0a-9b39-6f3b2a1d4c5e';
    const get = (c: AttachmentController) => c.getPublicFile({} as any, {} as any, { id: WS } as any, ATT, 'a.png', 'jwt');

    it('control: a page public now is served, uncacheable by shared caches (private, no-cache)', async () => {
      const { controller, shareService, send } = make(true);
      await expect(get(controller)).resolves.toBe('sent');
      expect(shareService.getShareForPage).toHaveBeenCalledWith('p-1', WS);
      expect(send).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'private, no-cache');
    });

    it('a valid token for a page no longer public (unshared/restricted/trashed/archived/expired) → 404, nothing sent', async () => {
      const { controller, send } = make(false);
      await expect(get(controller)).rejects.toBeInstanceOf(NotFoundException);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('POST /search/share-search (remote) — sharing allowed (incl. not archived) before any search', () => {
    const make = (o: { share?: object | undefined; allowed?: boolean; noGate?: boolean }) => {
      const shareRepo = { findById: jest.fn().mockResolvedValue('share' in o ? o.share : SHARE) };
      const gate = { isSharingAllowed: jest.fn().mockResolvedValue(o.allowed ?? true) };
      const service = new PdpSearchService(
        {} as any, {} as any, shareRepo as any, {} as any, {} as any, undefined,
        o.noGate ? undefined : (gate as any),
      );
      const upstream = jest.spyOn(SearchService.prototype, 'searchPage').mockResolvedValue({ items: ['hit'] } as any);
      return { service, gate, upstream };
    };
    const search = (svc: PdpSearchService) =>
      svc.searchPage({ query: 'roadmap', shareId: SHARE.id } as any, { workspaceId: WS } as any);
    afterEach(() => jest.restoreAllMocks());

    it('control: a public share delegates to the upstream share search', async () => {
      const { service, gate, upstream } = make({});
      expect((await search(service)).items).toEqual(['hit']);
      expect(gate.isSharingAllowed).toHaveBeenCalledWith(WS, SHARE.spaceId);
      expect(upstream).toHaveBeenCalled();
    });

    it.each([
      ['sharing disabled or the space archived', { allowed: false }],
      ['an unknown or expired share (the repo veto)', { share: undefined }],
      ['the gate is missing (fail closed)', { noGate: true }],
    ])('%s → empty, upstream never runs', async (_n, o) => {
      const { service, upstream } = make(o);
      expect(await search(service)).toEqual({ items: [] });
      expect(upstream).not.toHaveBeenCalled();
    });
  });

  // The predicates and the funnel-only consumers, proven on real rows (with a "stock would have leaked" control).
  const PROOFS: Array<{ vector: string; spec: string; title: string }> = [
    { vector: 'getShareForPage: restricted (incl. by slug), moved, disabled, archived, trashed, foreign ws', spec: 'share-lifecycle/public-share.pg.spec.ts', title: 'denies $name' },
    { vector: 'SEO og:title of a since-restricted page', spec: 'share-lifecycle/public-share.pg.spec.ts', title: 'SEO: a shared page gets og:title (control) — a since-restricted root does not leak its title' },
    { vector: 'archived space: isSharingAllowed', spec: 'share-lifecycle/public-share.pg.spec.ts', title: 'isSharingAllowed: an archived space is never public (control: the same space un-archived is)' },
    { vector: 'archived space: /info and /tree', spec: 'share-lifecycle/public-share.pg.spec.ts', title: '/info and /tree: an archived space 404s (control: un-archived it answers)' },
    { vector: 'files/public: an outstanding token after unshare/restrict/trash/archive/disable/move', spec: 'share-lifecycle/public-share.pg.spec.ts', title: '%s → the SAME outstanding token 404s at once' },
    { vector: 'expiry on every public path at read time, no sweeper', spec: 'share-lifecycle/public-share.pg.spec.ts', title: 'one expired share denies every public path at once, while its row is still in the table' },
    { vector: 'expiry: the repo veto fails closed', spec: 'pdp-share.repo.pg.spec.ts', title: 'fails CLOSED: an error evaluating expiry throws — never returns the share' },
    { vector: 'shares list: PDP deny before pagination', spec: 'pdp-share.repo.pg.spec.ts', title: 'a PDP deny is filtered BEFORE pagination: full pages, and meta/cursors only from authorized rows' },
    { vector: 'discovery: expired share never listed', spec: 'share-lifecycle/share-lifecycle.pg.spec.ts', title: 'lists live and "Never" shares, never an expired one (default or explicit); no sweeper involved' },
  ];
  it.each(PROOFS)('$vector — proven in $spec', ({ spec, title }) => {
    expect(readFileSync(join(__dirname, '..', spec), 'utf8')).toContain(`'${title}'`);
  });
});
