import {
  CanActivate,
  Controller,
  Get,
  Headers,
  Injectable,
  NotFoundException,
  Post,
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
import {
  ContentParseBusyException,
  ConversionBudgetExhaustedException,
} from '../../editor-compat/content-parse/content-parse.service';
import { RetryAfterModule } from './retry-after.module';
import { AuthzModule } from '../authz.module';
import {
  defaultRetryAfterSec,
  RETRY_AFTER_MAX_SEC,
  RETRY_AFTER_MIN_SEC,
  RetryAfterFilter,
  UNKEYED_CREATE_OUTCOME_UNKNOWN_MESSAGE,
  UNKEYED_CREATE_ROUTE,
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
  @Get('budget') budget(): never {
    throw new ConversionBudgetExhaustedException(17); // #642: the converter budget's own refill time
  }
  @Get('budget-preset') budgetPreset(
    @Res({ passthrough: true }) res: FastifyReply,
  ): never {
    res.header('Retry-After', '99');
    throw new ConversionBudgetExhaustedException(17);
  }
  @Get('not-found') nf(): never {
    throw new NotFoundException('gone');
  }
}

/**
 * wiki-v2#716: the native page routes, raised as production raises them. `create` is the upstream route path
 * (`PageController` @Controller('pages') @Post('create') under the global 'api' prefix); `x-probe` picks the throw.
 */
@Controller('api/pages')
class NativePageProbeController {
  private raise(probe: string | undefined): never {
    switch (probe) {
      case 'after-insert':
        // page.controller.ts: `validateCanViewWithPermissions` AFTER `pageService.create` committed.
        throw authzUnavailable();
      case 'before-insert':
        // The same uncoded 503 thrown BEFORE the insert (the parent/space check): indistinguishable on the wire.
        throw authzUnavailable();
      case 'parse-busy':
        throw new ContentParseBusyException(); // coded engine_busy: no conversion slot, nothing was created
      case 'engine-busy':
        throw engineBusy();
      case 'budget':
        throw new ConversionBudgetExhaustedException(7);
      default:
        throw new NotFoundException('gone');
    }
  }
  @Post('create') create(@Headers('x-probe') probe?: string): never {
    return this.raise(probe);
  }
  @Get('create') createGet(@Headers('x-probe') probe?: string): never {
    return this.raise(probe); // same url, another method: not the create
  }
  @Post('update') update(@Headers('x-probe') probe?: string): never {
    return this.raise(probe);
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
    controllers: [ProbeController, NativePageProbeController],
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

  it('#642: the converter-budget 429 carries its own refill time as Retry-After; body as Nest renders it', async () => {
    const res = await app.inject({ method: 'GET', url: '/budget' });
    const ref = await bare.inject({ method: 'GET', url: '/budget' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('17');
    expect(ref.headers['retry-after']).toBeUndefined();
    expect(res.body).toBe(ref.body);
    expect(res.json()).toMatchObject({ code: 'conversion_budget_exhausted' });
    // Never over a value already set.
    expect(
      (await app.inject({ method: 'GET', url: '/budget-preset' })).headers[
        'retry-after'
      ],
    ).toBe('99');
  });

  it('never on another status', async () => {
    const res = await app.inject({ method: 'GET', url: '/not-found' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['retry-after']).toBeUndefined();
  });

  describe('wiki-v2#716: the native unkeyed create’s uncoded 503 is outcome-unknown', () => {
    const create = (probe: string, method: 'POST' | 'GET' = 'POST', url = '/api/pages/create') =>
      app.inject({ method, url, headers: { 'x-probe': probe } });

    it.each(['after-insert', 'before-insert'])(
      '%s: still a 503, but NO Retry-After and the "may have been created" message',
      async (probe) => {
        const res = await create(probe);
        expect(res.statusCode).toBe(503);
        expect(res.headers['retry-after']).toBeUndefined();
        expect(res.json()).toEqual({
          statusCode: 503,
          error: 'Service Unavailable',
          message: UNKEYED_CREATE_OUTCOME_UNKNOWN_MESSAGE,
        });
      },
    );

    it.each(['parse-busy', 'engine-busy'])(
      'a CODED 503 (%s) on the create changed nothing: it keeps its body and the default Retry-After',
      async (probe) => {
        const res = await create(probe);
        expect(res.statusCode).toBe(503);
        expect(inWindow(res.headers['retry-after'])).toBe(true);
        expect(res.json()).toMatchObject({ code: 'engine_busy' });
      },
    );

    it('the converter-budget 429 on the create keeps its own Retry-After', async () => {
      const res = await create('budget');
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('7');
    });

    it('any other route (or method) keeps the default: /api/pages/update, GET /api/pages/create', async () => {
      for (const res of [
        await create('after-insert', 'POST', '/api/pages/update'),
        await create('after-insert', 'GET'),
      ]) {
        expect(res.statusCode).toBe(503);
        expect(inWindow(res.headers['retry-after'])).toBe(true);
        expect(res.json().message).not.toBe(
          UNKEYED_CREATE_OUTCOME_UNKNOWN_MESSAGE,
        );
      }
    });
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

describe('the unkeyed-create exception names the real native route (#716 review)', () => {
  // The filter keys on the literal Fastify route URL. If upstream renamed the controller prefix, the handler path or the
  // global prefix, the exception would silently stop matching and the native create's may-have-committed 503 would
  // carry a Retry-After again. Pin the literal against the sources it is built from.
  it("is 'api' + PageController's @Controller('pages') + its @Post('create')", () => {
    const main = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
    const ctrl = readFileSync(join(__dirname, '..', '..', 'core', 'page', 'page.controller.ts'), 'utf8');
    expect(main).toMatch(/app\.setGlobalPrefix\('api',/);
    expect(ctrl).toMatch(/@Controller\('pages'\)\s*export class PageController\b/);
    expect(ctrl).toMatch(/@Post\('create'\)\s*async create\(/);
    expect(UNKEYED_CREATE_ROUTE).toEqual({ method: 'POST', url: '/api/pages/create' });
  });
});
