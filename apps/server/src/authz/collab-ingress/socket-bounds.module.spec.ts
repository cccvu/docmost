import { Controller, HttpStatus, Post } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Public } from '../../common/decorators/public.decorator';
import { AUTHZ_MODE } from '../mode/authz-mode';
import { PublicSurfaceThrottlerGuard } from '../route-guard/public-surface-throttler.guard';
import { CollabClientTrust } from './client-trust';
import { CollabSocketBounds, collabClientTrustProvider, collabSocketBoundsProvider } from './socket-bounds';

/**
 * CCC spec (#810, ADR 0036) — NOT upstream Docmost code.
 *
 * The per-address share and the public-surface throttler's key are fail-safe: while the trust is `unknown` both behave
 * exactly as before #810, so a wiring break (a renamed inject token, a lost `onModuleInit`, a guard that no longer
 * receives the bounds' trust) would leave CI green and the share silently off. This spec builds the two production
 * providers and the guard the way Nest does (the real factories, `AUTHZ_MODE` as an injected value, `app.init()` running
 * the lifecycle hooks) against a real HTTP server standing in for the platform, and proves:
 * - remote mode: the bounds fetch `GET /authz/edge-trust` with the service secret at init and turn `active`, and the
 *   APP_GUARD throttler holds that same trust and keys on the walk;
 * - native mode: nothing is fetched and the trust stays `unknown` (the control arm).
 */
@Controller('probe')
class ProbeController {
  @Public()
  @Post('open')
  open() {
    return { ok: true };
  }
}

const PROXY = '192.0.2.200';
const ALB = '172.31.20.10';
const SECRET = 'module-spec-secret';
const ENV_KEYS = ['PLATFORM_AUTHZ_URL', 'PLATFORM_AUTHZ_SERVICE_SECRET', 'PLATFORM_AUTHZ_TIMEOUT_MS', 'PUBLIC_RATE_LIMIT_MAX', 'PUBLIC_RATE_LIMIT_TTL_MS'] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let server: Server;
const seen: Array<{ method?: string; url?: string; secret?: string | string[] }> = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    seen.push({ method: req.method, url: req.url, secret: req.headers['x-authz-service-secret'] });
    if (req.method === 'GET' && req.url === '/authz/edge-trust' && req.headers['x-authz-service-secret'] === SECRET) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ trustedProxies: [PROXY], xffTrusted: true }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  process.env.PLATFORM_AUTHZ_URL = `http://127.0.0.1:${port}`;
  process.env.PLATFORM_AUTHZ_SERVICE_SECRET = SECRET;
  process.env.PLATFORM_AUTHZ_TIMEOUT_MS = '1000';
  process.env.PUBLIC_RATE_LIMIT_MAX = '2';
  process.env.PUBLIC_RATE_LIMIT_TTL_MS = '60000';
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

beforeEach(() => {
  seen.length = 0;
});

/** The production providers and guard, with AUTHZ_MODE injected as AuthzModeModule provides it. */
async function boot(mode: 'native' | 'remote'): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'ignored', ttl: 60_000, limit: 1000 }] })],
    controllers: [ProbeController],
    providers: [
      Reflector,
      { provide: AUTHZ_MODE, useValue: mode },
      collabSocketBoundsProvider,
      collabClientTrustProvider,
      { provide: APP_GUARD, useClass: PublicSurfaceThrottlerGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init(); // runs CollabSocketBounds.onModuleInit: the trust fetch starts here
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('#810 the bounds and the throttler as Nest wires them', () => {
  it('remote: init fetches GET /authz/edge-trust with the secret, the trust turns active, and the guard keys on the walk', async () => {
    const app = await boot('remote');
    try {
      const bounds = app.get(CollabSocketBounds);
      await until(() => bounds.clientTrust.state === 'active');
      expect(seen).toEqual([{ method: 'GET', url: '/authz/edge-trust', secret: SECRET }]);
      expect(bounds.clientTrust.trust).toEqual({ trustedProxies: [PROXY], xffTrusted: true });
      // one instance: the exported trust is the bounds' own, never a second fetch loop
      expect(app.get(CollabClientTrust)).toBe(bounds.clientTrust);

      // The APP_GUARD received that trust: a direct caller rotating a forged X-Real-IP stays in its own bucket (with
      // the trust unknown, the guard would key on X-Real-IP and admit all three).
      const viaAlb = (xff: string, realIp: string) =>
        app.inject({ method: 'POST', url: '/probe/open', payload: {}, remoteAddress: ALB, headers: { 'x-forwarded-for': xff, 'x-real-ip': realIp } });
      expect((await viaAlb('203.0.113.80', '6.6.6.1')).statusCode).toBe(HttpStatus.CREATED);
      expect((await viaAlb('203.0.113.80', '6.6.6.2')).statusCode).toBe(HttpStatus.CREATED);
      expect((await viaAlb('203.0.113.80', '6.6.6.3')).statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
      // and a proxied client is keyed past the trusted proxy, per client
      expect((await viaAlb(`198.51.100.80, ${PROXY}`, '6.6.6.4')).statusCode).toBe(HttpStatus.CREATED);
    } finally {
      await app.close();
    }
  });

  it('native (control): nothing is fetched, the trust stays unknown, and the guard keys as before (X-Real-IP)', async () => {
    const app = await boot('native');
    try {
      const bounds = app.get(CollabSocketBounds);
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual([]);
      expect(bounds.clientTrust.state).toBe('unknown');
      expect(app.get(CollabClientTrust)).toBe(bounds.clientTrust);
      const at = (realIp: string) =>
        app.inject({ method: 'POST', url: '/probe/open', payload: {}, remoteAddress: ALB, headers: { 'x-forwarded-for': '203.0.113.81', 'x-real-ip': realIp } });
      expect((await at('6.6.6.10')).statusCode).toBe(HttpStatus.CREATED);
      expect((await at('6.6.6.11')).statusCode).toBe(HttpStatus.CREATED);
      expect((await at('6.6.6.12')).statusCode).toBe(HttpStatus.CREATED);
    } finally {
      await app.close();
    }
  });

  it('a graph without the bounds refuses to build the guard (no silent fallback to X-Real-IP)', async () => {
    const build = Test.createTestingModule({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'ignored', ttl: 60_000, limit: 1000 }] })],
      controllers: [ProbeController],
      providers: [Reflector, { provide: APP_GUARD, useClass: PublicSurfaceThrottlerGuard }],
    }).compile();
    await expect(build).rejects.toThrow(/CollabClientTrust/);
  });
});
