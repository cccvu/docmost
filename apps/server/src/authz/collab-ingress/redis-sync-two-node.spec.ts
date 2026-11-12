// Two real gateways (each a real Hocuspocus 4.7.1 + RedisSync, with the CCC extensions and bounds) on one in-memory
// Redis bus (redis-bus.testkit.ts).
import { FakeRedisBus, turn } from './redis-bus.testkit';

const mockBus: { current: FakeRedisBus | null } = { current: null };
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    if (!mockBus.current) throw new Error('no FakeRedisBus for this test');
    return mockBus.current.client();
  }),
}));
let mockNanoid = 0;
jest.mock('nanoid', () => ({ nanoid: () => `n${++mockNanoid}`, customAlphabet: () => () => 'x' }));
jest.mock('../../common/helpers', () => ({
  createRetryStrategy: jest.fn(),
  parseRedisUrl: jest.fn(() => ({ host: 'h', port: 6379, password: '', db: 0 })),
}));

import * as Y from 'yjs';
import { pack, unpack } from 'msgpackr';
import { Logger } from '@nestjs/common';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { authFrame, DOC_NAME, FakeSocket, MSG, readServerFrame, RemoteClient, step1Frame, syncFrame } from './collab-ingress.testkit';
import { authReplyOf } from './bounded-socket';
import { COLLAB_PREAUTH_DEADLINE_MS } from './limits';
import { CollabSocketBounds } from './socket-bounds';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { CollabProxySocket } from '../../collaboration/extensions/redis-sync/collab-proxy-socket';
import * as registry from '../page-write/compaction-registry';
import { SocketLimitLog } from './socket-limit-log';

/**
 * #810 T1 (and N3, the drain across nodes, F3): RedisSync between two collab nodes, which no spec ran before. CI boots no
 * Redis for the fork, so the bus is an in-memory model of the eight commands RedisSync uses (redis-bus.testkit.ts); the
 * live compose run uses real Redis 8. jest's fake clock, so the lock TTL, the 30 s custom-event TTL and Hocuspocus's 60 s
 * timeout are exact.
 *
 * Scenarios, each with its control or anti-vacuity arm:
 * - a socket on B for a document A owns authenticates through A, and edits travel both ways;
 * - closes are relayed: B's socket close ends A's proxied connection; A's document close reaches B's client;
 * - N3: the Authenticated reply relayed from A frees B's pre-auth slot (B's gateway hands RedisSync the bounded socket);
 *   a relayed PermissionDenied closes B's socket 4401;
 * - a custom event to an owner whose subscription is gone rejects TIMEOUT at 30 s and leaves no pending reply;
 * - the drain: during A's drain a B socket for A's document is closed 1013; after A unloads, B claims the lock and
 *   authenticates locally; no `collabLock:*` key is left once A's destroy resolves. The proxied reload case (a proxied
 *   Auth that completes after A's destroy resolved) leaves no lock either: see its case;
 * - F3, the owner's idle reap of a proxied connection: unreachable while the origin node's own ~60-120 s pre-auth cut
 *   (Hocuspocus's, on a socket that never authenticates there) always fires first; and when reached, the origin is told
 *   at the document level (a relayed CLOSE "Connection Timeout"), never by a socket close.
 */
type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
/** Run the timers due by `ms` from now, then let the bus deliveries (real-time immediates) and the hooks they start settle. */
const advance = async (ms = 0) => {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) {
    await turn();
    await jest.advanceTimersByTimeAsync(0);
  }
};
const paragraph = (t: string) => (f: Y.XmlFragment) => {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(t)]);
  f.insert(f.length, [p]);
};
const LOCK = `collabLock:${DOC_NAME}`;
const types = (s: FakeSocket) => s.sent.map(readServerFrame).map((f) => f.type);
const authReplies = (s: FakeSocket) => s.sent.map(authReplyOf).filter((r) => r !== null);

/** A socket whose pings are answered, like a browser's (the keepalive touches its connection). */
class PongingSocket extends FakeSocket {
  override ping(): void {
    setImmediate(() => this.emit('pong', Buffer.alloc(0)));
  }
}

function node(bus: FakeRedisBus, name: string) {
  const bounds = new CollabSocketBounds({ limitLog: new SocketLimitLog({ warn: () => undefined }), drainLog: { log: () => undefined } });
  const authHolds = new Map<string, Deferred>();
  const auth = {
    async onAuthenticate({ token }: { token: string }) {
      await authHolds.get(token)?.promise;
      if (token === 'deny') throw new Error('denied');
      return { user: { id: `u-${token}` } };
    },
  };
  const storeHolds: Deferred[] = [];
  let stores = 0;
  let loads = 0;
  const persistence = {
    extensionName: 'StubPersistence',
    async onLoadDocument() {
      loads++;
    },
    async onStoreDocument() {
      await storeHolds[stores++]?.promise;
    },
  };
  const gateway = new CollaborationGateway(
    auth as never,
    persistence as never,
    {} as never,
    { getRedisUrl: () => 'redis://h:6379', isCollabDisableRedis: () => false } as never,
    { getHandlers: () => ({ ping: async (_doc: string, payload: unknown) => ({ pong: payload, from: name }) }) } as never,
    bounds,
  );
  const internals = gateway as unknown as {
    hocuspocus: { documents: Map<string, Y.Doc>; getDocumentsCount(): number; getConnectionsCount(): number; closeConnections(): void };
    redisSync: { serverId: string; sub: { disconnect(): void }; pendingReplies: Record<number, unknown> };
  };
  const connect = (token: string, opts: { holdSlot?: boolean; sock?: FakeSocket } = {}) => {
    const sock = opts.sock ?? new FakeSocket();
    if (opts.holdSlot) bounds.preAuth.hold(sock as never); // what the ws adapter does at the upgrade (seam §226)
    gateway.handleConnection(sock as never, { method: 'GET', url: '/collab', headers: {}, socket: { remoteAddress: '10.0.0.1' } } as never);
    sock.deliver(authFrame(token));
    return sock;
  };
  let destroyed = false;
  const destroy = () =>
    gateway.destroy({ close: () => undefined } as never).then(() => {
      destroyed = true;
    });
  return {
    name,
    bounds,
    gateway,
    hp: internals.hocuspocus,
    sync: internals.redisSync,
    connect,
    authHolds,
    storeHolds,
    stores: () => stores,
    loads: () => loads,
    destroy,
    destroyed: () => destroyed,
  };
}

describe('#810 T1 RedisSync between two collab nodes', () => {
  let bus: FakeRedisBus;
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    bus = mockBus.current = new FakeRedisBus();
  });
  afterEach(() => {
    mockBus.current = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** A owns the document (a local editor on it); B's socket for it is proxied to A. */
  const owned = async () => {
    const a = node(bus, 'A');
    const b = node(bus, 'B');
    const editorA = a.connect('a', { sock: new PongingSocket() }); // a live browser: never idle-reaped
    await advance();
    expect(bus.read(LOCK)).toBe(a.sync.serverId);
    return { a, b, editorA };
  };

  it('a socket on B for a document A owns authenticates through A, and an edit travels both ways', async () => {
    const { a, b, editorA } = await owned();
    const sockB = b.connect('b');
    await advance();
    expect(authReplies(sockB)).toEqual(['authenticated']); // Authenticated, relayed from A
    expect(b.hp.getDocumentsCount()).toBe(0); // B never loaded it
    expect(a.hp.getConnectionsCount()).toBe(2); // the proxied connection is on A

    const clientB = new RemoteClient(a.hp.documents.get(DOC_NAME)!);
    sockB.deliver(syncFrame(clientB.edit(a.hp.documents.get(DOC_NAME)!, paragraph('from B'))));
    await advance();
    expect(a.hp.documents.get(DOC_NAME)!.getXmlFragment('default').toString()).toContain('from B');
    expect(types(editorA)).toContain(MSG.Sync); // broadcast to A's own editor

    const before = sockB.sent.length;
    editorA.deliver(syncFrame(new RemoteClient(a.hp.documents.get(DOC_NAME)!).edit(a.hp.documents.get(DOC_NAME)!, paragraph('from A'))));
    await advance();
    expect(sockB.sent.slice(before).map(readServerFrame).some((f) => f.type === MSG.Sync)).toBe(true); // relayed to B's client
  });

  it('#847: a frame proxied from B reaches A\'s live only through A\'s update guard, so a wedged live refuses it there (1013, never integrated)', async () => {
    const { a, b } = await owned();
    jest.spyOn(console, 'error').mockImplementation(() => undefined); // Hocuspocus logs the refusal it closes on
    const sockB = b.connect('b');
    await advance();
    const live = a.hp.documents.get(DOC_NAME)!;
    const ext = (a.hp as unknown as { configuration: { extensions: unknown[] } }).configuration.extensions.find(
      (e): e is CollabUpdateGuardExtension => e instanceof CollabUpdateGuardExtension,
    )!;
    const seen: Array<{ document: unknown; proxied: boolean; integrated: boolean }> = [];
    const check = ext.guard.check.bind(ext.guard);
    jest.spyOn(ext.guard, 'check').mockImplementation((frame) => {
      const proxied = (frame.connection as { webSocket?: unknown }).webSocket instanceof CollabProxySocket;
      seen.push({ document: frame.document, proxied, integrated: live.getXmlFragment('default').toString().includes('from B') });
      return check(frame);
    });
    // control: not wedged, the proxied edit is checked by A's guard first, then integrated
    sockB.deliver(syncFrame(new RemoteClient(live).edit(live, paragraph('from B'))));
    await advance();
    expect(live.getXmlFragment('default').toString()).toContain('from B');
    expect(seen.filter((x) => x.proxied)).toEqual([expect.objectContaining({ document: live, integrated: false })]);
    // wedged (the predicate the guard reads, as a wedge reads to it): A's guard refuses the proxied frame 1013
    const wedged = jest.spyOn(registry, 'liveWedged').mockImplementation((d) => d === live);
    try {
      sockB.deliver(syncFrame(new RemoteClient(live).edit(live, paragraph('after wedge'))));
      await advance();
    } finally {
      wedged.mockRestore();
    }
    expect(seen.filter((x) => x.proxied)).toHaveLength(2);
    expect(live.getXmlFragment('default').toString()).not.toContain('after wedge');
    expect(sockB.closed).toMatchObject({ code: 1013 }); // A's refusal (a try-later close) relayed to B's socket
  });

  it('anti-vacuity: with the bus delivering nothing, B\'s socket never gets an Authenticated reply', async () => {
    const { b } = await owned();
    bus.deliver = false;
    const sockB = b.connect('b');
    await advance();
    expect(authReplies(sockB)).toEqual([]);
  });

  it('closes are relayed both ways', async () => {
    const { a, b } = await owned();
    const sockB = b.connect('b');
    await advance();
    expect(a.hp.getConnectionsCount()).toBe(2);
    sockB.close(1000, 'tab closed'); // B's ws close -> closeProxy -> A ends the proxied connection
    await advance();
    expect(a.hp.getConnectionsCount()).toBe(1);

    const sockB2 = b.connect('b2');
    await advance();
    a.hp.closeConnections(); // A's document close (as a revalidator or the drain does) reaches B's client
    await advance();
    expect(sockB2.closeReasons()).toEqual(['Reset Connection']);
  });

  it('N3: the Authenticated reply relayed from A frees B\'s pre-auth slot, and nothing cuts the socket at the deadline', async () => {
    const { b } = await owned();
    const sockB = b.connect('b', { holdSlot: true });
    expect(b.bounds.preAuth.holds(sockB as never)).toBe(true);
    await advance();
    expect(b.bounds.preAuth.holds(sockB as never)).toBe(false);
    await advance(COLLAB_PREAUTH_DEADLINE_MS + 1_000);
    expect(sockB.closed).toBeNull();
    expect(sockB.terminated).toBe(false);
  });

  it('N3 control: a refused Auth relayed from A closes B\'s socket 4401, and a socket the reply never reaches is cut at the deadline', async () => {
    const { b } = await owned();
    jest.spyOn(console, 'error').mockImplementation(() => undefined); // Hocuspocus logs the refused onAuthenticate
    const denied = b.connect('deny', { holdSlot: true });
    await advance();
    expect(denied.closed).toEqual({ code: 4401, reason: 'permission-denied' });

    bus.deliver = false;
    const unanswered = b.connect('b', { holdSlot: true });
    await advance(COLLAB_PREAUTH_DEADLINE_MS + 1_000);
    expect(unanswered.terminated).toBe(true); // the slot the relayed reply frees in the case above
  });

  it('a custom event reaches the owner and back; to an owner whose subscription is gone it rejects TIMEOUT at 30 s', async () => {
    const { a, b } = await owned();
    await expect(b.gateway.handleYjsEvent('ping' as never, DOC_NAME, 1 as never)).resolves.toEqual({ pong: 1, from: 'A' });

    a.sync.sub.disconnect(); // the owner crashed: its lock lives on until the TTL
    let outcome: unknown = 'pending';
    b.gateway.handleYjsEvent('ping' as never, DOC_NAME, 2 as never)!.then(
      (v) => (outcome = v),
      (e: Error) => (outcome = e.message),
    );
    await advance(29_000);
    expect(outcome).toBe('pending');
    await advance(1_000);
    expect(outcome).toBe('TIMEOUT');
    expect(b.sync.pendingReplies).toEqual({});
  });

  it('the drain: a B socket for A\'s document is closed 1013 during A\'s drain; after A unloads B authenticates locally; no lock is left', async () => {
    const { a, b, editorA } = await owned();
    editorA.deliver(syncFrame(new RemoteClient(a.hp.documents.get(DOC_NAME)!).edit(a.hp.documents.get(DOC_NAME)!, paragraph('pending'))));
    await advance();
    a.storeHolds[0] = deferred();
    void a.destroy();
    await advance();
    expect(a.stores()).toBe(1); // the drain's store, held: the document is still resident on A, with A's lock

    const late = b.connect('late'); // the editor reconnects through B, which still sees A's lock
    await advance();
    expect(late.closed).toEqual({ code: 1013, reason: 'Try Again Later' }); // relayed from A's drain rule
    expect(late.closeReasons()).toEqual([]); // no document CLOSE (it would reopen at once)
    expect(a.hp.getConnectionsCount()).toBe(0);

    a.storeHolds[0].resolve();
    await advance();
    expect(a.destroyed()).toBe(true);
    expect(bus.keysMatching('collabLock:')).toEqual([]); // released before A disconnected
    expect(bus.dropped.filter(([c]) => c === 'del' || c === 'set')).toEqual([]);

    await advance();
    const next = b.connect('next');
    await advance();
    expect(authReplies(next)).toEqual(['authenticated']);
    expect(b.hp.getDocumentsCount()).toBe(1); // local on B now: the 'unload' broadcast cleared B's cached owner
    expect(bus.read(LOCK)).toBe(b.sync.serverId);
  });

  it('the proxied reload case: a proxied Auth that completes after A\'s destroy resolved re-loads the document but leaves no lock', async () => {
    const { a, b } = await owned();
    a.authHolds.set('late', deferred());
    const late = b.connect('late', { holdSlot: true }); // reaches A, whose onAuthenticate is still in flight
    await advance();
    expect(a.hp.getConnectionsCount()).toBe(1);

    void a.destroy(); // the local editor closes, nothing to store: A unloads and disconnects at once
    await advance();
    expect(a.destroyed()).toBe(true);
    expect(bus.keysMatching('collabLock:')).toEqual([]);

    expect(a.loads()).toBe(1);
    a.authHolds.get('late')!.resolve(); // ...then the late Auth completes on A: it re-loads the document
    await advance(10_000); // past a lock refresh
    expect(a.loads()).toBe(2); // it did re-load
    expect(a.hp.getDocumentsCount()).toBe(0); // the drain rule closed it, and it unloaded again
    // A's Redis clients are gone, so nothing it did reached Redis: no lock, and no reply or close for B's socket.
    expect(bus.keysMatching('collabLock:')).toEqual([]);
    expect(bus.dropped.map(([c]) => c)).toEqual(expect.arrayContaining(['publish']));
    // B's socket is left to its pre-auth deadline (the CCC slot, 10 s from the upgrade), then B's next one is local.
    expect(late.terminated).toBe(true);
    const next = b.connect('next');
    await advance();
    expect(authReplies(next)).toEqual(['authenticated']);
    expect(bus.read(LOCK)).toBe(b.sync.serverId);
  });

  describe('F3: the owner\'s idle reap of a proxied connection', () => {
    it('is unreachable: the origin node cuts its never-authenticated socket first, and A then ends the proxied connection', async () => {
      const { a, b } = await owned();
      const sockB = b.connect('b', { sock: new PongingSocket() }); // a live browser: pings answered
      await advance();
      expect(authReplies(sockB)).toEqual(['authenticated']);
      const publishedBefore = bus.published.length;
      await advance(130_000); // no frames from the client at all
      expect(sockB.closed?.code).toBe(4408); // B's Hocuspocus: the socket never authenticated on B (proxied frames only touch())
      expect(a.hp.getConnectionsCount()).toBe(1); // B's closeProxy ended it on A before A's own reap
      const relayedToB = bus.published.slice(publishedBefore).filter((m) => m.channel === `collabMsg:${b.sync.serverId}`);
      const closeFrames = relayedToB
        .map((m) => unpack(m.message) as { type: string; message?: Uint8Array })
        .filter((m) => m.type === 'send' && readServerFrame(new Uint8Array(m.message!)).type === MSG.Close);
      expect(closeFrames).toEqual([]); // A never reaped it
    });

    const ownerOnly = async (keepSending: boolean) => {
      const a = node(bus, 'A');
      const origin = bus.client(); // a stand-in origin node: only its reply channel
      const replies: Array<{ type: string; message?: Uint8Array; code?: number }> = [];
      await origin.subscribe('collabMsg:origin');
      origin.on('messageBuffer', (_c: Buffer, m: Buffer) => replies.push(unpack(m)));
      const proxy = (message: Uint8Array) =>
        origin.publish(
          `collabMsg:${a.sync.serverId}`,
          pack({
            type: 'proxy',
            replyTo: 'collabMsg:origin',
            message,
            serializedHTTPRequest: { method: 'GET', url: '/collab', headers: { 'sec-websocket-key': 'sock-f3', 'sec-websocket-protocol': '' }, socket: { remoteAddress: '' } },
          }),
        );
      await proxy(authFrame('f3'));
      await advance();
      expect(replies.map((r) => r.type)).toContain('send'); // Authenticated
      const before = replies.length;
      for (let t = 0; t < 130; t += 20) {
        if (keepSending) await proxy(step1Frame(new Y.Doc()));
        await advance(20_000);
      }
      return replies.slice(before);
    };
    const closeFrameReasons = (rs: Array<{ type: string; message?: Uint8Array }>) =>
      rs.filter((r) => r.type === 'send').map((r) => readServerFrame(new Uint8Array(r.message!))).filter((f) => f.type === MSG.Close).map((f) => f.reason);

    it('when reached, the origin is told at the document level (a relayed CLOSE "Connection Timeout"), never by a socket close', async () => {
      const after = await ownerOnly(false);
      expect(closeFrameReasons(after)).toEqual(['Connection Timeout']);
      expect(after.filter((r) => r.type === 'close')).toEqual([]); // the 4408 socket close is not relayed (redis-sync)
    });

    it('anti-vacuity: a connection that receives a frame inside every window is never reaped', async () => {
      const after = await ownerOnly(true);
      expect(closeFrameReasons(after)).toEqual([]);
      expect(after.filter((r) => r.type === 'close')).toEqual([]);
    });
  });
});
