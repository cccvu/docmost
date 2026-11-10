import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { Hocuspocus, OutgoingMessage } from '@hocuspocus/server';
import { CollabWsAdapter } from '../../collaboration/adapter/collab-ws.adapter';
import { WsSocketWrapper } from '../../collaboration/extensions/redis-sync/ws-socket-wrapper';
import { BoundedCollabSocket, isAuthenticatedReply } from './bounded-socket';
import { authFrame, FakeSocket } from './collab-ingress.testkit';
import { COLLAB_MAX_PAYLOAD_BYTES, COLLAB_PREAUTH_DEADLINE_MS, COLLAB_PREAUTH_SOCKETS, COLLAB_HOCUSPOCUS_OPTIONS } from './limits';
import { answerCollabUpgrade, collabPreAuthSlots, CollabPreAuthSlots } from './preauth-slots';
import { SocketLimitLog } from './socket-limit-log';

/**
 * #790 (review S1): a process-wide bound on unauthenticated collab sockets, held from the connection until the first
 * Authenticated reply is sent or the socket closes, refused 503 at the upgrade past the cap, and a pre-auth deadline.
 */
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const quietLog = () => new SocketLimitLog({ warn: () => undefined });
const MiB = 1024 * 1024;

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
    const fns = this.closers.splice(0);
    fns.forEach((fn) => fn());
  }
}

describe('#790 CollabPreAuthSlots', () => {
  afterEach(() => jest.useRealTimers());

  it('admits below the cap, refuses (logged) at it; a release or a close frees a slot; release is idempotent', () => {
    const warn = jest.fn();
    const slots = new CollabPreAuthSlots(2, 60_000, new SocketLimitLog({ warn }));
    const [a, b, c] = [new Sock(), new Sock(), new Sock()];
    expect(slots.admit()).toBe(true);
    slots.hold(a);
    slots.hold(a); // the same socket twice is one slot
    slots.hold(b);
    expect(slots.size).toBe(2);
    expect(slots.admit()).toBe(false);
    expect(warn.mock.calls).toEqual([['COLLAB_SOCKET_LIMIT {"limit":"preauth_sockets","held":2}']]);
    slots.release(a); // authenticated
    slots.release(a);
    expect(slots.holds(a)).toBe(false);
    expect(slots.admit()).toBe(true);
    slots.hold(c);
    c.closeNow(); // closed before authenticating
    expect(slots.size).toBe(1);
    b.closeNow();
    expect(slots.size).toBe(0);
  });

  it(`terminates (and logs) a socket still unauthenticated ${COLLAB_PREAUTH_DEADLINE_MS} ms after it opened; an authenticated one is left alone`, () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const slots = new CollabPreAuthSlots(4, COLLAB_PREAUTH_DEADLINE_MS, new SocketLimitLog({ warn }));
    const [slow, quick] = [new Sock(), new Sock()];
    slots.hold(slow);
    slots.hold(quick);
    jest.advanceTimersByTime(1_000);
    slots.release(quick);
    jest.advanceTimersByTime(COLLAB_PREAUTH_DEADLINE_MS - 1_001);
    expect(slow.terminated).toBe(0);
    jest.advanceTimersByTime(1);
    expect(slow.terminated).toBe(1);
    expect(quick.terminated).toBe(0);
    expect(slots.size).toBe(0);
    expect(warn.mock.calls).toEqual([[`COLLAB_SOCKET_LIMIT {"limit":"preauth_deadline","deadlineMs":${COLLAB_PREAUTH_DEADLINE_MS}}`]]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('answers the upgrade 503 with Retry-After at the cap, synchronously', () => {
    const slots = new CollabPreAuthSlots(1, 60_000, quietLog());
    const done = jest.fn();
    answerCollabUpgrade(slots, done);
    expect(done).toHaveBeenLastCalledWith(true);
    slots.hold(new Sock());
    answerCollabUpgrade(slots, done);
    expect(done).toHaveBeenLastCalledWith(false, 503, 'Service Unavailable', { 'Retry-After': '5' });
  });

  it('the cap times the per-socket pre-auth bound (queue + one partial frame) stays within 256 MiB', () => {
    const perSocket = COLLAB_HOCUSPOCUS_OPTIONS.maxUnauthenticatedQueueSize + COLLAB_MAX_PAYLOAD_BYTES;
    expect(perSocket).toBe(16 * MiB);
    expect(COLLAB_PREAUTH_SOCKETS * perSocket).toBeLessThanOrEqual(256 * MiB);
    expect(COLLAB_HOCUSPOCUS_OPTIONS.maxUnauthenticatedQueueSize).toBeGreaterThanOrEqual(COLLAB_MAX_PAYLOAD_BYTES); // one honest frame
  });
});

describe('#790 isAuthenticatedReply', () => {
  it("recognises Hocuspocus 4.7.1's own Authenticated reply (both scopes), and nothing else", () => {
    const name = 'page.00000000-0000-4000-8000-000000000790';
    expect(isAuthenticatedReply(new OutgoingMessage(name).writeAuthenticated(false).toUint8Array())).toBe(true);
    expect(isAuthenticatedReply(new OutgoingMessage(name).writeAuthenticated(true).toUint8Array())).toBe(true);
    expect(isAuthenticatedReply(new OutgoingMessage(name).writePermissionDenied('permission-denied').toUint8Array())).toBe(false);
    expect(isAuthenticatedReply(new OutgoingMessage(name).writeTokenSyncRequest().toUint8Array())).toBe(false);
    expect(isAuthenticatedReply(authFrame('token'))).toBe(false); // a client Auth (Token subtype)
    expect(isAuthenticatedReply(new Uint8Array([]))).toBe(false);
    expect(isAuthenticatedReply(new Uint8Array([200]))).toBe(false);
  });
});

describe('#790 through a real Hocuspocus 4.7.1: the slot is freed by the Authenticated reply, not by a denied one', () => {
  const open: Hocuspocus[] = [];
  const sockets: FakeSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close(1000, 'test over');
    for (const hp of open.splice(0)) hp.closeConnections();
    await settle();
  });

  it('a socket whose token verifies frees its slot; one that is denied keeps it (until the deadline or its close)', async () => {
    const slots = new CollabPreAuthSlots(8, 60_000, quietLog());
    const hp = new Hocuspocus({
      quiet: true,
      extensions: [{ async onAuthenticate(d: { token: string }) { if (d.token !== 'ok') throw new Error('denied'); return { user: { id: 'u' } }; } }],
    } as never);
    open.push(hp);
    const connect = (token: string) => {
      const sock = new FakeSocket();
      sockets.push(sock);
      const bounded = new BoundedCollabSocket(sock, new WsSocketWrapper(sock as never), quietLog(), slots);
      const cc = hp.handleConnection(bounded, new Request('http://localhost/'));
      sock.on('message', (data: Buffer) => cc.handleMessage(new Uint8Array(data)));
      sock.on('close', (code: number, reason: Buffer) => cc.handleClose({ code, reason: reason.toString() }));
      sock.deliver(authFrame(token));
      return sock;
    };
    const ok = connect('ok');
    const denied = connect('nope');
    expect(slots.size).toBe(2); // both held from the connection
    await settle(20);
    expect(slots.holds(ok)).toBe(false);
    expect(slots.holds(denied)).toBe(true);
    denied.close(1000, 'gone');
    expect(slots.size).toBe(0);
  });
});

describe('#790 through the real ws adapter: the upgrade is refused 503 past the cap', () => {
  let server: Server;
  let adapter: CollabWsAdapter;
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    server = createServer();
    adapter = new CollabWsAdapter();
    const wss = adapter.handleUpgrade('/collab', server);
    // As the gateway does on both paths: the bounded socket holds the slot from the connection.
    wss.on('connection', (ws: WebSocket) => {
      const bounded = new BoundedCollabSocket(ws, new WsSocketWrapper(ws as never));
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
    await settle(20);
  });

  /** Open a client; resolves 'open' or the HTTP status the upgrade was refused with. */
  const dial = () =>
    new Promise<{ ws: WebSocket; outcome: string | number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/collab`);
      clients.push(ws);
      ws.once('open', () => resolve({ ws, outcome: 'open' }));
      ws.once('unexpected-response', (_req, res) => resolve({ ws, outcome: res.statusCode ?? 0 }));
      ws.once('error', () => undefined);
    });

  it(`${COLLAB_PREAUTH_SOCKETS + 6} concurrent upgrades: exactly ${COLLAB_PREAUTH_SOCKETS} open, the rest get 503; an authentication or a close frees a slot`, async () => {
    const results = await Promise.all(Array.from({ length: COLLAB_PREAUTH_SOCKETS + 6 }, dial));
    const opened = results.filter((r) => r.outcome === 'open');
    expect(opened).toHaveLength(COLLAB_PREAUTH_SOCKETS);
    expect(results.filter((r) => r.outcome === 503)).toHaveLength(6);
    expect(collabPreAuthSlots.size).toBe(COLLAB_PREAUTH_SOCKETS);
    expect((await dial()).outcome).toBe(503);

    opened[0].ws.send('authenticate-me'); // the server sends its Authenticated reply: the slot is freed
    await settle(30);
    expect(collabPreAuthSlots.size).toBe(COLLAB_PREAUTH_SOCKETS - 1);
    expect((await dial()).outcome).toBe('open');

    opened[1].ws.close();
    await settle(30);
    expect(collabPreAuthSlots.size).toBe(COLLAB_PREAUTH_SOCKETS - 1);
    expect((await dial()).outcome).toBe('open');
  });
});
