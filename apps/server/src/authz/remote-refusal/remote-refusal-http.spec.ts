import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

// Factory mocks (not automock — automock loads the real module to introspect it) keep the controllers' import graphs
// off bullmq / the database / the email templates. Each boot injects fresh stubs for exactly what the handlers touch.
jest.mock('../../core/space/services/space.service', () => ({ __esModule: true, SpaceService: class SpaceService {} }));
jest.mock('../../core/space/services/space-member.service', () => ({
  __esModule: true,
  SpaceMemberService: class SpaceMemberService {},
}));
jest.mock('@docmost/db/repos/space/space-member.repo', () => ({
  __esModule: true,
  SpaceMemberRepo: class SpaceMemberRepo {},
}));
jest.mock('../../core/workspace/services/workspace.service', () => ({
  __esModule: true,
  WorkspaceService: class WorkspaceService {},
}));
jest.mock('../../core/workspace/services/workspace-invitation.service', () => ({
  __esModule: true,
  WorkspaceInvitationService: class WorkspaceInvitationService {},
}));
jest.mock('@docmost/db/repos/workspace/workspace.repo', () => ({ __esModule: true, WorkspaceRepo: class WorkspaceRepo {} }));
jest.mock('../../integrations/environment/environment.service', () => ({
  __esModule: true,
  EnvironmentService: class EnvironmentService {},
}));
jest.mock('../../integrations/environment/license-check.service', () => ({
  __esModule: true,
  LicenseCheckService: class LicenseCheckService {},
}));
jest.mock('../../core/group/services/group.service', () => ({ __esModule: true, GroupService: class GroupService {} }));
jest.mock('../../core/group/services/group-user.service', () => ({
  __esModule: true,
  GroupUserService: class GroupUserService {},
}));
jest.mock('../../core/user/user.service', () => ({ __esModule: true, UserService: class UserService {} }));

import { SpaceController } from '../../core/space/space.controller';
import { SpaceService } from '../../core/space/services/space.service';
import { SpaceMemberService } from '../../core/space/services/space-member.service';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { WorkspaceController } from '../../core/workspace/controllers/workspace.controller';
import { WorkspaceService } from '../../core/workspace/services/workspace.service';
import { WorkspaceInvitationService } from '../../core/workspace/services/workspace-invitation.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { LicenseCheckService } from '../../integrations/environment/license-check.service';
import { GroupController } from '../../core/group/group.controller';
import { GroupService } from '../../core/group/services/group.service';
import { GroupUserService } from '../../core/group/services/group-user.service';
import { UserController } from '../../core/user/user.controller';
import { UserService } from '../../core/user/user.service';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAuditClient } from '../audit/platform-audit.client';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { RemoteNativeRefusalInterceptor } from './remote-refusal.interceptor';
import { REMOTE_REFUSED_ROUTES } from './remote-refusal.table';

/**
 * HTTP-boundary proof of the whole remote refusal table (#636) — NOT upstream Docmost code.
 *
 * Boots the REAL upstream Workspace, Group, Space and User controllers on Fastify with the REAL
 * RemoteNativeRefusalInterceptor registered as app.module.ts registers it (a global APP_INTERCEPTOR) and main.ts's
 * ValidationPipe, and sends EVERY table key a request the upstream handler would accept. The caller is an engine
 * OWNER whom workspace and space CASL both ALLOW — the native-phase session remote mode used to rely on never
 * existing. (Workspace CASL is a stub on purpose: this proves the refusal alone, whatever the remote
 * WorkspaceAbilityFactory rebind decides.) For each key:
 *  - remote: 404, the handler's service is never called, and exactly one refusal row of the family's event;
 *  - remote WITHOUT the interceptor: 200 and the service runs (anti-vacuity: the 404 is the interceptor's, not CASL's
 *    or the pipe's, and the request really is one the handler accepts);
 *  - native: 200 and the service runs, with no refusal row (standalone keeps every upstream route).
 * A real request also proves the key matches the class and method names Nest hands the interceptor, which the
 * unit spec (which builds its contexts from the table's own strings) cannot.
 */
const USER = { id: '0198c2a1-0000-7000-8000-000000000001', role: 'owner' };
const WORKSPACE = { id: '0198c2a1-0000-7000-8000-0000000000aa', hostname: 'acme' };
const SPACE_ID = '0198c2a1-7b3e-7c6d-9f10-2a3b4c5d6e7f';
const GROUP_ID = '0198c2a1-7b3e-7c6d-9f10-00000000000b';
const OTHER_USER_ID = '0198c2a1-0000-7000-8000-000000000002';
const INVITATION_ID = '0198c2a1-7b3e-7c6d-9f10-00000000000c';

type Svc =
  | 'space'
  | 'spaceMember'
  | 'workspace'
  | 'invitation'
  | 'group'
  | 'groupUser'
  | 'user';

/** Per table key: a body the upstream handler accepts, and the service call it makes. */
const REQUESTS: Record<string, { body: Record<string, unknown>; svc: Svc; method: string }> = {
  'SpaceController.deleteSpace': { body: { spaceId: SPACE_ID }, svc: 'space', method: 'deleteSpace' },
  'SpaceController.createSpace': { body: { name: 'Native Space', slug: 'native-space' }, svc: 'space', method: 'createSpace' },
  'WorkspaceController.updateWorkspace': { body: { name: 'Renamed' }, svc: 'workspace', method: 'update' },
  'WorkspaceController.deactivateWorkspaceMember': {
    body: { userId: OTHER_USER_ID },
    svc: 'workspace',
    method: 'deactivateUser',
  },
  'WorkspaceController.activateWorkspaceMember': { body: { userId: OTHER_USER_ID }, svc: 'workspace', method: 'activateUser' },
  'WorkspaceController.deleteWorkspaceMember': { body: { userId: OTHER_USER_ID }, svc: 'workspace', method: 'deleteUser' },
  'WorkspaceController.updateWorkspaceMemberRole': {
    body: { userId: OTHER_USER_ID, role: 'admin' },
    svc: 'workspace',
    method: 'updateWorkspaceUserRole',
  },
  'WorkspaceController.inviteUser': {
    body: { emails: ['new@example.com'], role: 'admin' },
    svc: 'invitation',
    method: 'createInvitation',
  },
  'WorkspaceController.resendInvite': { body: { invitationId: INVITATION_ID }, svc: 'invitation', method: 'resendInvitation' },
  'WorkspaceController.revokeInvite': { body: { invitationId: INVITATION_ID }, svc: 'invitation', method: 'revokeInvitation' },
  'WorkspaceController.getInviteLink': {
    body: { invitationId: INVITATION_ID },
    svc: 'invitation',
    method: 'getInvitationLinkById',
  },
  'GroupController.createGroup': { body: { name: 'Owners' }, svc: 'group', method: 'createGroup' },
  'GroupController.updateGroup': { body: { groupId: GROUP_ID, name: 'Owners 2' }, svc: 'group', method: 'updateGroup' },
  'GroupController.addGroupMember': {
    body: { groupId: GROUP_ID, userIds: [USER.id] },
    svc: 'groupUser',
    method: 'addUsersToGroupBatch',
  },
  'GroupController.removeGroupMember': {
    body: { groupId: GROUP_ID, userId: OTHER_USER_ID },
    svc: 'groupUser',
    method: 'removeUserFromGroup',
  },
  'GroupController.deleteGroup': { body: { groupId: GROUP_ID }, svc: 'group', method: 'deleteGroup' },
  'SpaceController.addSpaceMember': {
    body: { spaceId: SPACE_ID, role: 'admin', userIds: [USER.id], groupIds: [] },
    svc: 'spaceMember',
    method: 'addMembersToSpaceBatch',
  },
  'SpaceController.removeSpaceMember': {
    body: { spaceId: SPACE_ID, userId: OTHER_USER_ID },
    svc: 'spaceMember',
    method: 'removeMemberFromSpace',
  },
  'SpaceController.updateSpaceMemberRole': {
    body: { spaceId: SPACE_ID, userId: USER.id, role: 'admin' },
    svc: 'spaceMember',
    method: 'updateSpaceMemberRole',
  },
  'UserController.updateUser': {
    body: { email: 'owner@shadow.wiki-v2.internal', confirmPassword: 'correct-horse' },
    svc: 'user',
    method: 'update',
  },
  // #797 directoryRead
  'WorkspaceController.getWorkspaceMembers': { body: {}, svc: 'workspace', method: 'getWorkspaceUsers' },
  'WorkspaceController.getInvitations': { body: {}, svc: 'invitation', method: 'getInvitations' },
  'GroupController.getWorkspaceGroups': { body: {}, svc: 'group', method: 'getWorkspaceGroups' },
  'GroupController.getGroup': { body: { groupId: GROUP_ID }, svc: 'group', method: 'getGroupInfo' },
  'GroupController.getGroupMembers': { body: { groupId: GROUP_ID }, svc: 'groupUser', method: 'getGroupUsers' },
  'SpaceController.getSpaceMembers': { body: { spaceId: SPACE_ID }, svc: 'spaceMember', method: 'getSpaceMembers' },
};

const stubService = (methods: string[]) =>
  Object.fromEntries(methods.map((m) => [m, jest.fn().mockResolvedValue({ ok: true, hostname: WORKSPACE.hostname })]));

async function bootApp(mode: AuthzMode, { withRefusal = true } = {}) {
  const methodsOf = (svc: Svc) => Object.values(REQUESTS).filter((r) => r.svc === svc).map((r) => r.method);
  const services: Record<Svc, Record<string, jest.Mock>> = {
    space: stubService([...methodsOf('space'), 'getSpaceInfo']), // + one read, to show reads stay reachable
    spaceMember: stubService(methodsOf('spaceMember')),
    workspace: stubService(methodsOf('workspace')),
    invitation: stubService(methodsOf('invitation')),
    group: stubService(methodsOf('group')),
    groupUser: stubService(methodsOf('groupUser')),
    user: stubService(methodsOf('user')),
  };
  // An engine OWNER: both CASL factories ALLOW everything (upstream's workspace createForUser is sync, space's async).
  const allow = { cannot: () => false, can: () => true };
  const workspaceCreateForUser = jest.fn(() => allow);
  const spaceCreateForUser = jest.fn().mockResolvedValue(allow);
  const forward = jest.fn().mockResolvedValue(undefined);

  const moduleRef = await Test.createTestingModule({
    controllers: [WorkspaceController, GroupController, SpaceController, UserController],
    providers: [
      { provide: AUTHZ_MODE, useValue: mode },
      { provide: PlatformAuditClient, useValue: { forward } },
      ...(withRefusal ? [{ provide: APP_INTERCEPTOR, useClass: RemoteNativeRefusalInterceptor }] : []),
      { provide: SpaceService, useValue: services.space },
      { provide: SpaceMemberService, useValue: services.spaceMember },
      { provide: SpaceMemberRepo, useValue: { getUserSpaceRoles: jest.fn().mockResolvedValue([]) } },
      { provide: WorkspaceService, useValue: services.workspace },
      { provide: WorkspaceInvitationService, useValue: services.invitation },
      { provide: WorkspaceRepo, useValue: {} },
      { provide: EnvironmentService, useValue: { isCloud: () => false } },
      { provide: LicenseCheckService, useValue: {} },
      { provide: GroupService, useValue: services.group },
      { provide: GroupUserService, useValue: services.groupUser },
      { provide: UserService, useValue: services.user },
      { provide: SpaceAbilityFactory, useValue: { createForUser: spaceCreateForUser } },
      { provide: WorkspaceAbilityFactory, useValue: { createForUser: workspaceCreateForUser } },
    ],
  })
    // The real JwtAuthGuard's contract: an authenticated request carries `req.user = { user, workspace }`.
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (ctx: any) => {
        ctx.switchToHttp().getRequest().user = { user: USER, workspace: WORKSPACE };
        return true;
      },
    })
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, services, forward, workspaceCreateForUser, spaceCreateForUser };
}

type Booted = Awaited<ReturnType<typeof bootApp>>;

// The table's `route` is `POST /api/<path>`; the test app has no global `api` prefix.
const CASES = [...REMOTE_REFUSED_ROUTES].map(([key, hit]) => ({
  key,
  event: hit.family.event,
  url: hit.entry.route.replace(/^POST \/api/, ''),
  ...REQUESTS[key],
}));

const post = (h: Booted, url: string, payload: unknown) =>
  h.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

const serviceCalls = (h: Booted) =>
  Object.values(h.services).reduce((n, svc) => n + Object.values(svc).reduce((m, fn) => m + fn.mock.calls.length, 0), 0);

describe('every remote refusal key over HTTP (#636)', () => {
  it('has a request for every table key, and no request for a key that is not in the table', () => {
    expect(Object.keys(REQUESTS).sort()).toEqual([...REMOTE_REFUSED_ROUTES.keys()].sort());
  });

  describe('AUTHZ_MODE=remote', () => {
    let h: Booted;
    beforeAll(async () => {
      h = await bootApp('remote');
    });
    afterAll(async () => {
      await h?.app.close();
    });
    beforeEach(() => jest.clearAllMocks());

    it.each(CASES.map((c) => [c.key, c] as const))('%s: an OWNER gets a 404, no service call, one row', async (_k, c) => {
      const res = await post(h, c.url, c.body);
      expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
      expect(serviceCalls(h)).toBe(0);
      expect(h.workspaceCreateForUser).not.toHaveBeenCalled();
      expect(h.spaceCreateForUser).not.toHaveBeenCalled();
      expect(h.forward).toHaveBeenCalledTimes(1);
      const [[row]] = h.forward.mock.calls[0];
      expect(row).toMatchObject({ event: c.event, actorId: USER.id, metadata: { actorRole: 'owner' } });
    });

    it.each([
      ['an empty body', {}],
      ['a null body', null],
    ])('the refusal runs before ValidationPipe: %s on a refused route is a 404, not a 400', async (_l, payload) => {
      for (const url of ['/groups/create', '/workspace/members/change-role', '/spaces/members/add']) {
        const res = await post(h, url, payload);
        expect([url, res.statusCode]).toEqual([url, HttpStatus.NOT_FOUND]);
      }
      expect(serviceCalls(h)).toBe(0);
    });

    it('users/update without an email is not refused: the name form still works', async () => {
      const res = await post(h, '/users/update', { name: 'New Name' });
      expect(res.statusCode).toBe(HttpStatus.OK);
      expect(h.services.user.update).toHaveBeenCalledTimes(1);
      expect(h.forward).not.toHaveBeenCalled();
    });

    it('a read outside the directory on a refused controller stays reachable (the SPA uses it as a member)', async () => {
      const res = await post(h, '/spaces/info', { spaceId: SPACE_ID });
      expect(res.statusCode).toBe(HttpStatus.OK);
      expect(h.services.space.getSpaceInfo).toHaveBeenCalledTimes(1);
      expect(h.forward).not.toHaveBeenCalled();
    });
  });

  describe('AUTHZ_MODE=remote WITHOUT the interceptor (anti-vacuity)', () => {
    let h: Booted;
    beforeAll(async () => {
      h = await bootApp('remote', { withRefusal: false });
    });
    afterAll(async () => {
      await h?.app.close();
    });
    beforeEach(() => jest.clearAllMocks());

    it.each(CASES.map((c) => [c.key, c] as const))('%s: the same OWNER request is a 200 and the service runs', async (_k, c) => {
      const res = await post(h, c.url, c.body);
      expect(res.statusCode).toBe(HttpStatus.OK);
      expect(h.services[c.svc][c.method]).toHaveBeenCalledTimes(1);
    });
  });

  describe('AUTHZ_MODE=native (standalone keeps every upstream route)', () => {
    let h: Booted;
    beforeAll(async () => {
      h = await bootApp('native');
    });
    afterAll(async () => {
      await h?.app.close();
    });
    beforeEach(() => jest.clearAllMocks());

    it.each(CASES.map((c) => [c.key, c] as const))('%s: 200, the service runs, no refusal row', async (_k, c) => {
      const res = await post(h, c.url, c.body);
      expect(res.statusCode).toBe(HttpStatus.OK);
      expect(h.services[c.svc][c.method]).toHaveBeenCalledTimes(1);
      expect(h.forward).not.toHaveBeenCalled();
    });

    it('keeps the upstream validation (an empty body is a 400, not a refusal)', async () => {
      const res = await post(h, '/groups/create', {});
      expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(h.forward).not.toHaveBeenCalled();
    });
  });
});
