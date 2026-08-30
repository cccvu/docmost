import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PageRestrictionService } from './page-restriction.service';
import { PageRestrictionController } from './page-restriction.controller';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AddPagePermissionDto,
  RemovePagePermissionDto,
  RestrictPageDto,
  UpdatePagePermissionDto,
} from './dto';
import { User } from '@docmost/db/types/entity.types';

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
    updatePagePermissionRole: jest.fn(async () => undefined),
  };

  const service = new PageRestrictionService(
    pageRepo as any,
    pagePermissionRepo as any,
    spaceAbility,
  );
  return { service, pageRepo, pagePermissionRepo, getUserSpaceRoles };
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

  // Invariant: only a space admin may change a subject's role; a reader is Forbidden.
  it('lets a space admin update a permission role', async () => {
    const { service, pagePermissionRepo } = makeService({
      role: 'admin',
      accessSeq: [{ id: ACCESS_ID }],
    });

    await expect(
      service.updatePermission(
        { pageId: PAGE_ID, role: 'writer', userId: TARGET_USER } as UpdatePagePermissionDto,
        userOf(ADMIN_ID),
      ),
    ).resolves.toBeUndefined();
    expect(pagePermissionRepo.updatePagePermissionRole).toHaveBeenCalledWith(
      ACCESS_ID,
      'writer',
      { userId: TARGET_USER, groupId: undefined },
    );
  });

  it('denies a plain space reader from updating a permission role (Forbidden, no update)', async () => {
    const { service, pagePermissionRepo } = makeService({
      role: 'reader',
      accessSeq: [{ id: ACCESS_ID }],
    });

    await expect(
      service.updatePermission(
        { pageId: PAGE_ID, role: 'writer', userId: TARGET_USER } as UpdatePagePermissionDto,
        userOf(READER_ID),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(pagePermissionRepo.updatePagePermissionRole).not.toHaveBeenCalled();
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
      controller.removeRestriction({ pageId: PAGE_ID } as RestrictPageDto, admin),
    ).resolves.toEqual({ restricted: false });
    expect(service.unrestrict).toHaveBeenCalledWith(PAGE_ID, admin);
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
