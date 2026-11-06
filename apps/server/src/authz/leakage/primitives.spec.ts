import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import { PdpSpaceMemberRepo } from '../pdp-space-member.repo';
import { HttpAuthzClient } from '../http-authz.client';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { spyKysely } from '../../service-bridge/kysely-spy.testkit';
import { LIFECYCLE_MAX_DEPTH } from '../../service-bridge/page-lineage';

/**
 * CCC authorization integration test (fork compatibility suite) — the leakage backbone.
 *
 * Every indirect-leakage vector (search, suggestions, backlinks, transclusion, favorites, labels,
 * notifications, exports, previews, history, attachments — architecture §8) funnels through a small
 * set of PDP-backed repo primitives. These tests prove the primitives EXCLUDE a confidential
 * page/space (and its non-member recipients) — so any vector routed through them cannot leak it — and
 * that they FAIL CLOSED when the platform is unreachable: every primitive, point decision or list, throws the
 * retryable 503 (`authzUnavailable`, #696 / #716). A list never answers empty or a partial subset on an outage —
 * upstream reads that as the complete answer ("you have nothing", or a move/duplicate of part of a tree).
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
    tryCheckBulk: jest.fn(async (_s: any, checks: Parameters<typeof decide>[0]) => decide(checks)),
    // #716: the repos call only the null-on-failure `try*` list methods. The fail-closed originals are absent here
    // on purpose, so a repo that went back to one of them fails these healthy cases too.
    tryFilterResources: jest.fn(async (_s: any, _p: string, _rt: string, ids: string[]) =>
      ids.filter((id) => id !== CONF_PAGE),
    ),
    tryLookupResources: jest.fn(async () => ['ok-space-1', 'ok-space-2']), // never CONF_SPACE
    tryFilterSubjects: jest.fn(async (_p: string, _rt: string, rid: string, users: string[]) =>
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

  it('#542: getUserSpaceRoles denies (undefined) a binding without space view, even administer + edit', async () => {
    const noView = {
      tryCheckBulk: jest.fn(async (_s: any, checks: Array<{ permission: string }>) =>
        checks.map((c) => c.permission !== 'view'),
      ),
    };
    const repo = new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, noView as any);
    expect(await repo.getUserSpaceRoles('u1', 'ok-space')).toBeUndefined();
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

  describe('FAIL CLOSED when the platform is unreachable (the try* methods answer null → a 503)', () => {
    // Mirrors HttpAuthzClient: an outage is `null` from every try* method (and empty/false from the fail-closed
    // originals, kept here so a repo that went back to one of them would answer [] and fail). #696: a POINT
    // decision that could not be made is a 503. #716: so is a LIST — never empty, which reads as "you have nothing".
    const down = {
      check: jest.fn(async () => false),
      checkBulk: jest.fn(async (_s: any, checks: any[]) => checks.map(() => false)),
      tryCheckBulk: jest.fn(async () => null), // #492: a failed bulk call is reported as UNKNOWN, not all-false
      filterResources: jest.fn(async () => []),
      lookupResources: jest.fn(async () => []),
      filterSubjects: jest.fn(async () => []),
      tryFilterResources: jest.fn(async () => null),
      tryLookupResources: jest.fn(async () => null),
      tryFilterSubjects: jest.fn(async () => null),
    };
    // #524: an unknown PDP answer denies BEFORE the fork's rows are read, so an outage adds no DB load.
    const downDb = spyKysely(() => {
      throw new Error('the lineage must not be read on a PDP outage');
    });
    const page = new PdpPagePermissionRepo(downDb.db, {} as any, {} as any, down as any);
    const space = new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, down as any);

    it('every primitive is a 503 on outage — a list never answers empty', async () => {
      // #716: the list primitives. Upstream reads an empty answer as the complete one: a blank sidebar, recent, trash,
      // favorites (or a 403 from its space check), labels, shares, suggestions, an export refused as "no accessible
      // pages", and a move-to-space / duplicate that moves or copies the root alone.
      await expect(page.filterAccessiblePageIds({ pageIds: ['a', 'b'], userId: 'u1' })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(page.filterAccessiblePageIdsWithPermissions(['a', 'b'], 'u1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(page.getUserIdsWithPageAccess('p', ['u1', 'u2'])).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(space.getUserIdsWithSpaceAccess(['u1'], 's')).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(space.getUserSpaceIds('u1')).rejects.toBeInstanceOf(ServiceUnavailableException);
      // The fail-closed originals are never consulted (each would answer [] / all-false).
      for (const m of [down.checkBulk, down.filterResources, down.lookupResources, down.filterSubjects]) {
        expect(m).not.toHaveBeenCalled();
      }
      // #696: the point decisions throw a 503 — never `false`/no role (a deny-shaped 403/404), and never an answer
      // upstream could fall back from. #492: in particular never the relaxing `locked=false`.
      await expect(page.canUserAccessPage('u1', 'p')).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(page.canUserEditPage('u1', 'p')).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(space.getUserSpaceRoles('u1', 's')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(downDb.calls).toHaveLength(0);
    });

    it('empty inputs stay a healthy [] with no PDP call (nothing to ask is not an outage)', async () => {
      expect(await page.filterAccessiblePageIds({ pageIds: [], userId: 'u1' })).toEqual([]);
      expect(await page.filterAccessiblePageIdsWithPermissions([], 'u1')).toEqual([]);
      expect(await page.getUserIdsWithPageAccess('p', [])).toEqual([]);
      expect([...(await space.getUserIdsWithSpaceAccess([], 's'))]).toEqual([]);
      expect(down.tryFilterResources).not.toHaveBeenCalled();
      expect(down.tryCheckBulk).not.toHaveBeenCalled();
      expect(down.tryFilterSubjects).not.toHaveBeenCalled();
    });

    it('a healthy empty answer is still [] (a real "none"), distinct from an outage', async () => {
      const none = {
        tryCheckBulk: jest.fn(async (_s: any, checks: any[]) => checks.map(() => false)),
        tryFilterResources: jest.fn(async () => []),
        tryLookupResources: jest.fn(async () => []),
        tryFilterSubjects: jest.fn(async () => []),
      };
      const p = new PdpPagePermissionRepo({} as any, {} as any, {} as any, none as any);
      const sp = new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, none as any);
      expect(await p.filterAccessiblePageIds({ pageIds: ['a'], userId: 'u1' })).toEqual([]);
      expect(await p.filterAccessiblePageIdsWithPermissions(['a'], 'u1')).toEqual([]);
      expect(await p.getUserIdsWithPageAccess('p', ['u1'])).toEqual([]);
      expect([...(await sp.getUserIdsWithSpaceAccess(['u1'], 's'))]).toEqual([]);
      expect(await sp.getUserSpaceIds('u1')).toEqual([]);
    });

    it('sidebar: a failure on the SECOND 128-page chunk is a 503, never the first chunk alone', async () => {
      const ids = Array.from({ length: 129 }, (_, i) => `p${i}`);
      const flaky = {
        tryCheckBulk: jest
          .fn()
          .mockImplementationOnce(async (_s: any, checks: any[]) => checks.map(() => true))
          .mockImplementationOnce(async () => null),
      };
      const p = new PdpPagePermissionRepo({} as any, {} as any, {} as any, flaky as any);
      await expect(p.filterAccessiblePageIdsWithPermissions(ids, 'u1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(flaky.tryCheckBulk).toHaveBeenCalledTimes(2);
      expect(flaky.tryCheckBulk.mock.calls[0][1]).toHaveLength(256);
      expect(flaky.tryCheckBulk.mock.calls[1][1]).toHaveLength(2);
    });

    it('sidebar: a non-true element never reads as view or edit', async () => {
      const odd = { tryCheckBulk: jest.fn(async () => [true, false, false, true]) };
      const p = new PdpPagePermissionRepo({} as any, {} as any, {} as any, odd as any);
      expect(await p.filterAccessiblePageIdsWithPermissions(['a', 'b'], 'u1')).toEqual([{ id: 'a', canEdit: false }]);
    });

    describe('over the REAL HttpAuthzClient: a failure on the second 1000-id chunk is a 503, never a subset', () => {
      // The client chunks filter-resources / filter-subjects at 1000; the repo must see the second chunk's failure.
      const fetchMock = jest.fn();
      const realFetch = global.fetch;
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      let client: HttpAuthzClient;
      beforeEach(() => {
        process.env.PLATFORM_AUTHZ_URL = 'http://platform.test';
        process.env.PLATFORM_AUTHZ_SERVICE_SECRET = 'sekret';
        (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
        fetchMock.mockReset();
        client = new HttpAuthzClient();
      });
      afterAll(() => {
        global.fetch = realFetch;
      });
      const ids = Array.from({ length: 1001 }, (_, i) => `p${i}`);
      const secondChunkFails = (first: unknown) =>
        fetchMock.mockResolvedValueOnce(ok(first)).mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

      it('filterAccessiblePageIds (move-to-space / duplicate / export / lists)', async () => {
        secondChunkFails({ ids: ['p0'] });
        const p = new PdpPagePermissionRepo({} as any, {} as any, {} as any, client);
        await expect(p.filterAccessiblePageIds({ pageIds: ids, userId: 'u1' })).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('getUserIdsWithPageAccess (notification recipients)', async () => {
        secondChunkFails({ subjects: [{ provider: 'docmost', externalId: 'p0' }] });
        const p = new PdpPagePermissionRepo({} as any, {} as any, {} as any, client);
        await expect(p.getUserIdsWithPageAccess('pg', ids)).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('getUserIdsWithSpaceAccess (digest / verification recipients)', async () => {
        secondChunkFails({ subjects: [{ provider: 'docmost', externalId: 'p0' }] });
        const sp = new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, client);
        await expect(sp.getUserIdsWithSpaceAccess(ids, 's')).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('getUserSpaceIds on a failed lookup', async () => {
        fetchMock.mockRejectedValueOnce(new Error('down'));
        const sp = new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, client);
        await expect(sp.getUserSpaceIds('u1')).rejects.toBeInstanceOf(ServiceUnavailableException);
      });

      it('control: both chunks healthy is the union in caller order', async () => {
        fetchMock.mockResolvedValueOnce(ok({ ids: ['p999', 'p0'] })).mockResolvedValueOnce(ok({ ids: ['p1000'] }));
        const p = new PdpPagePermissionRepo({} as any, {} as any, {} as any, client);
        expect(await p.filterAccessiblePageIds({ pageIds: ids, userId: 'u1' })).toEqual(['p0', 'p999', 'p1000']);
      });
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

    it('validateCanEdit, validateCanView and validateCanViewWithPermissions refuse (#696: a retryable 503)', async () => {
      await expect(access.validateCanEdit(page, user)).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(access.validateCanView(page, user)).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(access.validateCanViewWithPermissions(page, user)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('#716 P1: validateCanComment on a FLAPPING PDP — the edit check 503s, the view check answers — is a 503, never a 403', async () => {
      // The brown-out shape: the edit-side call (canUserEditPage) times out, the next call (canUserAccessPage, inside
      // validateCanView) answers. Upstream's bare catch read the 503 as "cannot edit" and fell through to the
      // viewer-comment rule, so an editor in a space with viewer comments off got a deny-shaped 403. A PDP that is
      // simply down would fail validateCanView as well, so only a flapping one reaches the bug.
      const flapping = {
        tryCheckBulk: jest
          .fn()
          .mockImplementationOnce(async () => null)
          .mockImplementation(async (_s: any, checks: any[]) => checks.map(() => true)),
      };
      const spaces = { findById: jest.fn(async () => ({ settings: { comments: { allowViewerComments: false } } })) };
      const flappingAccess = new PageAccessService(
        new PdpPagePermissionRepo({} as any, {} as any, {} as any, flapping as any),
        spaceMember as any,
        spaces as any,
      );
      await expect(flappingAccess.validateCanComment(page, user, 'w1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      // Not vacuous: the 503 came from the FIRST (edit) call; nothing after it ran.
      expect(flapping.tryCheckBulk).toHaveBeenCalledTimes(1);
      expect(flapping.tryCheckBulk.mock.calls[0][1].map((c: any) => c.permission)).toEqual(['view', 'edit', 'locked']);
      expect(spaces.findById).not.toHaveBeenCalled();
    });

    it('#716 P1 control: a genuine edit deny still falls through to the viewer-comment rule', async () => {
      // view only, on a restricted page: canUserEditPage → {locked, canAccess, !canEdit} → validateCanEdit 403s.
      const viewer = {
        tryCheckBulk: jest.fn(async (_s: any, checks: any[]) => checks.map((c: any) => c.permission !== 'edit')),
      };
      const repo = new PdpPagePermissionRepo({} as any, {} as any, {} as any, viewer as any);
      const on = { findById: jest.fn(async () => ({ settings: { comments: { allowViewerComments: true } } })) };
      const off = { findById: jest.fn(async () => ({ settings: { comments: { allowViewerComments: false } } })) };
      await expect(
        new PageAccessService(repo, spaceMember as any, on as any).validateCanComment(page, user, 'w1'),
      ).resolves.toBeUndefined();
      await expect(
        new PageAccessService(repo, spaceMember as any, off as any).validateCanComment(page, user, 'w1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
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
    // A page that is new or re-parented has no #space/#parent edges until the relay projects it (since ADR 0027
    // Release B, #493, trashing KEEPS them). For such a page the PDP answers view=false AND locked=false: `locked` cannot see
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
      expect(spy.calls[0].parameters).toEqual(['c', LIFECYCLE_MAX_DEPTH]);
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
