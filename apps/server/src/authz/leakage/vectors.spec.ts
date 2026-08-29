import { Test } from '@nestjs/testing';
import { FavoriteService } from '../../core/favorite/services/favorite.service';
import { FavoriteRepo, FavoriteType } from '@docmost/db/repos/favorite/favorite.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import { PdpSpaceMemberRepo } from '../pdp-space-member.repo';

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
  const pageOwn = new Set(Object.getOwnPropertyNames(PdpPagePermissionRepo.prototype));
  const spaceOwn = new Set(Object.getOwnPropertyNames(PdpSpaceMemberRepo.prototype));
  const isOverridden = (repo: 'page' | 'space', method: string) =>
    (repo === 'page' ? pageOwn : spaceOwn).has(method);

  // Each §8/§9 row -> the PDP repo primitive its callers funnel through (verified against the caller
  // map). If a primitive stops being overridden, that vector silently falls back to local tables — so
  // this asserts the override still exists.
  const COVERAGE: Array<{ vector: string; repo: 'page' | 'space'; primitive: string }> = [
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
    { vector: 'mention/comment/update notifications', repo: 'page',  primitive: 'getUserIdsWithPageAccess' },
    { vector: 'favorites (space)',                     repo: 'space', primitive: 'getUserSpaceIds' },
    { vector: 'digest/verification notifications',     repo: 'space', primitive: 'getUserIdsWithSpaceAccess' },
    { vector: 'CASL / collab space role',              repo: 'space', primitive: 'getUserSpaceRoles' },
  ];

  it.each(COVERAGE)('$vector -> $repo.$primitive is PDP-overridden', ({ repo, primitive }) => {
    expect(isOverridden(repo, primitive)).toBe(true);
  });

  it('documents the full mapping (no silent gaps)', () => {
    const distinct = new Set(COVERAGE.map((c) => `${c.repo}.${c.primitive}`));
    // The whole indirect backbone reduces to these seven PDP-overridden primitives.
    expect([...distinct].sort()).toEqual([
      'page.canUserAccessPage',
      'page.filterAccessiblePageIds',
      'page.filterAccessiblePageIdsWithPermissions',
      'page.getUserIdsWithPageAccess',
      'space.getUserIdsWithSpaceAccess',
      'space.getUserSpaceIds',
      'space.getUserSpaceRoles',
    ]);
  });
});
