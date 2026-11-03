import { Global, HttpStatus, Module, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

// Factory mocks (not automock — automock loads the real module to introspect it) keep the controller's import
// graph off bullmq / the database / the email templates. The native block injects stubs for what the handlers touch.
jest.mock('../../core/space/services/space.service', () => ({
  __esModule: true,
  SpaceService: class SpaceService {},
}));
jest.mock('../../core/space/services/space-member.service', () => ({
  __esModule: true,
  SpaceMemberService: class SpaceMemberService {},
}));
jest.mock('@docmost/db/repos/space/space-member.repo', () => ({
  __esModule: true,
  SpaceMemberRepo: class SpaceMemberRepo {},
}));

import { SpaceController } from '../../core/space/space.controller';
import { SpaceService } from '../../core/space/services/space.service';
import { SpaceMemberService } from '../../core/space/services/space-member.service';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAuditClient } from '../audit/platform-audit.client';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { NativeRouteAuthzModule } from './native-route-authz.module';

/**
 * HTTP-boundary proof of #542 — NOT upstream Docmost code.
 *
 * Boots the REAL upstream SpaceController on Fastify with the REAL NativeRouteAuthzModule (so the interceptor is
 * registered exactly as the app registers it) and main.ts's ValidationPipe, and proves:
 *  - remote: a manager's self-add, a remove and a change-role are 404s — also for an empty body, so the refusal runs
 *    before the pipe — and neither CASL Manage Member nor the member service is ever reached; one row per refusal;
 *  - native (standalone): the upstream routes are untouched — CASL is consulted and the write runs, no row.
 */
const USER = { id: '0198c2a1-0000-7000-8000-000000000001' };
const WORKSPACE = { id: '0198c2a1-0000-7000-8000-0000000000aa' };
const SPACE_ID = '0198c2a1-7b3e-7c6d-9f10-2a3b4c5d6e7f';
const OTHER = '0198c2a1-0000-7000-8000-000000000002';

async function bootApp(mode: AuthzMode) {
  const members = {
    addMembersToSpaceBatch: jest.fn().mockResolvedValue(undefined),
    removeMemberFromSpace: jest.fn().mockResolvedValue(undefined),
    updateSpaceMemberRole: jest.fn().mockResolvedValue(undefined),
  };
  const createForUser = jest.fn().mockResolvedValue({ cannot: () => false, can: () => true });
  const forward = jest.fn().mockResolvedValue(undefined);

  @Global()
  @Module({
    providers: [
      { provide: AUTHZ_MODE, useValue: mode },
      { provide: PlatformAuditClient, useValue: { forward } },
    ],
    exports: [AUTHZ_MODE, PlatformAuditClient],
  })
  class AppGlobals {}

  const moduleRef = await Test.createTestingModule({
    imports: [AppGlobals, NativeRouteAuthzModule],
    controllers: [SpaceController],
    providers: [
      { provide: SpaceService, useValue: {} },
      { provide: SpaceMemberService, useValue: members },
      { provide: SpaceMemberRepo, useValue: {} },
      { provide: SpaceAbilityFactory, useValue: { createForUser } },
      { provide: WorkspaceAbilityFactory, useValue: {} },
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
  return { app, members, createForUser, forward };
}

const post = (app: NestFastifyApplication, url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });

const CALLS: Array<[string, string, Record<string, unknown>]> = [
  ['/spaces/members/add', 'addMembersToSpaceBatch', { spaceId: SPACE_ID, userIds: [USER.id], groupIds: [], role: 'writer' }],
  ['/spaces/members/remove', 'removeMemberFromSpace', { spaceId: SPACE_ID, userId: OTHER }],
  ['/spaces/members/change-role', 'updateSpaceMemberRole', { spaceId: SPACE_ID, userId: OTHER, role: 'admin' }],
];

describe('native space-member mutation — AUTHZ_MODE=remote (#542)', () => {
  let h: Awaited<ReturnType<typeof bootApp>>;
  beforeEach(async () => {
    h = await bootApp('remote');
  });
  afterEach(async () => {
    await h?.app.close();
  });

  it.each(CALLS)('%s is a 404 that never reaches CASL or the member service', async (url, method, payload) => {
    const res = await post(h.app, url, payload);
    expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(h.createForUser).not.toHaveBeenCalled();
    expect(h.members[method as keyof typeof h.members]).not.toHaveBeenCalled();
    expect(h.forward).toHaveBeenCalledTimes(1);
  });

  it.each(CALLS)('%s with an empty body is refused before ValidationPipe (404, not 400)', async (url) => {
    const res = await post(h.app, url, {});
    expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
  });

  it('the manager self-add is audited as such', async () => {
    await post(h.app, '/spaces/members/add', { spaceId: SPACE_ID, userIds: [USER.id], role: 'writer' });
    const [[row]] = h.forward.mock.calls[0];
    expect(row).toMatchObject({
      event: 'space.native_member_mutation_refused',
      resourceId: SPACE_ID,
      actorId: USER.id,
      workspaceId: WORKSPACE.id,
      metadata: { outcome: 'denied', reason: 'platform_only', route: 'POST /api/spaces/members/add', targetsActor: true },
    });
  });
});

describe('native space-member mutation — AUTHZ_MODE=native (standalone preserved)', () => {
  let h: Awaited<ReturnType<typeof bootApp>>;
  beforeEach(async () => {
    h = await bootApp('native');
  });
  afterEach(async () => {
    await h?.app.close();
  });

  it.each(CALLS)('%s reaches CASL and the member service, with no refusal row', async (url, method, payload) => {
    const res = await post(h.app, url, payload);
    expect(res.statusCode).toBe(HttpStatus.OK);
    expect(h.createForUser).toHaveBeenCalledWith(USER, SPACE_ID);
    expect(h.members[method as keyof typeof h.members]).toHaveBeenCalledTimes(1);
    expect(h.forward).not.toHaveBeenCalled();
  });
});
