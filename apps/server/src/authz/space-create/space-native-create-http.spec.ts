import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

// Factory mocks (not automock — automock loads the real module to introspect it) keep the controller's import
// graph off bullmq / the database / the email templates. The native block below injects stubs for exactly what the
// create handler touches.
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
import { SpaceHardDeleteInterceptor } from '../space-delete/space-hard-delete.interceptor';
import { SpaceNativeCreateInterceptor } from './space-native-create.interceptor';

/**
 * HTTP-boundary proof of #598 — NOT upstream Docmost code.
 *
 * Boots the REAL upstream SpaceController on Fastify with the REAL refusal interceptors registered the way
 * app.module.ts registers them (global APP_INTERCEPTORs, #502's then #598's) and main.ts's ValidationPipe. The caller
 * is an engine OWNER — workspace CASL ALLOWS the create — which is exactly the session remote mode used to rely on
 * never existing. It proves:
 *  - remote: `POST /spaces/create` is a 404 for a valid body, an empty body, a null body and no body — so the refusal
 *    runs before the pipe — and neither CASL nor the service create is ever reached; one refusal row is forwarded.
 *    The #502 delete refusal is unaffected (they compose);
 *  - without the #598 interceptor the same owner request is a 200 (anti-vacuity: the 404 is this interceptor's);
 *  - native (standalone): the upstream route is untouched — the pipe still 400s a bad body, and an owner's valid
 *    request reaches CASL and the create, with no refusal row.
 * The static fitness spec proves the interceptor is keyed to the right route; this proves the wiring denies.
 */
const USER = { id: '0198c2a1-0000-7000-8000-000000000001', role: 'owner' };
const WORKSPACE = { id: '0198c2a1-0000-7000-8000-0000000000aa' };
const SPACE_ID = '0198c2a1-7b3e-7c6d-9f10-2a3b4c5d6e7f';
const VALID = { name: 'Native Space', slug: 'native-space' };

async function bootApp(mode: AuthzMode, { withCreateRefusal = true } = {}) {
  const createSpace = jest.fn().mockResolvedValue({ id: SPACE_ID, ...VALID, memberCount: 1 });
  const deleteSpace = jest.fn().mockResolvedValue(undefined);
  // An engine owner: workspace CASL ALLOWS Manage Space (upstream `WorkspaceAbilityFactory.createForUser` is sync).
  const workspaceCreateForUser = jest.fn(() => ({ cannot: () => false, can: () => true }));
  const spaceCreateForUser = jest.fn().mockResolvedValue({ cannot: () => false, can: () => true });
  const forward = jest.fn().mockResolvedValue(undefined);

  const moduleRef = await Test.createTestingModule({
    controllers: [SpaceController],
    providers: [
      { provide: AUTHZ_MODE, useValue: mode },
      { provide: PlatformAuditClient, useValue: { forward } },
      { provide: APP_INTERCEPTOR, useClass: SpaceHardDeleteInterceptor },
      ...(withCreateRefusal ? [{ provide: APP_INTERCEPTOR, useClass: SpaceNativeCreateInterceptor }] : []),
      { provide: SpaceService, useValue: { createSpace, deleteSpace } },
      { provide: SpaceMemberService, useValue: {} },
      { provide: SpaceMemberRepo, useValue: {} },
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
  return { app, createSpace, deleteSpace, workspaceCreateForUser, spaceCreateForUser, forward };
}

const post = (app: NestFastifyApplication, url: string, payload?: unknown) =>
  app.inject({
    method: 'POST',
    url,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) }),
  });

describe('native space create — AUTHZ_MODE=remote (#598)', () => {
  let h: Awaited<ReturnType<typeof bootApp>>;
  beforeEach(async () => {
    h = await bootApp('remote');
  });
  afterEach(async () => {
    await h?.app.close();
  });

  it.each([
    ['a valid body', VALID],
    ['an empty body (refused before ValidationPipe)', {}],
    ['a null body', null],
    ['no body at all', undefined],
  ])('404s an OWNER for %s and never reaches CASL or the create', async (_label, payload) => {
    const res = await post(h.app, '/spaces/create', payload);
    expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(h.workspaceCreateForUser).not.toHaveBeenCalled();
    expect(h.createSpace).not.toHaveBeenCalled();
    expect(h.forward).toHaveBeenCalledTimes(1);
  });

  it('forwards the refusal with the authenticated actor and their engine role', async () => {
    await post(h.app, '/spaces/create', VALID);
    const [[row]] = h.forward.mock.calls[0];
    expect(row).toMatchObject({
      event: 'space.native_create_refused',
      resourceType: 'space',
      actorId: USER.id,
      workspaceId: WORKSPACE.id,
      metadata: { outcome: 'denied', reason: 'platform_only', route: 'POST /api/spaces/create', actorRole: 'owner' },
    });
    expect(JSON.stringify(row)).not.toContain(VALID.slug);
  });

  it('composes with the #502 refusal: the native delete is still a 404 with its own row', async () => {
    const res = await post(h.app, '/spaces/delete', { spaceId: SPACE_ID });
    expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(h.deleteSpace).not.toHaveBeenCalled();
    const [[row]] = h.forward.mock.calls[0];
    expect(row).toMatchObject({ event: 'space.hard_delete_refused' });
  });
});

describe('native space create — AUTHZ_MODE=remote WITHOUT the #598 interceptor (anti-vacuity)', () => {
  it('an owner session creates a space: the 404 above is the interceptor, not CASL', async () => {
    const h = await bootApp('remote', { withCreateRefusal: false });
    try {
      const res = await post(h.app, '/spaces/create', VALID);
      expect(res.statusCode).toBe(HttpStatus.OK);
      expect(h.createSpace).toHaveBeenCalledTimes(1);
    } finally {
      await h.app.close();
    }
  });
});

describe('native space create — AUTHZ_MODE=native (standalone preserved)', () => {
  let h: Awaited<ReturnType<typeof bootApp>>;
  beforeEach(async () => {
    h = await bootApp('native');
  });
  afterEach(async () => {
    await h?.app.close();
  });

  it('keeps the upstream validation (an empty body is a 400, not a refusal)', async () => {
    const res = await post(h.app, '/spaces/create', {});
    expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(h.forward).not.toHaveBeenCalled();
  });

  it('lets an owner create: CASL is consulted and the service create runs', async () => {
    const res = await post(h.app, '/spaces/create', VALID);
    expect(res.statusCode).toBe(HttpStatus.OK);
    expect(h.workspaceCreateForUser).toHaveBeenCalledWith(USER, WORKSPACE);
    expect(h.createSpace).toHaveBeenCalledWith(USER, WORKSPACE.id, expect.objectContaining(VALID));
    expect(h.forward).not.toHaveBeenCalled();
  });
});
