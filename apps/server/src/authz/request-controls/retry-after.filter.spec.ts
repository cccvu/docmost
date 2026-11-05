import {
  CanActivate,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyReply } from 'fastify';
import { authzUnavailable } from '../authz-unavailable';
import { engineBusy } from '../../service-bridge/resource-version';
import { ContentParseBusyException } from '../../editor-compat/content-parse/content-parse.service';
import { RetryAfterModule } from './retry-after.module';
import { AuthzModule } from '../authz.module';
import {
  defaultRetryAfterSec,
  RETRY_AFTER_MAX_SEC,
  RETRY_AFTER_MIN_SEC,
  RetryAfterFilter,
} from './retry-after.filter';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

@Injectable()
class Busy503Guard implements CanActivate {
  canActivate(): boolean {
    throw authzUnavailable();
  }
}

/** Every engine 503 the wiki-v2#696 load runs found without a Retry-After, raised as production raises it. */
@Controller()
class ProbeController {
  @Get('authz-unavailable') authz(): never {
    throw authzUnavailable(); // the PDP-backed repos (pages/info, sidebar-pages, breadcrumbs)
  }
  @Get('search-unauthorized') search(): never {
    // authz/search/pdp-search.service.ts `gate()` — the exact exception it throws.
    throw new ServiceUnavailableException(
      'authorization is temporarily unavailable; the search did not run — retry',
    );
  }
  @Get('engine-busy') busy(): never {
    throw engineBusy(); // the search bulkhead shed, a versioned write's lock timeout
  }
  @Get('content-parse-busy') parse(): never {
    throw new ContentParseBusyException();
  }
  @Get('guard-503') @UseGuards(Busy503Guard) guarded(): string {
    return 'unreachable';
  }
  @Get('preset') preset(@Res({ passthrough: true }) res: FastifyReply): never {
    res.header('Retry-After', '30'); // export admission sets its own
    throw new ServiceUnavailableException('busy');
  }
  @Get('not-found') nf(): never {
    throw new NotFoundException('gone');
  }
}

const ROUTES = [
  'authz-unavailable',
  'search-unauthorized',
  'engine-busy',
  'content-parse-busy',
  'guard-503',
];

async function boot(withFilter: boolean): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: withFilter ? [RetryAfterModule] : [],
    controllers: [ProbeController],
    providers: [Busy503Guard],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('RetryAfterFilter (wiki-v2#696): every engine 503 says when to come back', () => {
  let app: NestFastifyApplication;
  let bare: NestFastifyApplication;
  beforeAll(async () => {
    app = await boot(true);
    bare = await boot(false);
  });
  afterAll(async () => {
    await app.close();
    await bare.close();
  });

  const inWindow = (v: unknown) => {
    const n = Number(v);
    return (
      Number.isInteger(n) &&
      n >= RETRY_AFTER_MIN_SEC &&
      n <= RETRY_AFTER_MAX_SEC
    );
  };

  it.each(ROUTES)(
    '%s: 503 with a jittered Retry-After, body byte-identical to Nest’s default',
    async (route) => {
      const res = await app.inject({ method: 'GET', url: `/${route}` });
      const ref = await bare.inject({ method: 'GET', url: `/${route}` });
      expect(res.statusCode).toBe(503);
      expect(inWindow(res.headers['retry-after'])).toBe(true);
      // Anti-vacuity: without the module the same route has none — the filter is what adds it.
      expect(ref.statusCode).toBe(503);
      expect(ref.headers['retry-after']).toBeUndefined();
      expect(res.body).toBe(ref.body);
      expect(res.headers['content-type']).toBe(ref.headers['content-type']);
    },
  );

  it('keeps a Retry-After the route already set (export admission’s 30 s)', async () => {
    const res = await app.inject({ method: 'GET', url: '/preset' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('never on another status', async () => {
    const res = await app.inject({ method: 'GET', url: '/not-found' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('re-throws outside HTTP (what Nest does there without a filter)', () => {
    const e = new ServiceUnavailableException('x');
    expect(() =>
      new RetryAfterFilter().catch(e, { getType: () => 'ws' } as never),
    ).toThrow(e);
  });

  it('the default stays inside 2–5 s at both ends of the jitter', () => {
    expect(defaultRetryAfterSec(() => 0)).toBe(RETRY_AFTER_MIN_SEC);
    expect(defaultRetryAfterSec(() => 0.999999)).toBe(RETRY_AFTER_MAX_SEC);
  });

  it('is registered from AuthzModule (in the graph via database.module — no upstream file registers it)', () => {
    const imports = Reflect.getMetadata('imports', AuthzModule) as unknown[];
    expect(imports).toContain(RetryAfterModule);
    const providers = Reflect.getMetadata(
      'providers',
      RetryAfterModule,
    ) as Array<{ provide: unknown; useClass: unknown }>;
    expect(providers).toEqual([
      { provide: 'APP_FILTER', useClass: RetryAfterFilter },
    ]);
    // And no upstream file had to change: the only registration is the CCC module.
    const src = readFileSync(
      join(__dirname, '..', '..', 'app.module.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/RetryAfter/);
  });
});
