import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { authFrame, FakeSocket } from './collab-ingress.testkit';
import { BoundedCollabSocket } from './bounded-socket';
import { CollabPreAuthSlots } from './preauth-slots';
import { CollabSocketDocuments } from './socket-documents';
import { COLLAB_EMPTY_INTERVALS, COLLAB_PING_INTERVAL_MS, COLLAB_STALL_INTERVALS, keepCollabSocketAlive } from './socket-keepalive';
import { SocketLimitLog } from './socket-limit-log';
import { CollabUserConnections, CollabUserConnectionsExtension } from './user-connections';
import { CollabSocketBytes } from './socket-bytes';

/**
 * #790: Hocuspocus 4.x sends no pings and reaps a connection that received nothing for `timeout`. The gateway pings
 * every socket and counts each pong as activity (`touch()`), on both the RedisSync and the standalone path, so a quiet
 * but healthy editor stays connected; an unauthenticated socket still meets its deadline. RedisSync's proxied frames
 * refresh the idle clock through `touch()` only, never the private pre-auth reference upstream rewrites.
 */
const SRC = join(__dirname, '..', '..');
const CONNECTION_TIMEOUT = 4408; // @hocuspocus/common ConnectionTimeout.code
/** A socket the reaper never sees as empty (the cases below that are not about it). */
const NEVER_EMPTY = { holdsNoDocument: () => false };

class PongingSocket extends FakeSocket {
  pings = 0;
  answer = true;
  override ping(): void {
    this.pings += 1;
    if (this.answer) setImmediate(() => this.emit('pong', Buffer.alloc(0)));
  }
}

describe('keepCollabSocketAlive (#790)', () => {
  afterEach(() => jest.useRealTimers());

  it('pings an open socket every interval, counts each pong as activity, and stops when the socket closes', () => {
    jest.useFakeTimers();
    const sock = new PongingSocket();
    sock.answer = false;
    const touch = jest.fn();
    keepCollabSocketAlive(sock, touch, { ...NEVER_EMPTY, intervalMs: 1_000 });
    jest.advanceTimersByTime(3_000);
    expect(sock.pings).toBe(3);
    sock.emit('pong');
    sock.emit('pong');
    expect(touch).toHaveBeenCalledTimes(2);
    sock.readyState = 2; // closing: no ping
    jest.advanceTimersByTime(1_000);
    expect(sock.pings).toBe(3);
    sock.readyState = 1;
    sock.close(1000, 'bye');
    jest.advanceTimersByTime(10_000);
    expect(sock.pings).toBe(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a ping that throws (the socket closed in between) is swallowed', () => {
    jest.useFakeTimers();
    const sock = new PongingSocket();
    sock.ping = () => {
      throw new Error('not open');
    };
    keepCollabSocketAlive(sock, () => undefined, { ...NEVER_EMPTY, intervalMs: 1_000 });
    expect(() => jest.advanceTimersByTime(1_000)).not.toThrow();
    sock.close(1000, 'bye');
  });

  it('pings well inside Hocuspocus\'s default 60 s idle timeout', () => {
    expect(COLLAB_PING_INTERVAL_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('#790 the stall check: a socket that stops reading is closed, a slow one is not', () => {
  afterEach(() => jest.useRealTimers());
  const MiB = 1024 * 1024;
  const run = () => {
    jest.useFakeTimers();
    const sock = new PongingSocket(); // answers every ping: a pong proves nothing about reading
    const warn = jest.fn();
    keepCollabSocketAlive(sock, () => undefined, { ...NEVER_EMPTY, intervalMs: 1_000, limitLog: new SocketLimitLog({ warn }) });
    return { sock, warn };
  };

  it(`terminates (and logs) a socket whose non-empty buffer has not gone down for ${COLLAB_STALL_INTERVALS} intervals in a row`, () => {
    const { sock, warn } = run();
    sock.bufferedAmount = 6 * MiB; // owed a SyncStep2 it never reads
    jest.advanceTimersByTime(1_000); // first sample
    sock.bufferedAmount += 2; // the ping it could not read either
    jest.advanceTimersByTime(1_000);
    expect(sock.terminated).toBe(false);
    sock.bufferedAmount += 2;
    jest.advanceTimersByTime(1_000);
    expect(sock.terminated).toBe(true);
    expect(warn.mock.calls).toEqual([[`COLLAB_SOCKET_LIMIT {"limit":"outbound_stalled","bufferedBytes":${6 * MiB + 4},"stalledMs":2000}`]]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a slow client that drains anything between two ticks is never closed, even with broadcasts arriving', () => {
    const { sock, warn } = run();
    sock.bufferedAmount = 8 * MiB;
    for (let tick = 0; tick < 60; tick++) {
      jest.advanceTimersByTime(1_000);
      sock.bufferedAmount = Math.max(1, sock.bufferedAmount - 100 * 1024 + 4 * 1024); // reads 100 KiB a tick, owed 4 KiB more
    }
    expect(sock.terminated).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('progress resets the count: one stalled interval, a drain, one more stalled interval is not a stall', () => {
    const { sock } = run();
    sock.bufferedAmount = 1000;
    jest.advanceTimersByTime(1_000);
    sock.bufferedAmount = 1000; // stalled once
    jest.advanceTimersByTime(1_000);
    sock.bufferedAmount = 900; // read something
    jest.advanceTimersByTime(1_000);
    sock.bufferedAmount = 900; // stalled once again
    jest.advanceTimersByTime(1_000);
    expect(sock.terminated).toBe(false);
  });

  it('an empty buffer is never a stall (an idle, healthy editor)', () => {
    const { sock } = run();
    jest.advanceTimersByTime(100_000);
    expect(sock.terminated).toBe(false);
    expect(sock.pings).toBe(100);
  });
});

describe('#790 CollabSocketDocuments', () => {
  const conn = (webSocket: object, present = true) => {
    const closers: Array<() => void> = [];
    return {
      c: { webSocket, document: { hasConnection: () => present }, onClose: (cb: () => void) => closers.push(cb) },
      close: () => closers.forEach((cb) => cb()),
    };
  };

  it('a socket that never held a document is not "empty"; one that held and closed every document is', () => {
    const docs = new CollabSocketDocuments();
    const ws = {};
    expect(docs.holdsNoDocument(ws)).toBe(false); // never authenticated: Hocuspocus's own pre-auth deadline applies
    const a = conn(ws);
    const b = conn(ws);
    docs.track(a.c);
    docs.track(b.c);
    expect(docs.holdsNoDocument(ws)).toBe(false);
    a.close();
    expect(docs.holdsNoDocument(ws)).toBe(false);
    b.close();
    b.close(); // a second close never goes below zero
    expect(docs.holdsNoDocument(ws)).toBe(true);
    docs.track(conn(ws).c); // a new document on the same socket
    expect(docs.holdsNoDocument(ws)).toBe(false);
  });

  it('keys by the raw ws socket under the gateway\'s BoundedCollabSocket; a connection already closed counts as held then closed', () => {
    const docs = new CollabSocketDocuments();
    const raw = new FakeSocket();
    const bounded = new BoundedCollabSocket(raw, raw as never, { preAuth: new CollabPreAuthSlots(), bytes: new CollabSocketBytes() });
    docs.track(conn(bounded, false).c);
    expect(docs.holdsNoDocument(raw)).toBe(true);
    expect(docs.holdsNoDocument(bounded)).toBe(false);
    docs.track(undefined); // never throws on a payload without a connection
    docs.track({});
  });
});

describe('#790 the empty-socket reaper', () => {
  afterEach(() => jest.useRealTimers());

  it(`terminates (and logs) a socket that held a document and held none for ${COLLAB_EMPTY_INTERVALS} ticks in a row`, () => {
    jest.useFakeTimers();
    const sock = new PongingSocket();
    const warn = jest.fn();
    let empty = false;
    keepCollabSocketAlive(sock, () => undefined, { intervalMs: 1_000, limitLog: new SocketLimitLog({ warn }), holdsNoDocument: () => empty });
    jest.advanceTimersByTime(10_000);
    expect(sock.terminated).toBe(false);
    empty = true;
    jest.advanceTimersByTime(1_000);
    empty = false; // it opened a document again: the count restarts
    jest.advanceTimersByTime(1_000);
    empty = true;
    jest.advanceTimersByTime(1_000);
    expect(sock.terminated).toBe(false);
    jest.advanceTimersByTime(1_000);
    expect(sock.terminated).toBe(true);
    expect(warn.mock.calls).toEqual([['COLLAB_SOCKET_LIMIT {"limit":"socket_empty","emptyMs":2000}']]);
    expect(jest.getTimerCount()).toBe(0);
  });
});

// Margins: Hocuspocus checks every `timeout` and reaps past it, so a reaped socket is closed within 2 x TIMEOUT; a
// kept-alive one is touched every 25 ms. #810 T5: on jest's fake clock (Hocuspocus 4.7.1's ClientConnection reads only
// setInterval and Date.now; the pong answers through setImmediate), so no runner stall can move a margin. nextTick and
// queueMicrotask stay real: Hocuspocus's hooks are promise chains, and `advanceTimersByTimeAsync` lets them settle
// between timers.
const TIMEOUT = 400;
const fakeClock = () => jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);
describe('through a real Hocuspocus 4.7.1 (timeout shortened to 400 ms)', () => {
  const open: Hocuspocus[] = [];
  const sockets: FakeSocket[] = [];
  beforeEach(fakeClock); // before `new Hocuspocus` and `connect`, so ClientConnection's interval and clock are fake
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close(1000, 'test over');
    for (const hp of open.splice(0)) hp.closeConnections();
    await advance(5);
    jest.useRealTimers();
  });
  const server = () => {
    const hp = new Hocuspocus({
      quiet: true,
      timeout: TIMEOUT,
      extensions: [{ async onAuthenticate(d: { token: string }) { if (d.token !== 'ok') throw new Error('denied'); return { user: { id: 'u' } }; } }],
    } as never);
    open.push(hp);
    return hp;
  };
  const socket = (hp: Hocuspocus, keepAlive: boolean) => {
    const sock = new PongingSocket();
    sockets.push(sock);
    const clientConnection = sock.connect(hp);
    if (keepAlive) keepCollabSocketAlive(sock, () => clientConnection.touch(), { ...NEVER_EMPTY, intervalMs: 25 });
    return sock;
  };

  it('control: an authenticated socket that sends nothing is reaped at the idle timeout', async () => {
    const hp = server();
    const sock = socket(hp, false);
    sock.deliver(authFrame('ok'));
    await advance(2.5 * TIMEOUT);
    expect(sock.closed?.code).toBe(CONNECTION_TIMEOUT);
  });

  it('with the keepalive, the same quiet socket stays connected', async () => {
    const hp = server();
    const sock = socket(hp, true);
    sock.deliver(authFrame('ok'));
    await advance(2.5 * TIMEOUT);
    expect(sock.closed).toBeNull();
    expect(sock.pings).toBeGreaterThan(5);
  });

  it('pongs never extend an unauthenticated socket\'s deadline', async () => {
    const hp = server();
    const sock = socket(hp, true); // never authenticates
    await advance(2.5 * TIMEOUT);
    expect(sock.pings).toBeGreaterThan(0);
    expect(sock.closed?.code).toBe(CONNECTION_TIMEOUT);
  });

  it('a socket that stops answering pings is reaped', async () => {
    const hp = server();
    const sock = socket(hp, true);
    sock.deliver(authFrame('ok'));
    await advance(TIMEOUT / 2);
    expect(sock.closed).toBeNull();
    sock.answer = false;
    await advance(2.5 * TIMEOUT);
    expect(sock.closed?.code).toBe(CONNECTION_TIMEOUT);
  });
});

describe('#790 through a real Hocuspocus 4.7.1: a socket left holding no document is reaped', () => {
  const open: Hocuspocus[] = [];
  const sockets: FakeSocket[] = [];
  beforeEach(fakeClock); // before `new Hocuspocus` and `connect`, so ClientConnection's interval and clock are fake
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close(1000, 'test over');
    for (const hp of open.splice(0)) hp.closeConnections();
    await advance(5);
    jest.useRealTimers();
  });
  const run = (reap: boolean) => {
    const docs = new CollabSocketDocuments();
    const hp = new Hocuspocus({
      quiet: true,
      timeout: TIMEOUT,
      extensions: [
        new CollabUserConnectionsExtension(new CollabUserConnections({ cap: 32, limitLog: new SocketLimitLog({ warn: () => undefined }) }), docs),
        { async onAuthenticate() { return { user: { id: 'u' } }; } },
      ],
    } as never);
    open.push(hp);
    const sock = new PongingSocket();
    sockets.push(sock);
    const clientConnection = sock.connect(hp);
    const holdsNoDocument = reap ? (ws: object) => docs.holdsNoDocument(ws) : () => false;
    keepCollabSocketAlive(sock, () => clientConnection.touch(), { intervalMs: 25, limitLog: new SocketLimitLog({ warn: () => undefined }), holdsNoDocument });
    sock.deliver(authFrame('ok'));
    const closeDocuments = () => {
      for (const doc of hp.documents.values()) for (const conn of doc.getConnections()) conn.close({ code: 4403, reason: 'access-revoked' });
    };
    return { sock, closeDocuments };
  };

  it('control: after a document-level close, pongs keep the empty socket open past the idle timeout', async () => {
    const { sock, closeDocuments } = run(false);
    await advance(50);
    closeDocuments();
    await advance(2.5 * TIMEOUT);
    expect(sock.closeReasons()).toEqual(['access-revoked']);
    expect(sock.closed).toBeNull();
  });

  it('with the reaper, the same socket is terminated within two ticks; a socket still holding its document is not', async () => {
    const { sock, closeDocuments } = run(true);
    const kept = run(true);
    await advance(50);
    expect(sock.closed).toBeNull();
    closeDocuments(); // closes the documents of `sock`'s server only
    await advance(150);
    expect(sock.terminated).toBe(true);
    await advance(2.5 * TIMEOUT);
    expect(kept.sock.closed).toBeNull();
  });
});

describe('wiring', () => {
  // The gateway starts the keepalive on both paths through CollabSocketBounds.open: socket-bounds.fitness.spec.ts pins it.
  it('RedisSync refreshes a proxied socket through touch() only, never the private pre-auth reference', () => {
    const text = readFileSync(join(SRC, 'collaboration/extensions/redis-sync/redis-sync.extension.ts'), 'utf8');
    const code = text.replace(/\/\/.*$/gm, ''); // comments may name it; code may not
    expect(code).not.toMatch(/connectionEstablishedAt/);
    expect(code).not.toMatch(/lastMessageReceivedAt\s*=/);
    expect(code).toMatch(/clientConnection\.touch\(\)/);
  });
});
