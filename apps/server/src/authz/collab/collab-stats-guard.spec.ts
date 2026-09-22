import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

// The controller only uses CollaborationGateway as a constructor TYPE, but NestJS emits its runtime require
// for DI metadata — which transitively pulls in the collab WebSocket stack (lib0 ESM) that jest cannot
// parse. Stub the module so the heavy graph never loads; the booted app injects its own fake gateway.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {
    getConnectionCount() {
      return 0;
    }
    getDocumentCount() {
      return 0;
    }
  },
}));

import { CollaborationController } from '../../collaboration/server/collaboration.controller';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { CollabServiceSecretGuard } from './service-secret.guard';

/**
 * CCC authorization regression test (part of the fork's compatibility suite) — issue #80.
 *
 * GET /collab/stats runs ONLY in the separate CollabAppModule process (collab-main.ts), which the main
 * app's fail-closed PlatformAuthorizationGuard cannot reach. It must instead carry the service-secret
 * primitive (parity with authz/collab/collab-disconnect). This spec proves, through the real Nest HTTP
 * layer, that the route now:
 *   - DENIES unauthenticated / wrong-secret callers (401),
 *   - ALLOWS the correct `x-authz-service-secret` and returns the gateway counts (200),
 *   - fails CLOSED (503) when the shared secret is unconfigured (CLAUDE.md deny-by-default).
 *
 * Critically, the booted module MIRRORS production wiring: `CollabAppModule` registers no guard provider,
 * so this spec deliberately does NOT list CollabServiceSecretGuard in `providers`. It therefore proves the
 * class-level @UseGuards is auto-registered and enforced by Nest — not masked by an explicit provider.
 * (The guard's internal timing-safe / non-string-header matrix is exhaustively covered in
 * collab-disconnect.controller.spec.ts; here we focus on THIS route's enforcement + fail-closed behavior.)
 */

const HEADER = 'x-authz-service-secret';
const SECRET = 'collab-stats-shared-secret-abcdef'; // >= 16 chars (matches the boot validator's MinLength)
const CONNECTIONS = 7;
const DOCUMENTS = 3;

// A fake gateway returning known counts, so a 200 body proves the handler ran with the real data source.
const gatewayMock = {
  getConnectionCount: () => CONNECTIONS,
  getDocumentCount: () => DOCUMENTS,
};

// Boot the REAL controller (with its class-level @UseGuards) under a FastifyAdapter with the same global
// prefix collab-main.ts sets. The guard reads the secret at construction, so callers set the env BEFORE this.
async function bootApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [CollaborationController],
    providers: [{ provide: CollaborationGateway, useValue: gatewayMock }],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  app.setGlobalPrefix('api'); // parity with collab-main.ts → live path /api/collab/stats
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('GET /collab/stats authentication (issue #80)', () => {
  let savedSecret: string | undefined;

  beforeAll(() => {
    savedSecret = process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
  });
  afterAll(() => {
    if (savedSecret === undefined)
      delete process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
    else process.env.PLATFORM_AUTHZ_SERVICE_SECRET = savedSecret;
  });

  // Static proof of wiring — survives even if the boot harness below regresses. The route classifier and
  // the route-inventory fitness test recognize an auth decision by exactly this metadata.
  it('the controller carries @UseGuards(CollabServiceSecretGuard)', () => {
    const guards =
      Reflect.getMetadata(GUARDS_METADATA, CollaborationController) || [];
    expect(guards).toContain(CollabServiceSecretGuard);
  });

  describe('with the service secret configured', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SECRET;
      app = await bootApp();
    });
    afterAll(async () => {
      await app?.close();
    });

    const get = (headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url: '/api/collab/stats', headers });

    // Unauthorized access is DENIED — the core of the fix.
    it('DENIES a request with no service-secret header (401)', async () => {
      expect((await get()).statusCode).toBe(401);
    });

    // A same-length wrong secret forces the constant-time comparison path (a `===` impl would short-circuit).
    it('DENIES a wrong secret of the same length (401)', async () => {
      expect(
        (await get({ [HEADER]: 'X'.repeat(SECRET.length) })).statusCode,
      ).toBe(401);
    });

    // A different-length wrong secret must be rejected without a timingSafeEqual length error.
    it('DENIES a wrong secret of a different length (401)', async () => {
      expect((await get({ [HEADER]: 'short' })).statusCode).toBe(401);
    });

    // Authorized access behaves correctly — 200 with the gateway's aggregate counts.
    it('ALLOWS the correct secret and returns the gateway counts (200)', async () => {
      const res = await get({ [HEADER]: SECRET });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        connections: CONNECTIONS,
        documents: DOCUMENTS,
      });
    });
  });

  describe('with the service secret UNCONFIGURED (fail-closed)', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      delete process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
      app = await bootApp();
    });
    afterAll(async () => {
      await app?.close();
    });

    // A blank env must never authorize the endpoint — even a presented header fails CLOSED (503),
    // never falls open to serving the counts.
    it('fails CLOSED (503), not open, even when a header is presented', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/collab/stats',
        headers: { [HEADER]: 'anything' },
      });
      expect(res.statusCode).toBe(503);
    });
  });
});
