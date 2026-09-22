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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTHZ_MODE } from '../mode/authz-mode';
import { PlatformAuditClient, AuditIngestEvent } from '../audit/platform-audit.client';
import { ApiAccessAuditService } from './api-access-audit.service';
import { ApiAccessAuditInterceptor } from './api-access-audit.interceptor';
import { PrincipalRateLimitInterceptor } from './principal-rate-limit.interceptor';

/**
 * Wiring + composition fitness for the #467 request controls — NOT upstream Docmost code.
 *
 * A source pin guards the seam-#4 registration + ORDER (dropping or reordering an interceptor would disable
 * a control, or stop 429s being audited, with the suite otherwise green), and an integration test proves the
 * load-bearing composition property: an authenticated `/api` request over the per-principal limit is BOTH
 * rejected (429) AND audited — because the audit interceptor wraps the rate-limit interceptor and observes
 * the 429 it raises.
 */
describe('request-controls wiring (#467) — app.module.ts source pin', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'app.module.ts'), 'utf8');

  it('registers both interceptors as global APP_INTERCEPTORs and imports them', () => {
    expect(src).toMatch(/provide:\s*APP_INTERCEPTOR,\s*useClass:\s*ApiAccessAuditInterceptor/);
    expect(src).toMatch(/provide:\s*APP_INTERCEPTOR,\s*useClass:\s*PrincipalRateLimitInterceptor/);
    expect(src).toMatch(/import\s*\{\s*ApiAccessAuditInterceptor\s*\}/);
    expect(src).toMatch(/import\s*\{\s*PrincipalRateLimitInterceptor\s*\}/);
    expect(src).toMatch(/import\s*\{\s*ApiAccessAuditService\s*\}/);
  });

  it('keeps the load-bearing order: AuditActor → ApiAccessAudit → PrincipalRateLimit (outer→inner)', () => {
    const iAudit = src.indexOf('useClass: AuditActorInterceptor');
    const iAccess = src.indexOf('useClass: ApiAccessAuditInterceptor');
    const iRate = src.indexOf('useClass: PrincipalRateLimitInterceptor');
    expect(iAudit).toBeGreaterThan(-1);
    expect(iAccess).toBeGreaterThan(iAudit); // access-audit wraps the rate limiter, so it records the 429
    expect(iRate).toBeGreaterThan(iAccess); // rate limiter is innermost — rejects before the handler
  });
});

/** Mimics JwtAuthGuard: sets the verified principal from a header. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = { user: { id: 'user-1' }, workspace: { id: 'ws1' } };
    return true;
  }
}

@Controller('probe')
class ProbeController {
  @UseGuards(FakeAuthGuard)
  @Post('authed')
  authed() {
    return { ok: true };
  }
}

function countingStorage(): ThrottlerStorage {
  const hits = new Map<string, number>();
  return {
    increment: async (key: string, ttl: number, limit: number, block: number) => {
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
  } as unknown as ThrottlerStorage;
}

describe('request-controls composition — an over-limit /api request is BOTH limited AND audited (#467)', () => {
  let app: NestFastifyApplication;
  const forwarded: AuditIngestEvent[] = [];

  beforeAll(async () => {
    process.env.PRINCIPAL_RATE_LIMIT_MAX = '1';
    process.env.PRINCIPAL_RATE_LIMIT_TTL_MS = '60000';
    process.env.PRINCIPAL_RATE_LIMIT_BLOCK_MS = '60000';
    process.env.PRINCIPAL_RATE_LIMIT_MODE = 'enforce';
    delete process.env.API_AUDIT_ENABLED;
    delete process.env.API_AUDIT_MUTATIONS_ONLY;

    const fakeClient: Pick<PlatformAuditClient, 'forward'> = {
      forward: async (events) => {
        forwarded.push(...events);
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'ignored', ttl: 60_000, limit: 1000 }] })],
      controllers: [ProbeController],
      providers: [
        Reflector,
        FakeAuthGuard,
        { provide: AUTHZ_MODE, useValue: 'remote' },
        { provide: PlatformAuditClient, useValue: fakeClient },
        ApiAccessAuditService,
        // Order = outer→inner: access-audit wraps the rate limiter (so it records the 429).
        { provide: APP_INTERCEPTOR, useClass: ApiAccessAuditInterceptor },
        { provide: APP_INTERCEPTOR, useClass: PrincipalRateLimitInterceptor },
      ],
    })
      .overrideProvider(ThrottlerStorage)
      .useValue(countingStorage())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const k of ['PRINCIPAL_RATE_LIMIT_MAX', 'PRINCIPAL_RATE_LIMIT_TTL_MS', 'PRINCIPAL_RATE_LIMIT_BLOCK_MS', 'PRINCIPAL_RATE_LIMIT_MODE']) {
      delete process.env[k];
    }
  });

  const post = () => app.inject({ method: 'POST', url: '/probe/authed', payload: {} });

  it('first request: allowed (201) and audited as a 200-class access row', async () => {
    expect((await post()).statusCode).toBe(HttpStatus.CREATED);
    const row = forwarded[forwarded.length - 1];
    expect(row).toMatchObject({ eventCategory: 'access', event: 'api.post', actorId: 'user-1' });
    expect(row.metadata).toMatchObject({ status: HttpStatus.CREATED, outcome: 'success' });
  });

  it('second request: rejected 429 AND still audited with status 429', async () => {
    const before = forwarded.length;
    const res = await post();
    expect(res.statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(forwarded.length).toBe(before + 1); // the 429 produced exactly one audit row
    expect(forwarded[forwarded.length - 1].metadata).toMatchObject({ status: 429, outcome: 'error' });
  });
});
