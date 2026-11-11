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
import { join } from 'node:path';
import * as encoding from 'lib0/encoding';
import { Logger } from '@nestjs/common';
import { Hocuspocus } from '@hocuspocus/server';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { BoundedCollabSocket } from './bounded-socket';
import { COLLAB_AUTH_FRAMES_PER_SOCKET, COLLAB_DOCUMENTS_PER_SOCKET, COLLAB_HOCUSPOCUS_OPTIONS } from './limits';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
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

const gateway = (withRedis: boolean) =>
  new CollaborationGateway(
    {} as never,
    {} as never,
    {} as never,
    { getRedisUrl: () => 'redis://localhost:6379', isCollabDisableRedis: () => !withRedis } as never,
    { getHandlers: jest.fn(() => ({})) } as never,
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
    gateway(false);
    const extensions = (Hocuspocus as unknown as jest.Mock).mock.calls[0][0].extensions as unknown[];
    expect(extensions[0]).toBeInstanceOf(CollabUpdateGuardExtension);
    expect(extensions[1]).toBeInstanceOf(CollabUserConnectionsExtension);
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
