// The REAL gateway, ws adapter and Hocuspocus 4.7.1 on real sockets. RedisSync runs for real too, over an in-memory
// Redis (the subset it uses: SET NX GET, GET, DEL, PUBLISH, SUBSCRIBE), so a document another node owns is relayed.
jest.mock('ioredis', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const store = new Map<string, string>();
  const clients = new Set<FakeRedis>();
  class FakeRedis extends EventEmitter {
    readonly channels = new Set<string>();
    constructor() {
      super();
      clients.add(this);
    }
    duplicate() {
      return new FakeRedis();
    }
    async subscribe(...channels: string[]) {
      for (const c of channels) this.channels.add(c);
      return channels.length;
    }
    async publish(channel: string, message: Uint8Array) {
      const to = [...clients].filter((c) => c.channels.has(channel));
      for (const c of to) setImmediate(() => c.emit('messageBuffer', Buffer.from(channel), Buffer.from(message)));
      return to.length;
    }
    async get(key: string) {
      return store.get(key) ?? null;
    }
    async set(key: string, value: string, ...args: unknown[]) {
      const previous = store.get(key) ?? null;
      if (!args.includes('NX') || previous === null) store.set(key, value);
      return args.includes('GET') ? previous : 'OK';
    }
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    }
    disconnect() {
      clients.delete(this);
    }
  }
  return { __esModule: true, default: FakeRedis };
});
// each gateway's RedisSync server id ends in a nanoid: distinct per node, so one node can own a document the other relays
jest.mock('nanoid', () => {
  let n = 0;
  return { nanoid: () => `node${++n}`, customAlphabet: () => () => 'test' };
});
jest.mock('../../common/helpers', () => ({
  createRetryStrategy: jest.fn(),
  parseRedisUrl: jest.fn(() => ({ host: 'h', port: 6379, password: '', db: 0 })),
}));

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { CollabWsAdapter } from '../../collaboration/adapter/collab-ws.adapter';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { authReplyOf } from './bounded-socket';
import { authFrame, DOC_NAME } from './collab-ingress.testkit';
import { COLLAB_PREAUTH_AUTH_FRAME_MS, COLLAB_PREAUTH_DEADLINE_MS } from './limits';
import { CollabSocketBounds } from './socket-bounds';
import { SocketLimitLog } from './socket-limit-log';

/**
 * #810 N1, as assembled, with the production timings: a socket that sends no Auth frame is cut at
 * COLLAB_PREAUTH_AUTH_FRAME_MS, but one whose Auth arrived at once and whose authentication takes 6 s (past that
 * deadline, inside COLLAB_PREAUTH_DEADLINE_MS) authenticates, on the standalone path, on the RedisSync path for a
 * document this node owns, and on the RedisSync path for a document another node owns (the Auth is relayed there and
 * the Authenticated reply relayed back). If the gateway's frame check ever stopped reporting the first Auth to the slots
 * on one path, every honest editor whose authentication took over 5 s would be cut there; this goes red instead.
 */
const AUTH_MS = 6_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Node {
  bounds: CollabSocketBounds;
  gateway: CollaborationGateway;
  adapter: CollabWsAdapter;
  http: Server;
  url: string;
  limitLines: string[];
}

async function startNode(withRedis: boolean): Promise<Node> {
  const limitLines: string[] = [];
  const bounds = new CollabSocketBounds({ limitLog: new SocketLimitLog({ warn: (m) => limitLines.push(m) }) });
  const authentication = {
    async onAuthenticate({ token }: { token: string }) {
      await sleep(token === 'slow' ? AUTH_MS : 0); // the reads, under load
      return { user: { id: `user-${token}` } };
    },
  };
  const gateway = new CollaborationGateway(
    authentication as never,
    {} as never, // persistence: nothing stored
    {} as never, // logger
    { getRedisUrl: () => 'redis://localhost:6379', isCollabDisableRedis: () => !withRedis } as never,
    { getHandlers: () => ({}) } as never,
    bounds,
  );
  const http = createServer();
  const adapter = new CollabWsAdapter(bounds);
  adapter.handleUpgrade('/collab', http).on('connection', (ws, req) => gateway.handleConnection(ws as never, req));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  return { bounds, gateway, adapter, http, url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/collab`, limitLines };
}

async function stopNode(node: Node): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([node.gateway.destroy(node.adapter), new Promise((r) => (timer = setTimeout(r, 3_000)))]);
  clearTimeout(timer);
  await new Promise((r) => node.http.close(r));
}

interface Outcome {
  /** ms from the upgrade to the Authenticated reply, or null if none came. */
  authenticatedAt: number | null;
  /** ms from the upgrade to the close, and its code, or null while open. */
  closedAt: number | null;
  closeCode: number | null;
}

/** Open a socket; send an Auth frame with `token` at once, or nothing (`null`). Resolves after `watchMs`. */
function client(url: string, token: string | null, watchMs: number, clients: WebSocket[]): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    clients.push(ws);
    const outcome: Outcome = { authenticatedAt: null, closedAt: null, closeCode: null };
    let opened = 0;
    ws.on('error', () => undefined);
    ws.once('unexpected-response', () => reject(new Error('upgrade refused')));
    ws.once('open', () => {
      opened = Date.now();
      if (token !== null) ws.send(authFrame(token, DOC_NAME));
      setTimeout(() => resolve(outcome), watchMs);
    });
    ws.on('message', (data: Buffer) => {
      if (outcome.authenticatedAt === null && authReplyOf(new Uint8Array(data)) === 'authenticated') outcome.authenticatedAt = Date.now() - opened;
    });
    ws.once('close', (code) => {
      outcome.closedAt = Date.now() - opened;
      outcome.closeCode = code;
    });
  });
}

describe('#810 N1 through the real gateway: a slow authentication outlives the first-Auth deadline; a silent socket does not', () => {
  const nodes: Node[] = [];
  const clients: WebSocket[] = [];
  const results: Record<string, { slow: Outcome; silent: Outcome; heldAfter: number }> = {};
  const WATCH_MS = AUTH_MS + 1_500;

  beforeAll(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const standalone = await startNode(false);
    const owner = await startNode(true);
    const relay = await startNode(true);
    nodes.push(standalone, owner, relay);

    // The owner loads the document first (a quick authentication), so the relay node must send its Auth to the owner.
    const first = await client(owner.url, 'fast', 300, clients);
    expect(first.authenticatedAt).not.toBeNull();

    const run = async (name: string, node: Node) => {
      const [slow, silent] = await Promise.all([client(node.url, 'slow', WATCH_MS, clients), client(node.url, null, WATCH_MS, clients)]);
      results[name] = { slow, silent, heldAfter: node.bounds.preAuth.size };
    };
    await Promise.all([run('standalone', standalone), run('RedisSync, owned here', owner), run('RedisSync, relayed to the owner', relay)]);
  }, 30_000);

  afterAll(async () => {
    for (const c of clients.splice(0)) c.terminate();
    await sleep(500); // every node sees its sockets close (RedisSync relays the closes) before it shuts down
    for (const n of nodes.splice(0)) await stopNode(n);
    jest.restoreAllMocks();
  }, 20_000);

  it.each(['standalone', 'RedisSync, owned here', 'RedisSync, relayed to the owner'])('%s', (name) => {
    const { slow, silent, heldAfter } = results[name];
    // the honest socket: Auth at once, authenticated after AUTH_MS (past the first-Auth deadline), never cut
    expect(slow.authenticatedAt).not.toBeNull();
    expect(slow.authenticatedAt!).toBeGreaterThanOrEqual(AUTH_MS - 50);
    expect(slow.authenticatedAt!).toBeLessThan(COLLAB_PREAUTH_DEADLINE_MS);
    expect(slow.closedAt).toBeNull();
    // control on the same node: no Auth frame, terminated (1006) at the first-Auth deadline
    expect(silent.closeCode).toBe(1006);
    expect(silent.closedAt!).toBeGreaterThanOrEqual(COLLAB_PREAUTH_AUTH_FRAME_MS - 100);
    expect(silent.closedAt!).toBeLessThan(COLLAB_PREAUTH_AUTH_FRAME_MS + 1_000);
    expect(heldAfter).toBe(0); // no slot left behind
  });

  it('each node logged exactly one first-Auth cut (the silent socket), and no deadline cut', () => {
    for (const n of nodes) {
      const lines = n.limitLines.filter((l) => l.includes('"limit":"preauth_'));
      expect(lines).toEqual([`COLLAB_SOCKET_LIMIT {"limit":"preauth_first_auth","deadlineMs":${COLLAB_PREAUTH_AUTH_FRAME_MS}}`]);
    }
  });
});
