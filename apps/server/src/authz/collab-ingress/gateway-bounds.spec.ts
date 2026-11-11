// Drive the REAL gateway's handleConnection with Hocuspocus and RedisSync stubbed (as collaboration-gateway-redis.spec.ts
// does), so both connection paths are exercised exactly as wired.
const hpConnections: Array<{ socket: unknown; handleMessage: jest.Mock }> = [];
jest.mock('@hocuspocus/server', () => ({
  MessageType: jest.requireActual('@hocuspocus/server').MessageType, // the real wire constants (frame-admission, bounded-socket)
  Hocuspocus: jest.fn().mockImplementation(() => ({
    configuration: { extensions: [] as unknown[] },
    handleConnection: (socket: unknown) => {
      const c = { socket, handleMessage: jest.fn(), handleClose: jest.fn(), touch: jest.fn() };
      hpConnections.push(c);
      return c;
    },
  })),
}));

const redis = {
  onSocketOpen: jest.fn((..._a: unknown[]) => ({ touch: jest.fn() })),
  onSocketMessage: jest.fn(),
  onSocketClose: jest.fn(),
};
jest.mock('../../collaboration/extensions/redis-sync', () => ({
  RedisSyncExtension: jest.fn().mockImplementation(() => ({
    onConfigure: jest.fn(),
    onSocketOpen: (...a: unknown[]) => redis.onSocketOpen(...a),
    onSocketMessage: (...a: unknown[]) => redis.onSocketMessage(...a),
    onSocketClose: (...a: unknown[]) => redis.onSocketClose(...a),
  })),
}));
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({})) }));
jest.mock('msgpackr', () => ({ pack: jest.fn(), unpack: jest.fn() }));
jest.mock('nanoid', () => ({ nanoid: () => 'test', customAlphabet: () => () => 'test' }));
jest.mock('../../common/helpers', () => ({
  createRetryStrategy: jest.fn(),
  parseRedisUrl: jest.fn(() => ({ host: 'h', port: 6379, password: '', db: 0 })),
}));

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import { Logger, Scope, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Hocuspocus } from '@hocuspocus/server';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { CollabWsAdapter } from '../../collaboration/adapter/collab-ws.adapter';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { CollaborationHandler } from '../../collaboration/collaboration.handler';
import { AuthenticationExtension } from '../../collaboration/extensions/authentication.extension';
import { LoggerExtension } from '../../collaboration/extensions/logger.extension';
import { PersistenceExtension } from '../../collaboration/extensions/persistence.extension';
import { TokenService } from '../../core/auth/services/token.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { COLLAB_USER_CONNECTIONS_REASON } from './auth-refusal';
import { BoundedCollabSocket } from './bounded-socket';
import { COLLAB_AUTH_FRAMES_PER_SOCKET, COLLAB_CONNECTIONS_PER_USER, COLLAB_DOCUMENTS_PER_SOCKET, COLLAB_HOCUSPOCUS_OPTIONS } from './limits';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { CollabSocketBounds, collabSocketBoundsProvider } from './socket-bounds';
import { CollabSocketDocuments } from './socket-documents';
import { SocketLimitLog } from './socket-limit-log';
import { CollabUserConnectionsExtension } from './user-connections';

/**
 * #790 wiring: on BOTH gateway paths every inbound frame passes the `page.<uuid>` address check before RedisSync or
 * Hocuspocus sees it, Hocuspocus writes through the outbound-bounded socket, Hocuspocus gets the CCC options, and the
 * RedisSync socket id is a server-made UUID, never the client's `sec-websocket-key`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLIENT_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

class FakeWs extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  terminate = jest.fn(() => {
    this.readyState = 2;
  });
  send(m: unknown) {
    this.sent.push(m);
  }
  close() {
    this.readyState = 2;
  }
  ping() {}
}
const frame = (name: string): Buffer => {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, name);
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint8Array(e, new Uint8Array([0]));
  return Buffer.from(encoding.toUint8Array(e));
};
const PAGE = frame('page.01890a5d-ac96-774b-bcce-b302099a8057');
const pageN = (n: number) => frame(`page.${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000790`);
const authN = (n: number) => {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, `page.${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000790`);
  encoding.writeVarUint(e, 2); // Auth
  encoding.writeVarUint(e, 0);
  encoding.writeVarString(e, 'token');
  return Buffer.from(encoding.toUint8Array(e));
};
const JUNK = frame('collabLock:anything');

const gateway = (withRedis: boolean, bounds: CollabSocketBounds = new CollabSocketBounds()) =>
  new CollaborationGateway(
    {} as never,
    {} as never,
    {} as never,
    { getRedisUrl: () => 'redis://localhost:6379', isCollabDisableRedis: () => !withRedis } as never,
    { getHandlers: jest.fn(() => ({})) } as never,
    bounds,
  );
const request = () => ({ method: 'GET', url: '/collab', headers: { 'sec-websocket-key': CLIENT_KEY }, socket: { remoteAddress: '10.0.0.1' } }) as never;

beforeEach(() => {
  hpConnections.length = 0;
  for (const f of Object.values(redis)) f.mockClear();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('#790 gateway bounds: the RedisSync path', () => {
  it('opens with the bounded socket and a server-made socket id, unique per socket', () => {
    const gw = gateway(true);
    const a = new FakeWs();
    const b = new FakeWs();
    gw.handleConnection(a as never, request());
    gw.handleConnection(b as never, request());
    const [[sockA, reqA], [, reqB]] = redis.onSocketOpen.mock.calls as Array<[unknown, { headers: Record<string, string> }]>;
    expect(sockA).toBeInstanceOf(BoundedCollabSocket);
    const idA = reqA.headers['sec-websocket-key'];
    const idB = reqB.headers['sec-websocket-key'];
    expect(idA).toMatch(UUID);
    expect(idA).not.toBe(CLIENT_KEY);
    expect(idB).not.toBe(idA); // the same client key on two sockets no longer names one connection
    a.emit('close', 1000, Buffer.from(''));
    expect(redis.onSocketClose.mock.calls[0][0]).toBe(idA); // close uses the id the socket opened with
  });

  it('forwards a page frame with the request the socket opened with', () => {
    const gw = gateway(true);
    const ws = new FakeWs();
    gw.handleConnection(ws as never, request());
    ws.emit('message', PAGE);
    expect(redis.onSocketMessage).toHaveBeenCalledTimes(1);
    expect(redis.onSocketMessage.mock.calls[0][0]).toBe(redis.onSocketOpen.mock.calls[0][1]);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('terminates on a junk-named frame, which never reaches RedisSync (so never a Redis key)', () => {
    const gw = gateway(true);
    const ws = new FakeWs();
    gw.handleConnection(ws as never, request());
    ws.emit('message', JUNK);
    ws.emit('message', PAGE); // already parsed behind it: dropped
    expect(redis.onSocketMessage).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it(`a flood of fresh page names reaches RedisSync (a Redis SET NX each) only ${COLLAB_DOCUMENTS_PER_SOCKET} times`, () => {
    const gw = gateway(true);
    const ws = new FakeWs();
    gw.handleConnection(ws as never, request());
    for (let i = 0; i < 1500; i++) ws.emit('message', pageN(i));
    expect(redis.onSocketMessage).toHaveBeenCalledTimes(COLLAB_DOCUMENTS_PER_SOCKET);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it(`Auth frames past ${COLLAB_AUTH_FRAMES_PER_SOCKET} on one socket never reach RedisSync`, () => {
    const gw = gateway(true);
    const ws = new FakeWs();
    gw.handleConnection(ws as never, request());
    for (let i = 0; i < 100; i++) ws.emit('message', authN(1));
    expect(redis.onSocketMessage).toHaveBeenCalledTimes(COLLAB_AUTH_FRAMES_PER_SOCKET);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it('a non-reading socket is cut off through the bounded socket RedisSync was given', () => {
    const gw = gateway(true);
    const ws = new FakeWs();
    gw.handleConnection(ws as never, request());
    const sock = redis.onSocketOpen.mock.calls[0][0] as BoundedCollabSocket;
    ws.bufferedAmount = 64 * 1024 * 1024;
    sock.send(new Uint8Array(10));
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.sent).toEqual([]);
  });
});

describe('#790 gateway bounds: the standalone path', () => {
  it('Hocuspocus writes through the bounded socket', () => {
    gateway(false).handleConnection(new FakeWs() as never, request());
    expect(hpConnections[0].socket).toBeInstanceOf(BoundedCollabSocket);
  });

  it(`a flood of fresh page names reaches Hocuspocus only ${COLLAB_DOCUMENTS_PER_SOCKET} times`, () => {
    const gw = gateway(false);
    const ws = new FakeWs();
    gw.handleConnection(ws as never, request());
    for (let i = 0; i < 100; i++) ws.emit('message', pageN(i));
    expect(hpConnections[0].handleMessage).toHaveBeenCalledTimes(COLLAB_DOCUMENTS_PER_SOCKET);
  });

  it('forwards a page frame and terminates on a junk-named one', () => {
    const gw = gateway(false);
    const ok = new FakeWs();
    gw.handleConnection(ok as never, request());
    ok.emit('message', PAGE);
    expect(hpConnections[0].handleMessage).toHaveBeenCalledTimes(1);

    const bad = new FakeWs();
    gw.handleConnection(bad as never, request());
    bad.emit('message', JUNK);
    expect(hpConnections[1].handleMessage).not.toHaveBeenCalled();
    expect(bad.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('#790 gateway bounds: configuration and source', () => {
  it('constructs Hocuspocus with the CCC options', () => {
    (Hocuspocus as unknown as jest.Mock).mockClear();
    gateway(true);
    expect((Hocuspocus as unknown as jest.Mock).mock.calls[0][0]).toMatchObject(COLLAB_HOCUSPOCUS_OPTIONS);
  });

  it('registers the per-user connection cap right after the update guard, ranked below it and above RedisSync', () => {
    (Hocuspocus as unknown as jest.Mock).mockClear();
    const bounds = new CollabSocketBounds();
    gateway(false, bounds);
    const extensions = (Hocuspocus as unknown as jest.Mock).mock.calls[0][0].extensions as unknown[];
    expect(extensions[0]).toBeInstanceOf(CollabUpdateGuardExtension);
    expect(extensions[1]).toBeInstanceOf(CollabUserConnectionsExtension);
    expect(extensions[1]).toBe(bounds.userConnectionsExtension); // the bounds' own registries, never a second set
    const ext = extensions[1] as CollabUserConnectionsExtension;
    expect(ext.priority).toBeLessThan(new CollabUpdateGuardExtension().priority);
    expect(ext.priority).toBeGreaterThan(1000);
  });

  it("the collab module logs a client's ws errors only through the rate-limited COLLAB_SOCKET_LIMIT logger", () => {
    const text = readFileSync(join(__dirname, '..', '..', 'collaboration', 'collaboration.module.ts'), 'utf8');
    const code = text.replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/client\.on\('error',\s*\(error\)\s*=>\s*logCollabSocketError\(error\)\)/);
    expect(code).not.toMatch(/WebSocket client error/);
  });

  it('no gateway or RedisSync source reads the client request’s sec-websocket-key', () => {
    const src = join(__dirname, '..', '..', 'collaboration');
    const files = ['collaboration.gateway.ts', 'extensions/redis-sync/redis-sync.extension.ts'];
    const clientRead = /\brequest\.headers\s*\[\s*['"]sec-websocket-key['"]\s*\]/;
    for (const f of files) expect([f, clientRead.test(readFileSync(join(src, f), 'utf8'))]).toEqual([f, false]);
    // anti-vacuity: the pattern catches the upstream line
    expect(clientRead.test("'sec-websocket-key': request.headers['sec-websocket-key'] ?? '',")).toBe(true);
  });
});

describe('#810 the empty-socket reaper, through the gateway on both paths', () => {
  afterEach(() => jest.useRealTimers());
  const PING_MS = 1000;
  /**
   * Open one socket through the gateway, then have the `connected` hook the gateway registered (or, for the anti-vacuity
   * arm, one on another registry) see a document connection on the bounded socket the gateway handed on.
   */
  const open = (withRedis: boolean, otherRegistry = false) => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const bounds = new CollabSocketBounds({ pingIntervalMs: PING_MS, limitLog: new SocketLimitLog({ warn }) });
    (Hocuspocus as unknown as jest.Mock).mockClear();
    const gw = gateway(withRedis, bounds);
    const registered = (Hocuspocus as unknown as jest.Mock).mock.calls[0][0].extensions[1] as CollabUserConnectionsExtension;
    const hook = otherRegistry ? new CollabUserConnectionsExtension(bounds.connections, new CollabSocketDocuments()) : registered;
    const ws = new FakeWs();
    gw.handleConnection(ws as never, request());
    const bounded = (withRedis ? redis.onSocketOpen.mock.calls[0][0] : hpConnections[0].socket) as BoundedCollabSocket;
    expect(bounded).toBeInstanceOf(BoundedCollabSocket);
    let closeDocument: () => void = () => undefined;
    void hook.connected({
      connection: { webSocket: bounded, document: { hasConnection: () => true }, onClose: (cb: () => void) => (closeDocument = cb), close: jest.fn() },
    } as never);
    return { ws, warn, closeDocument: () => closeDocument() };
  };

  describe.each([
    ['RedisSync', true],
    ['standalone', false],
  ] as const)('%s path', (_path, withRedis) => {
    it('a socket left holding no document is terminated within two ticks, and logged', () => {
      const { ws, warn, closeDocument } = open(withRedis);
      jest.advanceTimersByTime(3 * PING_MS);
      expect(ws.terminate).not.toHaveBeenCalled();
      closeDocument(); // a revalidator or refusal close: the document connection leaves, the websocket stays
      jest.advanceTimersByTime(2 * PING_MS);
      expect(ws.terminate).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.map((c) => c[0])).toContain(`COLLAB_SOCKET_LIMIT {"limit":"socket_empty","emptyMs":${2 * PING_MS}}`);
    });

    it('control: a socket still holding its document is kept', () => {
      const { ws } = open(withRedis);
      jest.advanceTimersByTime(10 * PING_MS);
      expect(ws.terminate).not.toHaveBeenCalled();
    });

    it('anti-vacuity: a hook on another registry than the keepalive reads never reaps (what one object prevents)', () => {
      const { ws, closeDocument } = open(withRedis, true);
      closeDocument();
      jest.advanceTimersByTime(10 * PING_MS);
      expect(ws.terminate).not.toHaveBeenCalled();
    });
  });
});

describe('#810 one CollabSocketBounds per process: the Nest provider, injected at the seams', () => {
  const PAGE_NAME = 'page.00000000-0000-4000-8000-000000000810';
  /** Build the gateway and the auth extension through Nest, with `provider` for the bounds and stubs for the rest. */
  const build = async (provider: typeof collabSocketBoundsProvider) => {
    (Hocuspocus as unknown as jest.Mock).mockClear();
    const userRepo = { findById: jest.fn(async () => undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        provider,
        AuthenticationExtension,
        CollaborationGateway,
        { provide: TokenService, useValue: { verifyJwt: async (t: string) => ({ sub: t, workspaceId: 'w1', sessionId: 's1' }) } },
        { provide: UserRepo, useValue: userRepo },
        { provide: PageRepo, useValue: {} },
        { provide: SpaceMemberRepo, useValue: {} },
        { provide: PagePermissionRepo, useValue: {} },
        { provide: UserSessionRepo, useValue: {} },
        { provide: PersistenceExtension, useValue: {} },
        { provide: LoggerExtension, useValue: {} },
        { provide: EnvironmentService, useValue: { getRedisUrl: () => 'redis://localhost:6379', isCollabDisableRedis: () => true } },
        { provide: CollaborationHandler, useValue: { getHandlers: () => ({}) } },
      ],
    }).compile();
    const calls = (Hocuspocus as unknown as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1); // one gateway
    const registered = calls[0][0].extensions[1] as CollabUserConnectionsExtension;
    return { moduleRef, userRepo, registered };
  };
  /** Fill one user's cap through the gateway's registered `connected` hook, then authenticate that user once more. */
  const fillThenAuthenticate = async (provider: typeof collabSocketBoundsProvider) => {
    const { moduleRef, userRepo, registered } = await build(provider);
    const user = 'u-810';
    for (let i = 0; i < COLLAB_CONNECTIONS_PER_USER; i++) {
      await registered.connected({ socketId: `s${i}`, documentName: PAGE_NAME, context: { user: { id: user } }, connection: { close: jest.fn() } } as never);
    }
    const refused = await moduleRef
      .get(AuthenticationExtension)
      .onAuthenticate({ documentName: PAGE_NAME, token: user, socketId: 'new', connectionConfig: { readOnly: false } } as never)
      .catch((e: unknown) => e);
    return { moduleRef, userRepo, registered, refused };
  };

  it("the auth extension's early check reads the registry the gateway's extension fills: refused before any read", async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { moduleRef, userRepo, registered, refused } = await fillThenAuthenticate(collabSocketBoundsProvider);
    expect(refused).toEqual({ reason: COLLAB_USER_CONNECTIONS_REASON });
    expect(userRepo.findById).not.toHaveBeenCalled();
    expect(registered).toBe(moduleRef.get(CollabSocketBounds).userConnectionsExtension);
  });

  it('anti-vacuity: a TRANSIENT provider (one instance per injection) splits the registries, and the read runs', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { userRepo, refused } = await fillThenAuthenticate({ ...collabSocketBoundsProvider, scope: Scope.TRANSIENT });
    expect(refused).toBeInstanceOf(UnauthorizedException); // no such user: the connect reached its first read
    expect(userRepo.findById).toHaveBeenCalledTimes(1);
  });
});

describe('#810 as assembled: the ws adapter takes the slot the gateway-built socket releases', () => {
  const { OutgoingMessage } = jest.requireActual<typeof import('@hocuspocus/server')>('@hocuspocus/server');

  /** A real adapter on `adapterBounds` and the gateway (standalone, Hocuspocus stubbed) on `gatewayBounds`. */
  const run = async (adapterBounds: CollabSocketBounds, gatewayBounds: CollabSocketBounds) => {
    const http = createServer();
    const adapter = new CollabWsAdapter(adapterBounds);
    const wss = adapter.handleUpgrade('/collab', http);
    const gw = gateway(false, gatewayBounds);
    wss.on('connection', (ws, req) => gw.handleConnection(ws as never, req));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    const client = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/collab`);
    client.on('error', () => undefined);
    await new Promise((r) => client.once('open', r));
    while (hpConnections.length === 0) await new Promise((r) => setTimeout(r, 5));
    const held = adapterBounds.preAuth.size;
    (hpConnections[0].socket as BoundedCollabSocket).send(new OutgoingMessage('page.x').writeAuthenticated(false).toUint8Array());
    const afterAuthenticated = adapterBounds.preAuth.size;
    const closed = new Promise((r) => client.once('close', r));
    client.terminate();
    await closed;
    await new Promise((r) => setTimeout(r, 20));
    const afterClose = adapterBounds.preAuth.size;
    adapter.destroy();
    await new Promise((r) => http.close(r));
    return { held, afterAuthenticated, afterClose };
  };

  it('one bounds: the upgrade holds a slot and the first Authenticated reply frees it', async () => {
    const bounds = new CollabSocketBounds();
    expect(await run(bounds, bounds)).toEqual({ held: 1, afterAuthenticated: 0, afterClose: 0 });
  });

  it('anti-vacuity: adapter and gateway on different bounds never free the slot while the socket lives', async () => {
    expect(await run(new CollabSocketBounds(), new CollabSocketBounds())).toEqual({ held: 1, afterAuthenticated: 1, afterClose: 0 });
  });

  it("verifyUpgrade keeps ws's two-argument (callback) form", () => {
    expect(new CollabSocketBounds().verifyUpgrade.length).toBe(2);
  });
});

describe('#810 (N1) the first Auth frame moves the slot deadline, on both gateway paths', () => {
  it.each([
    ['RedisSync', true],
    ['standalone', false],
  ] as const)('%s: the first Auth reaches preAuth.authArrived with the client socket, before it is forwarded', (_path, withRedis) => {
    const bounds = new CollabSocketBounds();
    const arrived = jest.spyOn(bounds.preAuth, 'authArrived');
    const forwarded = withRedis ? redis.onSocketMessage : null;
    const ws = new FakeWs();
    gateway(withRedis, bounds).handleConnection(ws as never, request());
    ws.emit('message', pageN(1)); // a Sync frame on the same document: not an Auth
    expect(arrived).not.toHaveBeenCalled();
    const forwardedBefore = withRedis ? forwarded!.mock.calls.length : hpConnections[0].handleMessage.mock.calls.length;
    ws.emit('message', authN(1));
    expect(arrived.mock.calls).toEqual([[ws]]);
    const forwardedAfter = withRedis ? forwarded!.mock.calls.length : hpConnections[0].handleMessage.mock.calls.length;
    expect(forwardedAfter).toBe(forwardedBefore + 1);
  });
});
