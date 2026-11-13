import {
  Body,
  CanActivate,
  Controller,
  Delete,
  Get,
  Global,
  Injectable,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { connect, type AddressInfo } from 'node:net';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { Public } from '../../common/decorators/public.decorator';
import { ORIGIN_CHECK_REFUSED_MESSAGE } from './origin-check';
import { OriginCheckModule } from './origin-check.module';

/**
 * wiki-v2 #655: the origin check in a real Nest + Fastify pipeline, configured as the engine's main.ts is
 * (`trustProxy: true`). Proves what the unit specs cannot: the guard registered by OriginCheckModule runs before a
 * controller's own guard (so a refused request never authenticates or reaches the handler), a forged
 * X-Forwarded-Host cannot help (Fastify's `request.host` would honour it), two raw Origin header lines are refused,
 * and a classic cross-site HTML form POST (urlencoded, which the adapter parses) is refused.
 */
const APP_URL = 'https://wiki.example.com';
const HOST = 'wiki.example.com';

const controllerGuardCalls: string[] = [];

/** Stands in for the controller's JwtAuthGuard: records that the request got past the global guards. */
@Injectable()
class SpyControllerGuard implements CanActivate {
  canActivate(ctx: import('@nestjs/common').ExecutionContext): boolean {
    controllerGuardCalls.push(ctx.switchToHttp().getRequest().url);
    return true;
  }
}

@Controller('probe')
@UseGuards(SpyControllerGuard)
class ProbeController {
  @Post('write')
  write(@Body() body: unknown) {
    return { ok: true, body };
  }

  @Delete('write')
  remove() {
    return { ok: true };
  }

  @Get('read')
  read() {
    return { ok: true };
  }

  @Public()
  @Post('public')
  publicWrite() {
    return { ok: true };
  }
}

@Global()
@Module({
  providers: [{ provide: EnvironmentService, useValue: { getAppUrl: () => APP_URL } }],
  exports: [EnvironmentService],
})
class EnvStubModule {}

describe('ForkOriginCheckGuard in a real Nest + Fastify (trustProxy) pipeline (#655)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EnvStubModule, OriginCheckModule],
      controllers: [ProbeController],
      providers: [SpyControllerGuard],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ trustProxy: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    controllerGuardCalls.length = 0;
  });

  const post = (headers: Record<string, string>, payload: unknown = { a: 1 }, url = '/api/probe/write') =>
    app.inject({ method: 'POST', url, headers: { host: HOST, ...headers }, payload: payload as any });

  const expectRefused = (res: { statusCode: number; body: string }) => {
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).message).toBe(ORIGIN_CHECK_REFUSED_MESSAGE);
    expect(controllerGuardCalls).toEqual([]); // the controller guard never ran
  };

  it('a same-origin browser write reaches the controller guard and the handler', async () => {
    const res = await post({ 'sec-fetch-site': 'same-origin', origin: APP_URL, cookie: 'authToken=t' });
    expect(res.statusCode).toBe(201);
    expect(controllerGuardCalls).toEqual(['/api/probe/write']);
  });

  it('a foreign Origin is refused BEFORE the controller guard runs', async () => {
    expectRefused(await post({ origin: 'https://evil.example', cookie: 'authToken=t' }));
  });

  it('a forged X-Forwarded-Host naming the foreign origin cannot help (raw Host is read)', async () => {
    expectRefused(
      await post({ 'x-forwarded-host': 'evil.example', origin: 'https://evil.example', cookie: 'authToken=t' }),
    );
  });

  it('a cross-site urlencoded HTML form POST is refused (the form-CSRF class)', async () => {
    expectRefused(
      await app.inject({
        method: 'POST',
        url: '/api/probe/write',
        headers: {
          host: HOST,
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-site',
          origin: 'https://sibling.example.edu',
          cookie: 'authToken=t',
        },
        payload: 'pageId=x&title=y',
      }),
    );
  });

  it('control: the same urlencoded form with no browser signal is parsed and handled (the refusal above is the guard)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/probe/write',
      headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded', cookie: 'authToken=t' },
      payload: 'pageId=x&title=y',
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).body).toEqual({ pageId: 'x', title: 'y' });
  });

  it('a request with no browser signal at all passes (the relay, the service bridge, smokes)', async () => {
    const res = await post({ cookie: 'authToken=t' });
    expect(res.statusCode).toBe(201);
  });

  it('a @Public route is not exempt', async () => {
    expectRefused(await post({ 'sec-fetch-site': 'cross-site', origin: 'null' }, {}, '/api/probe/public'));
  });

  it('DELETE is decided too', async () => {
    expectRefused(
      await app.inject({
        method: 'DELETE',
        url: '/api/probe/write',
        headers: { host: HOST, origin: 'https://evil.example', cookie: 'authToken=t' },
      }),
    );
  });

  it('a safe method is never decided', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/probe/read',
      headers: { host: HOST, 'sec-fetch-site': 'cross-site', origin: 'null', cookie: 'authToken=t' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('two raw Origin header lines (even both ours) are refused', async () => {
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => {
        const body = '{"a":1}';
        sock.write(
          'POST /api/probe/write HTTP/1.1\r\n' +
            `Host: ${HOST}\r\n` +
            `Origin: ${APP_URL}\r\n` +
            `Origin: ${APP_URL}\r\n` +
            'Cookie: authToken=t\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${body.length}\r\n` +
            'Connection: close\r\n\r\n' +
            body,
        );
      });
      let out = '';
      sock.on('data', (d) => (out += d.toString()));
      sock.on('end', () => resolve(out));
      sock.on('error', reject);
    });
    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    expect(controllerGuardCalls).toEqual([]);
  });
});
