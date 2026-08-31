import { CanActivate, Controller, ExecutionContext, Get, Injectable, UnauthorizedException, UseGuards } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PlatformAuthorizationGuard } from './platform-authorization.guard';
import { PlatformAuthz, PlatformPublic } from './platform-authz.decorator';
import { Public } from '../../common/decorators/public.decorator';

/**
 * Runtime proof of the fail-closed Layer-C guard — NOT upstream Docmost code (GitHub #13).
 *
 * The fork analog of the platform's `authorization.guard.spec.ts`. Boots the guard as an APP_GUARD over a
 * fixture controller and asserts: a deliberately un-annotated route is DENIED (403), while decided routes are
 * allowed and — critically — the guard is a PASS-THROUGH for 'authenticated' routes, so the controller's own
 * auth guard still runs (no bypass, no double-auth). This is the enforcement half the fork lacked.
 */

// A fixture guard NAMED `JwtAuthGuard` — the classifier recognizes auth guards by name (AUTH_GUARD_NAMES), so
// this stands in for the real one without importing its passport/env dependencies. It actually enforces (via
// a test header) so we can prove the global guard passes through to it rather than bypassing authn.
@Injectable()
class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.headers['x-test-auth'] === 'yes') return true;
    throw new UnauthorizedException();
  }
}

@Controller('fixture')
class FixtureController {
  @Get('none') // deliberately un-annotated, no guard → the global guard must DENY (403)
  unannotated() {
    return { ok: true };
  }

  @Public()
  @Get('public')
  publicRoute() {
    return { ok: true };
  }

  @PlatformPublic()
  @Get('platform-public')
  platformPublic() {
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('authed')
  authed() {
    return { ok: true };
  }

  @PlatformAuthz('page', 'view')
  @Get('fork-authz')
  forkAuthz() {
    return { ok: true };
  }
}

describe('PlatformAuthorizationGuard (fail-closed Layer C)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FixtureController],
      providers: [JwtAuthGuard, { provide: APP_GUARD, useClass: PlatformAuthorizationGuard }],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => await app?.close());

  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

  it('DENIES an un-annotated route (403) — the fail-closed core', async () => {
    const res = await get('/fixture/none');
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('route has no authorization decision');
  });

  it('allows a @Public route (200)', async () => {
    expect((await get('/fixture/public')).statusCode).toBe(200);
  });

  it('allows a @PlatformPublic route (200)', async () => {
    expect((await get('/fixture/platform-public')).statusCode).toBe(200);
  });

  it('allows a @PlatformAuthz route (fork-authz decided) (200)', async () => {
    expect((await get('/fixture/fork-authz')).statusCode).toBe(200);
  });

  it('is a PASS-THROUGH for an authenticated route — the controller JwtAuthGuard still enforces', async () => {
    // With credentials, the route passes both the global guard and JwtAuthGuard.
    expect((await get('/fixture/authed', { 'x-test-auth': 'yes' })).statusCode).toBe(200);
    // WITHOUT credentials, the global guard does NOT bypass authn — JwtAuthGuard denies (401). Proves the
    // global guard composes with (never short-circuits) the controller's own authentication.
    expect((await get('/fixture/authed')).statusCode).toBe(401);
  });
});
