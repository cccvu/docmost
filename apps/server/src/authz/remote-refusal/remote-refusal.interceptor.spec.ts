import { CallHandler, ExecutionContext, NotFoundException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import type { AuditIngestEvent, PlatformAuditClient } from '../audit/platform-audit.client';
import type { AuthzMode } from '../mode/authz-mode';
import { RemoteNativeRefusalInterceptor } from './remote-refusal.interceptor';
import {
  REMOTE_REFUSAL_FAMILIES,
  REMOTE_REFUSED_ROUTES,
  RefusalFamily,
  RefusedRoute,
  buildRefusalIndex,
  changesEmail,
  routesOf,
} from './remote-refusal.table';

/**
 * RemoteNativeRefusalInterceptor (#502, #598, #636) — NOT upstream Docmost code.
 *
 * Parametrised over EVERY (family, key) of the table, so a new entry is covered the moment it is added: in remote mode
 * it is a 404 before the handler, with exactly one row whose shape is the family's and which never echoes the body;
 * native mode, a non-HTTP context, another handler on the same class and the same handler name on another class all
 * pass through with no row. The #502 and #598 specs beside this one keep their family-specific cases.
 */
const USER_ID = '0198c2a1-0000-7000-8000-000000000001';
const WORKSPACE_ID = '0198c2a1-0000-7000-8000-0000000000aa';
const TARGET_ID = '0198c2a1-7b3e-7c6d-9f10-2a3b4c5d6e7f';
const CANARY = 'Secret Project Falcon';
const NO_ROLE = Symbol('no role');

type Req = {
  body?: unknown;
  user?: { user?: { id?: string; role?: unknown }; workspace?: { id?: string } };
  headers?: Record<string, string>;
  raw?: { socket?: { remoteAddress?: string }; headers?: Record<string, string> };
};

const authedReq = (body: unknown, role: unknown = 'member'): Req => ({
  body,
  user: { user: { id: USER_ID, role }, workspace: { id: WORKSPACE_ID } },
  headers: { 'user-agent': 'jest-agent' },
  raw: { socket: { remoteAddress: '10.0.0.7' }, headers: { 'x-forwarded-for': '203.0.113.9' } },
});

// A class and a handler whose runtime `.name`s are exactly the table key's — what Nest hands the interceptor.
const namedClass = (name: string) => ({ [name]: class {} })[name];
const namedFn = (name: string) => ({ [name]: () => undefined })[name];

const ctx = (className: string, handlerName: string, req: Req, type = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    getClass: () => namedClass(className),
    getHandler: () => namedFn(handlerName),
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

function setup(mode: AuthzMode, forward?: jest.Mock) {
  const fwd = forward ?? jest.fn().mockResolvedValue(undefined);
  const interceptor = new RemoteNativeRefusalInterceptor(mode, { forward: fwd } as unknown as PlatformAuditClient);
  const handler = jest.fn(() => of('handled'));
  const next: CallHandler = { handle: handler };
  return { interceptor, next, handler, forward: fwd };
}

/** A body the entry refuses, carrying a free-text canary and (where the entry records one) the target id. */
const refusedBody = (entry: RefusedRoute) => ({
  name: CANARY,
  ...(entry.resourceIdField ? { [entry.resourceIdField]: TARGET_ID } : {}),
  ...(entry.when ? { email: 'falcon@shadow.wiki-v2.internal' } : {}),
});

const CASES: [string, RefusalFamily, string, RefusedRoute][] = REMOTE_REFUSAL_FAMILIES.flatMap((f) =>
  [...f.routes].map(([key, entry]) => [`${f.id} ${key}`, f, key, entry] as [string, RefusalFamily, string, RefusedRoute]),
);

const run = (interceptor: RemoteNativeRefusalInterceptor, context: ExecutionContext, next: CallHandler) =>
  lastValueFrom(interceptor.intercept(context, next));

describe('RemoteNativeRefusalInterceptor — every table key (#636)', () => {
  it('the parametrisation is not vacuous: every family contributes and every key is a case', () => {
    expect(new Set(CASES.map(([, f]) => f.id))).toEqual(
      new Set(['spaceHardDelete', 'spaceNativeCreate', 'workspaceAdmin', 'groupAdmin', 'spaceMember', 'userEmail', 'directoryRead']),
    );
    expect(CASES).toHaveLength(REMOTE_REFUSED_ROUTES.size);
    expect(REMOTE_REFUSED_ROUTES.size).toBe(26); // 1 + 1 + 9 + 5 + 3 + 1 + 6 (#797 directoryRead)
  });

  describe.each(CASES)('%s', (_label, family, key, entry) => {
    const [className, handlerName] = key.split('.');

    it('remote: 404 before the handler, exactly one row in the family shape, the body never echoed', async () => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(run(interceptor, ctx(className, handlerName, authedReq(refusedBody(entry))), next)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(handler).not.toHaveBeenCalled();
      expect(forward).toHaveBeenCalledTimes(1);
      const [events] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(events).toEqual([
        {
          event: family.event,
          resourceType: family.resourceType,
          ...(entry.resourceIdField ? { resourceId: TARGET_ID } : {}),
          actorId: USER_ID,
          actorType: 'user',
          workspaceId: WORKSPACE_ID,
          clientEvidence: { socketPeer: '10.0.0.7', forwardedFor: '203.0.113.9' },
          userAgent: 'jest-agent',
          metadata: { outcome: 'denied', reason: family.reason, route: entry.route, actorRole: 'member' },
        },
      ]);
      const text = JSON.stringify(events);
      expect(text).not.toContain('Falcon');
      expect(text).not.toContain('falcon@');
    });

    it('remote: a sink that rejects, or throws synchronously, still gives the 404', async () => {
      for (const fwd of [
        jest.fn().mockRejectedValue(new Error('sink down')),
        jest.fn(() => {
          throw new Error('boom');
        }),
      ]) {
        const { interceptor, next, handler } = setup('remote', fwd);
        await expect(run(interceptor, ctx(className, handlerName, authedReq(refusedBody(entry))), next)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(handler).not.toHaveBeenCalled();
      }
    });

    it('remote: no authenticated user is still a 404, with no unattributable row', async () => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(run(interceptor, ctx(className, handlerName, { body: refusedBody(entry) }), next)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(handler).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
    });

    it.each([
      ['native mode', 'native', className, handlerName, 'http'],
      ['a non-HTTP context', 'remote', className, handlerName, 'ws'],
      ['another handler on the same class', 'remote', className, 'notARefusedHandler', 'http'],
      ['the same handler name on another class', 'remote', 'OtherController', handlerName, 'http'],
    ] as const)('passes through with no row: %s', async (_l, mode, cls, h, type) => {
      const { interceptor, next, handler, forward } = setup(mode);
      await expect(run(interceptor, ctx(cls, h, authedReq(refusedBody(entry)), type), next)).resolves.toBe('handled');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
    });
  });

  describe('the actor role is recorded only as a known enum value', () => {
    const groupCreate = (role: unknown) => ctx('GroupController', 'createGroup', authedReq({ name: CANARY }, role));
    it.each(['owner', 'admin', 'member'])('%s is recorded', async (role) => {
      const { interceptor, next, forward } = setup('remote');
      await expect(run(interceptor, groupCreate(role), next)).rejects.toBeInstanceOf(NotFoundException);
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row.metadata).toMatchObject({ actorRole: role });
    });
    it.each([
      ['an unknown role string', 'superuser'],
      ['a non-string role', { $ne: null }],
      ['no role', NO_ROLE],
    ])('%s is omitted', async (_l, role) => {
      const { interceptor, next, forward } = setup('remote');
      const context = groupCreate(role);
      if (role === NO_ROLE) delete (context.switchToHttp().getRequest() as Req).user!.user!.role;
      await expect(run(interceptor, context, next)).rejects.toBeInstanceOf(NotFoundException);
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row.metadata).toEqual({ outcome: 'denied', reason: 'platform_only', route: 'POST /api/groups/create' });
    });
  });

  describe('a resourceIdField is recorded only as a UUID (the #502 shape, for every family that has one)', () => {
    it.each([
      ['a slug', { groupId: 'engineering' }],
      ['a non-string id', { groupId: { $ne: null } }],
      ['no id', {}],
      ['a null body', null],
      ['an array body', [TARGET_ID]],
    ])('%s → no resourceId, invalidGroupId', async (_l, body) => {
      const { interceptor, next, forward } = setup('remote');
      await expect(run(interceptor, ctx('GroupController', 'deleteGroup', authedReq(body)), next)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row).not.toHaveProperty('resourceId');
      expect(row.metadata).toEqual({
        outcome: 'denied',
        reason: 'platform_only',
        route: 'POST /api/groups/delete',
        invalidGroupId: true,
        actorRole: 'member',
      });
      expect(JSON.stringify(row)).not.toContain('engineering');
    });

    it('a body getter that throws still gives the 404 and the row, as an invalid id', async () => {
      const { interceptor, next, forward } = setup('remote');
      const req = authedReq(undefined);
      Object.defineProperty(req, 'body', {
        get() {
          throw new Error('hostile body');
        },
      });
      await expect(run(interceptor, ctx('SpaceController', 'addSpaceMember', req), next)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row.metadata).toMatchObject({ invalidSpaceId: true });
    });
  });

  describe('a member write that names the caller is flagged targetsActor (the #542 self-grant shape)', () => {
    const OTHER_USER = '0198c2a1-0000-7000-8000-000000000002';
    it.each([
      ['add: userIds contains self', 'addSpaceMember', { spaceId: TARGET_ID, userIds: [OTHER_USER, USER_ID], role: 'writer' }],
      ['change-role: userId is self', 'updateSpaceMemberRole', { spaceId: TARGET_ID, userId: USER_ID, role: 'admin' }],
      ['remove: userId is self', 'removeSpaceMember', { spaceId: TARGET_ID, userId: USER_ID }],
    ])('%s', async (_l, handlerName, body) => {
      const { interceptor, next, forward } = setup('remote');
      await expect(run(interceptor, ctx('SpaceController', handlerName, authedReq(body)), next)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row.metadata).toMatchObject({ targetsActor: true });
    });

    it.each([
      ['another user', 'addSpaceMember', { spaceId: TARGET_ID, userIds: [OTHER_USER] }],
      ['the wrong field (userId on add)', 'addSpaceMember', { spaceId: TARGET_ID, userId: USER_ID }],
      ['a non-array, non-string value', 'removeSpaceMember', { spaceId: TARGET_ID, userId: { id: USER_ID } }],
      ['a self-add to a group (not a space-member family field)', 'addGroupMember', { groupId: TARGET_ID, userIds: [USER_ID] }],
    ])('not for %s', async (_l, handlerName, body) => {
      const { interceptor, next, forward } = setup('remote');
      const cls = handlerName === 'addGroupMember' ? 'GroupController' : 'SpaceController';
      await expect(run(interceptor, ctx(cls, handlerName, authedReq(body)), next)).rejects.toBeInstanceOf(NotFoundException);
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row.metadata).not.toHaveProperty('targetsActor');
    });

    it('only the three space-member routes carry a target field', () => {
      const withTarget = [...REMOTE_REFUSED_ROUTES].filter(([, h]) => h.entry.targetUserField).map(([k]) => k).sort();
      expect(withTarget).toEqual([...routesOf('spaceMember')].sort());
    });
  });

  describe('UserController.updateUser is refused only when the body names email (fail closed)', () => {
    const update = (req: Req) => ctx('UserController', 'updateUser', req);
    it.each([
      ['{email}', { email: 'a@shadow.wiki-v2.internal' }],
      ['{email: null}', { email: null }],
      ['{email} with other fields', { name: 'x', email: 'a@b.c', confirmPassword: 'p' }],
      ['an own email key on a null-prototype body', Object.assign(Object.create(null), { email: 'a@b.c' })],
    ])('refuses %s', async (_l, body) => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(run(interceptor, update(authedReq(body)), next)).rejects.toBeInstanceOf(NotFoundException);
      expect(handler).not.toHaveBeenCalled();
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row).toMatchObject({ event: 'user.native_email_change_refused', resourceType: 'user' });
      expect(JSON.stringify(row)).not.toContain('a@');
    });

    it('refuses when reading the body throws (fail closed)', async () => {
      const { interceptor, next, handler } = setup('remote');
      const req = authedReq(undefined);
      Object.defineProperty(req, 'body', {
        get() {
          throw new Error('hostile body');
        },
      });
      await expect(run(interceptor, update(req), next)).rejects.toBeInstanceOf(NotFoundException);
      expect(handler).not.toHaveBeenCalled();
    });

    it.each([
      ['{name}', { name: 'New Name' }],
      ['{fullPageWidth}', { fullPageWidth: true }],
      ['an inherited email (not an own key)', Object.create({ email: 'a@b.c' })],
      ['a null body', null],
      ['an array body', [{ email: 'a@b.c' }]],
      ['a string body', '{"email":"a@b.c"}'],
      ['no body', undefined],
    ])('passes %s through', async (_l, body) => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(run(interceptor, update(authedReq(body)), next)).resolves.toBe('handled');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
    });

    it('the predicate is the table’s, and it is pure', () => {
      expect(REMOTE_REFUSED_ROUTES.get('UserController.updateUser')?.entry.when).toBe(changesEmail);
      expect(changesEmail({ email: 'x' })).toBe(true);
      expect(changesEmail({ name: 'x' })).toBe(false);
    });
  });

  describe('the table', () => {
    it('pins the event names and reasons as literals (they are the audit contract)', () => {
      expect(REMOTE_REFUSAL_FAMILIES.map((f) => [f.id, f.event, f.resourceType, f.reason])).toEqual([
        ['spaceHardDelete', 'space.hard_delete_refused', 'space', 'archive_only'],
        ['spaceNativeCreate', 'space.native_create_refused', 'space', 'platform_only'],
        ['workspaceAdmin', 'workspace.native_admin_refused', 'workspace', 'platform_only'],
        ['groupAdmin', 'group.native_admin_refused', 'group', 'platform_only'],
        ['spaceMember', 'space.native_member_refused', 'space', 'platform_only'],
        ['userEmail', 'user.native_email_change_refused', 'user', 'identity_platform_owned'],
        ['directoryRead', 'directory.native_read_refused', 'workspace', 'directory_platform_owned'], // #797
      ]);
    });

    it('only the email change carries a predicate', () => {
      const withWhen = [...REMOTE_REFUSED_ROUTES].filter(([, h]) => h.entry.when).map(([k]) => k);
      expect(withWhen).toEqual(['UserController.updateUser']);
    });

    it('buildRefusalIndex throws on a key in two families', () => {
      const a = REMOTE_REFUSAL_FAMILIES[0];
      expect(() => buildRefusalIndex([a, { ...a, id: 'groupAdmin' }])).toThrow(/SpaceController\.deleteSpace is in two families/);
    });

    it('routesOf throws on an unknown family, so a typo cannot read as an empty set', () => {
      expect(() => routesOf('nope' as never)).toThrow(/unknown family/);
    });
  });
});
