import { Controller, Get, Module, Res } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import { Test } from '@nestjs/testing';
import { ResponseHeadersModule } from './response-headers.module';
import { RESPONSE_SECURITY_HEADERS } from './response-headers';

/**
 * CCC (#319, #62). Boots a REAL Fastify through Nest so the assertion is behavioural: the header is on the
 * wire, not merely present in a table. A table-only test would pass while the hook was never installed.
 */

@Controller()
class ProbeController {
  @Get('probe')
  probe() {
    return { ok: true };
  }

  @Get('own-header')
  ownHeader(@Res({ passthrough: true }) reply: FastifyReply) {
    // A route that has its own reason for a different value (Docmost does this for attachment CSP and the
    // frame header). The hook must not clobber it.
    reply.header('Referrer-Policy', 'no-referrer');
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('ResponseHeadersModule', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ResponseHeadersModule, ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sets every declared header on a normal response', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    for (const [name, value] of RESPONSE_SECURITY_HEADERS) {
      expect(res.headers[name.toLowerCase()]).toBe(value);
    }
  });

  it('sets them on a 404 too — the SPA fallback and error paths are responses like any other', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['referrer-policy']).toBe(
      'strict-origin-when-cross-origin',
    );
  });

  it('never overwrites a header a route set for itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/own-header' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('declares Referrer-Policy as strict-origin-when-cross-origin, NOT no-referrer', () => {
    // no-referrer would strip the same-origin Referer the platform's OriginCheckGuard falls back to.
    const map = new Map(RESPONSE_SECURITY_HEADERS.map(([k, v]) => [k, v]));
    expect(map.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});
