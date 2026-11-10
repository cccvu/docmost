import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { RedisSyncExtension } from '../../collaboration/extensions/redis-sync';

/**
 * #790: on the node that owns a document, a proxied frame arrives inside a Redis message, and msgpackr hands back its
 * `message` as a VIEW into the reply buffer. lib0 before 0.2.120 read a length prefix past a view's end into whatever
 * that buffer held next (`new Uint8Array(arr.buffer, …)`). Two layers: the owner gives Hocuspocus a copy, as the origin
 * node already does (`new Uint8Array(detachableMsg.slice())`), and the workspace pins lib0 to 0.2.120, which throws
 * on such a read (root `pnpm.overrides`, UPSTREAM_MODIFICATIONS §219–§221).
 */
const DOC = 'page.00000000-0000-4000-8000-000000000790';

/** A frame whose last field claims more bytes than the frame holds. */
function truncatedFrame(): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, DOC);
  encoding.writeVarUint(e, 1); // Awareness
  encoding.writeVarUint(e, 64); // a 64-byte update...
  encoding.writeUint8Array(e, new Uint8Array(4)); // ...of which only 4 are there
  return encoding.toUint8Array(e);
}

/** The frame as msgpackr returns it: a view, with foreign bytes right after it in the same buffer. */
function viewInReplyBuffer(frame: Uint8Array): Uint8Array {
  const reply = new Uint8Array(frame.length + 256).fill(0x41); // the next message's bytes
  reply.set(frame, 16);
  return reply.subarray(16, 16 + frame.length);
}

function ownerNode() {
  const handleMessage = jest.fn();
  const redis = {
    duplicate: () => ({ subscribe: jest.fn(), on: jest.fn(), publish: jest.fn(async () => 1) }),
  };
  const ext = new RedisSyncExtension({ redis: redis as never, serverId: 'owner', pack: (m: unknown) => m as never, unpack: (m: unknown) => m as never } as never);
  void ext.onConfigure({ instance: { handleConnection: () => ({ handleMessage, handleClose: jest.fn() }) } } as never);
  const deliver = async (message: Uint8Array) =>
    (ext as unknown as { handleRedisMessage: (c: Buffer, m: unknown) => Promise<void> }).handleRedisMessage(Buffer.from('ch'), {
      type: 'proxy',
      replyTo: 'collabMsg:origin',
      message,
      serializedHTTPRequest: { method: 'GET', url: '/', headers: { 'sec-websocket-key': 'sock-1', 'sec-websocket-protocol': '' }, socket: { remoteAddress: '' } },
    });
  return { handleMessage, deliver };
}

const readUpdate = (data: Uint8Array): Uint8Array => {
  const d = decoding.createDecoder(data);
  decoding.readVarString(d);
  decoding.readVarUint(d);
  return decoding.readVarUint8Array(d);
};

/** Node's resolution of `name` from directory `from` (walking up its node_modules), following pnpm's links. */
function resolveDir(name: string, from: string): string {
  for (let dir = realpathSync(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`${name} not found from ${from}`);
  }
}
const versionOf = (dir: string): string => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
const SERVER = join(__dirname, '..', '..', '..');

describe('#790 RedisSync owner path: the proxied frame is a copy', () => {
  it('every lib0 the collab path decodes with is 0.2.120 (bounds-checked): the server, yjs, y-protocols, Hocuspocus', () => {
    const hocuspocus = resolveDir('@hocuspocus/server', SERVER);
    const owners = {
      server: SERVER,
      yjs: resolveDir('yjs', SERVER),
      'y-protocols': resolveDir('y-protocols', hocuspocus),
      '@hocuspocus/server': hocuspocus,
    };
    const versions = Object.fromEntries(Object.entries(owners).map(([k, dir]) => [k, versionOf(resolveDir('lib0', dir))]));
    expect(versions).toEqual({ server: '0.2.120', yjs: '0.2.120', 'y-protocols': '0.2.120', '@hocuspocus/server': '0.2.120' });
  });

  it('lib0 0.2.120 refuses to read past a view, so the copy is defense in depth', () => {
    expect(() => readUpdate(viewInReplyBuffer(truncatedFrame()))).toThrow();
  });

  it('Hocuspocus gets a copy holding exactly the frame, so the same read throws instead of leaking', async () => {
    const { handleMessage, deliver } = ownerNode();
    const view = viewInReplyBuffer(truncatedFrame());
    await deliver(view);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const given = handleMessage.mock.calls[0][0] as Uint8Array;
    expect(given).not.toBe(view);
    expect(given.byteOffset).toBe(0);
    expect(given.buffer.byteLength).toBe(view.length);
    expect(Array.from(given)).toEqual(Array.from(view));
    expect(() => readUpdate(given)).toThrow();
  });
});
