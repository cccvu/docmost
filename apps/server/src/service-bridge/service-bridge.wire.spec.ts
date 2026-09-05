import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { TransformHttpResponseInterceptor } from '../common/interceptors/http-response.interceptor';
import { RemoteOnlyGuard } from '../authz/mode/remote-only.guard';
import { ServiceAuthGuard } from './service-auth.guard';
import { ServiceWorkspaceController } from './service-workspace.controller';
import { ServiceContentController } from './service-content.controller';
import { AuthzChangeController } from './authz-change.controller';
import { WorkspaceResolver } from './workspace-resolver';
import { ServiceWorkspaceService } from './service-workspace.service';
import { ServiceContentService } from './service-content.service';
import { AuthzChangeFeedService } from './authz-change-feed.service';
import { AuthzSnapshotService } from './authz-snapshot.service';

/**
 * CCC service-bridge — NOT upstream Docmost code. Wire-level proof for incident #181.
 *
 * The metadata assertion in service-scope-coverage.spec.ts proves every handler DECLARES @SkipTransform();
 * this spec proves the declaration actually defeats the upstream global TransformHttpResponseInterceptor
 * through the real Nest/Fastify pipeline (global prefix + interceptor mounted exactly as main.ts does), so
 * the bodies on the wire are the bare shapes service-bridge.openapi.json declares. The undecorated fixture
 * route is the negative control: it MUST come back wrapped, proving the interceptor is live in this app
 * (the test cannot pass vacuously). Guards are overridden: authorization is covered elsewhere; the subject
 * here is response shape only.
 */
const WS = '01a05517-809b-752b-a0d3-aecc8e7369b4';
const PAGE = '11111111-1111-1111-1111-111111111111';

@Controller('fixture')
class FixtureController {
  @Get('wrapped') // deliberately NO @SkipTransform(): the negative control
  wrapped() {
    return { ok: true };
  }
}

describe('service-bridge wire shape through the real response pipeline', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ServiceWorkspaceController, ServiceContentController, AuthzChangeController, FixtureController],
      providers: [
        { provide: WorkspaceResolver, useValue: { resolveDefaultWorkspaceId: async () => WS } },
        { provide: ServiceWorkspaceService, useValue: { getSettings: async () => ({ name: 'CCC', defaultPageEditMode: 'read' }) } },
        { provide: ServiceContentService, useValue: { listSpacesByIds: async () => ({ items: [] }) } },
        { provide: AuthzChangeFeedService, useValue: {} },
        { provide: AuthzSnapshotService, useValue: { getSnapshot: async () => ({ events: [], nextCursor: null, baseline: '7.0' }) } },
      ],
    })
      .overrideGuard(RemoteOnlyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ServiceAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api'); // main.ts
    app.useGlobalInterceptors(new TransformHttpResponseInterceptor(app.get(Reflector))); // main.ts
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => await app?.close());

  it('negative control: an undecorated handler IS wrapped (the interceptor is live in this app)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fixture/wrapped' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { ok: true }, success: true, status: 200 });
  });

  it('GET /api/service/workspace/default answers exactly { workspaceId } as application/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/service/workspace/default' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ workspaceId: WS });
  });

  it('GET /api/service/authz/snapshot answers the bare AuthzSnapshotResponse', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/service/authz/snapshot?limit=1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [], nextCursor: null, baseline: '7.0' });
  });

  it('POST /api/service/content/spaces/list answers the bare { items } list', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/service/content/spaces/list',
      payload: { ids: [PAGE], limit: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });
});
