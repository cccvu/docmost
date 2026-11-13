import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { connect, type AddressInfo, type Socket as NetSocket } from 'node:net';
import { JwtService } from '@nestjs/jwt';
import { Server, type Socket } from 'socket.io';
import { WebSocket, WebSocketServer } from 'ws';
import { TokenService } from '../../core/auth/services/token.service';
import { COLLAB_WS_SERVER_OPTIONS } from '../collab-ingress/limits';
import {
  hardenRealtimeServer,
  REALTIME_GATEWAY_OPTIONS,
  realtimeAccessVerifier,
  RealtimeWsServer,
} from './realtime-socket-bounds';

/**
 * CCC spec (#830, ADR 0036) — NOT upstream Docmost code.
 *
 * The /socket.io bounds against a REAL socket.io 4.8.3 server (engine.io 6.6.2, ws 8.21.0) on a node http server, driven
 * by raw TCP and ws clients that behave as an attacker would (never read, ping-flood, fragment, re-send CONNECT). Each
 * case runs once on the hardened server (REALTIME_GATEWAY_OPTIONS + hardenRealtimeServer, as the gateway and
 * RealtimeSocketBoundsModule build it) and, where it is meaningful, once on a stock server as a control that reproduces
 * the bug, so a spec that stopped exercising the bound would show it.
 *
 * The test reaches into engine.io internals (`transport.socket`, the server's ws) only to OBSERVE: the code under test
 * uses documented options and middlewares only.
 */
const SECRET = 'realtime-spec-secret';
const env = {
  isHttps: () => false, // the cookie is `authToken` (docmost-auth-cookie.ts)
  getCookieExpiresIn: () => new Date(Date.now() + 60_000),
  getAppSecret: () => SECRET,
};
const jwt = new JwtService({ secret: SECRET });
const verifier = realtimeAccessVerifier(new TokenService(jwt, env as any), env);
const accessToken = (over: Record<string, unknown> = {}) =>
  jwt.sign({ sub: 'u1', workspaceId: 'w1', type: 'access', sessionId: 's1', ...over });
const VALID_COOKIE = `theme=dark; authToken=${accessToken()}`;

const MiB = 1024 * 1024;
const PING_PAYLOAD = 125;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** One masked client frame (mask 0: the payload as is). */
function frame(opcode: number, payload: Buffer | string, fin = true): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head =
    data.length < 126
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | data.length])
      : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, data.length >> 8, data.length & 0xff]);
  return Buffer.concat([head, Buffer.alloc(4), data]);
}
const text = (s: string) => frame(0x1, s);
const pingFrame = () => frame(0x9, Buffer.alloc(PING_PAYLOAD, 0x61));

// --- process-level errors: nothing may escape the gate ------------------------------------------------------------
const escaped: unknown[] = [];
const onEscape = (e: unknown) => escaped.push(e);
beforeAll(() => {
  process.on('uncaughtException', onEscape);
  process.on('unhandledRejection', onEscape);
});
afterAll(() => {
  process.off('uncaughtException', onEscape);
  process.off('unhandledRejection', onEscape);
});

// --- the server rig -------------------------------------------------------------------------------------------------
interface RigOptions {
  hardened: boolean;
  connectTimeout?: number;
  pingInterval?: number;
  pingTimeout?: number;
  onConnection?: (socket: Socket) => unknown;
  /** a control's own engine middleware in place of the hardening's gate */
  gate?: (req: IncomingMessage, res: unknown, next: (err?: Error) => void) => void;
}
interface Rig {
  io: Server;
  http: HttpServer;
  port: number;
  url: string;
  engineSockets: any[];
  upgradeSockets: NetSocket[];
  connectionErrors: number;
  handlerRuns: number;
}
const rigs: Rig[] = [];
const clients: Array<NetSocket | WebSocket> = [];

const closeClient = (c: NetSocket | WebSocket): void => {
  if (c instanceof WebSocket) c.terminate();
  else c.destroy();
};
const timers: NodeJS.Timeout[] = [];

async function rig(o: RigOptions): Promise<Rig> {
  const http = createServer();
  const io = new Server(http, {
    cors: { origin: '*' },
    transports: ['websocket'],
    ...(o.hardened ? REALTIME_GATEWAY_OPTIONS : {}),
    ...(o.connectTimeout ? { connectTimeout: o.connectTimeout } : {}),
    pingInterval: o.pingInterval ?? 10_000,
    pingTimeout: o.pingTimeout ?? 10_000,
  });
  if (o.hardened) hardenRealtimeServer(io, { verifyAccessToken: verifier });
  if (o.gate) io.engine.use(o.gate as any);
  const r = { io, http, port: 0, url: '', engineSockets: [] as any[], upgradeSockets: [] as NetSocket[], connectionErrors: 0, handlerRuns: 0 };
  // observation and cleanup only: an upgrade socket is outside the http server's connection tracking (and half-open)
  http.on('upgrade', (_req, socket: NetSocket) => r.upgradeSockets.push(socket));
  io.engine.on('connection', (s: unknown) => r.engineSockets.push(s));
  io.engine.on('connection_error', () => r.connectionErrors++);
  io.on('connection', (s) => {
    r.handlerRuns++;
    o.onConnection?.(s);
  });
  await new Promise<void>((res) => http.listen(0, '127.0.0.1', () => res()));
  r.port = (http.address() as AddressInfo).port;
  r.url = `ws://127.0.0.1:${r.port}/socket.io/?EIO=4&transport=websocket`;
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const t of timers.splice(0)) clearInterval(t);
  for (const c of clients.splice(0)) closeClient(c);
  for (const r of rigs.splice(0)) {
    for (const s of r.upgradeSockets) s.destroy();
    r.http.closeAllConnections?.();
    await r.io.close();
  }
  expect(escaped).toEqual([]);
});

/** A raw TCP client that sends a socket.io websocket upgrade and records every byte it reads. */
interface RawClient {
  sock: NetSocket;
  rx: () => string;
  status: () => string;
  closed: Promise<number>; // ms after the upgrade request was written
}
function rawUpgrade(port: number, cookieHeader?: string): RawClient {
  const sock = connect(port, '127.0.0.1');
  clients.push(sock);
  sock.on('error', () => undefined);
  let rx = Buffer.alloc(0);
  sock.on('data', (d: Buffer) => (rx = Buffer.concat([rx, d])));
  const start = Date.now();
  const closed = new Promise<number>((r) => sock.once('close', () => r(Date.now() - start)));
  sock.write(
    'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
      (cookieHeader === undefined ? '' : `Cookie: ${cookieHeader}\r\n`) +
      '\r\n',
  );
  return {
    sock,
    rx: () => rx.toString('latin1'),
    status: () => rx.toString('latin1').split('\r\n')[0],
    closed,
  };
}
/** Upgrade, then wait for engine.io's open packet. */
async function openedRaw(r: Rig, cookieHeader = VALID_COOKIE): Promise<RawClient> {
  const c = rawUpgrade(r.port, cookieHeader);
  await until(() => c.rx().includes('0{"sid"'), 2000, 'the engine.io open packet');
  expect(c.status()).toBe('HTTP/1.1 101 Switching Protocols');
  return c;
}
/** A reading ws client; resolves once engine.io's open packet arrived. */
async function openedWs(r: Rig, cookieHeader = VALID_COOKIE) {
  const ws = new WebSocket(r.url, { headers: { cookie: cookieHeader } });
  clients.push(ws);
  ws.on('error', () => undefined);
  const messages: string[] = [];
  let closeCode: number | null = null;
  ws.on('message', (d) => messages.push(d.toString()));
  ws.on('close', (code) => (closeCode = code));
  await until(() => messages.some((m) => m.startsWith('0{')), 2000, 'the engine.io open packet');
  return { ws, messages, closeCode: () => closeCode };
}

// A gateway-style failed auth (ws.gateway.ts handleConnection's catch), after an async verify.
const gatewayRejectAsync = async (s: Socket) => {
  await sleep(5);
  s.emit('Unauthorized');
  s.disconnect();
};

describe('#830 the engine middleware gate (exactly one next per request)', () => {
  // the gate as hardenRealtimeServer installs it, driven directly
  function gateWith(verifyAccessToken: (c: string | undefined) => Promise<void>) {
    let gate: any;
    hardenRealtimeServer({ engine: { use: (fn: unknown) => (gate = fn) }, use: () => undefined } as any, { verifyAccessToken });
    return async (headers: Record<string, string | undefined>, next = jest.fn()) => {
      const socket = { destroy: jest.fn() };
      gate({ headers, socket }, {}, next);
      await sleep(5);
      return { next, socket };
    };
  }

  it('a verifier that throws synchronously, rejects, or resolves: next is called exactly once', async () => {
    const sync = await gateWith(() => {
      throw new TypeError('boom');
    })({});
    expect(sync.next).toHaveBeenCalledTimes(1);
    expect(sync.next.mock.calls[0][0]).toBeInstanceOf(Error);

    const rejects = await gateWith(async () => {
      throw new Error('bad');
    })({ cookie: 'a=b' });
    expect(rejects.next).toHaveBeenCalledTimes(1);
    expect(rejects.next.mock.calls[0][0]).toBeInstanceOf(Error);

    const ok = await gateWith(async () => undefined)({ cookie: 'a=b' });
    expect(ok.next).toHaveBeenCalledTimes(1);
    expect(ok.next.mock.calls[0]).toEqual([undefined]);
  });

  it('the production verifier on a request with no Cookie header (cookie.parse(undefined) throws): one next(err)', async () => {
    await expect(verifier(undefined)).rejects.toBeInstanceOf(TypeError); // the hazard the gate must contain
    const { next } = await gateWith(verifier)({});
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('engine.io continuation that throws: nothing escapes, and the raw socket is destroyed', async () => {
    const next = jest.fn(() => {
      throw new Error('continuation threw');
    });
    const { socket } = await gateWith(async () => undefined)({ cookie: 'a=b' }, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('#830 the upgrade gate on a real socket.io server', () => {
  const refused: Array<[string, string | undefined]> = [
    ['no Cookie header', undefined],
    ['a Cookie header without the auth cookie', 'theme=dark'],
    ['a bad signature', `authToken=${new JwtService({ secret: 'not-the-secret' }).sign({ sub: 'u1', type: 'access' })}`],
    ['a wrong token type (collab)', `authToken=${accessToken({ type: 'collab' })}`],
  ];

  it.each(refused)('%s: 400 within 1 s, the raw socket destroyed, no engine connection', async (_name, cookieHeader) => {
    const r = await rig({ hardened: true });
    const c = rawUpgrade(r.port, cookieHeader);
    const ms = await c.closed;
    expect(ms).toBeLessThan(1000);
    expect(c.status()).toBe('HTTP/1.1 400 Bad Request');
    expect(c.sock.destroyed).toBe(true);
    expect(r.io.engine.clientsCount).toBe(0);
    expect(r.engineSockets).toHaveLength(0);
    expect(r.connectionErrors).toBe(1);
    expect(r.handlerRuns).toBe(0);
  });

  it('control: the stock server upgrades a request with no Cookie header (101, an engine connection)', async () => {
    const r = await rig({ hardened: false });
    const c = await openedRaw(r, undefined);
    expect(c.status()).toBe('HTTP/1.1 101 Switching Protocols');
    expect(r.io.engine.clientsCount).toBe(1);
  });

  it('control: a gate that does not catch the rejection never answers (the socket hangs)', async () => {
    const naiveEscapes: unknown[] = [];
    const r = await rig({
      hardened: false,
      gate: (req, _res, next) => {
        verifier(req.headers.cookie).then(() => next(), (e) => naiveEscapes.push(e)); // rejection dropped: next never runs
      },
    });
    const c = rawUpgrade(r.port, undefined);
    await sleep(1000);
    expect(c.rx()).toBe('');
    expect(c.sock.destroyed).toBe(false);
    expect(naiveEscapes).toHaveLength(1);
  });

  it('a valid ACCESS cookie: 101, and the namespace connection handler runs once', async () => {
    const r = await rig({ hardened: true });
    const c = await openedRaw(r);
    c.sock.write(text('40'));
    await until(() => c.rx().includes('40{"sid"'), 2000, 'the CONNECT ack');
    expect(r.handlerRuns).toBe(1);
    await sleep(100);
    expect(r.io.engine.clientsCount).toBe(1);
  });
});

describe('#830 ws transport bounds (RealtimeWsServer)', () => {
  it('engine.io builds its ws server from RealtimeWsServer: one-in-flight pong, collab fragment caps, engine maxPayload', async () => {
    const r = await rig({ hardened: true });
    const wss = (r.io.engine as any).ws as WebSocketServer;
    expect(wss).toBeInstanceOf(RealtimeWsServer);
    expect(wss.options).toMatchObject({
      autoPong: false,
      maxFragments: COLLAB_WS_SERVER_OPTIONS.maxFragments,
      maxBufferedChunks: COLLAB_WS_SERVER_OPTIONS.maxBufferedChunks,
      perMessageDeflate: false,
      maxPayload: 1e6, // engine.io's maxHttpBufferSize, not collab's 8 MiB
      noServer: true,
      clientTracking: false,
    });
    expect(REALTIME_GATEWAY_OPTIONS).toEqual({ wsEngine: RealtimeWsServer, connectTimeout: 10_000 });
    expect(r.io.connectTimeout()).toBe(10_000);
  });

  async function pingFlood(hardened: boolean) {
    const r = await rig({ hardened });
    const c = await openedRaw(r);
    c.sock.pause(); // never reads again
    const serverWs = r.engineSockets[0].transport.socket as WebSocket;
    serverWs.send(Buffer.alloc(16 * MiB)); // the client stopped reading: the server's socket is backed up
    await sleep(50);
    const backlog = serverWs.bufferedAmount;
    expect(backlog).toBeGreaterThan(0);
    const pong = jest.spyOn(serverWs, 'pong');
    const PINGS = 10_000;
    let seen = 0;
    serverWs.on('ping', () => seen++);
    const batch = Buffer.concat(Array.from({ length: 500 }, pingFrame));
    for (let i = 0; i < PINGS / 500; i++) c.sock.write(batch);
    await until(() => seen >= PINGS, 10_000, 'the server to read every ping');
    return { pongs: pong.mock.calls.length, growth: serverWs.bufferedAmount - backlog };
  }

  it('a non-reading client ping-flooding holds at most one pong in flight', async () => {
    const { pongs, growth } = await pingFlood(true);
    expect(pongs).toBe(1);
    expect(growth).toBeLessThanOrEqual(2 + PING_PAYLOAD);
  });

  it('control: the stock engine queues one pong per ping', async () => {
    const { pongs, growth } = await pingFlood(false);
    expect(pongs).toBe(10_000);
    expect(growth).toBeGreaterThanOrEqual(10_000 * (2 + PING_PAYLOAD));
  });

  /** A connected client sends one socket.io event `e` whose message is split into `fragments` ws frames. */
  async function sendFragments(hardened: boolean, fragments: number) {
    const received: string[] = [];
    const r = await rig({ hardened, onConnection: (s) => s.on('e', (d: string) => received.push(d)) });
    const c = await openedWs(r);
    c.ws.send('40');
    await until(() => c.messages.some((m) => m.startsWith('40{')), 1000, 'the CONNECT ack');
    c.ws.send('42["e","', { fin: false });
    for (let i = 1; i < fragments - 1; i++) c.ws.send('x', { fin: false });
    c.ws.send('"]', { fin: true });
    await until(() => c.closeCode() !== null || received.length > 0, 2000, 'the server to close or receive');
    return { closeCode: c.closeCode(), received };
  }

  const MAX = COLLAB_WS_SERVER_OPTIONS.maxFragments;

  it('a message in 1025 fragments is refused (ws closes 1008, nothing delivered); 1024 is received', async () => {
    const over = await sendFragments(true, MAX + 1);
    expect(over.closeCode).toBe(1008); // ws's code for WS_ERR_TOO_MANY_BUFFERED_PARTS
    expect(over.received).toEqual([]);
    const at = await sendFragments(true, MAX);
    expect(at.closeCode).toBeNull();
    expect(at.received).toEqual(['x'.repeat(MAX - 2)]);
  });

  it('control: the stock engine accepts a message in 1025 fragments', async () => {
    const over = await sendFragments(false, MAX + 1);
    expect(over.closeCode).toBeNull();
    expect(over.received).toEqual(['x'.repeat(MAX - 1)]);
  });
});

describe('#830 a failed namespace auth closes the engine connection', () => {
  it('a reading client gets Unauthorized and DISCONNECT, then the engine closes', async () => {
    const r = await rig({ hardened: true, onConnection: gatewayRejectAsync });
    const c = await openedWs(r);
    c.ws.send('40');
    await until(() => c.closeCode() !== null, 2000, 'the client to see the close');
    expect(c.messages).toEqual(expect.arrayContaining(['42["Unauthorized"]', '41']));
    expect(c.messages.indexOf('41')).toBeGreaterThan(c.messages.indexOf('42["Unauthorized"]'));
    await until(() => r.io.engine.clientsCount === 0, 1000, 'the engine connection to close');
  });

  async function pongOnlyClient(hardened: boolean) {
    const r = await rig({ hardened, onConnection: gatewayRejectAsync, pingInterval: 100, pingTimeout: 100 });
    const c = await openedRaw(r);
    c.sock.write(text('40'));
    await until(() => r.handlerRuns === 1, 1000, 'the gateway handler');
    c.sock.pause(); // never reads again; keeps writing unsolicited pongs, which refresh engine.io's ping timer
    timers.push(setInterval(() => c.sock.writable && c.sock.write(text('3')), 50));
    return r;
  }

  it('a client that only writes "3" and never reads is closed', async () => {
    const r = await pongOnlyClient(true);
    await until(() => r.io.engine.clientsCount === 0, 1000, 'the engine connection to close');
    expect(r.engineSockets[0].readyState).toBe('closed');
  });

  it('control: on the stock server it outlives five ping windows', async () => {
    const r = await pongOnlyClient(false);
    await sleep(1000);
    expect(r.io.engine.clientsCount).toBe(1);
    expect(r.engineSockets[0].readyState).toBe('open');
  });

  const syncReject = (s: Socket) => {
    s.emit('Unauthorized');
    s.disconnect();
  };
  const throwAfterUserId = async (s: Socket) => {
    try {
      s.data.userId = 'u1';
      await Promise.reject(new Error('the PDP listing threw'));
    } catch {
      s.emit('Unauthorized');
      s.disconnect();
    }
  };

  it.each([
    ['a synchronous gateway reject', syncReject],
    ['a throw after data.userId is set', throwAfterUserId],
  ])('%s closes the engine', async (_name, onConnection) => {
    const r = await rig({ hardened: true, onConnection });
    const c = await openedWs(r);
    c.ws.send('40');
    await until(() => r.handlerRuns === 1, 1000, 'the gateway handler');
    await until(() => r.io.engine.clientsCount === 0, 1000, 'the engine connection to close');
  });

  it.each([
    ['a synchronous gateway reject', syncReject],
    ['a throw after data.userId is set', throwAfterUserId],
  ])('control: on the stock server %s leaves the engine open', async (_name, onConnection) => {
    const r = await rig({ hardened: false, onConnection });
    const c = await openedWs(r);
    c.ws.send('40');
    await until(() => r.handlerRuns === 1, 1000, 'the gateway handler');
    await sleep(300);
    expect(r.io.engine.clientsCount).toBe(1);
  });

  it('a client that authenticates stays connected', async () => {
    const r = await rig({ hardened: true, onConnection: (s) => s.join('user-u1') });
    const c = await openedWs(r);
    c.ws.send('40');
    await until(() => c.messages.some((m) => m.startsWith('40{"sid"')), 1000, 'the CONNECT ack');
    await sleep(300);
    expect(r.io.engine.clientsCount).toBe(1);
    expect(c.closeCode()).toBeNull();
  });
});

describe('#830 one CONNECT per engine connection', () => {
  async function burst(hardened: boolean) {
    const r = await rig({ hardened, onConnection: gatewayRejectAsync });
    const c = await openedRaw(r);
    c.sock.write(Buffer.concat(Array.from({ length: 200 }, () => text('40')))); // one write
    await sleep(300);
    return { r, c };
  }

  it('200 CONNECTs in one write run the gateway handler at most once, and the engine closes', async () => {
    const { r, c } = await burst(true);
    expect(r.handlerRuns).toBeLessThanOrEqual(1);
    await until(() => r.io.engine.clientsCount === 0, 1000, 'the engine connection to close');
    // the burst closed the engine before the first CONNECT completed: no CONNECT ack, a ws close frame
    expect(c.rx()).not.toContain('40{"sid"');
    expect(c.rx()).toContain('\x88');
  });

  it.each([true, false])('a CONNECT after a client namespace disconnect (hardened: %s)', async (hardened) => {
    const r = await rig({ hardened, onConnection: (s) => s.join('user-u1') });
    const c = await openedWs(r);
    c.ws.send('40');
    await until(() => c.messages.some((m) => m.startsWith('40{')), 1000, 'the CONNECT ack');
    c.ws.send('41'); // the client leaves the namespace, keeping its engine connection
    await sleep(50);
    c.ws.send('40'); // and asks to be authenticated again
    await sleep(200);
    if (hardened) {
      expect(r.handlerRuns).toBe(1);
      expect(r.io.engine.clientsCount).toBe(0);
    } else {
      expect(r.handlerRuns).toBe(2); // control: every CONNECT reruns the gateway's auth
      expect(r.io.engine.clientsCount).toBe(1);
    }
  });

  it('control: on the stock server they run it 200 times', async () => {
    const { r } = await burst(false);
    expect(r.handlerRuns).toBe(200);
  });
});

describe('#830 connectTimeout bounds a socket that never joins a namespace', () => {
  it('a silent socket closes at the configured connectTimeout', async () => {
    const r = await rig({ hardened: true, connectTimeout: 300 });
    const start = Date.now();
    await openedRaw(r);
    await until(() => r.io.engine.clientsCount === 0, 2000, 'the engine connection to close');
    const ms = Date.now() - start;
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(1000);
  });

  it("control: socket.io's default (45 s) keeps it open", async () => {
    const r = await rig({ hardened: false });
    expect(r.io.connectTimeout()).toBe(45_000);
    await openedRaw(r);
    await sleep(800);
    expect(r.io.engine.clientsCount).toBe(1);
  });
});
