import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PageRestrictionService } from './page-restriction.service';
import { PageRestrictionController } from './page-restriction.controller';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AddPagePermissionDto,
  MAX_PAGE_GRANTEES,
  RemovePagePermissionDto,
  RemoveRestrictionDto,
  RestrictPageDto,
  UpdatePagePermissionDto,
} from './dto';
import { User } from '@docmost/db/types/entity.types';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';

/**
 * CCC authorization integration test (fork compatibility suite) — the page-restriction WRITE surface.
 *
 * INTENDED behavior (page-restriction.service.ts doc-comment + architecture "authorization is
 * server-side and deny-by-default"): managing a page's restriction / grants is gated to a **space
 * admin** — the real CASL rule is `Manage` on space `Settings`, which ONLY a space admin holds
 * (space-ability.factory: writer/reader get `Read` Settings, never `Manage`). A plain reader OR a
 * plain writer must be DENIED (Forbidden). DTOs (class-validator) must reject malformed input
 * (non-uuid ids, unknown permission role) so no bad tuple reaches the outbox → SpiceDB.
 *
 * These are pure unit specs (no DB, no containers) — the CASL gate is exercised with the REAL
 * SpaceAbilityFactory over a mocked SpaceMemberRepo (so the actual role→ability mapping is under test),
 * the repos are jest mocks. Mirrors the direct-construction style of authz/search/pdp-search.service.spec.ts.
 *
 * GitHub Task #16 (test-suite from intended behavior).
 */

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const WS_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const READER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WRITER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TARGET_USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TARGET_GROUP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ACCESS_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const userOf = (id: string) => ({ id }) as unknown as User;

type Role = 'admin' | 'writer' | 'reader' | undefined;

/**
 * Build a service whose CASL gate uses the REAL SpaceAbilityFactory (role→ability under test) over a
 * mocked SpaceMemberRepo, with the page repo and page-permission repo as jest mocks. `accessSeq` feeds
 * successive `findPageAccessByPageId` returns so a test can model "not yet restricted" vs "restricted".
 */
function makeService(opts: {
  role?: Role;
  page?: { id: string; spaceId: string; workspaceId: string } | undefined;
  accessSeq?: (undefined | { id: string })[];
  /** The grant row `updatePermission` locks (`select … from page_permissions … for update`); none by default. */
  grant?: { id: string };
  /** AUTHZ_MODE (default `native`, where restrict keeps upstream's writer self-grant). */
  mode?: 'native' | 'remote';
  /** What `tryCheckBulk` answers (null = the PDP failed); all-true by default. */
  pdp?: boolean[] | null;
  /** Whether the actor is a member of the groups the A1 probe asks about. */
  inGroup?: boolean;
  /** Whether the page has a restricted ancestor (A2). */
  restrictedAncestor?: boolean;
  /** Whether a direct child of the page has no page_access row (A3). */
  darkChild?: boolean;
  /** The native repo's page-edit answer (A3 in native mode). */
  nativeEdit?: { hasAnyRestriction: boolean; canAccess: boolean; canEdit: boolean };
}) {
  const page =
    opts.page === undefined && !('page' in opts)
      ? { id: PAGE_ID, spaceId: SPACE_ID, workspaceId: WS_ID }
      : opts.page === undefined
        ? undefined
        : opts.page;

  const getUserSpaceRoles = jest.fn(async () =>
    opts.role ? [{ userId: 'x', role: opts.role }] : [],
  );
  const spaceAbility = new SpaceAbilityFactory({ getUserSpaceRoles } as any);

  const findById = jest.fn(async () => page as any);

  const seq = opts.accessSeq;
  let calls = 0;
  const findPageAccessByPageId = jest.fn(async () => {
    if (!seq) return undefined;
    const v = seq[Math.min(calls, seq.length - 1)];
    calls++;
    return v as any;
  });

  const pageRepo = { findById };
  const pagePermissionRepo = {
    findPageAccessByPageId,
    insertPageAccess: jest.fn(async () => ({ id: ACCESS_ID })),
    insertPagePermissions: jest.fn(async () => undefined),
    deletePageAccess: jest.fn(async () => undefined),
    deletePagePermissionsByUserIds: jest.fn(async () => undefined),
    deletePagePermissionsByGroupIds: jest.fn(async () => undefined),
    hasRestrictedAncestor: jest.fn(async () => opts.restrictedAncestor ?? false),
    canUserEditPage: jest.fn(
      async () => opts.nativeEdit ?? { hasAnyRestriction: false, canAccess: true, canEdit: true },
    ),
  };

  // The service's own Kysely reads/writes (the grant lookup + update-by-id, the A1 group probe, the A3 child
  // probe) go through the compiling spy.
  const spy = spyKysely((q: SpyQuery) => {
    if (q.sql.includes('from "page_permissions"')) return opts.grant ? [opts.grant] : [];
    if (q.sql.includes('from "group_users"')) return opts.inGroup ? [{ groupId: TARGET_GROUP }] : [];
    if (q.sql.includes('from "pages" as "c"')) return opts.darkChild ? [{ id: 'child' }] : [];
    return [];
  });

  const authz = {
    tryCheckBulk: jest.fn(async (_s: unknown, checks: unknown[]) =>
      opts.pdp === undefined ? checks.map(() => true) : opts.pdp,
    ),
  };

  const service = new PageRestrictionService(
    spy.db,
    pageRepo as any,
    pagePermissionRepo as any,
    spaceAbility,
    opts.mode ?? 'native',
    authz as any,
  );
  return { service, pageRepo, pagePermissionRepo, getUserSpaceRoles, spy, authz };
}

describe('PageRestrictionService — who may restrict a page (space-admin gate)', () => {
  // Invariant: a space admin (Manage Settings) may restrict; the write happens and the actor is
  // self-granted writer so they cannot lock themselves out.
  it('lets a space admin restrict a page and self-grants the actor writer', async () => {
    const { service, pagePermissionRepo } = makeService({
      role: 'admin',
      accessSeq: [undefined, { id: ACCESS_ID }],
    });

    await expect(
      service.restrict(PAGE_ID, userOf(ADMIN_ID)),
    ).resolves.toBeUndefined();

    expect(pagePermissionRepo.insertPageAccess).toHaveBeenCalledTimes(1);
    expect((pagePermissionRepo.insertPageAccess.mock.calls[0] as any[])[0]).toMatchObject({
      pageId: PAGE_ID,
      workspaceId: WS_ID,
      spaceId: SPACE_ID,
      accessLevel: 'members',
      creatorId: ADMIN_ID,
    });
    expect(pagePermissionRepo.insertPagePermissions).toHaveBeenCalledWith([
      { pageAccessId: ACCESS_ID, userId: ADMIN_ID, role: 'writer', addedById: ADMIN_ID },
    ]);
  });

  // Invariant (P0, deny-by-default): a plain space READER may NOT restrict — Forbidden, and NO write.
  it('denies a plain space reader from restricting a page (Forbidden, no write)', async () => {
    const { service, pagePermissionRepo } = makeService({ role: 'reader' });

    await expect(service.restrict(PAGE_ID, userOf(READER_ID))).rejects.toThrow(
      ForbiddenException,
    );
    expect(pagePermissionRepo.insertPageAccess).not.toHaveBeenCalled();
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
  });

  // Invariant (P0): a plain space WRITER is NOT a space admin — writer holds only `Read` Settings, so
  // restricting must be Forbidden. This is the load-bearing distinction (write access != admin access).
  it('denies a plain space writer from restricting a page (a writer is not a space admin)', async () => {
    const { service, pagePermissionRepo } = makeService({ role: 'writer' });

    await expect(service.restrict(PAGE_ID, userOf(WRITER_ID))).rejects.toThrow(
      ForbiddenException,
    );
    expect(pagePermissionRepo.insertPageAccess).not.toHaveBeenCalled();
  });

  // Invariant: a non-member (no space role at all) cannot restrict — denied, no write.
  it('denies a non-member from restricting a page (no space role → denied, no write)', async () => {
    const { service, pagePermissionRepo } = makeService({ role: undefined });

    await expect(service.restrict(PAGE_ID, userOf('99999999-9999-4999-8999-999999999999'))).rejects.toThrow();
    expect(pagePermissionRepo.insertPageAccess).not.toHaveBeenCalled();
  });

  // Invariant: restricting an already-restricted page is an idempotent no-op (no duplicate access row).
  it('is idempotent — restricting an already-restricted page writes nothing', async () => {
    const { service, pagePermissionRepo } = makeService({
      role: 'admin',
      accessSeq: [{ id: ACCESS_ID }],
    });

    await expect(
      service.restrict(PAGE_ID, userOf(ADMIN_ID)),
    ).resolves.toBeUndefined();
    expect(pagePermissionRepo.insertPageAccess).not.toHaveBeenCalled();
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
  });

  // Invariant: a missing page is NotFound and short-circuits before the ability check / any write.
  it('throws NotFound for a missing page (before ability check or write)', async () => {
    const { service, pagePermissionRepo, getUserSpaceRoles } = makeService({
      role: 'admin',
      page: undefined,
    });

    await expect(service.restrict(PAGE_ID, userOf(ADMIN_ID))).rejects.toThrow(
      NotFoundException,
    );
    expect(getUserSpaceRoles).not.toHaveBeenCalled();
    expect(pagePermissionRepo.insertPageAccess).not.toHaveBeenCalled();
  });

  // Invariant: only a space admin may remove a restriction; a reader is Forbidden and nothing is deleted.
  it('lets a space admin unrestrict a page', async () => {
    const { service, pagePermissionRepo } = makeService({ role: 'admin' });
    await expect(
      service.unrestrict(PAGE_ID, userOf(ADMIN_ID)),
    ).resolves.toBeUndefined();
    expect(pagePermissionRepo.deletePageAccess).toHaveBeenCalledWith(PAGE_ID);
  });

  it('denies a plain space reader from unrestricting a page (Forbidden, no delete)', async () => {
    const { service, pagePermissionRepo } = makeService({ role: 'reader' });
    await expect(
      service.unrestrict(PAGE_ID, userOf(READER_ID)),
    ).rejects.toThrow(ForbiddenException);
    expect(pagePermissionRepo.deletePageAccess).not.toHaveBeenCalled();
  });
});

describe('PageRestrictionService — who may grant/revoke/update a page permission (space-admin gate)', () => {
  // Invariant: a space admin may grant; add is idempotent — it replaces any existing grant for the
  // subjects (delete-by-userIds/groupIds) then inserts the new grant with the requested role.
  it('lets a space admin grant a permission (replace-then-insert with the requested role)', async () => {
    const { service, pagePermissionRepo } = makeService({
      role: 'admin',
      accessSeq: [{ id: ACCESS_ID }],
    });

    await expect(
      service.addPermission(
        { pageId: PAGE_ID, role: 'reader', userIds: [TARGET_USER] } as AddPagePermissionDto,
        userOf(ADMIN_ID),
      ),
    ).resolves.toBeUndefined();

    expect(pagePermissionRepo.deletePagePermissionsByUserIds).toHaveBeenCalledWith(
      ACCESS_ID,
      [TARGET_USER],
    );
    expect(pagePermissionRepo.insertPagePermissions).toHaveBeenCalledWith([
      { pageAccessId: ACCESS_ID, userId: TARGET_USER, role: 'reader', addedById: ADMIN_ID },
    ]);
  });

  // Invariant (P0): a plain reader may NOT grant — Forbidden, and no delete/insert reaches the repo.
  it('denies a plain space reader from granting a permission (Forbidden, no write)', async () => {
    const { service, pagePermissionRepo } = makeService({
      role: 'reader',
      accessSeq: [{ id: ACCESS_ID }],
    });

    await expect(
      service.addPermission(
        { pageId: PAGE_ID, role: 'writer', userIds: [TARGET_USER] } as AddPagePermissionDto,
        userOf(READER_ID),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
    expect(pagePermissionRepo.deletePagePermissionsByUserIds).not.toHaveBeenCalled();
  });

  // Invariant (P0): a plain writer may NOT grant either (write != admin).
  it('denies a plain space writer from granting a permission (Forbidden)', async () => {
    const { service, pagePermissionRepo } = makeService({
      role: 'writer',
      accessSeq: [{ id: ACCESS_ID }],
    });

    await expect(
      service.addPermission(
        { pageId: PAGE_ID, role: 'writer', groupIds: [TARGET_GROUP] } as AddPagePermissionDto,
        userOf(WRITER_ID),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
  });

  // Invariant: an admin grant with neither userIds nor groupIds is a BadRequest (no empty grant).
  it('rejects an add with neither userIds nor groupIds (BadRequest)', async () => {
    const { service, pagePermissionRepo } = makeService({
      role: 'admin',
      accessSeq: [{ id: ACCESS_ID }],
    });

    await expect(
      service.addPermission(
        { pageId: PAGE_ID, role: 'reader' } as AddPagePermissionDto,
        userOf(ADMIN_ID),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
  });

  // Invariant: granting on a page that is not restricted is a BadRequest (there is no access row).
  it('rejects a grant on a page that is not restricted (BadRequest)', async () => {
    const { service, pagePermissionRepo } = makeService({
      role: 'admin',
      accessSeq: [undefined],
    });

    await expect(
      service.addPermission(
        { pageId: PAGE_ID, role: 'reader', userIds: [TARGET_USER] } as AddPagePermissionDto,
        userOf(ADMIN_ID),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
  });

  // Invariant: only a space admin may revoke a grant; a writer is Forbidden.
  it('lets a space admin revoke a permission', async () => {
    const { service, pagePermissionRepo } = makeService({
      role: 'admin',
      accessSeq: [{ id: ACCESS_ID }],
    });

    await expect(
      service.removePermission(
        { pageId: PAGE_ID, userIds: [TARGET_USER] } as RemovePagePermissionDto,
        userOf(ADMIN_ID),
      ),
    ).resolves.toBeUndefined();
    expect(pagePermissionRepo.deletePagePermissionsByUserIds).toHaveBeenCalledWith(
      ACCESS_ID,
      [TARGET_USER],
    );
  });

  it('denies a plain space writer from revoking a permission (Forbidden, no delete)', async () => {
    const { service, pagePermissionRepo } = makeService({
      role: 'writer',
      accessSeq: [{ id: ACCESS_ID }],
    });

    await expect(
      service.removePermission(
        { pageId: PAGE_ID, userIds: [TARGET_USER] } as RemovePagePermissionDto,
        userOf(WRITER_ID),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(pagePermissionRepo.deletePagePermissionsByUserIds).not.toHaveBeenCalled();
  });

  // Invariant: only a space admin may change a subject's role; a reader is Forbidden. The existing grant is
  // locked (FOR UPDATE) in one transaction and updated by its row id (#486).
  it('lets a space admin update a permission role (lock the grant, update it by id, commit)', async () => {
    const { service, spy } = makeService({
      role: 'admin',
      accessSeq: [{ id: ACCESS_ID }],
      grant: { id: 'perm-1' },
    });

    await expect(
      service.updatePermission(
        { pageId: PAGE_ID, role: 'writer', userId: TARGET_USER } as UpdatePagePermissionDto,
        userOf(ADMIN_ID),
      ),
    ).resolves.toBeUndefined();
    expect(spy.tx).toEqual(['begin', 'commit']);
    const [select, update] = spy.calls.filter((c) => c.sql.includes('"page_permissions"'));
    expect(select.sql).toContain('from "page_permissions"');
    expect(select.sql).toContain('"user_id" =');
    expect(select.sql).toContain('for update');
    expect(select.parameters).toEqual([ACCESS_ID, TARGET_USER]);
    expect(update.sql).toMatch(/^update "page_permissions" set "role" = \$1, "updated_at" = \$2 where "id" = \$3$/);
    expect(update.parameters[0]).toBe('writer');
    expect(update.parameters[2]).toBe('perm-1');
  });

  it('keys a group grant on group_id', async () => {
    const { service, spy } = makeService({
      role: 'admin',
      accessSeq: [{ id: ACCESS_ID }],
      grant: { id: 'perm-2' },
    });
    await service.updatePermission(
      { pageId: PAGE_ID, role: 'reader', groupId: TARGET_GROUP } as UpdatePagePermissionDto,
      userOf(ADMIN_ID),
    );
    const select = spy.calls.find((c) => c.sql.includes('from "page_permissions"'))!;
    expect(select.sql).toContain('"group_id" =');
    expect(select.sql).not.toContain('"user_id"');
    expect(select.parameters).toEqual([ACCESS_ID, TARGET_GROUP]);
  });

  // #486: upstream's updatePagePermissionRole returns void, so a PATCH for a non-grantee used to "succeed".
  it('404s when the subject holds no grant on the page (rolled back, no UPDATE)', async () => {
    const { service, spy } = makeService({ role: 'admin', accessSeq: [{ id: ACCESS_ID }] });
    await expect(
      service.updatePermission(
        { pageId: PAGE_ID, role: 'writer', userId: TARGET_USER } as UpdatePagePermissionDto,
        userOf(ADMIN_ID),
      ),
    ).rejects.toThrow(NotFoundException);
    expect(spy.tx).toEqual(['begin', 'rollback']);
    expect(spy.calls.some((c) => c.sql.startsWith('update'))).toBe(false);
  });

  it('400s a page that is not restricted', async () => {
    const { service, spy } = makeService({ role: 'admin', accessSeq: [undefined] });
    await expect(
      service.updatePermission(
        { pageId: PAGE_ID, role: 'writer', userId: TARGET_USER } as UpdatePagePermissionDto,
        userOf(ADMIN_ID),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(spy.calls).toEqual([]);
  });

  // #486: exactly one subject — neither is ambiguous, and both would silently update only the user grant.
  it.each([
    ['neither', {}],
    ['both', { userId: TARGET_USER, groupId: TARGET_GROUP }],
  ])('400s when %s of userId/groupId is given (before any read or write)', async (_label, ids) => {
    const { service, spy, pageRepo } = makeService({ role: 'admin', accessSeq: [{ id: ACCESS_ID }], grant: { id: 'p' } });
    await expect(
      service.updatePermission({ pageId: PAGE_ID, role: 'writer', ...ids } as UpdatePagePermissionDto, userOf(ADMIN_ID)),
    ).rejects.toThrow(BadRequestException);
    expect(pageRepo.findById).not.toHaveBeenCalled();
    expect(spy.calls).toEqual([]);
  });

  it('denies a plain space reader from updating a permission role (Forbidden, no update)', async () => {
    const { service, spy } = makeService({
      role: 'reader',
      accessSeq: [{ id: ACCESS_ID }],
      grant: { id: 'perm-1' },
    });

    await expect(
      service.updatePermission(
        { pageId: PAGE_ID, role: 'writer', userId: TARGET_USER } as UpdatePagePermissionDto,
        userOf(READER_ID),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(spy.calls).toEqual([]);
  });
});

/** Assert a rejection is the 403 whose body carries `code: 'self_grant'` (#486). */
async function expectSelfGrant(p: Promise<unknown>) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ForbiddenException);
  expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'self_grant' });
}

describe('PageRestrictionService — A1: no self page-grant (#486)', () => {
  const grant = (ids: Partial<AddPagePermissionDto>) =>
    ({ pageId: PAGE_ID, role: 'writer', ...ids }) as AddPagePermissionDto;

  it.each([
    ['yourself', { userIds: [TARGET_USER, ADMIN_ID] }],
    ['yourself, upper-cased', { userIds: [ADMIN_ID.toUpperCase()] }],
  ])('refuses granting %s (403 self_grant, nothing deleted or inserted)', async (_l, ids) => {
    const { service, pagePermissionRepo } = makeService({ role: 'admin', accessSeq: [{ id: ACCESS_ID }] });
    await expectSelfGrant(service.addPermission(grant(ids), userOf(ADMIN_ID)));
    expect(pagePermissionRepo.deletePagePermissionsByUserIds).not.toHaveBeenCalled();
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
  });

  it('refuses granting a group the actor belongs to (probed in group_users for the actor)', async () => {
    const { service, pagePermissionRepo, spy } = makeService({
      role: 'admin',
      accessSeq: [{ id: ACCESS_ID }],
      inGroup: true,
    });
    await expectSelfGrant(service.addPermission(grant({ groupIds: [TARGET_GROUP] }), userOf(ADMIN_ID)));
    const probe = spy.calls.find((c) => c.sql.includes('from "group_users"'))!;
    expect(probe.parameters).toEqual([ADMIN_ID, TARGET_GROUP]);
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
  });

  it('allows granting a group the actor is not in, and other users', async () => {
    const { service, pagePermissionRepo } = makeService({ role: 'admin', accessSeq: [{ id: ACCESS_ID }] });
    await expect(
      service.addPermission(grant({ userIds: [TARGET_USER], groupIds: [TARGET_GROUP] }), userOf(ADMIN_ID)),
    ).resolves.toBeUndefined();
    expect(pagePermissionRepo.insertPagePermissions).toHaveBeenCalled();
  });

  it('refuses re-roling your own grant or your own group grant (no transaction opened)', async () => {
    const self = makeService({ role: 'admin', accessSeq: [{ id: ACCESS_ID }], grant: { id: 'p' } });
    await expectSelfGrant(
      self.service.updatePermission(
        { pageId: PAGE_ID, role: 'writer', userId: ADMIN_ID } as UpdatePagePermissionDto,
        userOf(ADMIN_ID),
      ),
    );
    expect(self.spy.tx).toEqual([]);

    const group = makeService({ role: 'admin', accessSeq: [{ id: ACCESS_ID }], grant: { id: 'p' }, inGroup: true });
    await expectSelfGrant(
      group.service.updatePermission(
        { pageId: PAGE_ID, role: 'reader', groupId: TARGET_GROUP } as UpdatePagePermissionDto,
        userOf(ADMIN_ID),
      ),
    );
    expect(group.spy.calls.some((c) => c.sql.startsWith('update'))).toBe(false);
  });

  it('always allows revoking your own grant', async () => {
    const { service, pagePermissionRepo } = makeService({ role: 'admin', accessSeq: [{ id: ACCESS_ID }] });
    await expect(
      service.removePermission({ pageId: PAGE_ID, userIds: [ADMIN_ID] } as RemovePagePermissionDto, userOf(ADMIN_ID)),
    ).resolves.toBeUndefined();
    expect(pagePermissionRepo.deletePagePermissionsByUserIds).toHaveBeenCalledWith(ACCESS_ID, [ADMIN_ID]);
  });
});

describe('PageRestrictionService — A2: restrict keeps only the access the actor already had (#486)', () => {
  const restrictAs = (opts: Parameters<typeof makeService>[0]) =>
    makeService({ role: 'admin', accessSeq: [undefined, { id: ACCESS_ID }], mode: 'remote', ...opts });

  it.each([
    ['space view + edit → writer', [true, true], 'writer'],
    ['space view only → reader', [true, false], 'reader'],
  ] as const)('%s', async (_l, pdp, role) => {
    const { service, pagePermissionRepo, authz } = restrictAs({ pdp: [...pdp] });
    await service.restrict(PAGE_ID, userOf(ADMIN_ID));
    expect(authz.tryCheckBulk).toHaveBeenCalledWith({ provider: 'docmost', externalId: ADMIN_ID }, [
      { permission: 'view', resourceType: 'space', resourceId: SPACE_ID },
      { permission: 'edit', resourceType: 'space', resourceId: SPACE_ID },
    ]);
    expect(pagePermissionRepo.insertPagePermissions).toHaveBeenCalledWith([
      { pageAccessId: ACCESS_ID, userId: ADMIN_ID, role, addedById: ADMIN_ID },
    ]);
  });

  it('no space view → the page is restricted but the actor is granted nothing', async () => {
    const { service, pagePermissionRepo } = restrictAs({ pdp: [false, false] });
    await service.restrict(PAGE_ID, userOf(ADMIN_ID));
    expect(pagePermissionRepo.insertPageAccess).toHaveBeenCalledTimes(1);
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
  });

  it('under a restricted ancestor → no grant, and the PDP is not even asked', async () => {
    const { service, pagePermissionRepo, authz } = restrictAs({ restrictedAncestor: true });
    await service.restrict(PAGE_ID, userOf(ADMIN_ID));
    expect(pagePermissionRepo.hasRestrictedAncestor).toHaveBeenCalledWith(PAGE_ID);
    expect(authz.tryCheckBulk).not.toHaveBeenCalled();
    expect(pagePermissionRepo.insertPageAccess).toHaveBeenCalledTimes(1);
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
  });

  it('a PDP failure is a 503 with NOTHING written (not even the restriction)', async () => {
    const { service, pagePermissionRepo } = restrictAs({ pdp: null });
    await expect(service.restrict(PAGE_ID, userOf(ADMIN_ID))).rejects.toThrow(ServiceUnavailableException);
    expect(pagePermissionRepo.insertPageAccess).not.toHaveBeenCalled();
    expect(pagePermissionRepo.insertPagePermissions).not.toHaveBeenCalled();
  });

  it('native mode keeps the upstream writer self-grant and never calls the PDP', async () => {
    const { service, pagePermissionRepo, authz } = restrictAs({ mode: 'native', pdp: [false, false] });
    await service.restrict(PAGE_ID, userOf(ADMIN_ID));
    expect(authz.tryCheckBulk).not.toHaveBeenCalled();
    expect(pagePermissionRepo.insertPagePermissions).toHaveBeenCalledWith([
      { pageAccessId: ACCESS_ID, userId: ADMIN_ID, role: 'writer', addedById: ADMIN_ID },
    ]);
  });

  it('never asks the PDP for `locked` (issue 499)', async () => {
    const { service, authz } = restrictAs({});
    await service.restrict(PAGE_ID, userOf(ADMIN_ID));
    const asked = authz.tryCheckBulk.mock.calls.flatMap((c) => (c[1] as Array<{ permission: string }>));
    expect(asked.map((c) => c.permission)).not.toContain('locked');
  });
});

describe('PageRestrictionService — A3: covered unrestrict (#486)', () => {
  const unrestrictAs = (opts: Parameters<typeof makeService>[0]) =>
    makeService({ role: 'admin', mode: 'remote', ...opts });
  const covered = { requireActorCoverage: true };

  it('without the flag, unrestrict is unchanged: no PDP call, no child probe', async () => {
    const { service, pagePermissionRepo, authz, spy } = unrestrictAs({ pdp: [false], darkChild: true });
    await expect(service.unrestrict(PAGE_ID, userOf(ADMIN_ID))).resolves.toBeUndefined();
    expect(authz.tryCheckBulk).not.toHaveBeenCalled();
    expect(spy.calls).toEqual([]);
    expect(pagePermissionRepo.deletePageAccess).toHaveBeenCalledWith(PAGE_ID);
  });

  it('with the flag, 403s when the actor cannot edit the page (strict page#edit), nothing deleted', async () => {
    const { service, pagePermissionRepo, authz } = unrestrictAs({ pdp: [false] });
    await expect(service.unrestrict(PAGE_ID, userOf(ADMIN_ID), covered)).rejects.toThrow(ForbiddenException);
    expect(authz.tryCheckBulk).toHaveBeenCalledWith({ provider: 'docmost', externalId: ADMIN_ID }, [
      { permission: 'edit', resourceType: 'page', resourceId: PAGE_ID },
    ]);
    expect(pagePermissionRepo.deletePageAccess).not.toHaveBeenCalled();
  });

  it('with the flag, 409s when a direct sub-page is unrestricted (it would be exposed), nothing deleted', async () => {
    const { service, pagePermissionRepo, spy } = unrestrictAs({ pdp: [true], darkChild: true });
    await expect(service.unrestrict(PAGE_ID, userOf(ADMIN_ID), covered)).rejects.toThrow(ConflictException);
    const probe = spy.calls.find((c) => c.sql.includes('from "pages" as "c"'))!;
    expect(probe.sql).toContain('"c"."parent_page_id" =');
    expect(probe.sql).toContain('not exists');
    expect(probe.sql).not.toContain('deleted_at'); // trashed children count: they can be restored
    expect(probe.parameters[0]).toBe(PAGE_ID);
    expect(pagePermissionRepo.deletePageAccess).not.toHaveBeenCalled();
  });

  it('with the flag, removes the restriction when the actor can edit and every sub-page is restricted', async () => {
    const { service, pagePermissionRepo } = unrestrictAs({ pdp: [true], darkChild: false });
    await expect(service.unrestrict(PAGE_ID, userOf(ADMIN_ID), covered)).resolves.toBeUndefined();
    expect(pagePermissionRepo.deletePageAccess).toHaveBeenCalledWith(PAGE_ID);
  });

  it('with the flag, a PDP failure is a 503 and nothing is deleted', async () => {
    const { service, pagePermissionRepo } = unrestrictAs({ pdp: null });
    await expect(service.unrestrict(PAGE_ID, userOf(ADMIN_ID), covered)).rejects.toThrow(ServiceUnavailableException);
    expect(pagePermissionRepo.deletePageAccess).not.toHaveBeenCalled();
  });

  it('native mode decides page edit with upstream semantics (no PDP call)', async () => {
    const { service, pagePermissionRepo, authz } = unrestrictAs({
      mode: 'native',
      nativeEdit: { hasAnyRestriction: true, canAccess: true, canEdit: false },
    });
    await expect(service.unrestrict(PAGE_ID, userOf(ADMIN_ID), covered)).rejects.toThrow(ForbiddenException);
    expect(authz.tryCheckBulk).not.toHaveBeenCalled();
    expect(pagePermissionRepo.canUserEditPage).toHaveBeenCalledWith(ADMIN_ID, PAGE_ID);
  });

  it('the space-admin gate still runs first: a writer is Forbidden before any coverage check', async () => {
    const { service, authz } = unrestrictAs({ role: 'writer' });
    await expect(service.unrestrict(PAGE_ID, userOf(WRITER_ID), covered)).rejects.toThrow(ForbiddenException);
    expect(authz.tryCheckBulk).not.toHaveBeenCalled();
  });
});

describe('page-restriction DTO validation (class-validator rejects malformed bodies)', () => {
  const props = (errs: { property: string }[]) => errs.map((e) => e.property);

  // Invariant: a page id must be a UUID — a malformed id never reaches the service/outbox.
  it('RestrictPageDto rejects a non-uuid pageId', async () => {
    const errs = await validate(plainToInstance(RestrictPageDto, { pageId: 'not-a-uuid' }));
    expect(props(errs)).toContain('pageId');
  });

  it('RestrictPageDto accepts a valid uuid pageId', async () => {
    const errs = await validate(plainToInstance(RestrictPageDto, { pageId: PAGE_ID }));
    expect(errs).toHaveLength(0);
  });

  // Invariant: the permission role vocabulary is exactly {reader, writer} — an unknown role is rejected
  // so it can never be projected to an unintended SpiceDB relation.
  it('AddPagePermissionDto rejects an unknown permission role', async () => {
    const errs = await validate(
      plainToInstance(AddPagePermissionDto, {
        pageId: PAGE_ID,
        role: 'owner',
        userIds: [TARGET_USER],
      }),
    );
    expect(props(errs)).toContain('role');
  });

  // Invariant: every subject id in a grant must be a UUID (each: true) — a malformed member id is rejected.
  it('AddPagePermissionDto rejects a malformed uuid inside userIds', async () => {
    const errs = await validate(
      plainToInstance(AddPagePermissionDto, {
        pageId: PAGE_ID,
        role: 'reader',
        userIds: ['nope'],
      }),
    );
    expect(props(errs)).toContain('userIds');
  });

  it('AddPagePermissionDto accepts a well-formed grant', async () => {
    const errs = await validate(
      plainToInstance(AddPagePermissionDto, {
        pageId: PAGE_ID,
        role: 'writer',
        userIds: [TARGET_USER],
        groupIds: [TARGET_GROUP],
      }),
    );
    expect(errs).toHaveLength(0);
  });

  it('UpdatePagePermissionDto rejects an unknown role', async () => {
    const errs = await validate(
      plainToInstance(UpdatePagePermissionDto, {
        pageId: PAGE_ID,
        role: 'superadmin',
        userId: TARGET_USER,
      }),
    );
    expect(props(errs)).toContain('role');
  });

  // #486: the grantee batch is capped (the platform relay's 256) on every add/remove id list.
  it.each([
    ['AddPagePermissionDto', AddPagePermissionDto, 'userIds'],
    ['AddPagePermissionDto', AddPagePermissionDto, 'groupIds'],
    ['RemovePagePermissionDto', RemovePagePermissionDto, 'userIds'],
    ['RemovePagePermissionDto', RemovePagePermissionDto, 'groupIds'],
  ] as const)('%s caps %s at MAX_PAGE_GRANTEES (256 ok, 257 rejected)', async (_n, cls, field) => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const body = (n: number) => ({ pageId: PAGE_ID, role: 'reader', [field]: ids(n) });
    expect(MAX_PAGE_GRANTEES).toBe(256);
    expect(await validate(plainToInstance(cls as any, body(MAX_PAGE_GRANTEES)))).toHaveLength(0);
    expect(props(await validate(plainToInstance(cls as any, body(MAX_PAGE_GRANTEES + 1))))).toContain(field);
  });

  // #486 A3: the coverage flag is a strict boolean (a form-encoded "true" must not read as set) and optional.
  it('RemoveRestrictionDto accepts an optional boolean requireActorCoverage and rejects a string', async () => {
    expect(await validate(plainToInstance(RemoveRestrictionDto, { pageId: PAGE_ID }))).toHaveLength(0);
    expect(
      await validate(plainToInstance(RemoveRestrictionDto, { pageId: PAGE_ID, requireActorCoverage: true })),
    ).toHaveLength(0);
    const errs = await validate(plainToInstance(RemoveRestrictionDto, { pageId: PAGE_ID, requireActorCoverage: 'true' }));
    expect(props(errs)).toContain('requireActorCoverage');
  });

  it('RemovePagePermissionDto rejects a malformed uuid inside groupIds', async () => {
    const errs = await validate(
      plainToInstance(RemovePagePermissionDto, {
        pageId: PAGE_ID,
        groupIds: ['x'],
      }),
    );
    expect(props(errs)).toContain('groupIds');
  });
});

describe('PageRestrictionController (auth guard + delegation)', () => {
  // Invariant: the write surface requires authentication — the controller is guarded by JwtAuthGuard.
  it('is protected by JwtAuthGuard', () => {
    const guards = Reflect.getMetadata('__guards__', PageRestrictionController) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });

  const makeController = () => {
    const service = {
      restrict: jest.fn(async () => undefined),
      unrestrict: jest.fn(async () => undefined),
      addPermission: jest.fn(async () => undefined),
      removePermission: jest.fn(async () => undefined),
      updatePermission: jest.fn(async () => undefined),
    };
    return { controller: new PageRestrictionController(service as any), service };
  };

  it('restrict delegates (pageId, user) to the service and returns {restricted:true}', async () => {
    const { controller, service } = makeController();
    const admin = userOf(ADMIN_ID);
    await expect(
      controller.restrict({ pageId: PAGE_ID } as RestrictPageDto, admin),
    ).resolves.toEqual({ restricted: true });
    expect(service.restrict).toHaveBeenCalledWith(PAGE_ID, admin);
  });

  it('remove-restriction delegates and returns {restricted:false}', async () => {
    const { controller, service } = makeController();
    const admin = userOf(ADMIN_ID);
    await expect(
      controller.removeRestriction({ pageId: PAGE_ID } as RemoveRestrictionDto, admin),
    ).resolves.toEqual({ restricted: false });
    expect(service.unrestrict).toHaveBeenCalledWith(PAGE_ID, admin, { requireActorCoverage: false });
  });

  it('remove-restriction forwards requireActorCoverage only when it is literally true (#486 A3)', async () => {
    const { controller, service } = makeController();
    const admin = userOf(ADMIN_ID);
    await controller.removeRestriction({ pageId: PAGE_ID, requireActorCoverage: true } as RemoveRestrictionDto, admin);
    expect(service.unrestrict).toHaveBeenLastCalledWith(PAGE_ID, admin, { requireActorCoverage: true });
  });

  it('add-permission delegates the dto + user and returns {success:true}', async () => {
    const { controller, service } = makeController();
    const admin = userOf(ADMIN_ID);
    const dto = { pageId: PAGE_ID, role: 'reader', userIds: [TARGET_USER] } as AddPagePermissionDto;
    await expect(controller.addPermission(dto, admin)).resolves.toEqual({ success: true });
    expect(service.addPermission).toHaveBeenCalledWith(dto, admin);
  });

  // Invariant: the space-admin gate lives in the service, so a Forbidden it raises propagates out of
  // the controller (the controller must not swallow it into a success response).
  it('propagates a ForbiddenException raised by the service gate', async () => {
    const { controller, service } = makeController();
    service.addPermission.mockRejectedValueOnce(new ForbiddenException('nope'));
    await expect(
      controller.addPermission(
        { pageId: PAGE_ID, role: 'reader', userIds: [TARGET_USER] } as AddPagePermissionDto,
        userOf(READER_ID),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
