import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CanActivate, ConflictException, Controller, ExecutionContext, Injectable, Module, Post } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ApiAccessAuditInterceptor } from '../authz/request-controls/api-access-audit.interceptor';
import { ApiAccessAuditService } from '../authz/request-controls/api-access-audit.service';
import { PageGuardConflictInterceptor, PAGE_GUARD_CONFLICTS, toPageGuardConflict } from './page-guard-conflict.interceptor';
import { RESTRICTED_SPACE_MOVE, RESTRICTION_STRIP } from './page-restriction-guard.installer';
import { ServiceBridgeModule } from './service-bridge.module';

/** What postgres.js throws for a trigger's `raise ... using errcode = 'check_violation', constraint = ...`. */
const pgError = (constraint: string, code = '23514') =>
  Object.assign(new Error(`moving page 11111111-1111-1111-1111-111111111111 would ...`), {
    name: 'PostgresError',
    code,
    constraint_name: constraint,
  });

describe('toPageGuardConflict', () => {
  it.each([RESTRICTED_SPACE_MOVE, RESTRICTION_STRIP, 'ccc_page_no_cycle'])('maps %s to a 409 with a fixed body', (c) => {
    const e = toPageGuardConflict(pgError(c));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e!.getResponse()).toEqual({ message: PAGE_GUARD_CONFLICTS[c], code: c });
    expect(JSON.stringify(e!.getResponse())).not.toMatch(/1111/); // the driver message (with ids) never leaks
  });

  it('passes everything else through: another constraint, another SQLSTATE, a non-driver error', () => {
    expect(toPageGuardConflict(pgError('pages_slug_key'))).toBeNull();
    expect(toPageGuardConflict(pgError('ccc_page_future_guard'))).toBeNull(); // closed set, not a prefix match
    expect(toPageGuardConflict(pgError(RESTRICTION_STRIP, '23505'))).toBeNull();
    expect(toPageGuardConflict(new Error('boom'))).toBeNull();
    expect(toPageGuardConflict(null)).toBeNull();
  });
});

/**
 * The interceptor must sit INSIDE the #467 access audit so the audit row says 409, not 500. Nest applies the
 * APP_INTERCEPTORs of the root module before (outside) those of the modules it imports; the real app registers the
 * audit in AppModule and this interceptor in ServiceBridgeModule. This boots that topology through the real Nest/
 * Fastify pipeline with the REAL audit interceptor, and pins both registrations.
 */
describe('PageGuardConflictInterceptor in the app topology', () => {
  const USER = '22222222-2222-2222-2222-222222222222';

  @Controller('pages')
  class MovingController {
    @Post('move')
    move() {
      throw pgError(RESTRICTION_STRIP);
    }

    @Post('other')
    other() {
      throw pgError('pages_slug_key', '23505');
    }
  }

  @Injectable()
  class SignedIn implements CanActivate {
    canActivate(ctx: ExecutionContext): boolean {
      ctx.switchToHttp().getRequest().user = { user: { id: USER }, workspace: { id: USER } };
      return true;
    }
  }

  @Module({
    controllers: [MovingController],
    providers: [{ provide: APP_INTERCEPTOR, useClass: PageGuardConflictInterceptor }],
  })
  class ChildModule {}

  const record = jest.fn();

  @Module({
    imports: [ChildModule],
    providers: [
      { provide: ApiAccessAuditService, useValue: { enabled: true, record } },
      { provide: APP_GUARD, useClass: SignedIn },
      { provide: APP_INTERCEPTOR, useClass: ApiAccessAuditInterceptor },
    ],
  })
  class RootModule {}

  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RootModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => await app?.close());
  beforeEach(() => record.mockClear());

  it('answers 409 { message, code } and the access audit records the 409', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pages/move' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ message: PAGE_GUARD_CONFLICTS[RESTRICTION_STRIP], code: RESTRICTION_STRIP });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ route: '/api/pages/move' }), 409, 'error', expect.any(Number));
  });

  it('negative control: any other driver error is untouched (still a 500, audited as one)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pages/other' });
    expect(res.statusCode).toBe(500);
    expect(record).toHaveBeenCalledWith(expect.anything(), 500, 'error', expect.any(Number));
  });

  it('the real registrations match this topology: audit in AppModule, the mapper in ServiceBridgeModule', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ServiceBridgeModule) as unknown[];
    expect(providers).toContainEqual({ provide: APP_INTERCEPTOR, useClass: PageGuardConflictInterceptor });
    // AppModule itself transitively loads the collab ESM graph jest cannot import; its source is the pin.
    const appModule = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');
    expect(appModule).toMatch(/provide:\s*APP_INTERCEPTOR,\s*useClass:\s*ApiAccessAuditInterceptor/);
    expect(appModule).not.toMatch(/PageGuardConflictInterceptor/);
  });
});
