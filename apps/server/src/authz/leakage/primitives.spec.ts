import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import { PdpSpaceMemberRepo } from '../pdp-space-member.repo';
import { ForbiddenException } from '@nestjs/common';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { spyKysely } from '../../service-bridge/kysely-spy.testkit';

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

  const decide = (checks: Array<{ permission: string; resourceType: string; resourceId: string }>) =>
    checks.map((c) => {
      if (c.permission === 'locked') return c.resourceId === LOCKED_PAGE; // only LOCKED_PAGE is restricted
      if (denies(c.resourceType, c.resourceId)) return false;
      if (c.permission === 'edit' && c.resourceId === READONLY_PAGE) return false;
      return true;
    });

  const authz = {
    check: jest.fn(async (_s: any, _p: string, rt: string, rid: string) => !denies(rt, rid)),
    checkBulk: jest.fn(async (_s: any, checks: Parameters<typeof decide>[0]) => decide(checks)),
    tryCheckBulk: jest.fn(async (_s: any, checks: Parameters<typeof decide>[0]) => decide(checks)),
    filterResources: jest.fn(async (_s: any, _p: string, _rt: string, ids: string[]) =>
      ids.filter((id) => id !== CONF_PAGE),
    ),
    lookupResources: jest.fn(async () => ['ok-space-1', 'ok-space-2']), // never CONF_SPACE
    filterSubjects: jest.fn(async (_p: string, _rt: string, rid: string, users: string[]) =>
      rid === CONF_PAGE || rid === CONF_SPACE ? [] : users.filter((u) => u !== BANNED_USER),
    ),
  };

  // #524: the page repo reads the fork's own rows (the restriction lineage) whenever the PDP neither shows a page
  // nor reports it locked. Every page here is a LIVE root with no restriction, so that read never changes a decision.
  const pageDb = spyKysely((q) => [{ id: q.parameters[0], parent_page_id: null, depth: 0, restricted: false }]);
  const pageRepo = new PdpPagePermissionRepo(pageDb.db, {} as any, {} as any, authz as any);
  const spaceRepo = new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, authz as any);

  beforeEach(() => {
    jest.clearAllMocks();
    pageDb.calls.length = 0;
  });

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
    // The PDP places no restriction on it and its own rows show none either (#524), so this passes through:
    // upstream then answers from the space role, which comes from the PDP too (PdpSpaceMemberRepo).
    expect(await pageRepo.canUserEditPage('u1', CONF_PAGE)).toEqual({
      hasAnyRestriction: false,
      canAccess: false,
      canEdit: false,
    });
    expect(pageDb.calls).toHaveLength(1);
  });

  it('canUserEditPage reports hasAnyRestriction=true for a restricted (locked) page', async () => {
    // A restricted page the user CAN view+edit via a local grant: upstream then trusts the PDP
    // decision instead of falling back to space CASL (closes the restricted-page edit fail-open).
    expect(await pageRepo.canUserEditPage('u1', LOCKED_PAGE)).toEqual({
      hasAnyRestriction: true,
      canAccess: true,
      canEdit: true,
    });
    // The fork's rows are read only when the PDP neither shows the page nor reports it locked (#524).
    expect(pageDb.calls).toHaveLength(0);
  });

  describe('FAIL CLOSED when the platform is unreachable (client returns empty/false)', () => {
    // Mirrors HttpAuthzClient's fail-closed contract: outage -> deny everything.
    const down = {
      check: jest.fn(async () => false),
      checkBulk: jest.fn(async (_s: any, checks: any[]) => checks.map(() => false)),
      tryCheckBulk: jest.fn(async () => null), // #492: a failed bulk call is reported as UNKNOWN, not all-false
      filterResources: jest.fn(async () => []),
      lookupResources: jest.fn(async () => []),
      filterSubjects: jest.fn(async () => []),
    };
    // #524: an unknown PDP answer denies BEFORE the fork's rows are read, so an outage adds no DB load.
    const downDb = spyKysely(() => {
      throw new Error('the lineage must not be read on a PDP outage');
    });
    const page = new PdpPagePermissionRepo(downDb.db, {} as any, {} as any, down as any);
    const space = new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, down as any);

    it('every primitive denies on outage', async () => {
      expect(await page.filterAccessiblePageIds({ pageIds: ['a', 'b'], userId: 'u1' })).toEqual([]);
      expect(await page.filterAccessiblePageIdsWithPermissions(['a', 'b'], 'u1')).toEqual([]);
      expect(await page.getUserIdsWithPageAccess('p', ['u1', 'u2'])).toEqual([]);
      expect(await page.canUserAccessPage('u1', 'p')).toBe(false);
      // #492: an unknown `locked` must read as RESTRICTED (never the relaxing `false`), so upstream trusts the
      // (deny) page decision instead of falling back to a space role fetched by a separate, possibly-healthy call.
      expect(await page.canUserEditPage('u1', 'p')).toEqual({
        hasAnyRestriction: true,
        canAccess: false,
        canEdit: false,
      });
      expect(downDb.calls).toHaveLength(0);
      expect([...(await space.getUserIdsWithSpaceAccess(['u1'], 's'))]).toEqual([]);
      expect(await space.getUserSpaceIds('u1')).toEqual([]);
      expect(await space.getUserSpaceRoles('u1', 's')).toBeUndefined();
    });
  });
  describe('#492 — a failed page check denies even when the space role (a separate call) allows', () => {
    // The exact fail-open precondition: PageAccessService takes the space role from ONE call (SpaceAbilityFactory →
    // PdpSpaceMemberRepo) and `locked` from ANOTHER (canUserEditPage). If only the page call fails, a restricted
    // page must still be denied — it must not fall through to the (healthy) space role.
    const spaceMember = { createForUser: jest.fn(async () => ({ can: () => true, cannot: () => false })) };
    const pageDown = {
      check: jest.fn(async () => false),
      checkBulk: jest.fn(async (_s: any, checks: any[]) => checks.map(() => false)),
      tryCheckBulk: jest.fn(async () => null),
    };
    const access = new PageAccessService(
      new PdpPagePermissionRepo({} as any, {} as any, {} as any, pageDown as any),
      spaceMember as any,
      {} as any,
    );
    const page = { id: 'restricted-page', spaceId: 's1' } as any;
    const user = { id: 'u1' } as any;

    it('validateCanEdit and validateCanViewWithPermissions deny', async () => {
      await expect(access.validateCanEdit(page, user)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(access.validateCanViewWithPermissions(page, user)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('control: the pre-fix all-false reading WOULD have fallen through to the space role (the test is not vacuous)', async () => {
      const legacy = new PageAccessService(
        { canUserEditPage: async () => ({ hasAnyRestriction: false, canAccess: false, canEdit: false }) } as any,
        spaceMember as any,
        {} as any,
      );
      await expect(legacy.validateCanEdit(page, user)).resolves.toEqual({ hasRestriction: false });
    });
  });

  describe('#524 — a page the PDP has not placed denies when its own rows show a restricted section', () => {
    // Trashing a page reaps its #space and #parent edges, and a page that is new, restored or re-parented has none
    // until the relay projects it. For such a page the PDP answers view=false AND locked=false: `locked` cannot see
    // a restriction the page only INHERITS through a missing #parent. Upstream reads locked=false as "unrestricted"
    // and falls back to the space role — so every space member could read the page and every writer edit, restore
    // or move it. The repo now asks the fork's own rows before that fallback is allowed.
    const spaceWriter = { createForUser: jest.fn(async () => ({ can: () => true, cannot: () => false })) };
    const unplaced = { tryCheckBulk: jest.fn(async (_s: any, checks: any[]) => checks.map(() => false)) };
    // One row of the lineage walk as the query returns it (snake_case; the CamelCasePlugin maps it).
    const row = (id: string, parent: string | null, depth: number, restricted = false) => ({
      id,
      parent_page_id: parent,
      depth,
      restricted,
    });
    const setup = (respond: () => unknown[], pdp: any = unplaced) => {
      const spy = spyKysely(respond);
      const repo = new PdpPagePermissionRepo(spy.db, {} as any, {} as any, pdp);
      return { spy, repo, access: new PageAccessService(repo, spaceWriter as any, {} as any) };
    };
    const page = { id: 'c', spaceId: 's1' } as any;
    const user = { id: 'u1' } as any;
    const DENY = { hasAnyRestriction: true, canAccess: false, canEdit: false };

    // Trashed or live makes no difference: a restored or new page is unplaced until projection too, and a writer
    // can make one on demand by trashing and restoring an open ancestor of a restricted section.
    it.each([
      ['inherits from a LIVE restricted parent (the #524 repro)', [row('c', 'r', 0), row('r', null, 1, true)]],
      ['sits under a TRASHED restricted ancestor', [row('c', 't', 0), row('t', 'r', 1), row('r', null, 2, true)]],
      ['is restricted itself but not projected yet', [row('c', null, 0, true)]],
      ['has a walk that stopped early (a cycle, the depth bound, an unreadable parent)', [row('c', 'gone', 0)]],
      ['has no row (it vanished after the caller loaded it)', []],
    ])('a page that %s is restricted with no access, and PageAccessService denies', async (_name, rows) => {
      const { repo, access } = setup(() => rows);
      await expect(repo.canUserEditPage('u1', 'c')).resolves.toEqual(DENY);
      // validateCanEdit gates update, conditional-update, restore, move, move-to-space, uploads, comment edits and
      // share create; validateCanViewWithPermissions gates /pages/info (by id or slug). The collab connect refuses
      // the same shape (hasAnyRestriction && !canAccess).
      await expect(access.validateCanEdit(page, user)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(access.validateCanViewWithPermissions(page, user)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a failed lineage read denies (fail closed, like #492)', async () => {
      const { repo } = setup(() => {
        throw new Error('connection terminated');
      });
      await expect(repo.canUserEditPage('u1', 'c')).resolves.toEqual(DENY);
    });

    it('control: an unrestricted lineage passes through to upstream (the /v1 restore and its read-back rely on it)', async () => {
      const { repo, access } = setup(() => [row('c', 'p', 0), row('p', null, 1)]);
      await expect(repo.canUserEditPage('u1', 'c')).resolves.toEqual({
        hasAnyRestriction: false,
        canAccess: false,
        canEdit: false,
      });
      await expect(access.validateCanEdit(page, user)).resolves.toEqual({ hasRestriction: false });
      await expect(access.validateCanViewWithPermissions(page, user)).resolves.toEqual({
        canEdit: true,
        hasRestriction: false,
      });
    });

    it('control: a PDP answer that shows or locks the page is trusted as-is, without reading the fork', async () => {
      const answering = (answer: boolean[]) => ({ tryCheckBulk: jest.fn(async () => answer) });
      const shown = setup(() => [row('c', 'r', 0), row('r', null, 1, true)], answering([true, true, false]));
      await expect(shown.repo.canUserEditPage('u1', 'c')).resolves.toEqual({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: true,
      });
      const locked = setup(() => [], answering([false, false, true]));
      await expect(locked.repo.canUserEditPage('u1', 'c')).resolves.toEqual(DENY);
      expect(shown.spy.calls).toHaveLength(0);
      expect(locked.spy.calls).toHaveLength(0);
    });

    it('reads the checks by position — view, edit, locked — so a reorder cannot reopen #492/#524', async () => {
      const { repo } = setup(() => [row('c', null, 0)]);
      await repo.canUserEditPage('u1', 'c');
      expect(unplaced.tryCheckBulk.mock.calls[0][1].map((c: any) => c.permission)).toEqual(['view', 'edit', 'locked']);
    });

    it('walks with one bounded, cycle-safe query scoped by the page\'s own workspace', async () => {
      const { repo, spy } = setup(() => [row('c', null, 0)]);
      await repo.canUserEditPage('u1', 'c');
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0].sql).toContain('with recursive');
      expect(spy.calls[0].sql).toContain('not (q.id = any(a.path))');
      expect(spy.calls[0].sql).toContain('q.workspace_id = a.workspace_id');
      expect(spy.calls[0].parameters).toEqual(['c', 256]);
    });

    it('control: the pre-fix pass-through WOULD have let a space writer in (the test is not vacuous)', async () => {
      const legacy = new PageAccessService(
        { canUserEditPage: async () => ({ hasAnyRestriction: false, canAccess: false, canEdit: false }) } as any,
        spaceWriter as any,
        {} as any,
      );
      await expect(legacy.validateCanEdit(page, user)).resolves.toEqual({ hasRestriction: false });
      await expect(legacy.validateCanViewWithPermissions(page, user)).resolves.toEqual({
        canEdit: true,
        hasRestriction: false,
      });
    });
  });
});
