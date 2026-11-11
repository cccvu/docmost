import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocket, type WebSocketServer } from 'ws';
import { CollabWsAdapter } from '../../collaboration/adapter/collab-ws.adapter';
import { COLLAB_WS_SERVER_OPTIONS } from './limits';
import { CollabSocketBounds } from './socket-bounds';
import { SocketLimitLog } from './socket-limit-log';

/**
 * #810: ws's autoPong off, and the bounds' own pong (socket-pong.ts) installed at the upgrade, through the REAL collab
 * ws adapter on a real HTTP server: at most one pong in flight, whatever a client pings, and a client that reads still
 * gets its latest ping answered. Also pins deflate off on the real server (the byte budget models no zlib stage).
 */
const MiB = 1024 * 1024;
const PING_PAYLOAD = 125; // the largest a control frame carries

/** One masked client ping of `payload` bytes (mask 0: the payload as is). */
const pingFrame = (payload: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x80 | payload, 0, 0, 0, 0]), Buffer.alloc(payload, 0x61)]);

describe('#810 the collab server answers pings with one pong in flight', () => {
  let http: Server;
  let wss: WebSocketServer;
  let adapter: CollabWsAdapter;
  let port: number;
  let serverSockets: WebSocket[];
  const clients: Array<Socket | WebSocket> = [];

  beforeEach(async () => {
    serverSockets = [];
    http = createServer();
    const bounds = new CollabSocketBounds({ limitLog: new SocketLimitLog({ warn: () => undefined }) });
    adapter = new CollabWsAdapter(bounds);
    wss = adapter.handleUpgrade('/collab', http);
    wss.on('connection', (ws: WebSocket) => {
      bounds.preAuth.release(ws); // as if authenticated: the pre-auth byte count would cut a ping flood far sooner
      serverSockets.push(ws);
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    port = (http.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) (c as Socket).destroy?.() ?? (c as WebSocket).terminate();
    adapter.destroy();
    await new Promise<void>((r) => http.close(() => r()));
  });

  /** A raw TCP client that upgrades, then never reads again. */
  const pausedClient = (): Promise<{ sock: Socket; ws: WebSocket }> =>
    new Promise((resolve) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(
          'GET /collab HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      clients.push(sock);
      sock.once('data', () => {
        sock.pause();
        const wait = () => (serverSockets.length ? resolve({ sock, ws: serverSockets[serverSockets.length - 1] }) : setImmediate(wait));
        wait();
      });
    });

  it('the real server runs with autoPong and perMessageDeflate off', () => {
    expect(COLLAB_WS_SERVER_OPTIONS.autoPong).toBe(false);
    expect(COLLAB_WS_SERVER_OPTIONS.perMessageDeflate).toBe(false);
    expect(wss.options.autoPong).toBe(false);
    expect(wss.options.perMessageDeflate).toBe(false);
  });

  it('a ping flood on a socket that never reads queues one pong, not one per ping', async () => {
    const { sock, ws } = await pausedClient();
    // the client stopped reading long ago: its socket and ws's are backed up behind a large frame
    ws.send(Buffer.alloc(16 * MiB));
    await new Promise((r) => setTimeout(r, 50));
    const backlog = ws.bufferedAmount;
    expect(backlog).toBeGreaterThan(0);
    const pong = jest.spyOn(ws, 'pong');
    const PINGS = 10_000;
    let seen = 0;
    let peak = 0;
    ws.on('ping', () => {
      seen++;
      peak = Math.max(peak, ws.bufferedAmount - backlog);
    });
    const batch = Buffer.concat(Array.from({ length: 500 }, () => pingFrame(PING_PAYLOAD)));
    for (let i = 0; i < PINGS / 500; i++) sock.write(batch);
    while (seen < PINGS) await new Promise((r) => setTimeout(r, 5));
    // one pong waits behind the backlog; every later ping only replaced the one kept for when it is written
    expect(pong).toHaveBeenCalledTimes(1);
    expect(peak).toBeLessThanOrEqual(2 + PING_PAYLOAD);
    expect(ws.bufferedAmount - backlog).toBeLessThanOrEqual(2 + PING_PAYLOAD);
  });

  it('a client that reads gets each ping answered, its latest one last, while the server keeps sending to it', async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/collab`);
    clients.push(client);
    await new Promise((r) => client.once('open', r));
    while (!serverSockets.length) await new Promise((r) => setImmediate(r));
    const server = serverSockets[0];
    const busy = setInterval(() => server.send(Buffer.alloc(64 * 1024)), 1); // its queue is rarely empty
    try {
      const pongs: string[] = [];
      client.on('pong', (d: Buffer) => pongs.push(d.toString()));
      for (const n of ['one', 'two', 'three']) {
        client.ping(n);
        while (!pongs.includes(n)) await new Promise((r) => setTimeout(r, 2));
      }
      // three back to back: at most three pongs, and the last one answers the latest
      pongs.length = 0;
      for (const n of ['a', 'b', 'c']) client.ping(n);
      while (!pongs.includes('c')) await new Promise((r) => setTimeout(r, 2));
      await new Promise((r) => setTimeout(r, 50));
      expect(pongs[pongs.length - 1]).toBe('c');
      expect(pongs.length).toBeLessThanOrEqual(3);
    } finally {
      clearInterval(busy);
    }
  });
});
