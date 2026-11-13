import { Global, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import { connect, type Socket as NetSocket } from 'node:net';
import { WebSocket } from 'ws';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { WsGateway } from '../../ws/ws.gateway';
import { WsModule } from '../../ws/ws.module';
import { WsService } from '../../ws/ws.service';
import { WsTreeService } from '../../ws/ws-tree.service';
import { RealtimeWsServer } from './realtime-socket-bounds';
import { RealtimeSocketBoundsModule } from './realtime-socket-bounds.module';

/**
 * CCC wiring spec (#830, ADR 0036) — NOT upstream Docmost code.
 *
 * The /socket.io bounds as production builds them: a real Nest boot in main.ts's order (create with the FastifyAdapter,
 * then `useWebSocketAdapter` with an IoAdapter — WsRedisIoAdapter minus Redis — then `listen`), the REAL WsModule and
 * WsGateway (so its decorator's `...REALTIME_GATEWAY_OPTIONS` spread, seam §161, is what reaches engine.io), and the REAL
 * RealtimeSocketBoundsModule with the real TokenModule. Only the gateway's data deps are stubbed (a live user and session
 * unless a case revokes it). A control boot without RealtimeSocketBoundsModule shows the gate is the module's doing.
 *
 * This is where a boot-order change would show: the module installs the gate from `onModuleInit`, which must see the
 * gateway's server, and engine.io must build RealtimeWsServer even after its `listening` re-init.
 */
const SECRET = 'realtime-wiring-secret';
const env = {
  getAppSecret: () => SECRET,
  getJwtTokenExpiresIn: () => '1h',
  isHttps: () => false,
  getCookieExpiresIn: () => new Date(Date.now() + 60_000),
  // wiki-v2 #655: the gateway's afterInit installs the handshake origin check (seam §161), which trusts APP_URL alone.
  getAppUrl: () => 'http://wiki.example.test',
};
const jwt = new JwtService({ secret: SECRET });
const COOKIE = `authToken=${jwt.sign({ sub: 'u1', workspaceId: 'w1', type: 'access', sessionId: 's1' })}`;
const PING_PAYLOAD = 125;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
const frame = (opcode: number, data: Buffer) => Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | data.length]), Buffer.alloc(4), data]);

let sessionLive = true;

@Global()
@Module({
  providers: [
    { provide: EnvironmentService, useValue: env },
    { provide: SpaceMemberRepo, useValue: { getUserSpaceIds: async () => ['sp1'] } },
    { provide: UserRepo, useValue: { findById: async (id: string) => ({ id, deactivatedAt: null, deletedAt: null }) } },
    {
      provide: UserSessionRepo,
      useValue: { findActiveById: async (id: string) => (sessionLive ? { id, userId: 'u1', workspaceId: 'w1' } : undefined) },
    },
  ],
  exports: [EnvironmentService, SpaceMemberRepo, UserRepo, UserSessionRepo],
})
class GlobalStubsModule {}

async function boot(withBounds: boolean) {
  const moduleRef = await Test.createTestingModule({
    imports: [GlobalStubsModule, WsModule, ...(withBounds ? [RealtimeSocketBoundsModule] : [])],
  })
    .overrideProvider(WsService)
    .useValue({ setServer: () => undefined, isTreeEvent: () => false })
    .overrideProvider(WsTreeService)
    .useValue({})
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
  app.useWebSocketAdapter(new IoAdapter(app));
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as { port: number }).port;
  const io = app.get(WsGateway).server;
  const engineSockets: any[] = [];
  io.engine.on('connection', (s: unknown) => engineSockets.push(s));
  return { app, port, io, engineSockets };
}

const clients: Array<NetSocket | WebSocket> = [];

const closeClient = (c: NetSocket | WebSocket): void => {
  if (c instanceof WebSocket) c.terminate();
  else c.destroy();
};
function rawUpgrade(port: number, cookieHeader?: string) {
  const sock = connect(port, '127.0.0.1');
  clients.push(sock);
  sock.on('error', () => undefined);
  let rx = '';
  sock.on('data', (d: Buffer) => (rx += d.toString('latin1')));
  sock.write(
    'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
      (cookieHeader === undefined ? '' : `Cookie: ${cookieHeader}\r\n`) +
      '\r\n',
  );
  return { sock, rx: () => rx, closed: new Promise<void>((r) => sock.once('close', () => r())) };
}

describe('#830 the /socket.io bounds in a real Nest boot (main.ts order)', () => {
  let rig: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    rig = await boot(true);
  });
  afterAll(async () => {
    for (const c of clients.splice(0)) closeClient(c);
    await rig.app.close();
  });
  afterEach(() => {
    sessionLive = true;
  });

  it('after listen, engine.io serves upgrades from RealtimeWsServer with the gateway-spread connectTimeout', () => {
    const wss = (rig.io.engine as any).ws;
    expect(wss).toBeInstanceOf(RealtimeWsServer);
    expect(wss.options).toMatchObject({ autoPong: false, maxFragments: 1024, maxBufferedChunks: 65_536, perMessageDeflate: false, maxPayload: 1e6 });
    expect(rig.io.connectTimeout()).toBe(10_000);
  });

  it('an upgrade without a cookie is refused 400 and the socket destroyed', async () => {
    const c = rawUpgrade(rig.port);
    await c.closed;
    expect(c.rx().split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
    expect(rig.io.engine.clientsCount).toBe(0);
  });

  it('a valid session: 101, and the real gateway authenticates and keeps it', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/socket.io/?EIO=4&transport=websocket`, { headers: { cookie: COOKIE } });
    clients.push(ws);
    const messages: string[] = [];
    ws.on('message', (d) => messages.push(d.toString()));
    await until(() => messages.some((m) => m.startsWith('0{')), 2000, 'the open packet');
    ws.send('40');
    await until(() => messages.some((m) => m.startsWith('40{"sid"')), 2000, 'the CONNECT ack');
    await sleep(100);
    expect(rig.io.engine.clientsCount).toBe(1);
    const [socket] = await rig.io.fetchSockets();
    expect(socket.rooms).toEqual(new Set([socket.id, 'user-u1', 'workspace-w1', 'space-sp1']));
    ws.terminate();
    await until(() => rig.io.engine.clientsCount === 0, 2000, 'the engine connection to close');
  });

  it('a revoked session passes the gate, and the real gateway refusal closes the engine connection', async () => {
    sessionLive = false;
    const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/socket.io/?EIO=4&transport=websocket`, { headers: { cookie: COOKIE } });
    clients.push(ws);
    const messages: string[] = [];
    let closed = false;
    ws.on('message', (d) => messages.push(d.toString()));
    ws.on('close', () => (closed = true));
    await until(() => messages.some((m) => m.startsWith('0{')), 2000, 'the open packet');
    ws.send('40');
    await until(() => closed, 2000, 'the server to close');
    expect(messages).toEqual(expect.arrayContaining(['42["Unauthorized"]', '41']));
    expect(rig.io.engine.clientsCount).toBe(0);
  });

  it('wiki-v2 #655 composes with the gate: a cross-site handshake with a valid cookie passes the upgrade, then every CONNECT is refused origin_check before the gateway runs', async () => {
    const connections = jest.fn();
    rig.io.on('connection', connections);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/socket.io/?EIO=4&transport=websocket`, {
        headers: { cookie: COOKIE, origin: 'https://evil.example', host: 'wiki.example.test' },
      });
      clients.push(ws);
      const messages: string[] = [];
      ws.on('message', (d) => messages.push(d.toString()));
      await until(() => messages.some((m) => m.startsWith('0{')), 2000, 'the open packet (the #830 gate admits a valid cookie)');
      ws.send('40');
      await until(() => messages.some((m) => m.startsWith('44')), 2000, 'the CONNECT_ERROR');
      expect(messages.filter((m) => m.startsWith('44'))).toEqual(['44{"message":"origin_check"}']);
      // The origin check runs before #830's one-CONNECT count, so a retry is refused the same way (never one_connect),
      // and the engine connection, which joined no namespace, is left to socket.io's connectTimeout.
      ws.send('40');
      await until(() => messages.filter((m) => m.startsWith('44')).length === 2, 2000, 'the second CONNECT_ERROR');
      expect(messages.filter((m) => m.startsWith('44'))).toEqual(['44{"message":"origin_check"}', '44{"message":"origin_check"}']);
      expect(connections).not.toHaveBeenCalled();
      expect((await rig.io.fetchSockets()).length).toBe(0);
      ws.terminate();
      await until(() => rig.io.engine.clientsCount === 0, 2000, 'the engine connection to close');
    } finally {
      rig.io.off('connection', connections);
    }
  });

  it('wiki-v2 #655: a same-origin handshake connects through both layers', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/socket.io/?EIO=4&transport=websocket`, {
      headers: { cookie: COOKIE, origin: 'http://wiki.example.test', host: 'wiki.example.test' },
    });
    clients.push(ws);
    const messages: string[] = [];
    ws.on('message', (d) => messages.push(d.toString()));
    await until(() => messages.some((m) => m.startsWith('0{')), 2000, 'the open packet');
    ws.send('40');
    await until(() => messages.some((m) => m.startsWith('40{"sid"')), 2000, 'the CONNECT ack');
    ws.terminate();
    await until(() => rig.io.engine.clientsCount === 0, 2000, 'the engine connection to close');
  });

  it('a ping flood from a client that never reads gets one pong in flight', async () => {
    const c = rawUpgrade(rig.port, COOKIE);
    await until(() => c.rx().includes('0{"sid"'), 2000, 'the open packet');
    c.sock.pause();
    const serverWs = rig.engineSockets[rig.engineSockets.length - 1].transport.socket as WebSocket;
    serverWs.send(Buffer.alloc(16 * 1024 * 1024));
    await sleep(50);
    const backlog = serverWs.bufferedAmount;
    const pong = jest.spyOn(serverWs, 'pong');
    let seen = 0;
    serverWs.on('ping', () => seen++);
    const ping = frame(0x9, Buffer.alloc(PING_PAYLOAD, 0x61));
    const batch = Buffer.concat(Array.from({ length: 500 }, () => ping));
    for (let i = 0; i < 10; i++) c.sock.write(batch);
    await until(() => seen >= 5000, 10_000, 'every ping read');
    expect(pong).toHaveBeenCalledTimes(1);
    expect(serverWs.bufferedAmount - backlog).toBeLessThanOrEqual(2 + PING_PAYLOAD);
  });
});

describe('#830 control: the same boot without RealtimeSocketBoundsModule', () => {
  it('upgrades a request with no cookie (the gate is the module, the transport bounds are the decorator)', async () => {
    const rig = await boot(false);
    try {
      expect((rig.io.engine as any).ws).toBeInstanceOf(RealtimeWsServer);
      const c = rawUpgrade(rig.port);
      await until(() => c.rx().includes('0{"sid"'), 2000, 'the open packet');
      expect(c.rx().split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    } finally {
      for (const c of clients.splice(0)) closeClient(c);
      await rig.app.close();
    }
  });
});
