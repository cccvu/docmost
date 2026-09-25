import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

// Factory mocks (not automock — automock loads the real module to introspect it) keep the controller's import
// graph off bullmq / the database / the email templates. The refusal happens before any handler runs; the native
// block below injects stubs for exactly what the delete handler touches.
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
import { SpaceHardDeleteInterceptor } from './space-hard-delete.interceptor';

/**
 * HTTP-boundary proof of #502 — NOT upstream Docmost code.
 *
 * Boots the REAL upstream SpaceController on Fastify with the REAL SpaceHardDeleteInterceptor registered the way
 * app.module.ts registers it (a global APP_INTERCEPTOR) and main.ts's ValidationPipe, and proves:
 *  - remote: `POST /spaces/delete` is a 404 for a valid id, an empty body and a null body — so the refusal runs
 *    before the pipe — and neither CASL nor the service delete is ever reached; one refusal row is forwarded;
 *  - native (standalone): the upstream route is untouched — the pipe still 400s a bad body, and a space admin's
 *    valid request reaches CASL and the delete, with no refusal row.
 * The static fitness spec proves the interceptor is keyed to the right route; this proves the wiring denies.
 */
const USER = { id: '0198c2a1-0000-7000-8000-000000000001' };
const WORKSPACE = { id: '0198c2a1-0000-7000-8000-0000000000aa' };
const SPACE_ID = '0198c2a1-7b3e-7c6d-9f10-2a3b4c5d6e7f';

async function bootApp(mode: AuthzMode) {
  const deleteSpace = jest.fn().mockResolvedValue(undefined);
  const createForUser = jest.fn().mockResolvedValue({ cannot: () => false, can: () => true });
  const forward = jest.fn().mockResolvedValue(undefined);

  const moduleRef = await Test.createTestingModule({
    controllers: [SpaceController],
    providers: [
      { provide: AUTHZ_MODE, useValue: mode },
      { provide: PlatformAuditClient, useValue: { forward } },
      { provide: APP_INTERCEPTOR, useClass: SpaceHardDeleteInterceptor },
      { provide: SpaceService, useValue: { deleteSpace } },
      { provide: SpaceMemberService, useValue: {} },
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
  return { app, deleteSpace, createForUser, forward };
}

const del = (app: NestFastifyApplication, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/spaces/delete',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

describe('native space hard delete — AUTHZ_MODE=remote (#502)', () => {
  let h: Awaited<ReturnType<typeof bootApp>>;
  beforeEach(async () => {
    h = await bootApp('remote');
  });
  afterEach(async () => {
    await h?.app.close();
  });

  it.each([
    ['a valid space id', { spaceId: SPACE_ID }],
    ['an empty body (refused before ValidationPipe)', {}],
    ['a null body', null],
  ])('404s %s and never reaches CASL or the delete', async (_label, payload) => {
    const res = await del(h.app, payload);
    expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(h.createForUser).not.toHaveBeenCalled();
    expect(h.deleteSpace).not.toHaveBeenCalled();
    expect(h.forward).toHaveBeenCalledTimes(1);
  });

  it('forwards the refusal with the authenticated actor and the attempted space', async () => {
    await del(h.app, { spaceId: SPACE_ID });
    const [[row]] = h.forward.mock.calls[0];
    expect(row).toMatchObject({
      event: 'space.hard_delete_refused',
      resourceType: 'space',
      resourceId: SPACE_ID,
      actorId: USER.id,
      workspaceId: WORKSPACE.id,
    });
  });
});

describe('native space hard delete — AUTHZ_MODE=native (standalone preserved)', () => {
  let h: Awaited<ReturnType<typeof bootApp>>;
  beforeEach(async () => {
    h = await bootApp('native');
  });
  afterEach(async () => {
    await h?.app.close();
  });

  it('keeps the upstream validation (an empty body is a 400, not a refusal)', async () => {
    const res = await del(h.app, {});
    expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(h.forward).not.toHaveBeenCalled();
  });

  it('lets a space admin delete: CASL is consulted and the service delete runs', async () => {
    const res = await del(h.app, { spaceId: SPACE_ID });
    expect(res.statusCode).toBe(HttpStatus.OK);
    expect(h.createForUser).toHaveBeenCalledWith(USER, SPACE_ID);
    expect(h.deleteSpace).toHaveBeenCalledWith(SPACE_ID, WORKSPACE.id);
    expect(h.forward).not.toHaveBeenCalled();
  });
});
