import { Controller, Get, ValidationPipe } from '@nestjs/common';
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
import { ServiceSearchService } from './service-search.service';
import { AuthzChangeFeedService } from './authz-change-feed.service';
import { AuthzSnapshotService } from './authz-snapshot.service';
import { PageAuthzStateService } from './page-authz-state.service';
import { ServiceSpaceController } from './service-space.controller';
import { ServiceSpaceService } from './service-space.service';
import { spyKysely, SpyQuery } from './kysely-spy.testkit';

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
        { provide: ServiceSearchService, useValue: { searchContent: async () => ({ items: [] }) } },
        { provide: AuthzChangeFeedService, useValue: {} },
        { provide: AuthzSnapshotService, useValue: { getSnapshot: async () => ({ events: [], nextCursor: null, baseline: '7.0' }) } },
        { provide: PageAuthzStateService, useValue: { read: async () => ({ pages: [], nextAfter: null }) } },
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

  it('POST /api/service/authz/pages/state answers the bare PageAuthzStateResponse with a 200 (#545)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/service/authz/pages/state', payload: { pageIds: [PAGE] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pages: [], nextAfter: null });
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

  it('POST /api/service/content/search answers the bare { items } list', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/service/content/search',
      payload: { userId: WS, query: 'x' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });
});

/**
 * #486 — the member-mutation refusals through the real pipeline: the REAL ServiceSpaceService (over the Kysely
 * spy) behind the real controller, with the global ValidationPipe mounted exactly as main.ts does. The platform
 * maps these by status + body, so the wire shape is the contract: a self-raise is a 403 whose body carries
 * `code: 'self_grant'` (the platform's STATUS_BOUND_CODES key), the last-admin guard a 409, and a re-role without
 * its actor a 400 that never reaches the service.
 */
describe('service-bridge member mutation refusals on the wire (#486)', () => {
  const SPACE = '22222222-2222-4222-8222-222222222222';
  const MEMBER = '33333333-3333-4333-8333-333333333333';
  let app: NestFastifyApplication;
  let calls: SpyQuery[];
  // The member row the spy returns: owned by the actor `ext-me` and the space's sole admin.
  let memberRow: { userId: string | null; groupId: string | null; role: string };

  beforeAll(async () => {
    const spy = spyKysely((query) => {
      const s = query.sql.toLowerCase();
      if (s.includes('for no key update')) return [{ id: SPACE, deletedAt: null }];
      if (s.includes('from spaces s')) {
        return [{ id: SPACE, name: 'S', slug: 's', description: null, visibility: 'private', createdAt: new Date(),
                  deletedAt: null, memberCount: '1' }];
      }
      if (s.includes('from space_members') && s.includes('for update')) return [{ id: MEMBER, ...memberRow }];
      if (s.includes('count(*)::int as n')) return [{ n: 0 }];
      return [];
    });
    calls = spy.calls;
    const bridge = {
      provisionShadowUser: async ({ externalId }: { externalId: string }) => ({ userId: `u-${externalId}`, workspaceId: WS }),
      findShadowUserId: async (externalId: string) => `u-${externalId}`,
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ServiceSpaceController],
      providers: [
        {
          provide: ServiceSpaceService,
          useValue: new ServiceSpaceService(spy.db, { resolveDefaultWorkspaceId: async () => WS } as any, bridge as any),
        },
      ],
    })
      .overrideGuard(RemoteOnlyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ServiceAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api'); // main.ts
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true })); // main.ts
    app.useGlobalInterceptors(new TransformHttpResponseInterceptor(app.get(Reflector))); // main.ts
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => await app?.close());
  beforeEach(() => {
    calls.length = 0;
    memberRow = { userId: 'u-ext-me', groupId: null, role: 'reader' };
  });

  const selfGrantBody = {
    code: 'self_grant',
    message: expect.stringContaining('another administrator must do this'),
  };

  it('PATCH raising your own membership answers 403 with code self_grant', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/service/spaces/${SPACE}/members/${MEMBER}`,
      payload: { role: 'admin', actorExternalId: 'ext-me' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(selfGrantBody);
  });

  it('POST adding yourself answers 403 with code self_grant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/service/spaces/${SPACE}/members`,
      payload: { externalId: 'ext-me', role: 'writer', addedByExternalId: 'ext-me' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(selfGrantBody);
  });

  it('PATCH demoting the sole admin answers 409 (the platform maps it to `conflict`)', async () => {
    memberRow = { userId: 'u-ext-other', groupId: null, role: 'admin' };
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/service/spaces/${SPACE}/members/${MEMBER}`,
      payload: { role: 'reader', actorExternalId: 'ext-me' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/at least one admin/);
  });

  it('PATCH without actorExternalId is a 400 that never reaches the service', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/service/spaces/${SPACE}/members/${MEMBER}`,
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});

/**
 * #616 Stage 2 — the versioned member / space writes and the member preview through the real pipeline (global
 * ValidationPipe exactly as main.ts mounts it, which strips unknown keys and would silently drop an undeclared
 * `expectedVersion`): a stale version is a 412 whose body carries `code: 'precondition_failed'` (the platform maps
 * it by code), the optional DELETE / archive body is parsed and validated, a body-less archive / removal is the
 * pre-#616 request, and the preview answers its bare body with a 200 and writes nothing.
 */
describe('service-bridge versioned writes + member preview on the wire (#616)', () => {
  const SPACE = '22222222-2222-4222-8222-222222222222';
  const MEMBER = '33333333-3333-4333-8333-333333333333';
  let app: NestFastifyApplication;
  let calls: SpyQuery[];
  const STALE = 'f'.repeat(64);

  beforeAll(async () => {
    const spy = spyKysely((query) => {
      const s = query.sql.toLowerCase();
      if (s.includes('for no key update')) return [{ id: SPACE, deletedAt: null }];
      if (s.includes('from space_members') && s.includes('for update')) {
        return [{ id: MEMBER, userId: 'u-ext-other', groupId: null, role: 'writer', deletedAt: null }];
      }
      if (s.includes('update spaces set')) return [{ id: SPACE, deletedAt: new Date() }];
      return [];
    });
    calls = spy.calls;
    const bridge = {
      provisionShadowUser: async () => {
        throw new Error('a preview must never provision');
      },
      // `ext-new` has never been provisioned: the preview must report it, never create it.
      findShadowUserId: async (externalId: string) => (externalId === 'ext-new' ? null : `u-${externalId}`),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ServiceSpaceController],
      providers: [
        {
          provide: ServiceSpaceService,
          useValue: new ServiceSpaceService(spy.db, { resolveDefaultWorkspaceId: async () => WS } as any, bridge as any),
        },
      ],
    })
      .overrideGuard(RemoteOnlyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ServiceAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api'); // main.ts
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true })); // main.ts
    app.useGlobalInterceptors(new TransformHttpResponseInterceptor(app.get(Reflector))); // main.ts
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => await app?.close());
  beforeEach(() => {
    calls.length = 0;
  });

  const VERSION = expect.stringMatching(/^[0-9a-f]{64}$/);
  const wrote = () => calls.some((c) => /^\s*(update|delete|insert)/i.test(c.sql));

  it('PATCH member with a stale expectedVersion answers 412 precondition_failed and writes nothing', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/service/spaces/${SPACE}/members/${MEMBER}`,
      payload: { role: 'reader', actorExternalId: 'ext-me', expectedVersion: STALE },
    });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toEqual({ code: 'precondition_failed', message: expect.any(String) });
    expect(wrote()).toBe(false);
  });

  it('PATCH member with "*" (exists) applies and answers { ok, version }', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/service/spaces/${SPACE}/members/${MEMBER}`,
      payload: { role: 'reader', actorExternalId: 'ext-me', expectedVersion: '*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: VERSION });
  });

  it('DELETE member parses its optional JSON body: a stale version is a 412, and no body at all is the old request', async () => {
    const stale = await app.inject({
      method: 'DELETE',
      url: `/api/service/spaces/${SPACE}/members/${MEMBER}`,
      payload: { expectedVersion: STALE },
    });
    expect(stale.statusCode).toBe(412);
    expect(wrote()).toBe(false);
    const bare = await app.inject({ method: 'DELETE', url: `/api/service/spaces/${SPACE}/members/${MEMBER}` });
    expect(bare.statusCode).toBe(200);
    expect(bare.json()).toEqual({ ok: true });
  });

  it('an over-long expectedVersion is a 400 (validated, never stripped)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/service/spaces/${SPACE}/archive`,
      payload: { expectedVersion: 'x'.repeat(129) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST archive without a body answers { ok, version } (the pre-#616 request, a new field in the answer)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/service/spaces/${SPACE}/archive` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: VERSION });
  });

  it('POST members/preview answers the bare preview with a 200, provisions nobody and writes nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/service/spaces/${SPACE}/members/preview`,
      payload: { action: 'add', externalId: 'ext-new', role: 'writer', addedByExternalId: 'ext-me' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      outcome: 'would_apply',
      version: null,
      effect: { roleBefore: null, roleAfter: 'writer', provisionsAccount: true },
    });
    expect(wrote()).toBe(false);
  });

  it('POST members/preview without a field its action requires is a 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/service/spaces/${SPACE}/members/preview`,
      payload: { action: 'update', role: 'reader', actorExternalId: 'ext-me' },
    });
    expect(res.statusCode).toBe(400);
  });
});
