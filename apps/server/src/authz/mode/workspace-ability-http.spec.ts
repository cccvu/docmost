import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import fastifyMultipart from '@fastify/multipart';

// Factory mocks (not automock — automock loads the real module to introspect it) keep the controller's import
// graph off the database, storage drivers, queues and JWT config. Each is replaced by a value below.
jest.mock('../../core/attachment/services/attachment.service', () => ({
  __esModule: true,
  AttachmentService: class AttachmentService {},
}));
jest.mock('../../integrations/storage/storage.service', () => ({
  __esModule: true,
  StorageService: class StorageService {},
}));
jest.mock('@docmost/db/repos/page/page.repo', () => ({ __esModule: true, PageRepo: class PageRepo {} }));
jest.mock('@docmost/db/repos/attachment/attachment.repo', () => ({
  __esModule: true,
  AttachmentRepo: class AttachmentRepo {},
}));
jest.mock('@docmost/db/repos/space/space-member.repo', () => ({
  __esModule: true,
  SpaceMemberRepo: class SpaceMemberRepo {},
}));
jest.mock('../../integrations/environment/environment.service', () => ({
  __esModule: true,
  EnvironmentService: class EnvironmentService {},
}));
jest.mock('../../core/auth/services/token.service', () => ({ __esModule: true, TokenService: class TokenService {} }));
jest.mock('../../core/page/page-access/page-access.service', () => ({
  __esModule: true,
  PageAccessService: class PageAccessService {},
}));

import { AttachmentController } from '../../core/attachment/attachment.controller';
import { AttachmentService } from '../../core/attachment/services/attachment.service';
import { StorageService } from '../../integrations/storage/storage.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { TokenService } from '../../core/auth/services/token.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AUTHZ_MODE, AuthzMode } from './authz-mode';
import { workspaceAbilityFactoryProvider } from './workspace-ability';

/**
 * HTTP-boundary proof of #636 (seam #177) — NOT upstream Docmost code.
 *
 * Boots the REAL upstream AttachmentController on Fastify with `@fastify/multipart` registered as main.ts registers
 * it, main.ts's ValidationPipe, and the REAL mode-selected `workspaceAbilityFactoryProvider` (no stubbed workspace
 * factory). No refusal interceptor is registered, so this proves the CASL layer on its own. The workspace-icon
 * routes are mixed handlers (avatar and space-icon branches share them), which is why they are decided here and
 * not by a route-level refusal:
 *  - remote: an engine OWNER gets 403 on the workspace-icon upload and removal, and neither service call runs;
 *    the same owner's avatar and space-icon requests still succeed (the 403 is the workspace branch, not a broken
 *    harness), and the user object reaching the service is still the owner (the demotion is a copy);
 *  - native: an OWNER sets and removes the workspace icon (anti-vacuity: the 403 above is the remote factory);
 *    a MEMBER is refused (upstream parity).
 */
const OWNER = { id: '0198c2a1-0000-7000-8000-000000000001', role: 'owner' };
const MEMBER = { id: '0198c2a1-0000-7000-8000-000000000002', role: 'member' };
const WORKSPACE = { id: '0198c2a1-0000-7000-8000-0000000000aa' };
const SPACE_ID = '0198c2a1-7b3e-7c6d-9f10-2a3b4c5d6e7f';

async function bootApp(mode: AuthzMode, user: { id: string; role: string }) {
  // Drain the file stream like the real service does, so the multipart request completes.
  const uploadImage = jest.fn(async (file: any, ..._rest: unknown[]) => {
    await file.toBuffer();
    return { ok: true };
  });
  const removeWorkspaceIcon = jest.fn().mockResolvedValue(undefined);
  const removeUserAvatar = jest.fn().mockResolvedValue(undefined);
  const removeSpaceIcon = jest.fn().mockResolvedValue(undefined);
  const spaceCreateForUser = jest.fn().mockResolvedValue({ cannot: () => false, can: () => true });

  const moduleRef = await Test.createTestingModule({
    controllers: [AttachmentController],
    providers: [
      { provide: AUTHZ_MODE, useValue: mode },
      workspaceAbilityFactoryProvider,
      { provide: SpaceAbilityFactory, useValue: { createForUser: spaceCreateForUser } },
      {
        provide: AttachmentService,
        useValue: { uploadImage, removeWorkspaceIcon, removeUserAvatar, removeSpaceIcon },
      },
      { provide: StorageService, useValue: {} },
      { provide: PageRepo, useValue: {} },
      { provide: AttachmentRepo, useValue: {} },
      { provide: EnvironmentService, useValue: {} },
      { provide: TokenService, useValue: {} },
      { provide: PageAccessService, useValue: {} },
      { provide: AUDIT_SERVICE, useValue: { log: jest.fn() } },
    ],
  })
    // The real JwtAuthGuard's contract: an authenticated request carries `req.user = { user, workspace }`.
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (ctx: any) => {
        ctx.switchToHttp().getRequest().user = { user, workspace: WORKSPACE };
        return true;
      },
    })
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.register(fastifyMultipart as any);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, uploadImage, removeWorkspaceIcon, removeUserAvatar, removeSpaceIcon, spaceCreateForUser };
}

// A real multipart body: the fields precede the file, as the SPA sends them (the handler reads `file.fields`).
const BOUNDARY = '----ccc636boundary';
function multipart(fields: Record<string, string>) {
  const parts = Object.entries(fields).map(
    ([k, v]) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
  );
  parts.push(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="icon.png"\r\n` +
      `Content-Type: image/png\r\n\r\n\x89PNG-not-really\r\n`,
  );
  return parts.join('') + `--${BOUNDARY}--\r\n`;
}

const uploadImage = (app: NestFastifyApplication, fields: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/attachments/upload-image',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipart(fields),
  });

const removeIcon = (app: NestFastifyApplication, body: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/attachments/remove-icon',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

describe('workspace icon — AUTHZ_MODE=remote, engine OWNER (#636)', () => {
  let h: Awaited<ReturnType<typeof bootApp>>;
  beforeEach(async () => {
    h = await bootApp('remote', OWNER);
  });
  afterEach(async () => {
    await h?.app.close();
  });

  it('403s the workspace-icon upload and never stores it', async () => {
    const res = await uploadImage(h.app, { type: 'workspace-icon' });
    expect(res.statusCode).toBe(HttpStatus.FORBIDDEN);
    expect(h.uploadImage).not.toHaveBeenCalled();
  });

  it('403s the workspace-icon removal and never removes it', async () => {
    const res = await removeIcon(h.app, { type: 'workspace-icon' });
    expect(res.statusCode).toBe(HttpStatus.FORBIDDEN);
    expect(h.removeWorkspaceIcon).not.toHaveBeenCalled();
  });

  it('still uploads and removes the avatar, with the owner user unchanged', async () => {
    const up = await uploadImage(h.app, { type: 'avatar' });
    expect(up.statusCode).toBe(HttpStatus.OK);
    expect(h.uploadImage).toHaveBeenCalledTimes(1);
    expect(h.uploadImage.mock.calls[0].slice(1)).toEqual(['avatar', OWNER.id, WORKSPACE.id, undefined]);

    const rm = await removeIcon(h.app, { type: 'avatar' });
    expect(rm.statusCode).toBe(HttpStatus.OK);
    expect(h.removeUserAvatar).toHaveBeenCalledWith(OWNER);
    expect(OWNER.role).toBe('owner');
  });

  it('still sets and removes a space icon, decided by space CASL', async () => {
    const up = await uploadImage(h.app, { type: 'space-icon', spaceId: SPACE_ID });
    expect(up.statusCode).toBe(HttpStatus.OK);
    expect(h.uploadImage).toHaveBeenCalledTimes(1);
    expect(h.spaceCreateForUser).toHaveBeenCalledWith(OWNER, SPACE_ID);

    const rm = await removeIcon(h.app, { type: 'space-icon', spaceId: SPACE_ID });
    expect(rm.statusCode).toBe(HttpStatus.OK);
    expect(h.removeSpaceIcon).toHaveBeenCalledWith(SPACE_ID, WORKSPACE.id);
  });
});

describe('workspace icon — AUTHZ_MODE=native (standalone preserved)', () => {
  it('an OWNER sets and removes the workspace icon (anti-vacuity: the remote 403 is the remote factory)', async () => {
    const h = await bootApp('native', OWNER);
    try {
      const up = await uploadImage(h.app, { type: 'workspace-icon' });
      expect(up.statusCode).toBe(HttpStatus.OK);
      expect(h.uploadImage).toHaveBeenCalledTimes(1);
      expect(h.uploadImage.mock.calls[0][1]).toBe('workspace-icon');

      const rm = await removeIcon(h.app, { type: 'workspace-icon' });
      expect(rm.statusCode).toBe(HttpStatus.OK);
      expect(h.removeWorkspaceIcon).toHaveBeenCalledWith(WORKSPACE);
    } finally {
      await h.app.close();
    }
  });

  it('a MEMBER is refused the workspace icon (upstream parity)', async () => {
    const h = await bootApp('native', MEMBER);
    try {
      expect((await uploadImage(h.app, { type: 'workspace-icon' })).statusCode).toBe(HttpStatus.FORBIDDEN);
      expect((await removeIcon(h.app, { type: 'workspace-icon' })).statusCode).toBe(HttpStatus.FORBIDDEN);
      expect(h.uploadImage).not.toHaveBeenCalled();
      expect(h.removeWorkspaceIcon).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });
});
