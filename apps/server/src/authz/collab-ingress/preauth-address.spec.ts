import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { OutgoingMessage } from '@hocuspocus/server';
import { CollabWsAdapter } from '../../collaboration/adapter/collab-ws.adapter';
import { WsSocketWrapper } from '../../collaboration/extensions/redis-sync/ws-socket-wrapper';
import { BoundedCollabSocket } from './bounded-socket';
import { collabClientKey, type ClientAddressRequest, type EdgeTrust } from './client-address';
import { CollabClientTrust } from './client-trust';
import {
  COLLAB_PREAUTH_AUTH_FRAME_MS,
  COLLAB_PREAUTH_CLOSE_GRACE_MS,
  COLLAB_PREAUTH_DEADLINE_MS,
  COLLAB_PREAUTH_SOCKETS,
  COLLAB_PREAUTH_SOCKETS_PER_ADDRESS,
} from './limits';
import { answerCollabUpgrade, CollabPreAuthSlots } from './preauth-slots';
import { CollabSocketBounds } from './socket-bounds';
import { SocketLimitLog } from './socket-limit-log';

/**
 * #810 (round-5 Security L2): the pre-auth pool shared per client address. One key holds at most
 * COLLAB_PREAUTH_SOCKETS_PER_ADDRESS slots (429 past it) while other keys still get the rest; an upgrade the walk cannot
 * key is refused 400; every exit gives the slot back to its key; and while the platform's trust is unknown nothing
 * changes from before #810.
 */
const PROXY = '107.22.62.237';
const TRUST: EdgeTrust = { trustedProxies: [PROXY], xffTrusted: true };
const quiet = () => new SocketLimitLog({ warn: () => undefined });
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** An upgrade as the ALB delivers it: the ALB is the socket peer and appended `client` to X-Forwarded-For. */
const fromClient = (client: string, sent = ''): ClientAddressRequest => ({
  headers: { 'x-forwarded-for': `${sent ? `${sent}, ` : ''}${client}` },
  socket: { remoteAddress: '172.31.20.10' },
});

class Sock {
  terminated = 0;
  private closers: Array<() => void> = [];
  terminate() {
    this.terminated += 1;
    this.closeNow();
  }
  once(_e: 'close', fn: () => void) {
    this.closers.push(fn);
  }
  closeNow() {
    this.closers.splice(0).forEach((fn) => fn());
  }
}

/** A transport whose `data` listener a test can drive. */
class Transport {
  listener: ((chunk: Buffer) => void) | null = null;
  on(_e: 'data', l: (chunk: Buffer) => void) {
    this.listener = l;
  }
  off() {
    this.listener = null;
  }
}

/** Slots with the share active (a fixed trust), and an upgrade helper doing what ws + the adapter do. */
function shared(opts: { cap?: number; perAddress?: number; totalBytes?: number; socketBytes?: number; warn?: (m: string) => void } = {}) {
  const slots = new CollabPreAuthSlots({
    cap: opts.cap ?? COLLAB_PREAUTH_SOCKETS,
    perAddress: opts.perAddress,
    totalBytes: opts.totalBytes,
    socketBytes: opts.socketBytes,
    clientKey: (req) => collabClientKey(req, TRUST),
    limitLog: new SocketLimitLog({ warn: opts.warn ?? (() => undefined) }),
  });
  /** verifyClient, then (when admitted) the adapter's hold with the same request. */
  const upgrade = (req: ClientAddressRequest, transport?: Transport): Sock | string => {
    const decision = slots.admitUpgrade(req);
    if (decision !== 'ok') return decision;
    const s = new Sock();
    slots.hold(s, transport as never, req);
    return s;
  };
  return { slots, upgrade };
}

describe('#810 the per-address share of the pre-auth pool', () => {
  afterEach(() => jest.useRealTimers());

  it('sizing: 128 per address, so emptying the 512-slot pool takes at least four addresses', () => {
    expect(COLLAB_PREAUTH_SOCKETS_PER_ADDRESS).toBe(128);
    expect(COLLAB_PREAUTH_SOCKETS / COLLAB_PREAUTH_SOCKETS_PER_ADDRESS).toBeGreaterThanOrEqual(4);
  });

  it('one key is capped at its share while another key is still admitted; a forged prefix stays in its key', () => {
    const warn = jest.fn();
    const { slots, upgrade } = shared({ warn });
    for (let i = 0; i < COLLAB_PREAUTH_SOCKETS_PER_ADDRESS; i++) {
      // half direct, half through the proxy, each with a different forged prefix: one key
      const req = i % 2 ? fromClient('198.51.100.7', `9.9.9.${i}`) : fromClient(PROXY, `9.9.9.${i}, 198.51.100.7`);
      expect(upgrade(req)).toBeInstanceOf(Sock);
    }
    expect(slots.heldBy('198.51.100.7')).toBe(COLLAB_PREAUTH_SOCKETS_PER_ADDRESS);
    expect(upgrade(fromClient('198.51.100.7', '1.1.1.1'))).toBe('address');
    expect(upgrade(fromClient(PROXY, '198.51.100.7'))).toBe('address');
    expect(upgrade(fromClient('203.0.113.9'))).toBeInstanceOf(Sock); // another address: admitted
    expect(slots.size).toBe(COLLAB_PREAUTH_SOCKETS_PER_ADDRESS + 1);
    // the refusal is logged with numbers and enums only, never the address
    const line = warn.mock.calls.map((c) => c[0] as string).find((m) => m.includes('"client_address"'))!;
    expect(JSON.parse(line.replace('COLLAB_SOCKET_LIMIT ', ''))).toEqual({ limit: 'client_address', held: 128, cap: 128, hop: 1, kind: 'ipv4' });
    expect(warn.mock.calls.join('\n')).not.toMatch(/198\.51|9\.9\.9|203\.0/);
  });

  it('the pool full with the address under its share is still the pool (503); an address at its share is 429 first', () => {
    const { slots, upgrade } = shared({ cap: 4, perAddress: 2 });
    upgrade(fromClient('198.51.100.1'));
    upgrade(fromClient('198.51.100.1'));
    upgrade(fromClient('198.51.100.2'));
    upgrade(fromClient('198.51.100.3'));
    expect(slots.size).toBe(4);
    expect(slots.admitUpgrade(fromClient('198.51.100.4'))).toBe('pool');
    expect(slots.admitUpgrade(fromClient('198.51.100.1'))).toBe('address');
    const done = jest.fn();
    answerCollabUpgrade(slots, fromClient('198.51.100.4'), done);
    expect(done).toHaveBeenLastCalledWith(false, 503, 'Service Unavailable', { 'Retry-After': '5' });
    answerCollabUpgrade(slots, fromClient('198.51.100.1'), done);
    expect(done).toHaveBeenLastCalledWith(false, 429, 'Too Many Requests', { 'Retry-After': '5' });
  });

  it('two X-Forwarded-For lines, or an address that is not an IP, are refused 400 and take nothing', () => {
    const warn = jest.fn();
    const { slots } = shared({ warn });
    const twoLines = { headers: { 'x-forwarded-for': '9.9.9.9, 198.51.100.7' }, headersDistinct: { 'x-forwarded-for': ['9.9.9.9', '198.51.100.7'] }, socket: { remoteAddress: '172.31.20.10' } };
    const done = jest.fn();
    answerCollabUpgrade(slots, twoLines, done);
    expect(done).toHaveBeenLastCalledWith(false, 400, 'Bad Request');
    answerCollabUpgrade(slots, { headers: {}, socket: {} }, done); // no peer at all
    expect(done).toHaveBeenLastCalledWith(false, 400, 'Bad Request');
    expect(slots.size).toBe(0);
    expect(slots.addresses).toBe(0);
    expect(warn.mock.calls).toEqual([
      ['COLLAB_SOCKET_LIMIT {"limit":"client_address_refused","why":"xff_lines"}'],
      ['COLLAB_SOCKET_LIMIT {"limit":"client_address_refused","why":"not_ip"}'],
    ]);
  });

  it('share off (trust unknown): no per-address count and no new refusal, exactly as before #810', () => {
    const slots = new CollabPreAuthSlots({ cap: COLLAB_PREAUTH_SOCKETS, clientKey: () => null, limitLog: quiet() });
    const twoLines = { headers: {}, headersDistinct: { 'x-forwarded-for': ['9.9.9.9', '198.51.100.7'] }, socket: { remoteAddress: '172.31.20.10' } };
    expect(slots.admitUpgrade(twoLines)).toBe('ok');
    for (let i = 0; i < COLLAB_PREAUTH_SOCKETS; i++) {
      const req = fromClient('198.51.100.7');
      expect(slots.admitUpgrade(req)).toBe('ok');
      slots.hold(new Sock(), undefined, req);
    }
    expect(slots.addresses).toBe(0);
    expect(slots.admitUpgrade(fromClient('198.51.100.8'))).toBe('pool');
    // and a slots object built without a clientKey (every pre-#810 caller) is the same
    expect(new CollabPreAuthSlots({ cap: 1, limitLog: quiet() }).admitUpgrade(twoLines)).toBe('ok');
  });

  describe('every exit gives the slot back to its address', () => {
    const A = '198.51.100.7';
    /**
     * Fill A to its share of 2, run `exit` on one of its sockets, and prove A's count is exactly the sockets it still
     * holds (a timer exit expires its sibling too) and that A is admitted again for each freed slot, and no more.
     */
    const proves = (exit: (ctx: { slots: CollabPreAuthSlots; sock: Sock; transport: Transport }) => void) => {
      const { slots, upgrade } = shared({ perAddress: 2, socketBytes: 100, totalBytes: 150 });
      const transport = new Transport();
      const sock = upgrade(fromClient(A), transport) as Sock;
      const other = upgrade(fromClient(A)) as Sock;
      expect(slots.admitUpgrade(fromClient(A))).toBe('address');
      exit({ slots, sock, transport });
      expect(slots.holds(sock)).toBe(false);
      const still = [sock, other].filter((s) => slots.holds(s)).length;
      expect(slots.heldBy(A)).toBe(still);
      const readmitted: Sock[] = [];
      for (let r = upgrade(fromClient(A)); r instanceof Sock; r = upgrade(fromClient(A))) readmitted.push(r);
      expect(readmitted).toHaveLength(2 - still);
      for (const s of [other, ...readmitted]) slots.release(s);
      expect(slots.addresses).toBe(0);
    };

    it('the first Authenticated reply (release)', () => {
      proves(({ slots, sock }) => slots.release(sock));
    });

    it('a close', () => {
      proves(({ sock }) => sock.closeNow());
    });

    it('the first-Auth deadline', () => {
      jest.useFakeTimers();
      proves(({ sock }) => {
        jest.advanceTimersByTime(COLLAB_PREAUTH_AUTH_FRAME_MS + 1);
        expect(sock.terminated).toBeGreaterThan(0);
      });
    });

    it('the absolute deadline after an Auth', () => {
      jest.useFakeTimers();
      proves(({ slots, sock }) => {
        slots.authArrived(sock);
        jest.advanceTimersByTime(COLLAB_PREAUTH_DEADLINE_MS);
        expect(sock.terminated).toBeGreaterThan(0);
      });
    });

    it('the close grace', () => {
      jest.useFakeTimers();
      proves(({ slots, sock }) => {
        slots.closing(sock);
        jest.advanceTimersByTime(COLLAB_PREAUTH_CLOSE_GRACE_MS);
        expect(sock.terminated).toBeGreaterThan(0);
      });
    });

    it('a per-socket byte cut', () => {
      proves(({ sock, transport }) => {
        transport.listener!(Buffer.alloc(101));
        expect(sock.terminated).toBeGreaterThan(0);
      });
    });

    it('a total byte cut (the largest socket)', () => {
      proves(({ sock, transport }) => {
        transport.listener!(Buffer.alloc(99));
        transport.listener!(Buffer.alloc(52)); // 151 > 150 in total; it is the largest
        expect(sock.terminated).toBeGreaterThan(0);
      });
    });

    it('nothing leaks: after everything exits, no address is held', () => {
      const { slots, upgrade } = shared({ perAddress: 3 });
      const socks = [upgrade(fromClient(A)), upgrade(fromClient(A)), upgrade(fromClient('203.0.113.9'))] as Sock[];
      socks[0].closeNow();
      slots.release(socks[1]);
      slots.release(socks[1]); // idempotent: never below zero
      socks[2].terminate();
      expect(slots.addresses).toBe(0);
      expect(slots.size).toBe(0);
    });
  });
});

describe('#810 through the real ws adapter: forged X-Forwarded-For on the direct and the proxied shape', () => {
  let server: Server;
  let adapter: CollabWsAdapter;
  let bounds: CollabSocketBounds;
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    server = createServer();
    // The bounds as production builds them, with the platform's answer already fetched (127.0.0.1 is hop 0, the "ALB").
    const clientTrust = new CollabClientTrust({ fetchTrust: async () => ({ body: TRUST }), limitLog: quiet() });
    await clientTrust.attempt();
    clientTrust.stop();
    bounds = new CollabSocketBounds({ clientTrust, limitLog: quiet() });
    adapter = new CollabWsAdapter(bounds);
    const wss = adapter.handleUpgrade('/collab', server);
    wss.on('connection', (ws: WebSocket) => {
      const bounded = new BoundedCollabSocket(ws, new WsSocketWrapper(ws as never), { preAuth: bounds.preAuth });
      ws.on('message', (data: Buffer) => {
        if (data.toString() === 'authenticate-me') bounded.send(new OutgoingMessage('page.x').writeAuthenticated(false).toUint8Array());
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.terminate();
    adapter.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await settle(30);
    expect(bounds.preAuth.size).toBe(0);
    expect(bounds.preAuth.addresses).toBe(0);
  });

  /** Open a client with `xff`; resolves 'open' or the HTTP status the upgrade was refused with. */
  const dial = (xff: string) =>
    new Promise<{ ws: WebSocket; outcome: string | number; retryAfter?: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/collab`, { headers: { 'X-Forwarded-For': xff, 'X-Real-IP': `6.6.6.${clients.length % 250}` } });
      clients.push(ws);
      ws.once('open', () => resolve({ ws, outcome: 'open' }));
      ws.once('unexpected-response', (_req, res) => resolve({ ws, outcome: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] as string }));
      ws.once('error', () => undefined);
    });

  it('128 from one client (direct and proxied, each with a different forged prefix and X-Real-IP), then 429; another client opens', async () => {
    const C = '198.51.100.7';
    const opened = await Promise.all(
      Array.from({ length: COLLAB_PREAUTH_SOCKETS_PER_ADDRESS }, (_, i) => dial(i % 2 ? `10.${i}.0.1, ${C}` : `${PROXY}, 10.${i}.0.1, ${C}, ${PROXY}`)),
    );
    expect(opened.every((r) => r.outcome === 'open')).toBe(true);
    expect(bounds.preAuth.heldBy(C)).toBe(COLLAB_PREAUTH_SOCKETS_PER_ADDRESS);

    const direct = await dial(`1.2.3.4, ${C}`);
    expect([direct.outcome, direct.retryAfter]).toEqual([429, '5']);
    const proxied = await dial(`${C}, ${PROXY}`);
    expect(proxied.outcome).toBe(429);
    const forgedProxyName = await dial(`${PROXY}, ${C}`); // a direct caller naming the proxy left of itself
    expect(forgedProxyName.outcome).toBe(429);

    const other = await dial('203.0.113.9');
    expect(other.outcome).toBe('open');
    expect(bounds.preAuth.heldBy('203.0.113.9')).toBe(1);

    // an authentication frees one of C's slots, and C is admitted again
    opened[0].ws.send('authenticate-me');
    await settle(30);
    expect(bounds.preAuth.heldBy(C)).toBe(COLLAB_PREAUTH_SOCKETS_PER_ADDRESS - 1);
    expect((await dial(C)).outcome).toBe('open');
    // a close frees one too
    const gone = new Promise((r) => opened[1].ws.once('close', r));
    opened[1].ws.close();
    await gone;
    await settle(30);
    expect(bounds.preAuth.heldBy(C)).toBe(COLLAB_PREAUTH_SOCKETS_PER_ADDRESS - 1);
  }, 30_000);

  it('two X-Forwarded-For lines on the wire are refused 400 before any socket exists', async () => {
    const status = await new Promise<string>((resolve) => {
      const sock = connect(port, '127.0.0.1', () =>
        sock.write(
          'GET /collab HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nX-Forwarded-For: 9.9.9.9\r\nX-Forwarded-For: 198.51.100.7\r\n\r\n',
        ),
      );
      let got = '';
      sock.on('data', (d) => (got += d.toString()));
      sock.on('close', () => resolve(got.split('\r\n')[0]));
      sock.on('error', () => resolve(got.split('\r\n')[0]));
    });
    expect(status).toBe('HTTP/1.1 400 Bad Request');
    expect(bounds.preAuth.size).toBe(0);
  });
});
