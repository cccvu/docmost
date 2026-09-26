import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { getMetadataStorage, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { User } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';
import { NARROWING_ROUTES } from '../live-access/narrowing-routes';
import { PAGE_ACL_LOCK_CLASS, PageRestrictionService } from './page-restriction.service';
import { PageRestrictionController } from './page-restriction.controller';
import {
  AddPagePermissionDto,
  RemovePagePermissionDto,
  RemoveRestrictionDto,
  RestrictionPreviewDto,
  RestrictPageDto,
  UpdatePagePermissionDto,
} from './dto';
import { aclVersionOf } from './acl-state';

/**
 * #616 Stage 2 — the ACL writes as versioned transactions, and the preview, at the unit level (the pg spec proves the
 * SQL, the locks and the rollback on a real engine):
 *   - the transaction's first statements bound the waits and take the per-page ACL lock BEFORE anything is read;
 *   - every repo write runs on that one transaction; the socket.io cache is dropped only AFTER the commit;
 *   - a stale `expectedVersion` is a 412 before any write; `"*"` passes;
 *   - a preview rolls back, never touches the cache, reports the CURRENT version, and turns a refusal into
 *     `{ outcome: 'refused', code }` while an authorization failure still throws;
 *   - a busy engine is a 503 `engine_busy`;
 *   - the preview route takes every field the real routes take, and is NOT a narrowing route.
 */
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const WS_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACCESS_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const admin = { id: ADMIN_ID } as unknown as User;

type Grant = { userId: string | null; groupId: string | null; role: string };

function make(opts: {
  role?: 'admin' | 'reader';
  restricted?: boolean;
  grants?: Grant[];
  /** Grants the ACL holds after the write (what the post-write re-read sees); defaults to `grants`. */
  after?: { restricted: boolean; grants: Grant[] };
  failOn?: (q: SpyQuery) => unknown;
  inGroup?: boolean;
}) {
  const events: string[] = [];
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
      events.push(`read#${reads}`);
      // The first in-transaction read is the state before; any later one is the state after the write.
      if (reads > 1 && opts.after) return aclRows(opts.after.restricted, opts.after.grants);
      return aclRows(opts.restricted ?? true, opts.grants ?? []);
    }
    if (q.sql.includes('from "group_users"')) return opts.inGroup ? [{ groupId: 'g' }] : [];
    if (q.sql.includes('from "page_permissions"')) return [{ id: 'perm-1', role: 'reader' }];
    return [];
  });
  const page = { id: PAGE_ID, spaceId: SPACE_ID, workspaceId: WS_ID };
  const repo = {
    findPageAccessByPageId: jest.fn(async () => ((opts.restricted ?? true) ? { id: ACCESS_ID } : undefined)),
    insertPageAccess: jest.fn(async () => ({ id: ACCESS_ID })),
    insertPagePermissions: jest.fn(async () => undefined),
    deletePageAccess: jest.fn(async () => undefined),
    deletePagePermissionsByUserIds: jest.fn(async () => undefined),
    deletePagePermissionsByGroupIds: jest.fn(async () => undefined),
    hasRestrictedAncestor: jest.fn(async () => false),
    canUserEditPage: jest.fn(async () => ({ hasAnyRestriction: false, canAccess: true, canEdit: true })),
  };
  const spaceAbility = new SpaceAbilityFactory({
    getUserSpaceRoles: async () => [{ userId: ADMIN_ID, role: opts.role ?? 'admin' }],
  } as never);
  const ws = {
    invalidateSpaceRestrictionCache: jest.fn(async () => {
      events.push(`invalidate after [${spy.tx.join(',')}]`); // the transaction's state when the cache is dropped
    }),
  };
  const service = new PageRestrictionService(
    spy.db,
    { findById: jest.fn(async () => page) } as never,
    repo as never,
    spaceAbility,
    'native',
    { tryCheckBulk: jest.fn(async (_s: unknown, c: unknown[]) => c.map(() => true)) } as never,
    ws as never,
  );
  return { service, spy, repo, ws, events };
}

const versionOf = (restricted: boolean, grants: Grant[]) => aclVersionOf(PAGE_ID, { restricted, grants });

describe('ACL writes are one bounded, per-page-locked transaction (#616)', () => {
  it('bounds the waits, then takes the per-page ACL lock, before the first read', async () => {
    const { service, spy } = make({ restricted: true });
    await service.addPermission({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET] } as AddPagePermissionDto, admin);
    const sqls = spy.calls.map((c) => c.sql);
    const first = sqls.findIndex((s) => s.startsWith('SET LOCAL lock_timeout'));
    expect(sqls[first]).toBe("SET LOCAL lock_timeout = '2s'");
    expect(sqls[first + 1]).toBe("SET LOCAL statement_timeout = '15s'");
    expect(sqls[first + 2]).toBe(`select pg_advisory_xact_lock(${PAGE_ACL_LOCK_CLASS}, hashtext($1::text))`);
    expect(spy.calls[first + 2].parameters).toEqual([PAGE_ID]);
    expect(sqls[first + 3]).toContain('from page_access pa left join page_permissions');
    expect(spy.tx).toEqual(['begin', 'commit']);
  });

  it('runs every repo write on the SAME transaction (never this.db)', async () => {
    const { service, repo } = make({ restricted: true });
    await service.addPermission({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET] } as AddPagePermissionDto, admin);
    const arg = (m: jest.Mock, i: number) => (m.mock.calls[0] as unknown[])[i] as { isTransaction?: boolean } | undefined;
    const trxs = [
      arg(repo.deletePagePermissionsByUserIds, 2),
      arg(repo.deletePagePermissionsByGroupIds, 2),
      arg(repo.insertPagePermissions, 1),
    ];
    expect(trxs[0]?.isTransaction).toBe(true);
    expect(new Set(trxs).size).toBe(1);
  });

  it('answers the ACL version AFTER the write and the effect', async () => {
    const after = { restricted: true, grants: [{ userId: TARGET, groupId: null, role: 'reader' }] };
    const { service } = make({ restricted: true, after });
    await expect(
      service.addPermission({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET] } as AddPagePermissionDto, admin),
    ).resolves.toEqual({
      version: versionOf(true, after.grants),
      effect: {
        restrictedBefore: true,
        restrictedAfter: true,
        added: [{ userId: TARGET, groupId: null, role: 'reader' }],
        changed: [],
        removed: [],
      },
    });
  });

  it('drops the socket.io restriction cache only AFTER the commit', async () => {
    const { service, events } = make({ restricted: false, after: { restricted: true, grants: [] } });
    await service.restrict(PAGE_ID, admin);
    expect(events).toContain('invalidate after [begin,commit]');
  });

  it('a stale expectedVersion is a 412 before any write, rolled back; "*" and the current version pass', async () => {
    const stale = make({ restricted: true });
    await expect(
      stale.service.removePermission(
        { pageId: PAGE_ID, userIds: [TARGET], expectedVersion: 'b'.repeat(64) } as RemovePagePermissionDto,
        admin,
      ),
    ).rejects.toMatchObject({ status: 412, response: { code: 'precondition_failed' } });
    expect(stale.repo.deletePagePermissionsByUserIds).not.toHaveBeenCalled();
    expect(stale.spy.tx).toEqual(['begin', 'rollback']);

    for (const expectedVersion of ['*', versionOf(true, [])]) {
      const ok = make({ restricted: true });
      await ok.service.removePermission({ pageId: PAGE_ID, userIds: [TARGET], expectedVersion } as RemovePagePermissionDto, admin);
      expect(ok.repo.deletePagePermissionsByUserIds).toHaveBeenCalled();
    }
  });

  it('with expectedVersion, restrict compares even on an already-restricted page (412), and noops on a match', async () => {
    const stale = make({ restricted: true });
    await expect(stale.service.restrict(PAGE_ID, admin, { expectedVersion: 'b'.repeat(64) })).rejects.toMatchObject({ status: 412 });
    const match = make({ restricted: true });
    await expect(match.service.restrict(PAGE_ID, admin, { expectedVersion: versionOf(true, []) })).resolves.toMatchObject({
      version: versionOf(true, []),
      effect: { restrictedBefore: true, restrictedAfter: true, added: [], changed: [], removed: [] },
    });
    expect(match.repo.insertPageAccess).not.toHaveBeenCalled();
  });

  it('a busy engine (lock_timeout, deadlock, statement timeout) is a retryable 503 engine_busy', async () => {
    for (const code of ['55P03', '40P01', '57014']) {
      const { service } = make({
        restricted: true,
        failOn: (q) => (q.sql.includes('pg_advisory_xact_lock') ? Object.assign(new Error('busy'), { code }) : undefined),
      });
      const err = await service
        .removePermission({ pageId: PAGE_ID, userIds: [TARGET] } as RemovePagePermissionDto, admin)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'engine_busy' });
    }
  });
});

describe('restriction-preview (#616)', () => {
  it('runs the real write and rolls it back: current version, the effect, no cache invalidation', async () => {
    const after = { restricted: true, grants: [{ userId: ADMIN_ID, groupId: null, role: 'writer' }] };
    const { service, spy, repo, ws } = make({ restricted: false, after });
    await expect(service.preview({ pageId: PAGE_ID, action: 'restrict' } as RestrictionPreviewDto, admin)).resolves.toEqual({
      outcome: 'would_apply',
      version: versionOf(false, []),
      effect: {
        restrictedBefore: false,
        restrictedAfter: true,
        added: [{ userId: ADMIN_ID, groupId: null, role: 'writer' }],
        changed: [],
        removed: [],
        retainedRole: 'writer',
      },
    });
    expect(repo.insertPageAccess).toHaveBeenCalled(); // the real write ran…
    expect(spy.tx).toEqual(['begin', 'rollback']); // …and was rolled back
    expect(ws.invalidateSpaceRestrictionCache).not.toHaveBeenCalled();
  });

  it('a write that changes nothing is a noop', async () => {
    const { service } = make({ restricted: true });
    await expect(
      service.preview({ pageId: PAGE_ID, action: 'remove', userIds: [TARGET] } as RestrictionPreviewDto, admin),
    ).resolves.toMatchObject({ outcome: 'noop', version: versionOf(true, []) });
  });

  it.each([
    ['a self-grant', { action: 'add', role: 'writer', userIds: [ADMIN_ID] }, {}, 'self_grant'],
    ['a stale version', { action: 'remove', userIds: [TARGET], expectedVersion: 'b'.repeat(64) }, {}, 'precondition_failed'],
    ['an unrestricted page', { action: 'update', role: 'writer', userId: TARGET }, { restricted: false }, 'not_restricted'],
  ])('%s is { outcome: refused, code } with the current version, nothing written', async (_l, body, world, code) => {
    const { service, spy } = make({ restricted: true, ...world });
    const res = await service.preview({ pageId: PAGE_ID, ...body } as RestrictionPreviewDto, admin);
    expect(res).toMatchObject({ outcome: 'refused', code, version: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(spy.tx).not.toContain('commit');
  });

  it('an authorization failure is NOT a refusal: it throws exactly as the real route (403)', async () => {
    const { service } = make({ role: 'reader' });
    await expect(service.preview({ pageId: PAGE_ID, action: 'restrict' } as RestrictionPreviewDto, admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('add / update without a role is a 400', async () => {
    const { service } = make({});
    await expect(
      service.preview({ pageId: PAGE_ID, action: 'add', userIds: [TARGET] } as RestrictionPreviewDto, admin),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('the preview DTO accepts every field every real ACL route accepts (and validates it the same way)', async () => {
    const storage = getMetadataStorage();
    const props = (cls: new () => unknown) =>
      new Set(storage.getTargetValidationMetadatas(cls, '', true, false).map((m) => m.propertyName));
    const preview = props(RestrictionPreviewDto);
    for (const cls of [RestrictPageDto, RemoveRestrictionDto, AddPagePermissionDto, RemovePagePermissionDto, UpdatePagePermissionDto]) {
      for (const p of props(cls as never)) expect(preview.has(p)).toBe(true);
    }
    const errs = await validate(
      plainToInstance(RestrictionPreviewDto, { pageId: PAGE_ID, action: 'add', role: 'owner', userIds: ['x'] }),
    );
    expect(errs.map((e) => e.property).sort()).toEqual(['role', 'userIds']);
    expect((await validate(plainToInstance(RestrictionPreviewDto, { pageId: PAGE_ID, action: 'nuke' }))).length).toBe(1);
  });

  it('is a JWT route on the same controller as the real writes, and NOT a narrowing route (it narrows nothing)', () => {
    expect(Reflect.getMetadata('path', PageRestrictionController.prototype.restrictionPreview)).toBe('restriction-preview');
    expect(NARROWING_ROUTES.has('PageRestrictionController.restrictionPreview')).toBe(false);
    expect(NARROWING_ROUTES.has('ServiceSpaceController.previewMember')).toBe(false);
    for (const h of ['restrict', 'removeRestriction', 'addPermission', 'removePermission', 'updatePermission']) {
      expect(NARROWING_ROUTES.has(`PageRestrictionController.${h}`)).toBe(true);
    }
  });
});
