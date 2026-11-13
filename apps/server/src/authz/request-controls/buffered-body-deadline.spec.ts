import { EventEmitter } from 'events';
import { AddressInfo, connect, Socket } from 'net';
import { setFlagsFromString } from 'v8';
import { runInNewContext } from 'vm';
import {
  Body,
  CanActivate,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import fastifyMultipart from '@fastify/multipart';
import { bufferedBodyDeadlineHook } from './request-timeout';

/**
 * #763 — CCC, not upstream. The buffered-body deadline on a REAL Nest + Fastify app shaped like main.ts's
 * (main.ts's adapter options, `rawBody: true`, `@fastify/multipart`), with a real Nest guard that refuses
 * unauthenticated callers. Guards run in the handler, AFTER Fastify has buffered the whole JSON body, so an
 * unauthenticated dripped JSON body holds its bytes (as Buffers: Nest's parser is `parseAs: 'buffer'`) until
 * something cuts it. `requestTimeout` stays at Fastify's 0 here, so only the hook can.
 */

// A full GC on demand, so the memory case measures what is RETAINED (precedent: export-stream.spec.ts).
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
async function settledArrayBuffers(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 20));
  }
  return process.memoryUsage().arrayBuffers;
}

const KiB = 1024;
const MiB = 1024 * KiB;

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException();
  }
}

@Controller()
class ProbeController {
  @Get('ping')
  ping() {
    return { ok: 'ping' };
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    return { ok: String(JSON.stringify(body)).length };
  }

  @Post('guarded')
  @UseGuards(DenyGuard)
  guarded() {
    return { ok: 'never' };
  }

  @Post('upload')
  @UseGuards(DenyGuard)
  upload() {
    return { ok: 'never' };
  }
}

@Module({ controllers: [ProbeController], providers: [DenyGuard] })
class ProbeModule {}

async function makeApp(deadlineMs: number | null): Promise<{ app: NestFastifyApplication; port: number }> {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({
      trustProxy: true,
      routerOptions: { maxParamLength: 1000, ignoreTrailingSlash: true, ignoreDuplicateSlashes: true },
    }),
    { rawBody: true, logger: false },
  );
  await app.register(fastifyMultipart);
  if (deadlineMs !== null) app.getHttpAdapter().getInstance().addHook('onRequest', bufferedBodyDeadlineHook(deadlineMs));
  await app.listen(0, '127.0.0.1');
  expect(app.getHttpServer().requestTimeout).toBe(0); // isolate the hook: Node's bound is off
  return { app, port: (app.getHttpServer().address() as AddressInfo).port };
}

interface RawConn {
  socket: Socket;
  text(): string;
  closedAt: Promise<number>;
  isClosed(): boolean;
}

function rawConnect(port: number): Promise<RawConn> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let buf = '';
    let closed = false;
    socket.setEncoding('latin1');
    socket.on('data', (d: string) => (buf += d));
    socket.on('error', () => undefined); // ECONNRESET once the server cuts us: expected
    const closedAt = new Promise<number>((r) =>
      socket.once('close', () => {
        closed = true;
        r(Date.now());
      }),
    );
    socket.once('connect', () => resolve({ socket, text: () => buf, closedAt, isClosed: () => closed }));
    socket.once('error', reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The losing side of a Promise.race: unref'd, so a race decided early leaves nothing keeping jest alive.
const expire = (ms: number) => new Promise<number>((r) => setTimeout(() => r(-1), ms).unref());
async function waitFor(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}
const statusLines = (text: string) => text.match(/HTTP\/1\.1 \d{3}/g) ?? [];

function drip(conn: RawConn, every = 40): () => void {
  const timer = setInterval(() => {
    if (conn.isClosed() || conn.socket.destroyed) return clearInterval(timer);
    conn.socket.write('a');
  }, every);
  return () => clearInterval(timer);
}

const jsonHead = (path: string, length: number) =>
  `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`;

describe('#763 buffered-body deadline: the hook’s own bookkeeping (fake request, fake timers)', () => {
  const D = 1000;
  const fake = (headers: Record<string, string>) => {
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false,
      writable: true,
      write: jest.fn(),
      destroy: jest.fn(),
    });
    const raw = Object.assign(new EventEmitter(), { headers, complete: false, socket });
    const reply = { raw: { headersSent: false } };
    const done = jest.fn();
    bufferedBodyDeadlineHook(D)({ raw } as never, reply as never, done);
    expect(done).toHaveBeenCalledTimes(1);
    return { raw, socket, reply };
  };
  const body = { 'content-type': 'application/json', 'content-length': '10' };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fires on a body still incomplete at the deadline: Node’s 408, then destroy', () => {
    const { socket } = fake(body);
    jest.advanceTimersByTime(D - 1);
    expect(socket.destroy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('no 408 when a response already started (only the destroy)', () => {
    const { socket, reply } = fake(body);
    reply.raw.headersSent = true;
    jest.advanceTimersByTime(D);
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('a stale timer never cuts a socket whose request completed, even if nothing cleared it (keep-alive reuse)', () => {
    const { raw, socket } = fake(body);
    raw.complete = true; // completed, but no end/close was emitted (e.g. a body nobody consumed yet)
    jest.advanceTimersByTime(D);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it.each(['end', 'close'])('request %s clears the timer and leaves no listener on the kept-alive socket', (event) => {
    const { raw, socket } = fake(body);
    expect(socket.listenerCount('close')).toBe(1);
    raw.emit(event);
    expect(socket.listenerCount('close')).toBe(0);
    expect(raw.listenerCount('end') + raw.listenerCount('close')).toBe(0);
    jest.advanceTimersByTime(D);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ['no framing (bodyless)', {}],
    ['Content-Length: 0', { 'content-length': '0' }],
    ['multipart', { 'content-type': 'Multipart/Form-Data; boundary=x', 'content-length': '10' }],
  ])('arms nothing for %s', (_label, headers) => {
    fake(headers as Record<string, string>);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ['Content-Length', { 'content-type': 'application/json', 'content-length': '10' }],
    ['Transfer-Encoding: chunked', { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }],
    ['no Content-Type', { 'content-length': '10' }],
  ])('arms for a body framed by %s', (_label, headers) => {
    fake(headers as Record<string, string>);
    expect(jest.getTimerCount()).toBe(1);
  });
});

describe('#763 buffered-body deadline (onRequest hook) on a real Nest + Fastify app', () => {
  const D = 317; // an unusual value, so a setTimeout spy can tell the hook's timer apart
  let app: NestFastifyApplication;
  let port: number;
  const conns: RawConn[] = [];
  const open = async () => {
    const c = await rawConnect(port);
    conns.push(c);
    return c;
  };

  beforeEach(async () => {
    ({ app, port } = await makeApp(D));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const c of conns.splice(0)) c.socket.destroy();
    await app.close();
  });

  it('cuts an unauthenticated JSON body still dripping at the deadline: 408, then the socket closes', async () => {
    const c = await open();
    const start = Date.now();
    c.socket.write(jsonHead('/guarded', 10_000) + '"');
    const stop = drip(c);
    const closedAt = await Promise.race([c.closedAt, expire(10 * D)]);
    stop();
    expect(closedAt).not.toBe(-1);
    expect(closedAt - start).toBeGreaterThanOrEqual(D - 5);
    expect(statusLines(c.text())).toEqual(['HTTP/1.1 408']);
  });

  it('a JSON body that completes in time passes (fast, and dripped but done before the deadline)', async () => {
    const c = await open();
    const body = JSON.stringify({ a: 'x'.repeat(2000) });
    c.socket.write(jsonHead('/echo', body.length) + body);
    expect(await waitFor(() => statusLines(c.text()).length === 1, 5 * D)).toBe(true);

    const slow = await open();
    slow.socket.write(jsonHead('/echo', 9) + '{"a":');
    await sleep(D / 3);
    slow.socket.write('"b"}');
    expect(await waitFor(() => statusLines(slow.text()).length === 1, 5 * D)).toBe(true);
    await sleep(2 * D); // well past the deadline: nothing stale fires on the kept-alive socket
    expect([c.isClosed(), slow.isClosed()]).toEqual([false, false]);
    expect(statusLines(c.text())).toEqual(['HTTP/1.1 201']);
    expect(statusLines(slow.text())).toEqual(['HTTP/1.1 201']);
  });

  it('a bodyless GET passes and never arms a deadline timer', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const c = await open();
    c.socket.write('GET /ping HTTP/1.1\r\nHost: x\r\n\r\n');
    c.socket.write(jsonHead('/echo', 0)); // Content-Length: 0 is bodyless too
    expect(await waitFor(() => statusLines(c.text()).length === 2, 5 * D)).toBe(true);
    expect(statusLines(c.text())[0]).toBe('HTTP/1.1 200');
    expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === D)).toHaveLength(0);
  });

  it('keep-alive: idle far beyond the deadline after a JSON request, then a second request — both answered', async () => {
    const c = await open();
    c.socket.write(jsonHead('/echo', 2) + '{}');
    expect(await waitFor(() => statusLines(c.text()).length === 1, 5 * D)).toBe(true);
    await sleep(3 * D);
    expect(c.isClosed()).toBe(false);
    c.socket.write('GET /ping HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(await waitFor(() => statusLines(c.text()).length === 2, 5 * D)).toBe(true);
    expect(statusLines(c.text())).toEqual(['HTTP/1.1 201', 'HTTP/1.1 200']);
    expect(c.isClosed()).toBe(false);
  });

  it('does NOT cut a multipart body (its handlers stream after auth; requestTimeout bounds it)', async () => {
    const c = await open();
    c.socket.write(
      'POST /upload HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=zz\r\nContent-Length: 100000\r\n\r\n--zz\r\n' +
        'Content-Disposition: form-data; name="file"; filename="f.bin"\r\n\r\n',
    );
    const stop = drip(c);
    expect(await waitFor(() => c.text().startsWith('HTTP/1.1 401'), 5 * D)).toBe(true);
    await sleep(3 * D);
    stop();
    expect(c.isClosed()).toBe(false);
    expect(statusLines(c.text())).toEqual(['HTTP/1.1 401']);
  });
});

describe('#763 buffered-body deadline: memory held by unauthenticated JSON drips', () => {
  const N = 100;
  const SENT = 512 * KiB; // sent at once, then the last bytes are dripped
  const D = 2500; // long enough to observe the held memory before the deadline, even on a slow runner
  const payload = Buffer.alloc(SENT, 'a');
  payload[0] = 0x22; // '"'

  let app: NestFastifyApplication | undefined;
  const conns: RawConn[] = [];
  const stops: Array<() => void> = [];
  afterEach(async () => {
    for (const s of stops.splice(0)) s();
    for (const c of conns.splice(0)) c.socket.destroy();
    await app?.close();
    app = undefined;
  });

  async function openDrips(port: number): Promise<void> {
    for (let i = 0; i < N; i++) {
      const c = await rawConnect(port);
      conns.push(c);
      c.socket.write(jsonHead('/guarded', SENT + 64));
      c.socket.write(payload);
      stops.push(drip(c, 200));
    }
  }

  it(`control: without the hook, ${N} drips hold ~${(N * SENT) / MiB} MiB of Buffers well past the deadline`, async () => {
    const base = await settledArrayBuffers();
    let port: number;
    ({ app, port } = await makeApp(null));
    await openDrips(port);
    const held = async () => (await settledArrayBuffers()) - base;
    expect(await waitFor(async () => (await held()) > 0.8 * N * SENT, 5000)).toBe(true);
    await sleep(D);
    expect(await held()).toBeGreaterThan(0.8 * N * SENT);
    expect(conns.filter((c) => c.isClosed())).toHaveLength(0);
  });

  it(`with the hook, the ${N} drips are destroyed at the deadline and the memory returns to baseline`, async () => {
    const base = await settledArrayBuffers();
    let port: number;
    ({ app, port } = await makeApp(D));
    const start = Date.now();
    await openDrips(port);
    const held = async () => (await settledArrayBuffers()) - base;
    // Held while the bodies are arriving (the window the deadline bounds) ...
    expect(await waitFor(async () => (await held()) > 0.8 * N * SENT, D - 200)).toBe(true);
    expect(Date.now() - start).toBeLessThan(D);
    // ... and released once it fires: every socket closed, the Buffers gone.
    const closed = await Promise.race([Promise.all(conns.map((c) => c.closedAt)), expire(D + 5000)]);
    expect(closed).not.toBe(-1);
    expect(Math.min(...(closed as number[])) - start).toBeGreaterThanOrEqual(D - 5);
    expect(await waitFor(async () => (await held()) < 4 * MiB, 3000)).toBe(true);
  });
});
