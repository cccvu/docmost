// The gateway's Redis clients are FakeRedisClients on one in-memory bus (redis-bus.testkit.ts); RedisSync, Hocuspocus
// 4.7.1, the gateway and the CCC extensions are real.
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
jest.mock('nanoid', () => ({ nanoid: () => `node${++mockNanoid}`, customAlphabet: () => () => 'x' }));
jest.mock('../../common/helpers', () => ({
  createRetryStrategy: jest.fn(),
  parseRedisUrl: jest.fn(() => ({ host: 'h', port: 6379, password: '', db: 0 })),
}));

import * as Y from 'yjs';
import { Logger } from '@nestjs/common';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { authFrame, DOC_NAME, FakeSocket, MSG, readServerFrame, RemoteClient, syncFrame } from './collab-ingress.testkit';
import { CollabSocketBounds, COLLAB_DRAIN_TOKEN } from './socket-bounds';
import { SocketLimitLog } from './socket-limit-log';

/**
 * #810 T4: the gateway's graceful shutdown (`destroy`, the #345 drain), run against the real Hocuspocus 4.7.1 with a
 * pending store, never only as config:
 * - a debounced store is run by the drain, and `destroy` resolves only once it is stored and the document unloaded,
 *   with RedisSync's lock released;
 * - CRIT-13: a store already executing with a second edit debounced behind it. Hocuspocus's debouncer deletes the second
 *   one's timer before it waits for the first, so `flushPendingStores` cannot see it; `destroy` still waits for both,
 *   because unload is gated on the running store too;
 * - the drain race: an Auth already inside `onAuthenticate` when `closeConnections` ran gets the socket closed 1013 (no
 *   document CLOSE frame, which the editor would answer by reopening at once), and `destroy` resolves. Its mutation arm
 *   (the drain flag never set) leaves `destroy` unresolved with the document still resident.
 * jest's fake clock (nextTick and queueMicrotask real), so the 10 s debounce and the 60 s idle timeout are exact.
 */
type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
/** Run timers due by `ms` from now, and the promise chains and bus deliveries between them. */
const advance = async (ms = 0) => {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) {
    await turn();
    await jest.advanceTimersByTimeAsync(0);
  }
};

const text = (state: Uint8Array): string => {
  const d = new Y.Doc();
  Y.applyUpdate(d, state);
  return d.getXmlFragment('default').toString();
};
const paragraph = (t: string) => (f: Y.XmlFragment) => {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(t)]);
  f.insert(f.length, [p]);
};

function harness() {
  const bus = (mockBus.current = new FakeRedisBus());
  const drainLines: string[] = [];
  const bounds = new CollabSocketBounds({ limitLog: new SocketLimitLog({ warn: () => undefined }), drainLog: { log: (m) => drainLines.push(m) } });
  /** Auth tokens held until the spec resolves them. */
  const authHolds = new Map<string, Deferred>();
  const auth = {
    async onAuthenticate({ token }: { token: string }) {
      await authHolds.get(token)?.promise;
      return { user: { id: `u-${token}` } };
    },
  };
  /** Each store's state as the hook saw it on entry; a store waits on `storeHolds[i]` when set. */
  const stored: Uint8Array[] = [];
  const storeHolds: Deferred[] = [];
  const storeDone: number[] = [];
  const persistence = {
    extensionName: 'StubPersistence',
    async onLoadDocument() {},
    async onStoreDocument({ document }: { document: Y.Doc }) {
      const i = stored.push(Y.encodeStateAsUpdate(document)) - 1;
      await storeHolds[i]?.promise;
      storeDone.push(i);
    },
  };
  const gateway = new CollaborationGateway(
    auth as never,
    persistence as never,
    {} as never,
    { getRedisUrl: () => 'redis://h:6379', isCollabDisableRedis: () => false } as never,
    { getHandlers: () => ({}) } as never,
    bounds,
  );
  const hp = (gateway as unknown as { hocuspocus: { getDocumentsCount(): number; documents: Map<string, unknown> } }).hocuspocus;
  const connect = (token: string) => {
    const sock = new FakeSocket();
    gateway.handleConnection(sock as never, { method: 'GET', url: '/collab', headers: {}, socket: { remoteAddress: '10.0.0.1' } } as never);
    sock.deliver(authFrame(token));
    return sock;
  };
  /** The server's replica, for diffing a client's edit against. */
  const serverDoc = () => hp.documents.get(DOC_NAME) as Y.Doc;
  const edit = (sock: FakeSocket, client: RemoteClient, t: string) => sock.deliver(syncFrame(client.edit(serverDoc(), paragraph(t))));
  let destroyed = false;
  const destroy = () => {
    const adapter = { close: jest.fn() };
    const p = gateway.destroy(adapter as never).then(() => {
      destroyed = true;
    });
    return { p, adapter, done: () => destroyed };
  };
  const lockKeys = () => bus.keysMatching('collabLock:');
  return { bus, bounds, gateway, hp, connect, edit, destroy, stored, storeHolds, storeDone, authHolds, drainLines, lockKeys };
}

describe('#810 T4 the gateway drain, through the real Hocuspocus 4.7.1 and RedisSync', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    mockBus.current = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a debounced store runs on destroy, which resolves only after it is stored, the document unloaded and its lock released', async () => {
    const h = harness();
    const sock = h.connect('a');
    await advance();
    expect(sock.sent.map(readServerFrame).some((f) => f.type === MSG.Auth)).toBe(true);
    expect(h.lockKeys()).toEqual([`collabLock:${DOC_NAME}`]);
    h.edit(sock, new RemoteClient(new Y.Doc()), 'one');
    await advance(1_000); // inside the 10 s debounce: nothing stored yet
    expect(h.stored).toHaveLength(0);

    h.storeHolds[0] = deferred();
    const d = h.destroy();
    await advance();
    expect(d.adapter.close).toHaveBeenCalledTimes(1);
    expect(h.stored).toHaveLength(1); // the drain ran it at once, not at the debounce
    expect(d.done()).toBe(false); // ...and waits for it
    expect(h.lockKeys()).toHaveLength(1);

    h.storeHolds[0].resolve();
    await advance();
    expect(d.done()).toBe(true);
    expect(text(h.stored[0])).toContain('one');
    expect(h.hp.getDocumentsCount()).toBe(0);
    expect(h.lockKeys()).toEqual([]); // DEL'd before onDestroy disconnected RedisSync
    expect(h.bus.dropped).toEqual([]);
    expect(sock.closeReasons()).toEqual(['Reset Connection']);
    expect(h.drainLines).toEqual([
      `${COLLAB_DRAIN_TOKEN} {"phase":"start","documents":1}`,
      expect.stringMatching(new RegExp(`^${COLLAB_DRAIN_TOKEN} \\{"phase":"done","documents":1,"ms":\\d+\\}$`)),
    ]);
  });

  it('CRIT-13: a store already executing plus a debounced second edit: destroy waits for both, and the lock goes after the second', async () => {
    const h = harness();
    const sock = h.connect('a');
    await advance();
    const client = new RemoteClient(new Y.Doc());
    h.edit(sock, client, 'one');
    h.storeHolds[0] = deferred();
    await advance(10_000); // the debounce fires: store 1 is executing, held
    expect(h.stored).toHaveLength(1);
    h.edit(sock, client, 'two'); // store 2 debounced behind it
    await advance();

    h.storeHolds[1] = deferred();
    const d = h.destroy();
    await advance();
    expect(h.stored).toHaveLength(1); // store 2 waits for store 1
    h.storeHolds[0].resolve();
    await advance();
    expect(h.stored).toHaveLength(2); // the drain's executeNow of store 2 ran once store 1 finished
    expect(d.done()).toBe(false); // flushPendingStores alone would have let it resolve here
    expect(h.lockKeys()).toHaveLength(1);
    h.storeHolds[1].resolve();
    await advance();
    expect(d.done()).toBe(true);
    expect(h.storeDone).toEqual([0, 1]);
    const last = text(h.stored[1]);
    expect(last).toContain('one');
    expect(last).toContain('two');
    expect(h.lockKeys()).toEqual([]);
    expect(h.hp.getDocumentsCount()).toBe(0);
  });

  const lateAuth = async (drainFlag: boolean) => {
    const h = harness();
    if (!drainFlag) jest.spyOn(h.bounds, 'beginDrain').mockReturnValue(() => undefined); // MUTATION: the flag never set
    const editor = h.connect('a');
    await advance();
    h.edit(editor, new RemoteClient(new Y.Doc()), 'one');
    await advance();
    h.authHolds.set('late', deferred());
    const late = h.connect('late'); // its onAuthenticate is a PDP round trip still in flight at destroy
    await advance();
    h.storeHolds[0] = deferred();
    const d = h.destroy();
    await advance();
    h.authHolds.get('late')!.resolve(); // authenticates while the drain's store still runs
    await advance();
    h.storeHolds[0].resolve();
    await advance(45_000); // well past the debounce, inside Hocuspocus's 60 s idle timeout
    return { h, d, late, editor };
  };

  it('a late Auth during destroy gets its socket closed 1013, no document CLOSE, and destroy resolves', async () => {
    const { h, d, late, editor } = await lateAuth(true);
    expect(late.closed).toEqual({ code: 1013, reason: 'Try Again Later' });
    expect(late.closeReasons()).toEqual([]); // the socket was closing first, so no document CLOSE was sent
    expect(late.sent.map(readServerFrame).some((f) => f.type === MSG.Auth)).toBe(true); // it had authenticated
    expect(editor.closeReasons()).toEqual(['Reset Connection']);
    expect(d.done()).toBe(true);
    expect(h.hp.getDocumentsCount()).toBe(0);
    expect(h.lockKeys()).toEqual([]);
    expect(h.bounds.connections.count('u-late')).toBe(0);
  });

  it('MUTATION arm: with the drain flag never set, the late connection keeps the document and destroy never resolves', async () => {
    const { h, d, late } = await lateAuth(false);
    expect(late.closed).toBeNull();
    expect(d.done()).toBe(false);
    expect(h.hp.getDocumentsCount()).toBe(1);
    expect(h.lockKeys()).toHaveLength(1);
    late.close(1000, 'test over'); // let the document go, so the test leaves nothing running
    await advance();
    expect(d.done()).toBe(true);
  });
});
