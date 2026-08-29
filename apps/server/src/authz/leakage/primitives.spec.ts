import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import { PdpSpaceMemberRepo } from '../pdp-space-member.repo';

/**
 * CCC authorization integration test (fork compatibility suite) — the leakage backbone.
 *
 * Every indirect-leakage vector (search, suggestions, backlinks, transclusion, favorites, labels,
 * notifications, exports, previews, history, attachments — architecture §8) funnels through a small
 * set of PDP-backed repo primitives. These tests prove the primitives EXCLUDE a confidential
 * page/space (and its non-member recipients) — so any vector routed through them cannot leak it — and
 * that they FAIL CLOSED when the platform is unreachable (the client returns empty/false).
 */
describe('PDP repo primitives — deny propagation (leakage backbone)', () => {
  const CONF_PAGE = 'conf-page';
  const CONF_SPACE = 'conf-space';
  const READONLY_PAGE = 'read-only-page';
  const LOCKED_PAGE = 'locked-page';
  const BANNED_USER = 'banned-user';

  // A stub platform client modelling: the confidential page/space is denied to everyone; a
  // read-only page grants view but not edit; LOCKED_PAGE is restricted (locked=true) but viewable;
  // the banned user is not a recipient anywhere.
  const denies = (rt: string, rid: string) =>
    (rt === 'page' && rid === CONF_PAGE) || (rt === 'space' && rid === CONF_SPACE);

  const authz = {
    check: jest.fn(async (_s: any, _p: string, rt: string, rid: string) => !denies(rt, rid)),
    checkBulk: jest.fn(async (_s: any, checks: Array<{ permission: string; resourceType: string; resourceId: string }>) =>
      checks.map((c) => {
        if (c.permission === 'locked') return c.resourceId === LOCKED_PAGE; // only LOCKED_PAGE is restricted
        if (denies(c.resourceType, c.resourceId)) return false;
        if (c.permission === 'edit' && c.resourceId === READONLY_PAGE) return false;
        return true;
      }),
    ),
    filterResources: jest.fn(async (_s: any, _p: string, _rt: string, ids: string[]) =>
      ids.filter((id) => id !== CONF_PAGE),
    ),
    lookupResources: jest.fn(async () => ['ok-space-1', 'ok-space-2']), // never CONF_SPACE
    filterSubjects: jest.fn(async (_p: string, _rt: string, rid: string, users: string[]) =>
      rid === CONF_PAGE || rid === CONF_SPACE ? [] : users.filter((u) => u !== BANNED_USER),
    ),
  };

  const pageRepo = new PdpPagePermissionRepo({} as any, {} as any, {} as any, authz as any);
  const spaceRepo = new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, authz as any);

  beforeEach(() => jest.clearAllMocks());

  it('filterAccessiblePageIds drops the confidential page (search/labels/backlinks/transclusion/exports/notifications feed)', async () => {
    const out = await pageRepo.filterAccessiblePageIds({ pageIds: ['a', CONF_PAGE, 'b'], userId: 'u1' });
    expect(out).toEqual(['a', 'b']);
    expect(out).not.toContain(CONF_PAGE);
  });

  it('filterAccessiblePageIdsWithPermissions drops the confidential page and reports canEdit (sidebar)', async () => {
    const out = await pageRepo.filterAccessiblePageIdsWithPermissions(['a', CONF_PAGE, READONLY_PAGE], 'u1');
    expect(out).toEqual([
      { id: 'a', canEdit: true },
      { id: READONLY_PAGE, canEdit: false },
    ]);
    expect(out.map((p) => p.id)).not.toContain(CONF_PAGE);
  });

  it('getUserIdsWithPageAccess excludes non-viewers; empty for a confidential page (mention/comment/update notifications)', async () => {
    expect(await pageRepo.getUserIdsWithPageAccess('ok-page', ['u1', BANNED_USER, 'u2'])).toEqual(['u1', 'u2']);
    expect(await pageRepo.getUserIdsWithPageAccess(CONF_PAGE, ['u1', 'u2'])).toEqual([]);
  });

  it('getUserIdsWithSpaceAccess returns a Set excluding non-members; empty for a confidential space (digest/verification)', async () => {
    const ok = await spaceRepo.getUserIdsWithSpaceAccess(['u1', BANNED_USER, 'u2'], 'ok-space');
    expect([...ok].sort()).toEqual(['u1', 'u2']);
    const conf = await spaceRepo.getUserIdsWithSpaceAccess(['u1', 'u2'], CONF_SPACE);
    expect(conf.size).toBe(0);
  });

  it('getUserSpaceIds returns only PDP-authorized spaces (favorites/watchers/ws-gateway/search pre-filter)', async () => {
    const out = await spaceRepo.getUserSpaceIds('u1');
    expect(out).toEqual(['ok-space-1', 'ok-space-2']);
    expect(out).not.toContain(CONF_SPACE);
  });

  it('getUserSpaceRoles denies (undefined) for a confidential space; grants for an open one', async () => {
    expect(await spaceRepo.getUserSpaceRoles('u1', CONF_SPACE)).toBeUndefined();
    expect(await spaceRepo.getUserSpaceRoles('u1', 'ok-space')).toEqual([{ userId: 'u1', role: 'admin' }]);
  });

  it('canUserAccessPage / canUserEditPage deny the confidential page', async () => {
    expect(await pageRepo.canUserAccessPage('u1', CONF_PAGE)).toBe(false);
    expect(await pageRepo.canUserEditPage('u1', CONF_PAGE)).toEqual({
      hasAnyRestriction: false,
      canAccess: false,
      canEdit: false,
    });
  });

  it('canUserEditPage reports hasAnyRestriction=true for a restricted (locked) page', async () => {
    // A restricted page the user CAN view+edit via a local grant: upstream then trusts the PDP
    // decision instead of falling back to space CASL (closes the restricted-page edit fail-open).
    expect(await pageRepo.canUserEditPage('u1', LOCKED_PAGE)).toEqual({
      hasAnyRestriction: true,
      canAccess: true,
      canEdit: true,
    });
  });

  describe('FAIL CLOSED when the platform is unreachable (client returns empty/false)', () => {
    // Mirrors PlatformAuthzClient's fail-closed contract: outage -> deny everything.
    const down = {
      check: jest.fn(async () => false),
      checkBulk: jest.fn(async (_s: any, checks: any[]) => checks.map(() => false)),
      filterResources: jest.fn(async () => []),
      lookupResources: jest.fn(async () => []),
      filterSubjects: jest.fn(async () => []),
    };
    const page = new PdpPagePermissionRepo({} as any, {} as any, {} as any, down as any);
    const space = new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, down as any);

    it('every primitive denies on outage', async () => {
      expect(await page.filterAccessiblePageIds({ pageIds: ['a', 'b'], userId: 'u1' })).toEqual([]);
      expect(await page.filterAccessiblePageIdsWithPermissions(['a', 'b'], 'u1')).toEqual([]);
      expect(await page.getUserIdsWithPageAccess('p', ['u1', 'u2'])).toEqual([]);
      expect(await page.canUserAccessPage('u1', 'p')).toBe(false);
      expect([...(await space.getUserIdsWithSpaceAccess(['u1'], 's'))]).toEqual([]);
      expect(await space.getUserSpaceIds('u1')).toEqual([]);
      expect(await space.getUserSpaceRoles('u1', 's')).toBeUndefined();
    });
  });
});
