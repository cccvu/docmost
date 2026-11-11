import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { Hocuspocus, OutgoingMessage } from '@hocuspocus/server';
import { CollabWsAdapter } from '../../collaboration/adapter/collab-ws.adapter';
import { WsSocketWrapper } from '../../collaboration/extensions/redis-sync/ws-socket-wrapper';
import { authReplyOf, BoundedCollabSocket, COLLAB_DENIED_CLOSE_CODE } from './bounded-socket';
import * as encoding from 'lib0/encoding';
import { authFrame, DOC_NAME, FakeSocket, MSG } from './collab-ingress.testkit';
import { admitCollabFrame } from './frame-admission';
import {
  COLLAB_HOCUSPOCUS_OPTIONS,
  COLLAB_MAX_PAYLOAD_BYTES,
  COLLAB_PREAUTH_AUTH_FRAME_MS,
  COLLAB_PREAUTH_HEADROOM_BYTES,
  COLLAB_PREAUTH_SOCKET_BYTES,
  COLLAB_PREAUTH_TOTAL_BYTES,
  COLLAB_PREAUTH_CLOSE_GRACE_MS,
  COLLAB_PREAUTH_DEADLINE_MS,
  COLLAB_PREAUTH_SOCKETS,
} from './limits';
import { answerCollabUpgrade, CollabPreAuthSlots } from './preauth-slots';
import { CollabSocketBounds } from './socket-bounds';
import { EventEmitter } from 'node:events';
import { SocketLimitLog } from './socket-limit-log';
import { CollabSocketBytes } from './socket-bytes';

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

  it('takes its bounds by name (#810 N7): positional numbers, which could be swapped silently, no longer type-check', () => {
    // @ts-expect-error positional numbers are no longer accepted (scripts/ci/docmost-server-typecheck.mjs fails if they are)
    expect(new CollabPreAuthSlots(4, 60_000).admit()).toBe(true);
  });

  it('admits below the cap, refuses (logged) at it; a release or a close frees a slot; release is idempotent', () => {
    const warn = jest.fn();
    const slots = new CollabPreAuthSlots({ cap: 2, deadlineMs: 60_000, limitLog: new SocketLimitLog({ warn }) });
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

  it(`terminates (and logs) a socket with no Auth frame ${COLLAB_PREAUTH_AUTH_FRAME_MS} ms after it opened; an authenticated one is left alone`, () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const slots = new CollabPreAuthSlots({ cap: 4, limitLog: new SocketLimitLog({ warn }) });
    const [silent, quick] = [new Sock(), new Sock()];
    slots.hold(silent);
    slots.hold(quick);
    jest.advanceTimersByTime(1_000);
    slots.release(quick);
    jest.advanceTimersByTime(COLLAB_PREAUTH_AUTH_FRAME_MS - 1_001);
    expect(silent.terminated).toBe(0);
    jest.advanceTimersByTime(1);
    expect(silent.terminated).toBe(0); // its check waits one setImmediate (an Auth read in the same turn would save it)
    jest.advanceTimersByTime(1); // (jest's clock runs an immediate set at the deadline on its next advance)
    expect(silent.terminated).toBe(1);
    expect(quick.terminated).toBe(0);
    expect(slots.size).toBe(0);
    expect(warn.mock.calls).toEqual([[`COLLAB_SOCKET_LIMIT {"limit":"preauth_first_auth","deadlineMs":${COLLAB_PREAUTH_AUTH_FRAME_MS}}`]]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it(`its first Auth frame moves the deadline, once, to ${COLLAB_PREAUTH_DEADLINE_MS} ms after the upgrade (absolute), never further`, () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const slots = new CollabPreAuthSlots({ cap: 4, limitLog: new SocketLimitLog({ warn }) });
    const late = new Sock();
    slots.hold(late);
    jest.advanceTimersByTime(4_900);
    slots.authArrived(late); // its Auth at 4.9 s
    jest.advanceTimersByTime(101); // past the first-Auth deadline: kept
    expect(late.terminated).toBe(0);
    jest.advanceTimersByTime(4_000);
    slots.authArrived(late); // a second Auth extends nothing
    jest.advanceTimersByTime(COLLAB_PREAUTH_DEADLINE_MS - 9_001 - 1); // 9 999 ms after the upgrade
    expect(late.terminated).toBe(0);
    jest.advanceTimersByTime(1); // 10 000 ms after the upgrade, not 14 900
    expect(late.terminated).toBe(1);
    expect(warn.mock.calls).toEqual([[`COLLAB_SOCKET_LIMIT {"limit":"preauth_deadline","deadlineMs":${COLLAB_PREAUTH_DEADLINE_MS}}`]]);
    slots.authArrived(late); // after the release: nothing
    expect(slots.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('an Auth frame read in the same turn of the event loop as the first-Auth deadline is not cut (one setImmediate re-check)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const warn = jest.fn();
    const slots = new CollabPreAuthSlots({ cap: 4, limitLog: new SocketLimitLog({ warn }) });
    const [racing, silent] = [new Sock(), new Sock()];
    slots.hold(racing);
    slots.hold(silent);
    jest.advanceTimersByTime(COLLAB_PREAUTH_AUTH_FRAME_MS); // both timers fire; their checks wait one setImmediate
    expect(racing.terminated + silent.terminated).toBe(0);
    slots.authArrived(racing); // the read that follows expired timers in the same turn delivers its Auth
    await new Promise((r) => setImmediate(r));
    expect(racing.terminated).toBe(0);
    expect(silent.terminated).toBe(1); // control: the same turn without an Auth is cut
    expect(slots.holds(racing)).toBe(true);
    slots.release(racing);
  });

  it('closing shortens once: a later close (or Auth) never extends the grace', () => {
    jest.useFakeTimers();
    const slots = new CollabPreAuthSlots({ cap: 4, limitLog: quietLog() });
    const s = new Sock();
    slots.hold(s);
    slots.closing(s);
    jest.advanceTimersByTime(COLLAB_PREAUTH_CLOSE_GRACE_MS - 1);
    slots.closing(s);
    slots.authArrived(s);
    jest.advanceTimersByTime(1);
    expect(s.terminated).toBe(1);
  });

  it('the first-Auth deadline is never later than the overall one', () => {
    expect(COLLAB_PREAUTH_AUTH_FRAME_MS).toBeLessThan(COLLAB_PREAUTH_DEADLINE_MS);
    jest.useFakeTimers();
    const slots = new CollabPreAuthSlots({ cap: 4, deadlineMs: 1_000, firstAuthMs: 5_000, limitLog: quietLog() });
    const s = new Sock();
    slots.hold(s);
    jest.advanceTimersByTime(1_000);
    jest.advanceTimersByTime(1); // the first-Auth check's setImmediate
    expect(s.terminated).toBe(1);
  });

  it('answers the upgrade 503 with Retry-After at the cap, synchronously', () => {
    const slots = new CollabPreAuthSlots({ cap: 1, deadlineMs: 60_000, limitLog: quietLog() });
    const done = jest.fn();
    answerCollabUpgrade(slots, { headers: {} }, done);
    expect(done).toHaveBeenLastCalledWith(true);
    slots.hold(new Sock());
    answerCollabUpgrade(slots, { headers: {} }, done);
    expect(done).toHaveBeenLastCalledWith(false, 503, 'Service Unavailable', { 'Retry-After': '5' });
  });

  it('the total pre-auth bytes plus 64 KiB of objects per slot stays within 256 MiB; one socket may send a maximal frame and 1 MiB', () => {
    expect(COLLAB_PREAUTH_TOTAL_BYTES + COLLAB_PREAUTH_SOCKETS * 64 * 1024).toBeLessThanOrEqual(256 * MiB);
    expect(COLLAB_PREAUTH_TOTAL_BYTES).toBe(128 * MiB); // #810 N5 raised the per-socket cap only
    // a maximal frame plus the wire bytes around it (the Auth frame, a SyncStep1 of a page many sessions wrote to, about
    // 7 bytes per client id, frame headers) is never cut off before auth (#810 N5)
    expect(COLLAB_PREAUTH_HEADROOM_BYTES).toBe(MiB);
    expect(COLLAB_PREAUTH_SOCKET_BYTES).toBe(COLLAB_MAX_PAYLOAD_BYTES + COLLAB_PREAUTH_HEADROOM_BYTES);
    // the Hocuspocus pre-auth queue is made of bytes the socket sent before it authenticated
    expect(COLLAB_HOCUSPOCUS_OPTIONS.maxUnauthenticatedQueueSize).toBe(COLLAB_PREAUTH_SOCKET_BYTES);
  });

  it('no one source can hold the pool: the edge lets one address hold about 34 silent unauthenticated sockets at a time', () => {
    const edgeRequestsPerSecond = 2000 / 300; // the WAF rate rules, proxied and direct: 2000 requests per 5 minutes per address
    // a socket that sends no Auth holds its slot for the first-Auth deadline (#810 N1); a refused Auth only for the grace
    const perSource = Math.ceil(edgeRequestsPerSecond * (COLLAB_PREAUTH_AUTH_FRAME_MS / 1000));
    expect(perSource).toBeLessThanOrEqual(34);
    expect(COLLAB_PREAUTH_SOCKETS).toBeGreaterThanOrEqual(15 * perSource);
    expect(COLLAB_PREAUTH_CLOSE_GRACE_MS).toBeLessThan(COLLAB_PREAUTH_AUTH_FRAME_MS);
  });

  it('counts what the TCP socket delivers while unauthenticated: past the byte cap it terminates (logged); after release it stops counting', () => {
    const warn = jest.fn();
    const slots = new CollabPreAuthSlots({ cap: 4, deadlineMs: 60_000, limitLog: new SocketLimitLog({ warn }), socketBytes: 1000, closeGraceMs: 2000, totalBytes: 1_000_000 });
    const [greedy, honest] = [new Sock(), new Sock()];
    const [tg, th] = [new EventEmitter(), new EventEmitter()];
    slots.hold(greedy, tg as never);
    slots.hold(honest, th as never);
    tg.emit('data', Buffer.alloc(600));
    tg.emit('data', Buffer.alloc(400));
    expect(greedy.terminated).toBe(0); // exactly at the cap
    tg.emit('data', Buffer.alloc(1));
    expect(greedy.terminated).toBe(1);
    expect(warn.mock.calls).toEqual([['COLLAB_SOCKET_LIMIT {"limit":"preauth_bytes","bytes":1001}']]);
    expect(tg.listenerCount('data')).toBe(0);
    th.emit('data', Buffer.alloc(900));
    slots.release(honest); // authenticated
    expect(th.listenerCount('data')).toBe(0);
    th.emit('data', Buffer.alloc(10_000)); // an authenticated socket is not counted here
    expect(honest.terminated).toBe(0);
    expect(slots.bytes).toBe(0);
  });

  it('past the total budget the socket holding the most is cut, not the small honest ones, until the total is under', () => {
    const warn = jest.fn();
    // per socket 10,000 bytes, all of them together 10,000
    const slots = new CollabPreAuthSlots({ cap: 8, deadlineMs: 60_000, limitLog: new SocketLimitLog({ warn }), socketBytes: 10_000, closeGraceMs: 2000, totalBytes: 10_000 });
    const honest = [new Sock(), new Sock(), new Sock()];
    const [big1, big2] = [new Sock(), new Sock()];
    const t = new Map<Sock, EventEmitter>();
    for (const s of [...honest, big1, big2]) {
      t.set(s, new EventEmitter());
      slots.hold(s, t.get(s) as never);
    }
    for (const s of honest) t.get(s)!.emit('data', Buffer.alloc(300)); // an Auth, a SyncStep1, an awareness state
    t.get(big1)!.emit('data', Buffer.alloc(5000));
    t.get(big2)!.emit('data', Buffer.alloc(4000));
    expect(slots.bytes).toBe(9900);
    t.get(big2)!.emit('data', Buffer.alloc(500)); // 10,400: over; big1 (5000) holds the most
    expect(big1.terminated).toBe(1);
    expect(big2.terminated).toBe(0);
    expect(slots.bytes).toBe(5400);
    t.get(big2)!.emit('data', Buffer.alloc(4700)); // 10,100: over; now big2 (9200) holds the most
    expect(big2.terminated).toBe(1);
    expect(honest.map((s) => s.terminated)).toEqual([0, 0, 0]);
    expect(slots.bytes).toBe(900);
    expect(warn.mock.calls.map((c) => JSON.parse(c[0].replace('COLLAB_SOCKET_LIMIT ', '')))).toEqual([
      { limit: 'preauth_total_bytes', bytes: 5000, totalBytes: 10_400 },
      { limit: 'preauth_total_bytes', bytes: 9200, totalBytes: 10_100 },
    ]);
  });

  it('a page whose SyncStep1 is 1 MiB (about 150,000 client ids) still opens before auth', () => {
    const slots = new CollabPreAuthSlots({ cap: 8, deadlineMs: 60_000, limitLog: quietLog() });
    const sock = new Sock();
    const tr = new EventEmitter();
    slots.hold(sock, tr as never);
    tr.emit('data', Buffer.alloc(MiB));
    expect(sock.terminated).toBe(0);
    slots.release(sock);
  });

  it(`a refused socket keeps its slot while it closes, for at most ${COLLAB_PREAUTH_CLOSE_GRACE_MS} ms`, () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const slots = new CollabPreAuthSlots({ cap: 4, deadlineMs: 60_000, limitLog: new SocketLimitLog({ warn }) });
    const [slow, prompt] = [new Sock(), new Sock()];
    slots.hold(slow);
    slots.hold(prompt);
    slots.closing(slow);
    slots.closing(prompt);
    prompt.closeNow(); // an honest client closes at once
    expect(slots.holds(prompt)).toBe(false);
    expect(slots.holds(slow)).toBe(true);
    jest.advanceTimersByTime(COLLAB_PREAUTH_CLOSE_GRACE_MS);
    expect(slow.terminated).toBe(1);
    expect(slots.size).toBe(0);
    expect(warn.mock.calls).toEqual([[`COLLAB_SOCKET_LIMIT {"limit":"preauth_close_grace","deadlineMs":${COLLAB_PREAUTH_CLOSE_GRACE_MS}}`]]);
  });
});

describe('#790 authReplyOf', () => {
  it("recognises Hocuspocus 4.7.1's own Authenticated (both scopes) and PermissionDenied replies, and nothing else", () => {
    const name = 'page.00000000-0000-4000-8000-000000000790';
    expect(authReplyOf(new OutgoingMessage(name).writeAuthenticated(false).toUint8Array())).toBe('authenticated');
    expect(authReplyOf(new OutgoingMessage(name).writeAuthenticated(true).toUint8Array())).toBe('authenticated');
    expect(authReplyOf(new OutgoingMessage(name).writePermissionDenied('permission-denied').toUint8Array())).toBe('denied');
    expect(authReplyOf(new OutgoingMessage(name).writeTokenSyncRequest().toUint8Array())).toBeNull();
    expect(authReplyOf(authFrame('token'))).toBeNull(); // a client Auth (Token subtype)
    expect(authReplyOf(new Uint8Array([]))).toBeNull();
    expect(authReplyOf(new Uint8Array([200]))).toBeNull();
  });
});

describe('#790 through a real Hocuspocus 4.7.1: Authenticated frees the slot, PermissionDenied closes the socket', () => {
  const open: Hocuspocus[] = [];
  const sockets: FakeSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close(1000, 'test over');
    for (const hp of open.splice(0)) hp.closeConnections();
    await settle();
  });
  const server = () => {
    const hp = new Hocuspocus({
      quiet: true,
      extensions: [{ async onAuthenticate(d: { token: string }) { if (d.token !== 'ok') throw new Error('denied'); return { user: { id: 'u' } }; } }],
    } as never);
    open.push(hp);
    return hp;
  };
  const connect = (hp: Hocuspocus, slots: CollabPreAuthSlots, token: string) => {
    const sock = new FakeSocket();
    sockets.push(sock);
    slots.hold(sock); // as the ws adapter does at the upgrade
    const bounded = new BoundedCollabSocket(sock, new WsSocketWrapper(sock as never), { preAuth: slots, bytes: new CollabSocketBytes(), limitLog: quietLog() });
    const cc = hp.handleConnection(bounded, new Request('http://localhost/'));
    sock.on('message', (data: Buffer) => cc.handleMessage(new Uint8Array(data)));
    sock.on('close', (code: number, reason: Buffer) => cc.handleClose({ code, reason: reason.toString() }));
    sock.deliver(authFrame(token));
    return sock;
  };

  it('a verified token frees its slot and keeps its socket; a refused one is closed 4401 after its PermissionDenied reply', async () => {
    const slots = new CollabPreAuthSlots({ cap: 8, deadlineMs: 60_000, limitLog: quietLog() });
    const closing = jest.spyOn(slots, 'closing');
    const hp = server();
    const ok = connect(hp, slots, 'ok');
    const denied = connect(hp, slots, 'nope');
    expect(slots.size).toBe(2);
    await settle(20);
    expect(slots.holds(ok)).toBe(false);
    expect(ok.closed).toBeNull();
    expect(denied.closed).toEqual({ code: COLLAB_DENIED_CLOSE_CODE, reason: 'permission-denied' });
    const replies = denied.sent.map((f) => authReplyOf(f)).filter(Boolean);
    expect(replies).toEqual(['denied']); // the editor reads the refusal (and runs its token refetch) before the close
    expect(closing.mock.calls).toEqual([[denied]]); // a client that does not finish closing is cut off after the grace
    expect(slots.size).toBe(0);
  });

  it('refused editors reconnecting over and over never fill the pool: an honest socket still gets a slot', async () => {
    const slots = new CollabPreAuthSlots({ cap: 4, deadlineMs: 60_000, limitLog: quietLog() });
    const hp = server();
    for (let i = 0; i < 40; i++) {
      connect(hp, slots, 'nope');
      if (i % 4 === 3) await settle(5);
    }
    await settle(20);
    expect(slots.size).toBe(0);
    expect(slots.admit()).toBe(true);
    const ok = connect(hp, slots, 'ok');
    await settle(20);
    expect(ok.closed).toBeNull();
    expect(slots.holds(ok)).toBe(false);
  });
});

/** A client that never finishes the close handshake (ws would wait 30 s for its close frame). */
class StubbornSocket extends FakeSocket {
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  close(code?: number, reason?: string): void {
    if (this.terminated) return super.close(code, reason);
    this.closeCalls.push({ code, reason });
  }
}

/** An Auth frame whose token claims 100 bytes and carries 3: complete as a ws message, undecodable as an Auth. */
function malformedAuth(): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, DOC_NAME);
  encoding.writeVarUint(e, MSG.Auth);
  encoding.writeVarUint(e, 0); // Token
  encoding.writeVarUint(e, 100);
  encoding.writeUint8Array(e, new Uint8Array([97, 98, 99]));
  return encoding.toUint8Array(e);
}

describe('#810 (red team): a complete but malformed Auth frame buys no more than the close grace', () => {
  let errors: jest.SpyInstance;
  beforeEach(() => (errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)));
  afterEach(() => {
    errors.mockRestore();
    jest.useRealTimers();
  });

  it(`Hocuspocus closes it, the bounded socket starts the ${COLLAB_PREAUTH_CLOSE_GRACE_MS} ms grace, and a client that never finishes closing is cut`, () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const limitLog = new SocketLimitLog({ warn });
    const slots = new CollabPreAuthSlots({ cap: 4, limitLog });
    const hp = new Hocuspocus({ quiet: true, extensions: [{ async onAuthenticate() { return { user: { id: 'u' } }; } }] } as never);
    const sock = new StubbornSocket();
    slots.hold(sock); // as the ws adapter does at the upgrade
    const bounded = new BoundedCollabSocket(sock, new WsSocketWrapper(sock as never), { preAuth: slots, bytes: new CollabSocketBytes(), limitLog });
    const cc = hp.handleConnection(bounded, new Request('http://localhost/'));
    // as CollabSocketBounds.open wires it: the frame check (which reports the first Auth to the slots), then Hocuspocus
    sock.on('message', (data: Buffer) => {
      if (admitCollabFrame(sock, data, limitLog, Date.now, slots)) cc.handleMessage(new Uint8Array(data));
    });
    sock.deliver(malformedAuth()); // a complete Auth: the deadline moves to 10 s; Hocuspocus cannot decode it and closes
    expect(sock.closeCalls).toEqual([{ code: 4205, reason: 'Reset Connection' }]); // @hocuspocus/common ResetConnection
    expect(slots.holds(sock)).toBe(true);
    jest.advanceTimersByTime(COLLAB_PREAUTH_CLOSE_GRACE_MS - 1);
    expect(sock.terminated).toBe(false);
    jest.advanceTimersByTime(1);
    expect(sock.terminated).toBe(true);
    expect(slots.size).toBe(0);
    expect(warn.mock.calls).toEqual([[`COLLAB_SOCKET_LIMIT {"limit":"preauth_close_grace","deadlineMs":${COLLAB_PREAUTH_CLOSE_GRACE_MS}}`]]);
    hp.closeConnections();
  });
});

describe('#790 through the real ws adapter: the upgrade check, the slot and the byte count', () => {
  let server: Server;
  let adapter: CollabWsAdapter;
  let bounds: CollabSocketBounds;
  let port: number;
  const clients: WebSocket[] = [];
  const fillers: Sock[] = [];

  beforeEach(async () => {
    server = createServer();
    bounds = new CollabSocketBounds(); // per test: nothing one test holds reaches the next
    adapter = new CollabWsAdapter(bounds);
    const wss = adapter.handleUpgrade('/collab', server);
    // As the gateway does on both paths: the bounded socket frees the slot on its first Authenticated reply.
    wss.on('connection', (ws: WebSocket) => {
      const bounded = new BoundedCollabSocket(ws, new WsSocketWrapper(ws as never), { preAuth: bounds.preAuth, bytes: bounds.bytes });
      ws.on('message', (data: Buffer) => {
        if (data.toString() === 'authenticate-me') bounded.send(new OutgoingMessage('page.x').writeAuthenticated(false).toUint8Array());
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const f of fillers.splice(0)) bounds.preAuth.release(f);
    for (const c of clients.splice(0)) c.terminate();
    adapter.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await settle(30);
    expect(bounds.preAuth.size).toBe(0); // nothing leaks
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
  const closed = (ws: WebSocket) => new Promise<number>((r) => ws.once('close', (code) => r(code)));
  /** Take all but `free` slots with stand-ins (512 real sockets would only slow the spec down). */
  const fill = (free: number) => {
    while (bounds.preAuth.size < COLLAB_PREAUTH_SOCKETS - free) {
      const f = new Sock();
      fillers.push(f);
      bounds.preAuth.hold(f);
    }
  };

  it('12 concurrent upgrades with 6 slots free: exactly 6 open, 6 get 503; an authentication or a close frees a slot', async () => {
    fill(6);
    const results = await Promise.all(Array.from({ length: 12 }, dial));
    const opened = results.filter((r) => r.outcome === 'open');
    expect(opened).toHaveLength(6);
    expect(results.filter((r) => r.outcome === 503)).toHaveLength(6);
    expect(bounds.preAuth.size).toBe(COLLAB_PREAUTH_SOCKETS);
    expect((await dial()).outcome).toBe(503);

    opened[0].ws.send('authenticate-me'); // the server sends its Authenticated reply: the slot is freed
    await settle(30);
    expect(bounds.preAuth.size).toBe(COLLAB_PREAUTH_SOCKETS - 1);
    expect((await dial()).outcome).toBe('open');

    opened[1].ws.close();
    await settle(30);
    expect(bounds.preAuth.size).toBe(COLLAB_PREAUTH_SOCKETS - 1);
    expect((await dial()).outcome).toBe('open');
  });

  it('one source holding as many idle unauthenticated sockets as the edge lets it (67) leaves room: a second one connects and authenticates', async () => {
    const held = await Promise.all(Array.from({ length: 67 }, dial));
    expect(held.every((r) => r.outcome === 'open')).toBe(true);
    const other = await dial();
    expect(other.outcome).toBe('open');
    other.ws.send('authenticate-me');
    await settle(30);
    expect(bounds.preAuth.size).toBe(67);
  });

  /** A ws client frame header: FIN + binary, masked, a 64-bit payload length, a mask. */
  const header = (payloadBytes: number) => {
    const h = Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
    h.writeBigUInt64BE(BigInt(payloadBytes), 2);
    return h;
  };
  const rawOf = (ws: WebSocket) => (ws as unknown as { _socket: import('node:net').Socket })._socket;

  it(`an honest provider's pre-auth bytes (an Auth, a 512 KiB SyncStep1, then a maximal frame) are kept, and it authenticates (#810 N5)`, async () => {
    const honest = await dial();
    honest.ws.send(authFrame('token'));
    honest.ws.send(Buffer.alloc(512 * 1024)); // a SyncStep1 of a page about 75,000 sessions wrote to
    honest.ws.send(Buffer.alloc(COLLAB_MAX_PAYLOAD_BYTES)); // a cached copy near maxPayload
    await new Promise<void>((r) => honest.ws.send('', () => r()));
    await settle(100);
    expect(honest.ws.readyState).toBe(WebSocket.OPEN);
    expect(bounds.preAuth.bytes).toBeGreaterThan(COLLAB_MAX_PAYLOAD_BYTES + 512 * 1024); // all of it was counted
    honest.ws.send('authenticate-me');
    await settle(30);
    expect(bounds.preAuth.size).toBe(0);
  });

  it(`terminates an unauthenticated socket past ${COLLAB_PREAUTH_SOCKET_BYTES} bytes, a partial frame included; an honest one is kept`, async () => {
    const greedy = await dial();
    const honest = await dial();
    honest.ws.send(Buffer.alloc(MiB)); // a SyncStep1 of a page about 150,000 sessions wrote to
    const code = closed(greedy.ws);
    // a complete maximal frame, then a second one announcing 8 MiB, of which enough arrives to pass the cap by one byte
    const first = Buffer.concat([header(COLLAB_MAX_PAYLOAD_BYTES), Buffer.alloc(COLLAB_MAX_PAYLOAD_BYTES)]);
    const rest = COLLAB_PREAUTH_SOCKET_BYTES + 1 - first.length - 14;
    rawOf(greedy.ws).write(Buffer.concat([first, header(COLLAB_MAX_PAYLOAD_BYTES), Buffer.alloc(rest)]));
    expect(await code).toBe(1006);
    await settle(30);
    expect(honest.ws.readyState).toBe(WebSocket.OPEN);
    expect(bounds.preAuth.size).toBe(1);
  });
});
