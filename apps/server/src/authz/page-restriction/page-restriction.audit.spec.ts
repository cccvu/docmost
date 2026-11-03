import { Logger } from '@nestjs/common';
import { User } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';
import { PageRestrictionService } from './page-restriction.service';
import {
  AddPagePermissionDto,
  RemovePagePermissionDto,
  RestrictionPreviewDto,
  UpdatePagePermissionDto,
} from './dto';
import { aclVersionOf } from './acl-state';

/**
 * #503 — every APPLIED native page-ACL write emits exactly one domain-audit row, after its transaction commits;
 * a no-op, a refusal, a busy engine and a preview emit nothing; a broken sink never fails the committed write; and
 * the service works with no sink at all (the collaboration app's wiring).
 */
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const WS_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GROUP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ACCESS_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const admin = { id: ADMIN_ID } as unknown as User;

type Grant = { userId: string | null; groupId: string | null; role: string };
type Sink = { log: jest.Mock };

function make(opts: {
  role?: 'admin' | 'reader';
  mode?: 'native' | 'remote';
  restricted?: boolean;
  grants?: Grant[];
  /** The ACL the post-write re-read sees; defaults to the state before (a no-op). */
  after?: { restricted: boolean; grants: Grant[] };
  failOn?: (q: SpyQuery) => unknown;
  inGroup?: boolean;
  /** `tryCheckBulk`'s answer (null = PDP unavailable); all-true by default. */
  pdp?: boolean[] | null;
  /** A direct sub-page with no restriction of its own (A3 `exposes_subpages`). */
  darkChild?: boolean;
  /** Whether `updatePermission` finds the grant row; yes by default. */
  grantRow?: boolean;
  nativeCanEdit?: boolean;
  /** The audit sink; `null` = none injected (the collab app). A recording sink by default. */
  audit?: Sink | null;
}) {
  let reads = 0;
  const aclRows = (restricted: boolean, grants: Grant[]) =>
    restricted
      ? grants.length
        ? grants.map((g) => ({ accessId: ACCESS_ID, ...g }))
        : [{ accessId: ACCESS_ID, userId: null, groupId: null, role: null }]
      : [];
  const spy = spyKysely((q) => {
    const fail = opts.failOn?.(q);
    if (fail) throw fail;
    if (q.sql.includes('from page_access pa left join page_permissions')) {
      reads++;
      if (reads > 1 && opts.after) return aclRows(opts.after.restricted, opts.after.grants);
      return aclRows(opts.restricted ?? true, opts.grants ?? []);
    }
    if (q.sql.includes('from "group_users"')) return opts.inGroup ? [{ groupId: GROUP }] : [];
    if (q.sql.includes('from "page_permissions"')) return opts.grantRow === false ? [] : [{ id: 'perm-1', role: 'reader' }];
    if (q.sql.includes('from "pages" as "c"')) return opts.darkChild ? [{ id: 'child' }] : [];
    return [];
  });
  const page = { id: PAGE_ID, spaceId: SPACE_ID, workspaceId: WS_ID, title: 'Secret title zq9' };
  const repo = {
    findPageAccessByPageId: jest.fn(async () => ((opts.restricted ?? true) ? { id: ACCESS_ID } : undefined)),
    insertPageAccess: jest.fn(async () => ({ id: ACCESS_ID })),
    insertPagePermissions: jest.fn(async () => undefined),
    deletePageAccess: jest.fn(async () => undefined),
    deletePagePermissionsByUserIds: jest.fn(async () => undefined),
    deletePagePermissionsByGroupIds: jest.fn(async () => undefined),
    hasRestrictedAncestor: jest.fn(async () => false),
    canUserEditPage: jest.fn(async () => ({
      hasAnyRestriction: true,
      canAccess: true,
      canEdit: opts.nativeCanEdit ?? true,
    })),
  };
  const spaceAbility = new SpaceAbilityFactory({
    getUserSpaceRoles: async () => [{ userId: ADMIN_ID, role: opts.role ?? 'admin' }],
  } as never);
  // The sink records the transaction's state at the moment it is called: it must be AFTER the commit.
  const txAtLog: string[][] = [];
  const audit: Sink | undefined =
    opts.audit === null
      ? undefined
      : (opts.audit ?? {
          log: jest.fn(() => {
            txAtLog.push([...spy.tx]);
          }),
        });
  const service = new PageRestrictionService(
    spy.db,
    { findById: jest.fn(async () => page) } as never,
    repo as never,
    spaceAbility,
    opts.mode ?? 'native',
    {
      tryCheckBulk: jest.fn(async (_s: unknown, c: unknown[]) => (opts.pdp === undefined ? c.map(() => true) : opts.pdp)),
    } as never,
    undefined,
    audit as never,
  );
  return { service, spy, repo, audit, txAtLog };
}

const reader = (userId: string): Grant => ({ userId, groupId: null, role: 'reader' });
const addDto = (b: Partial<AddPagePermissionDto> = {}) =>
  ({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET], ...b }) as AddPagePermissionDto;
const removeDto = (b: Partial<RemovePagePermissionDto> = {}) =>
  ({ pageId: PAGE_ID, userIds: [TARGET], ...b }) as RemovePagePermissionDto;
const updateDto = (b: Partial<UpdatePagePermissionDto> = {}) =>
  ({ pageId: PAGE_ID, role: 'writer', userId: TARGET, ...b }) as UpdatePagePermissionDto;

describe('page-ACL domain audit (#503)', () => {
  it('restrict → one page.restricted row, after the commit, with the self-grant and retained role', async () => {
    const { service, audit, txAtLog } = make({
      restricted: false,
      after: { restricted: true, grants: [{ userId: ADMIN_ID, groupId: null, role: 'writer' }] },
    });
    await service.restrict(PAGE_ID, admin);
    expect(audit!.log).toHaveBeenCalledTimes(1);
    expect(txAtLog).toEqual([['begin', 'commit']]);
    expect(audit!.log).toHaveBeenCalledWith({
      event: 'page.restricted',
      resourceType: 'page',
      resourceId: PAGE_ID,
      spaceId: SPACE_ID,
      changes: { before: { restricted: false }, after: { restricted: true } },
      metadata: {
        surface: 'engine',
        operation: 'restricted',
        added: [{ userId: ADMIN_ID, role: 'writer' }],
        changed: [],
        removed: [],
        retainedRole: 'writer',
      },
    });
  });

  it('unrestrict → one page.restriction_removed row listing the cascaded grants', async () => {
    const { service, audit, txAtLog } = make({ grants: [reader(TARGET)], after: { restricted: false, grants: [] } });
    await service.unrestrict(PAGE_ID, admin);
    expect(audit!.log).toHaveBeenCalledTimes(1);
    expect(txAtLog).toEqual([['begin', 'commit']]);
    expect(audit!.log.mock.calls[0][0]).toMatchObject({
      event: 'page.restriction_removed',
      resourceId: PAGE_ID,
      spaceId: SPACE_ID,
      changes: { before: { restricted: true }, after: { restricted: false } },
      metadata: { surface: 'engine', operation: 'unrestricted', removed: [{ userId: TARGET, role: 'reader' }] },
    });
  });

  it('add → one page.permission_added (granted) row', async () => {
    const { service, audit, txAtLog } = make({ after: { restricted: true, grants: [reader(TARGET)] } });
    await service.addPermission(addDto(), admin);
    expect(audit!.log).toHaveBeenCalledTimes(1);
    expect(txAtLog).toEqual([['begin', 'commit']]);
    expect(audit!.log.mock.calls[0][0]).toMatchObject({
      event: 'page.permission_added',
      metadata: { surface: 'engine', operation: 'granted', added: [{ userId: TARGET, role: 'reader' }], changed: [], removed: [] },
    });
  });

  it('update → one page.permission_added (role_changed) row', async () => {
    const { service, audit, txAtLog } = make({
      grants: [reader(TARGET)],
      after: { restricted: true, grants: [{ ...reader(TARGET), role: 'writer' }] },
    });
    await service.updatePermission(updateDto(), admin);
    expect(audit!.log).toHaveBeenCalledTimes(1);
    expect(txAtLog).toEqual([['begin', 'commit']]);
    expect(audit!.log.mock.calls[0][0]).toMatchObject({
      event: 'page.permission_added',
      metadata: {
        surface: 'engine',
        operation: 'role_changed',
        added: [],
        changed: [{ userId: TARGET, fromRole: 'reader', toRole: 'writer' }],
        removed: [],
      },
    });
  });

  it('remove → one page.permission_removed (revoked) row', async () => {
    const { service, audit, txAtLog } = make({ grants: [reader(TARGET)], after: { restricted: true, grants: [] } });
    await service.removePermission(removeDto(), admin);
    expect(audit!.log).toHaveBeenCalledTimes(1);
    expect(txAtLog).toEqual([['begin', 'commit']]);
    expect(audit!.log.mock.calls[0][0]).toMatchObject({
      event: 'page.permission_removed',
      metadata: { surface: 'engine', operation: 'revoked', removed: [{ userId: TARGET, role: 'reader' }] },
    });
  });

  it('no row carries the page title', async () => {
    const { service, audit } = make({ after: { restricted: true, grants: [reader(TARGET)] } });
    await service.addPermission(addDto(), admin);
    expect(JSON.stringify(audit!.log.mock.calls)).not.toContain('zq9');
  });

  describe('a write that changes nothing emits no row', () => {
    it.each<[string, Parameters<typeof make>[0], (s: PageRestrictionService) => Promise<unknown>]>([
      ['restrict on an already-restricted page (early return)', { restricted: true }, (s) => s.restrict(PAGE_ID, admin)],
      [
        'restrict on an already-restricted page (in-transaction, with expectedVersion)',
        { restricted: true },
        (s) => s.restrict(PAGE_ID, admin, { expectedVersion: '*' }),
      ],
      ['unrestrict on an unrestricted page', { restricted: false }, (s) => s.unrestrict(PAGE_ID, admin)],
      ['a re-grant with the same role', { grants: [reader(TARGET)] }, (s) => s.addPermission(addDto(), admin)],
      ['removing a non-grantee', { grants: [] }, (s) => s.removePermission(removeDto(), admin)],
      [
        'a re-role to the role already held',
        { grants: [{ ...reader(TARGET), role: 'writer' }] },
        (s) => s.updatePermission(updateDto(), admin),
      ],
    ])('%s', async (_l, world, op) => {
      const { service, audit } = make(world);
      await op(service);
      expect(audit!.log).not.toHaveBeenCalled();
    });
  });

  describe('a refused or failed write emits no row', () => {
    const stale = 'b'.repeat(64);
    const busy = (q: SpyQuery) =>
      q.sql.includes('pg_advisory_xact_lock') ? Object.assign(new Error('busy'), { code: '55P03' }) : undefined;
    const wouldApply = { after: { restricted: true, grants: [reader(TARGET)] } };
    it.each<[string, Parameters<typeof make>[0], (s: PageRestrictionService) => Promise<unknown>, number]>([
      ['not a space admin (403)', { role: 'reader', ...wouldApply }, (s) => s.addPermission(addDto(), admin), 403],
      ['a self-grant (403 self_grant)', wouldApply, (s) => s.addPermission(addDto({ userIds: [ADMIN_ID] }), admin), 403],
      [
        'a group self-grant (403 self_grant)',
        { inGroup: true, ...wouldApply },
        (s) => s.addPermission(addDto({ userIds: [], groupIds: [GROUP] }), admin),
        403,
      ],
      [
        'unrestrict the actor cannot edit (403 actor_cannot_edit)',
        { nativeCanEdit: false, after: { restricted: false, grants: [] } },
        (s) => s.unrestrict(PAGE_ID, admin, { requireActorCoverage: true }),
        403,
      ],
      [
        'unrestrict exposing a sub-page (409 exposes_subpages)',
        { darkChild: true, after: { restricted: false, grants: [] } },
        (s) => s.unrestrict(PAGE_ID, admin, { requireActorCoverage: true }),
        409,
      ],
      [
        'update of a non-grantee (404 grant_not_found)',
        { grantRow: false, ...wouldApply },
        (s) => s.updatePermission(updateDto(), admin),
        404,
      ],
      ['add on an unrestricted page (400 not_restricted)', { restricted: false, ...wouldApply }, (s) => s.addPermission(addDto(), admin), 400],
      [
        'a stale expectedVersion (412)',
        wouldApply,
        (s) => s.addPermission(addDto({ expectedVersion: stale }), admin),
        412,
      ],
      [
        'the PDP is unavailable (503)',
        { mode: 'remote', restricted: false, pdp: null, after: { restricted: true, grants: [] } },
        (s) => s.restrict(PAGE_ID, admin),
        503,
      ],
      ['a busy engine (503 engine_busy)', { failOn: busy, ...wouldApply }, (s) => s.addPermission(addDto(), admin), 503],
    ])('%s', async (_l, world, op, status) => {
      const { service, audit } = make(world);
      await expect(op(service)).rejects.toMatchObject({ status });
      expect(audit!.log).not.toHaveBeenCalled();
    });
  });

  it.each<[string, Partial<RestrictionPreviewDto>, Parameters<typeof make>[0]]>([
    ['restrict', { action: 'restrict' }, { restricted: false, after: { restricted: true, grants: [] } }],
    ['unrestrict', { action: 'unrestrict' }, { grants: [reader(TARGET)], after: { restricted: false, grants: [] } }],
    ['add', { action: 'add', role: 'reader', userIds: [TARGET] }, { after: { restricted: true, grants: [reader(TARGET)] } }],
    [
      'update',
      { action: 'update', role: 'writer', userId: TARGET },
      { grants: [reader(TARGET)], after: { restricted: true, grants: [{ ...reader(TARGET), role: 'writer' }] } },
    ],
    ['remove', { action: 'remove', userIds: [TARGET] }, { grants: [reader(TARGET)], after: { restricted: true, grants: [] } }],
  ])('a %s preview that would apply emits no row', async (_l, body, world) => {
    const { service, audit } = make(world);
    await expect(service.preview({ pageId: PAGE_ID, ...body } as RestrictionPreviewDto, admin)).resolves.toMatchObject({
      outcome: 'would_apply',
    });
    expect(audit!.log).not.toHaveBeenCalled();
  });

  it('a sink that throws never fails the committed write', async () => {
    const after = { restricted: true, grants: [reader(TARGET)] };
    const { service, audit, spy } = make({
      after,
      audit: {
        log: jest.fn(() => {
          throw new Error('sink down');
        }),
      },
    });
    await expect(service.addPermission(addDto(), admin)).resolves.toMatchObject({
      version: aclVersionOf(PAGE_ID, after),
    });
    expect(audit!.log).toHaveBeenCalledTimes(1);
    expect(spy.tx).toEqual(['begin', 'commit']);
  });

  it('a sink that rejects never fails the write (and is not an unhandled rejection)', async () => {
    const after = { restricted: true, grants: [reader(TARGET)] };
    const log = jest.fn(async () => {
      throw new Error('sink down');
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service } = make({ after, audit: { log } });
      await expect(service.addPermission(addDto(), admin)).resolves.toMatchObject({ version: aclVersionOf(PAGE_ID, after) });
      await new Promise((r) => setImmediate(r)); // drain microtasks: the rejection's .catch has run
      expect(log).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('PAGE_ACL_AUDIT_FAILED action=add'));
    } finally {
      warn.mockRestore();
    }
  });

  it('without a sink (the collaboration app), every write still works', async () => {
    const restricted = make({ audit: null, restricted: false, after: { restricted: true, grants: [] } });
    await expect(restricted.service.restrict(PAGE_ID, admin)).resolves.toMatchObject({ version: expect.any(String) });
    const added = make({ audit: null, after: { restricted: true, grants: [reader(TARGET)] } });
    await expect(added.service.addPermission(addDto(), admin)).resolves.toMatchObject({
      effect: { added: [reader(TARGET)] },
    });
  });
});
