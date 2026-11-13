import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo, connect, Socket } from 'net';
import { Duplex } from 'stream';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';
import { WebSocket, WebSocketServer } from 'ws';
import { applyRequestTimeout } from './request-timeout';

/**
 * #763 — CCC, not upstream. What `requestTimeout` actually does on the wire, on Node's plain http server AND on
 * the real Fastify built like main.ts's (+ `@fastify/multipart`), so the doc comment's claims are pinned to
 * behaviour: a dripped body is cut with a 408 and the connection closes; a fast body, an upgraded WebSocket, a
 * slow response after a complete body and keep-alive idle time are NOT cut; a multipart body still dripping
 * after an early 401 IS cut at the bound.
 *
 * Two traps, both handled here:
 *  - Node checks expiry every `connectionsCheckingInterval` (30 s by default), so the servers are built with
 *    50 ms (Fastify passes `http` options through to `http.createServer`);
 *  - Node silently SWAPS `requestTimeout` and `headersTimeout` when the latter is larger, so with the default
 *    60 s `headersTimeout` a small test bound would test nothing. `headersTimeout` is lowered below it FIRST,
 *    then `applyRequestTimeout` (which refuses the swap) sets the bound.
 */

const T = 400; // the request-receipt bound under test
const HEADERS_T = 200; // below T, or Node swaps them
const CHECK_INTERVAL = 50;

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
    socket.on('error', () => undefined); // EPIPE / ECONNRESET once the server cuts us: expected
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

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

/** Writes one byte every `every` ms until the socket closes. */
function drip(conn: RawConn, every = 40): () => void {
  const timer = setInterval(() => {
    if (conn.isClosed() || conn.socket.destroyed) return clearInterval(timer);
    conn.socket.write('a');
  }, every);
  return () => clearInterval(timer);
}

const statusLines = (text: string) => text.match(/HTTP\/1\.1 \d{3}/g) ?? [];

interface Harness {
  name: string;
  server: Server;
  port: number;
  close(): Promise<void>;
}

const sockets = new Set<Duplex>();

function attachWsEcho(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`echo:${m.toString()}`)));
  });
  return wss;
}

async function plainHarness(): Promise<Harness> {
  const server = createServer({ connectionsCheckingInterval: CHECK_INTERVAL }, (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/upload') {
      // A guard-shaped early refusal: answers before reading the body.
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"statusCode":401}');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const delay = req.url === '/slow' ? 3 * T : 0;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`ok:${Buffer.concat(chunks).length}`);
      }, delay);
    });
  });
  const wss = attachWsEcho(server);
  server.on('connection', (s) => sockets.add(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  server.headersTimeout = HEADERS_T;
  applyRequestTimeout(server, T);
  return {
    name: 'plain node:http',
    server,
    port: (server.address() as AddressInfo).port,
    close: async () => {
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function fastifyHarness(opts: { bound: boolean } = { bound: true }): Promise<Harness> {
  // main.ts's adapter options, plus the check interval (main.ts cannot set it without an upstream edit).
  const adapter = new FastifyAdapter({
    trustProxy: true,
    routerOptions: { maxParamLength: 1000, ignoreTrailingSlash: true, ignoreDuplicateSlashes: true },
    http: { connectionsCheckingInterval: CHECK_INTERVAL },
  } as ConstructorParameters<typeof FastifyAdapter>[0]);
  const app = adapter.getInstance();
  await app.register(fastifyMultipart);
  app.post('/echo', async (req) => `ok:${JSON.stringify(req.body).length}`);
  app.post('/slow', async () => {
    await sleep(3 * T);
    return 'ok:slow';
  });
  app.get('/ping', async () => 'ok:ping');
  app.post('/upload', async (_req, reply) => reply.code(401).send({ statusCode: 401 }));
  await app.ready();
  const server = app.server as Server;
  const wss = attachWsEcho(server);
  server.on('connection', (s) => sockets.add(s));
  await app.listen({ port: 0, host: '127.0.0.1' });
  if (opts.bound) {
    server.headersTimeout = HEADERS_T;
    applyRequestTimeout(server, T);
  }
  return {
    name: 'Fastify (main.ts options + @fastify/multipart)',
    server,
    port: (server.address() as AddressInfo).port,
    close: async () => {
      wss.close();
      await app.close();
    },
  };
}

afterEach(() => {
  for (const s of sockets) s.destroy();
  sockets.clear();
});

describe.each([
  ['plain node:http', plainHarness],
  ['Fastify', () => fastifyHarness()],
])('#763 requestTimeout behaviour — %s', (_name, make) => {
  let h: Harness;
  const conns: RawConn[] = [];
  beforeEach(async () => {
    h = await make();
  });
  afterEach(async () => {
    for (const c of conns.splice(0)) c.socket.destroy();
    await h.close();
  });
  const open = async () => {
    const c = await rawConnect(h.port);
    conns.push(c);
    return c;
  };

  it('a dripped body is answered 408 and the connection closes at the bound', async () => {
    const c = await open();
    const start = Date.now();
    c.socket.write('POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n"');
    const stop = drip(c);
    const closedAt = await Promise.race([c.closedAt, expire(5 * T)]);
    stop();
    expect(closedAt).not.toBe(-1);
    expect(closedAt - start).toBeGreaterThanOrEqual(T - CHECK_INTERVAL);
    expect(statusLines(c.text())).toEqual(['HTTP/1.1 408']);
  });

  it('a body that arrives in time is answered normally', async () => {
    const c = await open();
    const body = JSON.stringify({ a: 'x'.repeat(1000) });
    c.socket.write(
      `POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    expect(await waitFor(() => /HTTP\/1\.1 200[\s\S]*ok:\d+/.test(c.text()), 2 * T)).toBe(true);
  });

  it('a slow RESPONSE after a complete body is not cut (response time is not counted)', async () => {
    const c = await open();
    c.socket.write('POST /slow HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}');
    expect(await waitFor(() => c.text().includes('ok:'), 6 * T)).toBe(true);
    expect(statusLines(c.text())).toEqual(['HTTP/1.1 200']);
  });

  it('keep-alive idle time between requests is not counted', async () => {
    const c = await open();
    const req = 'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}';
    c.socket.write(req);
    expect(await waitFor(() => statusLines(c.text()).length === 1, 2 * T)).toBe(true);
    await sleep(3 * T);
    expect(c.isClosed()).toBe(false);
    c.socket.write(req);
    expect(await waitFor(() => statusLines(c.text()).length === 2, 2 * T)).toBe(true);
    expect(statusLines(c.text())).toEqual(['HTTP/1.1 200', 'HTTP/1.1 200']);
  });

  it('an upgraded WebSocket outlives the bound (upgrades leave the timeout list)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/collab`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    try {
      await sleep(3 * T);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      const reply = new Promise<string>((r) => ws.once('message', (m) => r(m.toString())));
      ws.send('ping');
      expect(await reply).toBe('echo:ping');
    } finally {
      ws.terminate();
    }
  });

  it('a multipart body still dripping after an early 401 is cut at the bound', async () => {
    const c = await open();
    const start = Date.now();
    c.socket.write(
      'POST /upload HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=zz\r\nContent-Length: 100000\r\n\r\n--zz\r\n' +
        'Content-Disposition: form-data; name="file"; filename="f.bin"\r\n\r\n',
    );
    const stop = drip(c);
    expect(await waitFor(() => c.text().startsWith('HTTP/1.1 401'), T)).toBe(true);
    const closedAt = await Promise.race([c.closedAt, expire(5 * T)]);
    stop();
    expect(closedAt).not.toBe(-1);
    expect(closedAt - start).toBeGreaterThanOrEqual(T - CHECK_INTERVAL);
    // Both Node and Fastify append a raw 408 after the finished 401 before closing (Node 22): wire noise only,
    // the socket is destroyed right after it. Not pinned; the 401 coming first is.
    expect(statusLines(c.text())[0]).toBe('HTTP/1.1 401');
  });
});

describe('#763 control: Fastify without the bound holds a dripped body', () => {
  let h: Harness;
  let c: RawConn | undefined;
  afterEach(async () => {
    c?.socket.destroy();
    await h?.close();
  });

  it('requestTimeout 0 (Fastify’s default): the drip is still open well past the bound', async () => {
    h = await fastifyHarness({ bound: false });
    expect(h.server.requestTimeout).toBe(0);
    c = await rawConnect(h.port);
    c.socket.write('POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n"');
    const stop = drip(c);
    await sleep(4 * T);
    stop();
    expect(c.isClosed()).toBe(false);
    expect(c.text()).toBe('');
  });

  it('the swap trap: a bound below headersTimeout would silently enforce headersTimeout, so it is refused', async () => {
    h = await fastifyHarness({ bound: false });
    expect(h.server.headersTimeout).toBe(60_000);
    expect(() => applyRequestTimeout(h.server, T)).toThrow(/must exceed headersTimeout/);
    expect(h.server.requestTimeout).toBe(0);
  });
});
