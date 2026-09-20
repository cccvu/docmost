import { Controller, ExecutionContext, HttpStatus, Post } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Public, IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { PLATFORM_PUBLIC_KEY } from './platform-authz.decorator';

/**
 * Regression suite for the @Public-surface per-IP throttler (GitHub #29) — NOT upstream Docmost code.
 *
 * Proves the properties that matter: a @Public HTTP route is rate-limited (429 + the stock un-suffixed
 * Retry-After) once the per-IP limit is exceeded; the guard keys on the unspoofable X-Real-IP (a second
 * X-Real-IP gets its own bucket) not on req.ip; a non-@Public route is NEVER throttled; and the guard FAILS
 * OPEN when the throttle storage errors or hangs (a Redis outage must not 500/hang the anonymous surface).
 * A unit block pins the @Public/@PlatformPublic scoping predicate, and a source pin guards the APP_GUARD
 * registration. Same Fastify-adapter harness shape as authz/mode/native-auth-http.spec.ts.
 *
 * The guard reads its limit from env at CONSTRUCTION, so boot() sets a small, deterministic limit before the
 * app (and therefore the APP_GUARD singleton) is instantiated.
 */
import {
  PublicSurfaceThrottlerGuard,
  isPublicHttpRoute,
} from './public-surface-throttler.guard';

const ENV_KEYS = ['PUBLIC_RATE_LIMIT_MAX', 'PUBLIC_RATE_LIMIT_TTL_MS'] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

@Controller('probe')
class ProbeController {
  @Public()
  @Post('open')
  open() {
    return { ok: true };
  }

  @Post('closed')
  closed() {
    return { ok: true };
  }
}

async function boot(
  storageOverride?: Partial<ThrottlerStorage>,
): Promise<NestFastifyApplication> {
  // small, deterministic limit — read by the guard's constructor during module init below
  process.env.PUBLIC_RATE_LIMIT_MAX = '2';
  process.env.PUBLIC_RATE_LIMIT_TTL_MS = '60000';
  let builder = Test.createTestingModule({
    // forRoot provides the (in-memory) ThrottlerStorage + Reflector the guard injects. Its named
    // throttlers are irrelevant — the guard uses its OWN isolated options object.
    imports: [
      ThrottlerModule.forRoot({
        throttlers: [{ name: 'ignored', ttl: 60_000, limit: 1000 }],
      }),
    ],
    controllers: [ProbeController],
    providers: [
      Reflector,
      { provide: APP_GUARD, useClass: PublicSurfaceThrottlerGuard },
    ],
  });
  if (storageOverride) {
    builder = builder
      .overrideProvider(ThrottlerStorage)
      .useValue(storageOverride);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('PublicSurfaceThrottlerGuard — HTTP boundary (#29)', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await boot();
  });
  afterAll(async () => {
    await app?.close();
  });

  const open = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/probe/open', payload: {}, headers });

  it('rate-limits a @Public route per X-Real-IP: 429 + a sane Retry-After once the limit is exceeded', async () => {
    const ip = { 'x-real-ip': '203.0.113.10' };
    expect((await open(ip)).statusCode).toBe(HttpStatus.CREATED);
    expect((await open(ip)).statusCode).toBe(HttpStatus.CREATED);
    const blocked = await open(ip);
    expect(blocked.statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // stock (un-suffixed) header, and a real positive value clients can honor
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('keys on X-Real-IP, not req.ip: a DIFFERENT X-Real-IP keeps its own bucket (spoof-resistant, no global bucket)', async () => {
    const a = { 'x-real-ip': '203.0.113.20' };
    expect((await open(a)).statusCode).toBe(HttpStatus.CREATED);
    expect((await open(a)).statusCode).toBe(HttpStatus.CREATED);
    expect((await open(a)).statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS); // IP A exhausted
    // IP B is unaffected — proves per-IP isolation (a global-bucket regression would 429 here)
    expect((await open({ 'x-real-ip': '203.0.113.21' })).statusCode).toBe(
      HttpStatus.CREATED,
    );
  });

  it('never throttles a non-@Public route (authenticated traffic is untouched)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/probe/closed',
        payload: {},
        headers: { 'x-real-ip': '203.0.113.99' },
      });
      expect(res.statusCode).toBe(HttpStatus.CREATED);
    }
  });
});

describe('PublicSurfaceThrottlerGuard — fails OPEN when throttle storage is unavailable (#29)', () => {
  it('admits the @Public request (200/201, not 500) when storage.increment REJECTS', async () => {
    const app = await boot({
      increment: async () => {
        throw new Error('redis down');
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/probe/open',
        payload: {},
        headers: { 'x-real-ip': '203.0.113.30' },
      });
      expect(res.statusCode).toBe(HttpStatus.CREATED);
    } finally {
      await app.close();
    }
  });

  it('admits the @Public request when storage.increment HANGS (fast-fail via the storage timeout)', async () => {
    const app = await boot({
      increment: () => new Promise(() => undefined) as never, // never resolves
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/probe/open',
        payload: {},
        headers: { 'x-real-ip': '203.0.113.31' },
      });
      expect(res.statusCode).toBe(HttpStatus.CREATED);
    } finally {
      await app.close();
    }
  }, 10_000);
});

describe('isPublicHttpRoute — scoping predicate (#29)', () => {
  const handler = () => undefined;
  class Cls {}
  const ctx = (type: 'http' | 'ws' | 'rpc'): ExecutionContext =>
    ({
      getType: () => type,
      getHandler: () => handler,
      getClass: () => Cls,
    }) as unknown as ExecutionContext;
  // reflector stub returning true only for the given metadata key (like the real @Public/@PlatformPublic)
  const reflectorForKey = (key?: string): Reflector =>
    ({ getAllAndOverride: (k: string) => k === key }) as unknown as Reflector;

  it('is true for HTTP + @Public()', () => {
    expect(isPublicHttpRoute(reflectorForKey(IS_PUBLIC_KEY), ctx('http'))).toBe(
      true,
    );
  });

  it('is true for HTTP + @PlatformPublic() (matches the canonical route classifier, not just @Public)', () => {
    expect(
      isPublicHttpRoute(reflectorForKey(PLATFORM_PUBLIC_KEY), ctx('http')),
    ).toBe(true);
  });

  it('is false for an authenticated HTTP route (neither marker)', () => {
    expect(isPublicHttpRoute(reflectorForKey(undefined), ctx('http'))).toBe(
      false,
    );
  });

  it('is false for non-HTTP contexts (WS/RPC) even when the route is public', () => {
    expect(isPublicHttpRoute(reflectorForKey(IS_PUBLIC_KEY), ctx('ws'))).toBe(
      false,
    );
    expect(isPublicHttpRoute(reflectorForKey(IS_PUBLIC_KEY), ctx('rpc'))).toBe(
      false,
    );
  });
});

describe('app.module.ts wiring (#29)', () => {
  // Source pin (repo idiom, cf. platform-audit.wiring.spec.ts): guards against silently dropping the
  // provider — which would disable the whole feature with the suite otherwise green — without importing the
  // heavy AppModule graph.
  const src = readFileSync(join(__dirname, '..', '..', 'app.module.ts'), 'utf8');

  it('registers PublicSurfaceThrottlerGuard as a global APP_GUARD', () => {
    expect(src).toMatch(
      /provide:\s*APP_GUARD,\s*useClass:\s*PublicSurfaceThrottlerGuard/,
    );
    expect(src).toMatch(/import\s*\{\s*PublicSurfaceThrottlerGuard\s*\}/);
  });
});
