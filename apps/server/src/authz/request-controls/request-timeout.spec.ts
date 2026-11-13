import { createServer, Server } from 'http';
import { connect } from 'net';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  applyRequestTimeout,
  bufferedBodyDeadlineHook,
  DOCMOST_BUFFERED_BODY_TIMEOUT_MS,
  DOCMOST_REQUEST_TIMEOUT_MS,
} from './request-timeout';
import { RequestTimeoutModule } from './request-timeout.module';

/**
 * #763 — CCC, not upstream. The values are read off the REAL `http.Server` of a REAL `FastifyAdapter` built the
 * way `main.ts` builds it, never off our own object, so a Fastify upgrade that rebuilt or re-zeroed the server
 * goes red here. Behaviour (a drip is actually cut) is in `request-timeout.behaviour.spec.ts` and
 * `buffered-body-deadline.spec.ts`.
 */

/** Exactly main.ts's adapter options. */
const buildMainAdapter = (): FastifyAdapter =>
  new FastifyAdapter({
    trustProxy: true,
    routerOptions: {
      maxParamLength: 1000,
      ignoreTrailingSlash: true,
      ignoreDuplicateSlashes: true,
    },
  });

const hostFor = (adapter: FastifyAdapter): HttpAdapterHost => {
  const host = new HttpAdapterHost();
  host.httpAdapter = adapter;
  return host;
};

describe('#763 request-receipt bounds: values and wiring', () => {
  let adapter: FastifyAdapter | undefined;
  afterEach(async () => {
    jest.restoreAllMocks();
    await adapter?.close();
    adapter = undefined;
  });

  it('control: Fastify builds main.ts’s server with requestTimeout 0 (no body bound) — the reason this exists', () => {
    adapter = buildMainAdapter();
    const server = adapter.getHttpServer() as Server;
    expect(server.requestTimeout).toBe(0);
    expect(server.headersTimeout).toBe(60_000);
    // and Node's own default, which Fastify's 0 overrides:
    const plain = createServer();
    try {
      expect(plain.requestTimeout).toBe(300_000);
    } finally {
      plain.close();
    }
  });

  it('after the module’s onModuleInit the running server has requestTimeout 900000, above headersTimeout 60000', () => {
    adapter = buildMainAdapter();
    new RequestTimeoutModule(hostFor(adapter)).onModuleInit();
    const server = adapter.getHttpServer() as Server;
    expect(server.requestTimeout).toBe(900_000);
    expect(server.headersTimeout).toBe(60_000);
    expect(server.headersTimeout).toBeLessThan(server.requestTimeout);
  });

  it('installs the buffered-body deadline as an onRequest hook', () => {
    adapter = buildMainAdapter();
    const addHook = jest.spyOn(adapter.getInstance(), 'addHook');
    new RequestTimeoutModule(hostFor(adapter)).onModuleInit();
    const onRequest = addHook.mock.calls.filter(([name]) => name === 'onRequest');
    expect(onRequest).toHaveLength(1);
    expect((onRequest[0][1] as { name: string }).name).toBe('bufferedBodyDeadline');
  });

  it('the constants carry the arithmetic their doc comments state', () => {
    expect(DOCMOST_REQUEST_TIMEOUT_MS).toBe(900_000);
    expect(DOCMOST_BUFFERED_BODY_TIMEOUT_MS).toBe(60_000);
    const mbitPerS = (bytes: number, ms: number) => (bytes * 8) / (ms / 1000) / 1e6;
    expect(mbitPerS(103_809_024, DOCMOST_REQUEST_TIMEOUT_MS)).toBeCloseTo(0.92, 2); // 99mb zip import
    expect(mbitPerS(103_809_024, 300_000)).toBeCloseTo(2.77, 2); // ... what Node's 300 s would need
    expect(mbitPerS(50 * 1024 * 1024, DOCMOST_REQUEST_TIMEOUT_MS)).toBeCloseTo(0.47, 2); // 50 MiB attachment
    expect(mbitPerS(1024 * 1024, DOCMOST_BUFFERED_BODY_TIMEOUT_MS) * 1000).toBeCloseTo(140, -1); // 1 MiB JSON, kbit/s
    expect(DOCMOST_REQUEST_TIMEOUT_MS).toBeGreaterThan(120_000); // the platform upload relay is cut first
    expect(DOCMOST_BUFFERED_BODY_TIMEOUT_MS).toBeLessThan(DOCMOST_REQUEST_TIMEOUT_MS);
  });

  describe('applyRequestTimeout', () => {
    it.each([60_000, 59_999, 1])('refuses %p ms against headersTimeout 60000 (Node would silently swap them)', (ms) => {
      const server = { headersTimeout: 60_000, requestTimeout: 0 };
      expect(() => applyRequestTimeout(server, ms)).toThrow(/must exceed headersTimeout/);
      expect(server.requestTimeout).toBe(0);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a non-positive or non-finite %p', (ms) => {
      const server = { headersTimeout: 60_000, requestTimeout: 0 };
      expect(() => applyRequestTimeout(server, ms)).toThrow();
      expect(server.requestTimeout).toBe(0);
    });

    it('accepts a value just above headersTimeout and defaults to DOCMOST_REQUEST_TIMEOUT_MS', () => {
      const server = { headersTimeout: 60_000, requestTimeout: 0 };
      applyRequestTimeout(server, 60_001);
      expect(server.requestTimeout).toBe(60_001);
      applyRequestTimeout(server);
      expect(server.requestTimeout).toBe(DOCMOST_REQUEST_TIMEOUT_MS);
    });
  });

  it('bufferedBodyDeadlineHook refuses a non-positive or non-finite deadline', () => {
    for (const ms of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => bufferedBodyDeadlineHook(ms)).toThrow();
    }
  });

  describe('fails soft without an http adapter', () => {
    it('no HttpAdapterHost, or one with no adapter: onModuleInit is a no-op', () => {
      expect(() => new RequestTimeoutModule(undefined).onModuleInit()).not.toThrow();
      expect(() => new RequestTimeoutModule(new HttpAdapterHost()).onModuleInit()).not.toThrow();
    });

    it('a compiled testing module with no app (no adapter) initialises cleanly', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [RequestTimeoutModule] }).compile();
      await expect(moduleRef.init()).resolves.toBeDefined();
      await moduleRef.close();
    });
  });
});

@Controller()
class ProbeController {
  @Get('ping')
  ping() {
    return { ok: true };
  }

  @Post('echo')
  echo() {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('#763 through a real Nest app (the boot path main.ts takes)', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
    app = undefined;
  });

  it('the module, imported like any Nest module, sets the bound and its hook runs on Nest-registered routes', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RequestTimeoutModule, ProbeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(buildMainAdapter(), { rawBody: true, logger: false });
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as Server;
    expect(server.requestTimeout).toBe(DOCMOST_REQUEST_TIMEOUT_MS);

    // The hook arms its 60 s timer for a body still arriving on a Nest route (observed, not waited out).
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const { port } = server.address() as { port: number };
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    socket.write('POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{"a"');
    const deadline = Date.now() + 2000;
    while (!setTimeoutSpy.mock.calls.some(([, ms]) => ms === DOCMOST_BUFFERED_BODY_TIMEOUT_MS) && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    socket.destroy();
    expect(setTimeoutSpy.mock.calls.some(([, ms]) => ms === DOCMOST_BUFFERED_BODY_TIMEOUT_MS)).toBe(true);
  });
});
