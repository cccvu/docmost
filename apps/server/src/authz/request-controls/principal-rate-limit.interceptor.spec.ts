import {
  CanActivate,
  Controller,
  ExecutionContext,
  HttpStatus,
  Injectable,
  Post,
  UseGuards,
} from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { PrincipalRateLimitInterceptor } from './principal-rate-limit.interceptor';

/**
 * Regression suite for the per-principal `/api` rate limit (#467) — NOT upstream Docmost code.
 *
 * Proves: an authenticated route is limited per VERIFIED principal (`req.user.user.id`) with a 429 +
 * Retry-After once the limit is exceeded; a SINGLE bucket spans all endpoints (`principal:<id>`, NOT the
 * stock per-(class,handler) key — the cross-endpoint-scraper evasion the design fixes); distinct principals
 * keep distinct buckets; @Public and no-principal (east-west) traffic is never throttled; it FAILS OPEN when
 * the storage errors or hangs; and `count` mode observes without blocking.
 */

/** Mimics JwtAuthGuard's population: sets the verified `{user,workspace}` principal from a header. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers['x-user-id'];
    if (id) req.user = { user: { id }, workspace: { id: 'ws1' } };
    return true;
  }
}

@Controller('probe')
class ProbeController {
  @Public()
  @Post('open')
  open() {
    return { ok: true };
  }

  @UseGuards(FakeAuthGuard)
  @Post('authed')
  authed() {
    return { ok: true };
  }

  @UseGuards(FakeAuthGuard)
  @Post('authed2')
  authed2() {
    return { ok: true };
  }
}

/** A deterministic per-key counter storage that mirrors the Redis increment contract (block on n>limit). */
function countingStorage(): ThrottlerStorage & { keys: string[] } {
  const hits = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    increment: async (key: string, ttl: number, limit: number, block: number) => {
      keys.push(key);
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      const over = n > limit;
      return {
        totalHits: n,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: over,
        timeToBlockExpire: over ? Math.ceil(block / 1000) : 0,
      };
    },
  } as unknown as ThrottlerStorage & { keys: string[] };
}

const ENV_KEYS = [
  'PRINCIPAL_RATE_LIMIT_MAX',
  'PRINCIPAL_RATE_LIMIT_TTL_MS',
  'PRINCIPAL_RATE_LIMIT_BLOCK_MS',
  'PRINCIPAL_RATE_LIMIT_MODE',
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

async function boot(opts?: {
  storage?: Partial<ThrottlerStorage>;
  env?: Partial<Record<(typeof ENV_KEYS)[number], string>>;
}): Promise<NestFastifyApplication> {
  process.env.PRINCIPAL_RATE_LIMIT_MAX = opts?.env?.PRINCIPAL_RATE_LIMIT_MAX ?? '2';
  process.env.PRINCIPAL_RATE_LIMIT_TTL_MS = opts?.env?.PRINCIPAL_RATE_LIMIT_TTL_MS ?? '60000';
  process.env.PRINCIPAL_RATE_LIMIT_BLOCK_MS = opts?.env?.PRINCIPAL_RATE_LIMIT_BLOCK_MS ?? '30000';
  process.env.PRINCIPAL_RATE_LIMIT_MODE = opts?.env?.PRINCIPAL_RATE_LIMIT_MODE ?? 'enforce';
  let builder = Test.createTestingModule({
    imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'ignored', ttl: 60_000, limit: 1000 }] })],
    controllers: [ProbeController],
    providers: [Reflector, FakeAuthGuard, { provide: APP_INTERCEPTOR, useClass: PrincipalRateLimitInterceptor }],
  });
  if (opts?.storage) builder = builder.overrideProvider(ThrottlerStorage).useValue(opts.storage);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const post = (app: NestFastifyApplication, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: {}, headers });

describe('PrincipalRateLimitInterceptor — HTTP boundary (#467)', () => {
  it('limits an authenticated route per principal: 429 + Retry-After once the limit is exceeded', async () => {
    const app = await boot({ storage: countingStorage() });
    try {
      const u = { 'x-user-id': 'user-A' };
      expect((await post(app, '/probe/authed', u)).statusCode).toBe(HttpStatus.CREATED);
      expect((await post(app, '/probe/authed', u)).statusCode).toBe(HttpStatus.CREATED);
      const blocked = await post(app, '/probe/authed', u);
      expect(blocked.statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.headers['x-ratelimit-limit']).toBe('2');
    } finally {
      await app.close();
    }
  });

  it('uses ONE bucket per principal across endpoints (not per-handler — cross-endpoint scraping is caught)', async () => {
    const storage = countingStorage();
    const app = await boot({ storage });
    try {
      const u = { 'x-user-id': 'user-B' };
      expect((await post(app, '/probe/authed', u)).statusCode).toBe(HttpStatus.CREATED);
      // A DIFFERENT endpoint, same user: still the same bucket, so this is the 2nd hit...
      expect((await post(app, '/probe/authed2', u)).statusCode).toBe(HttpStatus.CREATED);
      // ...and a third across either endpoint is blocked.
      expect((await post(app, '/probe/authed', u)).statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
      // Every increment keyed on the principal alone — never the class/handler.
      expect(storage.keys.every((k) => k === 'principal:user-B')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('keeps distinct buckets per principal (one user exhausting does not block another)', async () => {
    const app = await boot({ storage: countingStorage() });
    try {
      const a = { 'x-user-id': 'user-C' };
      expect((await post(app, '/probe/authed', a)).statusCode).toBe(HttpStatus.CREATED);
      expect((await post(app, '/probe/authed', a)).statusCode).toBe(HttpStatus.CREATED);
      expect((await post(app, '/probe/authed', a)).statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect((await post(app, '/probe/authed', { 'x-user-id': 'user-D' })).statusCode).toBe(HttpStatus.CREATED);
    } finally {
      await app.close();
    }
  });

  it('never throttles a @Public route or a no-principal (east-west) request', async () => {
    const app = await boot({ storage: countingStorage() });
    try {
      for (let i = 0; i < 5; i++) expect((await post(app, '/probe/open')).statusCode).toBe(HttpStatus.CREATED);
      // authenticated route but NO x-user-id header ⇒ no principal ⇒ exempt (service/collab east-west shape)
      for (let i = 0; i < 5; i++) expect((await post(app, '/probe/authed')).statusCode).toBe(HttpStatus.CREATED);
    } finally {
      await app.close();
    }
  });

  it('fails OPEN (admits, not 500) when the throttle storage REJECTS', async () => {
    const app = await boot({
      storage: {
        increment: async () => {
          throw new Error('redis down');
        },
      },
    });
    try {
      expect((await post(app, '/probe/authed', { 'x-user-id': 'user-E' })).statusCode).toBe(HttpStatus.CREATED);
    } finally {
      await app.close();
    }
  });

  it('fails OPEN when the throttle storage HANGS (fast-fail via the 1s storage timeout)', async () => {
    const app = await boot({ storage: { increment: () => new Promise(() => undefined) as never } });
    try {
      expect((await post(app, '/probe/authed', { 'x-user-id': 'user-F' })).statusCode).toBe(HttpStatus.CREATED);
    } finally {
      await app.close();
    }
  }, 10_000);

  it('count mode: over-limit is ADMITTED (never 429) so the limit can be tuned before enforcing', async () => {
    const app = await boot({ storage: countingStorage(), env: { PRINCIPAL_RATE_LIMIT_MODE: 'count' } });
    try {
      const u = { 'x-user-id': 'user-G' };
      for (let i = 0; i < 5; i++) expect((await post(app, '/probe/authed', u)).statusCode).toBe(HttpStatus.CREATED);
    } finally {
      await app.close();
    }
  });

  it('off mode: the interceptor is inert', async () => {
    const app = await boot({ storage: countingStorage(), env: { PRINCIPAL_RATE_LIMIT_MODE: 'off' } });
    try {
      const u = { 'x-user-id': 'user-H' };
      for (let i = 0; i < 5; i++) expect((await post(app, '/probe/authed', u)).statusCode).toBe(HttpStatus.CREATED);
    } finally {
      await app.close();
    }
  });
});
