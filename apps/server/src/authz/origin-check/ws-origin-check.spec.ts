import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { WebSocket } from 'ws';
import { WsGateway } from '../../ws/ws.gateway';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { SOCKET_ORIGIN_CHECK_ERROR } from './ws-origin-check';
import { originCheckLogSink, resetOriginCheckLogForTests } from './origin-check-log';

/**
 * wiki-v2 #655: the socket.io handshake origin check (cross-site WebSocket hijacking), through the REAL
 * `WsGateway.afterInit` (seam #161) on a real socket.io server with the gateway's transport settings. The client is a
 * raw `ws` socket speaking the engine.io v4 / socket.io v5 wire protocol, so the test sets Origin and Host exactly as
 * a browser or the Vite dev proxy would. A CONNECT answered `40` joined the namespace; `44` is `connect_error`.
 *
 * `handleConnection` is bound the way Nest binds it (on the namespace's `connection` event), with a token service
 * that records the cookie read, so a refused socket is shown never to reach authentication.
 */
const APP_URL = 'http://localhost:3300';

describe('socket.io handshake origin check through WsGateway.afterInit (#655)', () => {
  let http: HttpServer;
  let io: Server;
  let port: number;
  const verifyJwt = jest.fn(async () => {
    throw new Error('stub: not a real token');
  });

  beforeAll(async () => {
    const env = { getAppUrl: () => APP_URL, isHttps: () => false } as unknown as EnvironmentService;
    const gateway = new WsGateway(
      { verifyJwt } as any,
      undefined as any,
      { setServer: () => undefined } as any,
      { setServer: () => undefined } as any,
      env,
      undefined as any,
      undefined as any,
    );
    http = createServer();
    io = new Server(http, { cors: { origin: '*' }, transports: ['websocket'] });
    gateway.afterInit(io);
    io.on('connection', (socket) => void gateway.handleConnection(socket));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as AddressInfo).port;
  });

  afterAll(async () => {
    io.close();
    await new Promise((resolve) => http.close(resolve));
  });

  beforeEach(() => verifyJwt.mockClear());

  /** Opens the socket with these headers, sends CONNECT to the main namespace, and returns the first answer. */
  const connectAnswer = (headers: Record<string, string>): Promise<string> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, { headers });
      const timer = setTimeout(() => reject(new Error('no CONNECT answer')), 5000);
      ws.on('message', (data) => {
        const msg = data.toString();
        if (msg.startsWith('0')) {
          ws.send('40'); // engine.io open → socket.io CONNECT to "/"
          return;
        }
        if (msg.startsWith('40') || msg.startsWith('44')) {
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        }
      });
      ws.on('error', reject);
    });

  const refusedWith = (answer: string) => {
    expect(answer.slice(0, 2)).toBe('44');
    expect(JSON.parse(answer.slice(2)).message).toBe(SOCKET_ORIGIN_CHECK_ERROR);
    expect(verifyJwt).not.toHaveBeenCalled(); // never reached handleConnection's cookie read
  };

  it('refuses a foreign Origin carrying the session cookie (connect_error, never authenticated)', async () => {
    refusedWith(await connectAnswer({ Host: 'localhost:3300', Origin: 'https://evil.example', Cookie: 'authToken=t' }));
  });

  it('a refused handshake writes one FORK_ORIGIN_CHECK_REFUSED socket line; an admitted one writes none', async () => {
    resetOriginCheckLogForTests();
    const warn = jest.spyOn(originCheckLogSink, 'warn').mockImplementation(() => undefined);
    try {
      refusedWith(await connectAnswer({ Host: 'localhost:3300', Origin: 'https://evil.example', Cookie: 'authToken=t' }));
      expect(warn.mock.calls.map((c) => c[0])).toEqual([
        'FORK_ORIGIN_CHECK_REFUSED {"surface":"socket","secFetchSite":"absent","origin":"present","referer":"absent"}',
      ]);
      await connectAnswer({ Host: 'localhost:3300', Origin: APP_URL, Cookie: 'authToken=t' });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a same-site sibling (Sec-Fetch-Site same-site, untrusted Origin)', async () => {
    refusedWith(
      await connectAnswer({
        Host: 'localhost:3300',
        Origin: 'https://sibling.example.edu',
        'Sec-Fetch-Site': 'same-site',
        Cookie: 'authToken=t',
      }),
    );
  });

  it('refuses a foreign Origin without the cookie too (every handshake is decided)', async () => {
    refusedWith(await connectAnswer({ Host: 'localhost:3300', Origin: 'https://evil.example' }));
  });

  it('admits a same-origin handshake, which then reaches authentication', async () => {
    const answer = await connectAnswer({
      Host: 'wiki.example.com',
      Origin: 'https://wiki.example.com',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: 'authToken=t',
    });
    expect(answer.slice(0, 2)).toBe('40');
    // socket.io acknowledges CONNECT before it emits `connection`, so the cookie read lands just after the answer.
    for (let i = 0; i < 100 && verifyJwt.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(verifyJwt).toHaveBeenCalled();
  });

  it('admits the dev proxy shape: Origin rewritten to APP_URL while Host stays the dev server', async () => {
    const answer = await connectAnswer({
      Host: 'localhost:5173',
      Origin: APP_URL,
      'Sec-Fetch-Site': 'same-origin',
      Cookie: 'authToken=t',
    });
    expect(answer.slice(0, 2)).toBe('40');
  });

  it('admits a non-browser client with no signal (it still needs the cookie in handleConnection)', async () => {
    const answer = await connectAnswer({ Host: 'localhost:3300' });
    expect(answer.slice(0, 2)).toBe('40');
  });
});
