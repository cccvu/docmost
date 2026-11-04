import { CallHandler, ExecutionContext, NotFoundException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import type { AuditIngestEvent, PlatformAuditClient } from '../audit/platform-audit.client';
import type { AuthzMode } from '../mode/authz-mode';
import {
  NATIVE_SPACE_MEMBER_MUTATION_ROUTES,
  SPACE_NATIVE_MEMBER_MUTATION_REFUSED_EVENT,
  SpaceMemberMutationInterceptor,
} from './space-member-mutation.interceptor';

/**
 * SpaceMemberMutationInterceptor (#542) — NOT upstream Docmost code.
 *
 * In `AUTHZ_MODE=remote` the native space-member add/remove/change-role are refused (404) for every caller before the
 * handler (so before CASL Manage Member and the write) and each refusal is audited. Everything else — the member
 * list, another controller, native mode, a non-HTTP context — passes through untouched and writes no row.
 */
class SpaceController {
  addSpaceMember() {}
  removeSpaceMember() {}
  updateSpaceMemberRole() {}
  getSpaceMembers() {}
}
class OtherController {
  addSpaceMember() {}
}

const SPACE_ID = '0198c2a1-7b3e-7c6d-9f10-2a3b4c5d6e7f';
const USER_ID = '0198c2a1-0000-7000-8000-000000000001';
const OTHER_USER = '0198c2a1-0000-7000-8000-000000000002';
const WORKSPACE_ID = '0198c2a1-0000-7000-8000-0000000000aa';

type Req = {
  body?: unknown;
  user?: { user?: { id?: string }; workspace?: { id?: string } };
  headers?: Record<string, string>;
  raw?: { socket?: { remoteAddress?: string }; headers?: Record<string, string> };
};

const authedReq = (body: unknown): Req => ({
  body,
  user: { user: { id: USER_ID }, workspace: { id: WORKSPACE_ID } },
  headers: { 'user-agent': 'jest-agent' },
  raw: { socket: { remoteAddress: '10.0.0.7' }, headers: { 'x-forwarded-for': '203.0.113.9' } },
});

const ctx = (target: object, handler: unknown, req: Req, type = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    getClass: () => target,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

function setup(mode: AuthzMode, forward?: jest.Mock) {
  const fwd = forward ?? jest.fn().mockResolvedValue(undefined);
  const interceptor = new SpaceMemberMutationInterceptor(mode, { forward: fwd } as unknown as PlatformAuditClient);
  const handler = jest.fn(() => of('handled'));
  const next: CallHandler = { handle: handler };
  return { interceptor, next, handler, forward: fwd };
}

const P = SpaceController.prototype;
const REFUSED: Array<[string, unknown, string, Record<string, unknown>]> = [
  ['addSpaceMember', P.addSpaceMember, 'POST /api/spaces/members/add', { spaceId: SPACE_ID, userIds: [OTHER_USER], role: 'writer' }],
  ['removeSpaceMember', P.removeSpaceMember, 'POST /api/spaces/members/remove', { spaceId: SPACE_ID, userId: OTHER_USER }],
  [
    'updateSpaceMemberRole',
    P.updateSpaceMemberRole,
    'POST /api/spaces/members/change-role',
    { spaceId: SPACE_ID, groupId: OTHER_USER, role: 'admin' },
  ],
];

describe('SpaceMemberMutationInterceptor (#542)', () => {
  it('refuses exactly the three native SpaceController member mutations', () => {
    expect([...NATIVE_SPACE_MEMBER_MUTATION_ROUTES.keys()].sort()).toEqual([
      'SpaceController.addSpaceMember',
      'SpaceController.removeSpaceMember',
      'SpaceController.updateSpaceMemberRole',
    ]);
  });

  describe('AUTHZ_MODE=remote', () => {
    it.each(REFUSED)('%s: 404s before the handler and forwards one refusal row', async (_name, handlerFn, route, body) => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(
        lastValueFrom(interceptor.intercept(ctx(SpaceController, handlerFn, authedReq(body)), next)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handler).not.toHaveBeenCalled();
      expect(forward).toHaveBeenCalledTimes(1);
      const [events] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(events).toEqual([
        {
          event: SPACE_NATIVE_MEMBER_MUTATION_REFUSED_EVENT,
          resourceType: 'space',
          resourceId: SPACE_ID,
          actorId: USER_ID,
          actorType: 'user',
          workspaceId: WORKSPACE_ID,
          clientEvidence: { socketPeer: '10.0.0.7', forwardedFor: '203.0.113.9' },
          userAgent: 'jest-agent',
          metadata: { outcome: 'denied', reason: 'platform_only', route },
        },
      ]);
      expect(events[0]).not.toHaveProperty('spaceId');
      expect(SPACE_NATIVE_MEMBER_MUTATION_REFUSED_EVENT).toBe('space.native_member_mutation_refused');
    });

    it.each([
      ['add: userIds contains self', P.addSpaceMember, { spaceId: SPACE_ID, userIds: [OTHER_USER, USER_ID], role: 'writer' }],
      ['change-role: userId is self', P.updateSpaceMemberRole, { spaceId: SPACE_ID, userId: USER_ID, role: 'admin' }],
      ['remove: userId is self', P.removeSpaceMember, { spaceId: SPACE_ID, userId: USER_ID }],
    ])('flags a request that names the actor (%s) as targetsActor (the #542 self-grant shape)', async (_label, handlerFn, body) => {
      const { interceptor, next, forward } = setup('remote');
      await expect(
        lastValueFrom(interceptor.intercept(ctx(SpaceController, handlerFn, authedReq(body)), next)),
      ).rejects.toBeInstanceOf(NotFoundException);
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row.metadata).toMatchObject({ targetsActor: true });
    });

    it.each([
      ['a slug', { spaceId: 'engineering', userIds: [USER_ID] }],
      ['a non-string id', { spaceId: { $ne: null } }],
      ['no spaceId', {}],
      ['a null body', null],
      ['an array body', [SPACE_ID]],
      ['a string body', SPACE_ID],
    ])('404s %s without echoing it into the audit row', async (_label, body) => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(
        lastValueFrom(interceptor.intercept(ctx(SpaceController, P.addSpaceMember, authedReq(body)), next)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handler).not.toHaveBeenCalled();
      const [[row]] = forward.mock.calls[0] as [AuditIngestEvent[]];
      expect(row.resourceId).toBeUndefined();
      expect(row.metadata).toMatchObject({ invalidSpaceId: true, route: 'POST /api/spaces/members/add' });
      expect(JSON.stringify(row)).not.toContain('engineering');
    });

    it('still 404s, and writes no unattributable row, when there is no authenticated user', async () => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(
        lastValueFrom(interceptor.intercept(ctx(SpaceController, P.addSpaceMember, { body: { spaceId: SPACE_ID } }), next)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handler).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
    });

    it.each([
      ['rejects', jest.fn().mockRejectedValue(new Error('sink down'))],
      [
        'throws synchronously',
        jest.fn(() => {
          throw new Error('boom');
        }),
      ],
    ])('an audit forward that %s never changes the outcome', async (_label, fwd) => {
      const { interceptor, next, handler } = setup('remote', fwd);
      await expect(
        lastValueFrom(
          interceptor.intercept(ctx(SpaceController, P.addSpaceMember, authedReq({ spaceId: SPACE_ID })), next),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('everything else passes through with no row', () => {
    it.each([
      ['the member list on SpaceController', ctx(SpaceController, P.getSpaceMembers, authedReq({ spaceId: SPACE_ID }))],
      ['a same-named handler on another controller', ctx(OtherController, OtherController.prototype.addSpaceMember, authedReq({ spaceId: SPACE_ID }))],
      ['a non-HTTP context', ctx(SpaceController, P.addSpaceMember, authedReq({ spaceId: SPACE_ID }), 'ws')],
    ])('remote: %s', async (_label, context) => {
      const { interceptor, next, handler, forward } = setup('remote');
      await expect(lastValueFrom(interceptor.intercept(context, next))).resolves.toBe('handled');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
    });

    it.each(REFUSED)('native mode: %s stays reachable (standalone)', async (_name, handlerFn, _route, body) => {
      const { interceptor, next, handler, forward } = setup('native');
      await expect(
        lastValueFrom(interceptor.intercept(ctx(SpaceController, handlerFn, authedReq(body)), next)),
      ).resolves.toBe('handled');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(forward).not.toHaveBeenCalled();
    });
  });
});
