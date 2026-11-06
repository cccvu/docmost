import { Body, Controller, Global, HttpCode, HttpStatus, Logger, Module, Post, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { TransformHttpResponseInterceptor } from '../../common/interceptors/http-response.interceptor';
import { PageIdDto } from '../../core/page/dto/page.dto';
import { PlatformAuditClient } from '../audit/platform-audit.client';
import { HttpAuthzClient } from '../http-authz.client';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { NativeRouteAuthzModule } from './native-route-authz.module';

/**
 * Nest-pipeline proof for #574 — NOT upstream Docmost code.
 *
 * The redaction reads `{ data, success, status }` because fork APP_INTERCEPTORs are registered at create time and
 * main.ts appends `TransformHttpResponseInterceptor` afterwards with `useGlobalInterceptors`, which puts the wrapper
 * INSIDE them. This boots a Fastify app the way main.ts does — the REAL NativeRouteAuthzModule (so the interceptor is
 * an APP_INTERCEPTOR from an imported module, as in the app) and the REAL wrapper via `useGlobalInterceptors` after
 * creation — and proves the cut lands on the wire, a fully viewable chain is byte-identical to native mode, and
 * (anti-vacuity) without the wrapper the interceptor sees a bare array and fails closed rather than passing it.
 *
 * The controller is a stand-in with the upstream class and handler names (the interceptor keys on
 * `PageController.getPageBreadcrumbs`; the fitness spec pins that key to the real route that reaches the query), so the
 * real controller's import graph (collab gateway ESM, queues) stays out of jest.
 */
const USER = { id: '0198c2a1-0000-7000-8000-000000000001' };
const id = (n: number) => `0198c2a1-0000-7000-8000-${String(n).padStart(12, '0')}`;
const crumb = (n: number, parent: number | null) => ({
  id: id(n),
  slugId: `slug${n}`,
  title: `Title ${n}`,
  icon: null,
  isBase: false,
  position: 'a0',
  parentPageId: parent === null ? null : id(parent),
  spaceId: id(500),
  deletedAt: null,
  hasChildren: true,
});

@Controller('pages')
class PageController {
  @HttpCode(HttpStatus.OK)
  @Post('/breadcrumbs')
  async getPageBreadcrumbs(@Body() _dto: PageIdDto) {
    return [crumb(1, null), crumb(2, 1), crumb(3, 2)];
  }
}

async function boot(mode: AuthzMode, viewable: string[] | null, opts: { wrap?: boolean } = {}) {
  // #716: the interceptor asks `tryFilterResources` (null = the PDP could not answer).
  const filterResources = jest.fn().mockResolvedValue(viewable);

  @Global()
  @Module({
    providers: [
      { provide: AUTHZ_MODE, useValue: mode },
      { provide: PlatformAuditClient, useValue: { forward: async () => undefined } },
    ],
    exports: [AUTHZ_MODE, PlatformAuditClient],
  })
  class AppGlobals {}

  const moduleRef = await Test.createTestingModule({
    imports: [AppGlobals, NativeRouteAuthzModule],
    controllers: [PageController],
    providers: [
      // The real JwtAuthGuard's contract: an authenticated request carries `req.user = { user, workspace }`.
      {
        provide: APP_GUARD,
        useValue: {
          canActivate: (ctx: any) => {
            ctx.switchToHttp().getRequest().user = { user: USER };
            return true;
          },
        },
      },
    ],
  })
    .overrideProvider(HttpAuthzClient)
    .useValue({ tryFilterResources: filterResources })
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true }));
  if (opts.wrap !== false) app.useGlobalInterceptors(new TransformHttpResponseInterceptor(app.get(Reflector)));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, filterResources };
}

const breadcrumbs = (app: NestFastifyApplication, pageId: string) =>
  app.inject({
    method: 'POST',
    url: '/pages/breadcrumbs',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ pageId }),
  });

describe('breadcrumbs redaction in the Nest pipeline (#574)', () => {
  let app: NestFastifyApplication | undefined;
  beforeAll(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('remote, parent hidden: the wire body is the wrapped [self] with its parent withheld', async () => {
    const h = await boot('remote', [id(1)]);
    app = h.app;
    const res = await breadcrumbs(app, id(3));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [{ ...crumb(3, 2), parentPageId: null }], success: true, status: 200 });
    expect(h.filterResources).toHaveBeenCalledTimes(1);
  });

  it('remote, root hidden: keeps the run below it; by slug as well as by id', async () => {
    const h = await boot('remote', [id(2)]);
    app = h.app;
    for (const pageId of [id(3), 'slug3']) {
      const res = await breadcrumbs(app, pageId);
      expect(res.json().data).toEqual([{ ...crumb(2, 1), parentPageId: null }, crumb(3, 2)]);
    }
  });

  it('remote, whole chain viewable: byte-identical to the native-mode response', async () => {
    const remote = await boot('remote', [id(1), id(2)]);
    const remoteBody = (await breadcrumbs(remote.app, id(3))).payload;
    await remote.app.close();
    const native = await boot('native', []);
    app = native.app;
    const nativeBody = (await breadcrumbs(app, id(3))).payload;
    expect(remoteBody).toBe(nativeBody);
    expect(JSON.parse(nativeBody).data).toHaveLength(3);
    expect(native.filterResources).not.toHaveBeenCalled();
  });

  it('#716 remote, the PDP could not answer: a 503 on the wire, no ancestor and no self row', async () => {
    const h = await boot('remote', null);
    app = h.app;
    const res = await breadcrumbs(app, id(3));
    expect(res.statusCode).toBe(503);
    expect(res.payload).not.toContain('Title');
    expect(h.filterResources).toHaveBeenCalledTimes(1);
  });

  it('anti-vacuity: without the response wrapper the interceptor sees a bare array and fails closed (500)', async () => {
    const h = await boot('remote', [id(1), id(2)], { wrap: false });
    app = h.app;
    const res = await breadcrumbs(app, id(3));
    expect(res.statusCode).toBe(500);
    expect(res.payload).not.toContain('Title');
  });
});
