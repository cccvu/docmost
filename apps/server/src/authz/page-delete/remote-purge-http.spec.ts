import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';

// Factory mocks (not automock — automock loads the real module to introspect it) keep the controller's import graph
// off bullmq / the database / the collab stack. Each stub below injects exactly what the delete handler touches.
jest.mock('../../core/page/services/page.service', () => ({ __esModule: true, PageService: class PageService {} }));
jest.mock('../../core/page/services/backlink.service', () => ({ __esModule: true, BacklinkService: class BacklinkService {} }));
jest.mock('../../core/page/services/page-history.service', () => ({
  __esModule: true,
  PageHistoryService: class PageHistoryService {},
}));
jest.mock('../../core/page/page-access/page-access.service', () => ({
  __esModule: true,
  PageAccessService: class PageAccessService {},
}));
jest.mock('../../core/label/label.service', () => ({ __esModule: true, LabelService: class LabelService {} }));
jest.mock('@docmost/db/repos/page/page.repo', () => ({ __esModule: true, PageRepo: class PageRepo {} }));
jest.mock('../../collaboration/collaboration.util', () => ({ jsonToHtml: () => '', jsonToMarkdown: () => '' }));

import { PageController } from '../../core/page/page.controller';
import { PageService } from '../../core/page/services/page.service';
import { BacklinkService } from '../../core/page/services/backlink.service';
import { PageHistoryService } from '../../core/page/services/page-history.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { LabelService } from '../../core/label/label.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TransformHttpResponseInterceptor } from '../../common/interceptors/http-response.interceptor';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { RemotePurgeInterceptor } from './remote-purge.interceptor';
import { RemotePurgeService } from './remote-purge.service';

/**
 * HTTP-boundary proof of #636 W6 — NOT upstream Docmost code.
 *
 * Boots the REAL upstream PageController on Fastify with main.ts's ValidationPipe and response envelope, the REAL
 * RemotePurgeInterceptor registered the way app.module.ts registers it (a global APP_INTERCEPTOR), and the REAL
 * RemotePurgeService over a recording database (its locking on real Postgres is `remote-purge.pg.spec.ts`). The
 * caller is a space admin CASL allows. Proves:
 *  - remote, a restricted descendant → 403 `purge_needs_edit` and the upstream handler is never invoked;
 *  - remote, the whole subtree editable → the purge runs and answers exactly the upstream handler's response;
 *  - anti-vacuity: the same remote request WITHOUT the interceptor reaches the handler, which purges;
 *  - a trash is unaffected (the handler, never the purge), and native mode is unchanged;
 *  - a body the DTO would refuse is a 400 without reaching either.
 * The service and the handler get SEPARATE stubs, so every call is attributed to the side that made it.
 */
const USER = { id: '0198c2a1-0000-7000-8000-000000000001' };
const WORKSPACE = { id: '0198c2a1-0000-7000-8000-0000000000aa' };
const ROOT = '0198c2a1-7b3e-7c6d-9f10-000000000001';
const CHILD = '0198c2a1-7b3e-7c6d-9f10-000000000002';
const SPACE = '0198c2a1-7b3e-7c6d-9f10-0000000000ee';
const ROW = { id: ROOT, slugId: 'slug-1', title: 'T', spaceId: SPACE, workspaceId: WORKSPACE.id, deletedAt: null };

async function bootApp(mode: AuthzMode, opts: { interceptor?: boolean; restricted?: string[] } = {}) {
  const restricted = new Set(opts.restricted ?? []);
  const allowAdmin = { can: () => true, cannot: () => false };
  // The upstream handler's collaborators.
  const handler = {
    findById: jest.fn().mockResolvedValue(ROW),
    forceDelete: jest.fn().mockResolvedValue([ROOT, CHILD]),
    removePage: jest.fn().mockResolvedValue(undefined),
    validateCanEdit: jest.fn().mockResolvedValue({ hasRestriction: false }),
    createForUser: jest.fn().mockResolvedValue(allowAdmin),
    audit: jest.fn(),
  };
  // The purge's collaborators.
  const spy = spyKysely((q: SpyQuery) => {
    if (/with recursive/i.test(q.sql)) return [{ id: ROOT }, { id: CHILD }];
    if (/for update/i.test(q.sql)) return [{ id: ROOT }, { id: CHILD }];
    if (/authz_outbox/i.test(q.sql)) return [{ xactId: '10', id: '1' }];
    if (/"content"/.test(q.sql)) return [ROW];
    return [];
  });
  const purgeSide = {
    findById: jest.fn().mockResolvedValue(ROW),
    forceDelete: jest.fn().mockResolvedValue([ROOT, CHILD]),
    createForUser: jest.fn().mockResolvedValue(allowAdmin),
    settleProjection: jest.fn().mockResolvedValue({ status: 'confirmed' }),
    tryCheckBulk: jest.fn(async (_s: unknown, checks: { resourceId: string }[]) =>
      checks.map((c) => !restricted.has(c.resourceId)),
    ),
    audit: jest.fn(),
    queue: jest.fn().mockResolvedValue(undefined),
  };
  const purge = new RemotePurgeService(
    spy.db,
    { findById: purgeSide.findById } as never,
    { forceDelete: purgeSide.forceDelete } as never,
    { createForUser: purgeSide.createForUser } as never,
    { settleProjection: purgeSide.settleProjection, tryCheckBulk: purgeSide.tryCheckBulk } as never,
    { log: purgeSide.audit } as never,
    { add: purgeSide.queue } as never,
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [PageController],
    providers: [
      { provide: AUTHZ_MODE, useValue: mode },
      { provide: RemotePurgeService, useValue: purge },
      ...(opts.interceptor === false ? [] : [{ provide: APP_INTERCEPTOR, useClass: RemotePurgeInterceptor }]),
      { provide: PageService, useValue: { forceDelete: handler.forceDelete, removePage: handler.removePage } },
      { provide: PageRepo, useValue: { findById: handler.findById } },
      { provide: PageHistoryService, useValue: {} },
      { provide: SpaceAbilityFactory, useValue: { createForUser: handler.createForUser } },
      { provide: PageAccessService, useValue: { validateCanEdit: handler.validateCanEdit } },
      { provide: BacklinkService, useValue: {} },
      { provide: LabelService, useValue: {} },
      { provide: AUDIT_SERVICE, useValue: { log: handler.audit } },
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
  app.useGlobalInterceptors(new TransformHttpResponseInterceptor(app.get(Reflector)));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, handler, purgeSide, spy };
}

const del = (app: NestFastifyApplication, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/pages/delete',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

type Booted = Awaited<ReturnType<typeof bootApp>>;
const handlerUntouched = (h: Booted) => {
  expect(h.handler.findById).not.toHaveBeenCalled();
  expect(h.handler.forceDelete).not.toHaveBeenCalled();
  expect(h.handler.removePage).not.toHaveBeenCalled();
  expect(h.handler.audit).not.toHaveBeenCalled();
};
const purgeUntouched = (h: Booted) => {
  expect(h.purgeSide.findById).not.toHaveBeenCalled();
  expect(h.purgeSide.forceDelete).not.toHaveBeenCalled();
  expect(h.spy.tx).toEqual([]);
};

describe('native permanent delete — AUTHZ_MODE=remote (#636 W6)', () => {
  let h: Booted | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('a restricted descendant → 403 purge_needs_edit; the upstream handler is never invoked; nothing deleted', async () => {
    h = await bootApp('remote', { restricted: [CHILD] });
    const res = await del(h.app, { pageId: ROOT, permanentlyDelete: true });
    expect(res.statusCode).toBe(HttpStatus.FORBIDDEN);
    expect(res.json()).toMatchObject({ code: 'purge_needs_edit' });
    handlerUntouched(h);
    expect(h.purgeSide.forceDelete).not.toHaveBeenCalled();
    expect(h.purgeSide.audit).not.toHaveBeenCalled();
    expect(h.spy.tx).toEqual(['begin', 'rollback']);
  });

  it('the whole subtree editable → the purge runs and answers exactly the upstream handler’s response', async () => {
    h = await bootApp('remote');
    const res = await del(h.app, { pageId: ROOT, permanentlyDelete: true });
    expect(res.statusCode).toBe(HttpStatus.OK);
    handlerUntouched(h);
    expect(h.purgeSide.forceDelete).toHaveBeenCalledWith(ROOT, WORKSPACE.id, expect.anything());
    expect(h.purgeSide.tryCheckBulk.mock.calls[0][1].map((c: { resourceId: string }) => c.resourceId).sort()).toEqual(
      [ROOT, CHILD].sort(),
    );
    expect(h.purgeSide.audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'page.deleted', resourceId: ROOT }));
    expect(h.spy.tx).toEqual(['begin', 'commit']);

    // Byte-for-byte the native handler's answer for the same request.
    const native = await bootApp('native');
    try {
      const nativeRes = await del(native.app, { pageId: ROOT, permanentlyDelete: true });
      expect(native.handler.forceDelete).toHaveBeenCalled();
      expect([res.statusCode, res.body]).toEqual([nativeRes.statusCode, nativeRes.body]);
    } finally {
      await native.app.close();
    }
  });

  it('anti-vacuity: WITHOUT the interceptor the same remote request reaches the upstream handler, which purges', async () => {
    h = await bootApp('remote', { interceptor: false, restricted: [CHILD] });
    const res = await del(h.app, { pageId: ROOT, permanentlyDelete: true });
    expect(res.statusCode).toBe(HttpStatus.OK);
    expect(h.handler.forceDelete).toHaveBeenCalledWith(ROOT, WORKSPACE.id);
    purgeUntouched(h);
  });

  it.each([
    ['permanentlyDelete: false', { pageId: ROOT, permanentlyDelete: false }],
    ['permanentlyDelete absent', { pageId: ROOT }],
    ['permanentlyDelete: null', { pageId: ROOT, permanentlyDelete: null }],
  ])('a trash (%s) is unaffected: the upstream handler, never the purge', async (_l, payload) => {
    h = await bootApp('remote', { restricted: [CHILD] });
    const res = await del(h.app, payload);
    expect(res.statusCode).toBe(HttpStatus.OK);
    expect(h.handler.validateCanEdit).toHaveBeenCalled();
    expect(h.handler.removePage).toHaveBeenCalledWith(ROOT, USER.id, WORKSPACE.id);
    expect(h.handler.forceDelete).not.toHaveBeenCalled();
    purgeUntouched(h);
  });

  it.each([
    ['a string flag', { pageId: ROOT, permanentlyDelete: 'true' }],
    ['a numeric flag', { pageId: ROOT, permanentlyDelete: 1 }],
    ['no pageId', { permanentlyDelete: true }],
    ['an empty pageId', { pageId: '', permanentlyDelete: true }],
    ['a non-string pageId', { pageId: 42, permanentlyDelete: true }],
  ])('%s → 400, neither the handler nor the purge runs', async (_l, payload) => {
    h = await bootApp('remote');
    const res = await del(h.app, payload);
    expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
    handlerUntouched(h);
    purgeUntouched(h);
  });
});

describe('native permanent delete — AUTHZ_MODE=native (standalone preserved)', () => {
  let h: Booted | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('the interceptor is inert: the upstream handler decides and purges; the purge routine is never touched', async () => {
    h = await bootApp('native', { restricted: [CHILD] });
    const res = await del(h.app, { pageId: ROOT, permanentlyDelete: true });
    expect(res.statusCode).toBe(HttpStatus.OK);
    expect(h.handler.createForUser).toHaveBeenCalledWith(USER, SPACE);
    expect(h.handler.forceDelete).toHaveBeenCalledWith(ROOT, WORKSPACE.id);
    expect(h.handler.audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'page.deleted' }));
    purgeUntouched(h);
  });

  it('keeps the upstream validation: a string flag is the pipe’s 400', async () => {
    h = await bootApp('native');
    const res = await del(h.app, { pageId: ROOT, permanentlyDelete: 'true' });
    expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
    handlerUntouched(h);
  });
});
