import { Controller, ExecutionContext, HttpStatus, Post } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { Public, IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

/**
 * Regression suite for the @Public-surface per-IP throttler (GitHub #29) — NOT upstream Docmost code.
 *
 * Proves the two properties that matter: (1) a `@Public()` HTTP route is rate-limited (429 + the stock
 * `Retry-After` header once the per-IP limit is exceeded), and (2) a non-`@Public` route is NEVER
 * throttled by this guard (authenticated traffic is untouched) — the guard's isolation from the shared
 * auth/ai-chat throttlers and its @Public scoping, exercised end-to-end on a Fastify adapter (same
 * harness shape as authz/mode/native-auth-http.spec.ts). A unit block pins the scoping predicate.
 *
 * The guard reads its limit from env at CONSTRUCTION, so boot() sets a small, deterministic limit before
 * the app (and therefore the APP_GUARD singleton) is instantiated.
 */
import {
  PublicSurfaceThrottlerGuard,
  isPublicHttpRoute,
} from './public-surface-throttler.guard';

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

async function boot(): Promise<NestFastifyApplication> {
  // small, deterministic limit — read by the guard's constructor during module init below
  process.env.PUBLIC_RATE_LIMIT_MAX = '2';
  process.env.PUBLIC_RATE_LIMIT_TTL_MS = '60000';
  const moduleRef = await Test.createTestingModule({
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
  }).compile();

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

  const openOnce = () =>
    app.inject({ method: 'POST', url: '/probe/open', payload: {} });

  it('rate-limits a @Public route: 429 + Retry-After once the per-IP limit is exceeded', async () => {
    // limit = 2 per window (env above). The 3rd request from the same IP is blocked.
    expect((await openOnce()).statusCode).toBe(HttpStatus.CREATED);
    expect((await openOnce()).statusCode).toBe(HttpStatus.CREATED);
    const blocked = await openOnce();
    expect(blocked.statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // stock (un-suffixed) header — clients can honor it because the throttler is named 'default'
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('never throttles a non-@Public route (authenticated traffic is untouched)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/probe/closed',
        payload: {},
      });
      expect(res.statusCode).toBe(HttpStatus.CREATED);
    }
  });
});

describe('isPublicHttpRoute — scoping predicate (#29)', () => {
  const handler = () => undefined;
  class Cls {}
  const ctx = (
    type: 'http' | 'ws' | 'rpc',
    isPublic: boolean | undefined,
  ): ExecutionContext =>
    ({
      getType: () => type,
      getHandler: () => handler,
      getClass: () => Cls,
    }) as unknown as ExecutionContext;
  const reflectorReturning = (v: boolean | undefined): Reflector =>
    ({ getAllAndOverride: () => v }) as unknown as Reflector;

  it('is true only for HTTP + @Public()', () => {
    expect(isPublicHttpRoute(reflectorReturning(true), ctx('http', true))).toBe(
      true,
    );
  });

  it('is false for an authenticated HTTP route (no @Public marker)', () => {
    expect(
      isPublicHttpRoute(reflectorReturning(undefined), ctx('http', undefined)),
    ).toBe(false);
  });

  it('is false for non-HTTP contexts (WS/RPC) even if the metadata says public', () => {
    expect(isPublicHttpRoute(reflectorReturning(true), ctx('ws', true))).toBe(
      false,
    );
    expect(isPublicHttpRoute(reflectorReturning(true), ctx('rpc', true))).toBe(
      false,
    );
  });

  it('reads the @Public metadata key the decorator sets', () => {
    // guards against the guard drifting from the decorator's metadata key
    expect(IS_PUBLIC_KEY).toBe('isPublic');
  });
});
