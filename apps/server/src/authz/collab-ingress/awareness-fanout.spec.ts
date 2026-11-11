// The REAL gateway (standalone path), ws adapter and Hocuspocus 4.7.1 on real sockets.
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() })); // the standalone path never constructs it
jest.mock('nanoid', () => ({ nanoid: () => 'test', customAlphabet: () => () => 'test' }));
jest.mock('../../common/helpers', () => ({
  createRetryStrategy: jest.fn(),
  parseRedisUrl: jest.fn(() => ({ host: 'h', port: 6379, password: '', db: 0 })),
}));

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as decoding from 'lib0/decoding';
import { WebSocket } from 'ws';
import { CollabWsAdapter } from '../../collaboration/adapter/collab-ws.adapter';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { authReplyOf } from './bounded-socket';
import { authFrame, awarenessFrame, DOC_NAME, MSG } from './collab-ingress.testkit';
import { COLLAB_AWARENESS_BURST_BYTES, COLLAB_AWARENESS_REFILL_BYTES_PER_SECOND } from './limits';
import { CollabSocketBounds } from './socket-bounds';
import { SocketLimitLog } from './socket-limit-log';
import { AWARENESS_STATE_MAX_BYTES } from './update-guard';

/**
 * #810: one socket pushing large awareness frames (each state under the guard's AWARENESS_STATE_MAX_BYTES) through the
 * real gateway. Hocuspocus relays every admitted awareness frame to every peer, so what a peer receives of the sender's
 * awareness is what the gateway's byte bucket admitted: at most COLLAB_AWARENESS_BURST_BYTES plus
 * COLLAB_AWARENESS_REFILL_BYTES_PER_SECOND for each second the flood lasted. Frames are spaced a few ms apart, so each
 * is its own event-loop turn and Hocuspocus's flushDelay 0 coalescing does not hide what was admitted. Anti-vacuity arm
 * (recorded in the #810 notes): charging one frame whatever its length admits the whole 200-frame burst (about 1.4 MB
 * to the peer), and this goes red.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SENDER_CLIENT_ID = 4242;
const STATE_JSON = JSON.stringify({ user: { name: 'x'.repeat(AWARENESS_STATE_MAX_BYTES - 1024), color: '#000000' } });
const FRAMES = 200;
const SPACING_MS = 5;

/** The awareness frame's client ids, or null when `data` is not an Awareness frame. */
function awarenessClients(data: Uint8Array): number[] | null {
  const d = decoding.createDecoder(data);
  decoding.readVarString(d);
  if (decoding.readVarUint(d) !== MSG.Awareness) return null;
  const inner = decoding.createDecoder(decoding.readVarUint8Array(d));
  const ids: number[] = [];
  for (let n = decoding.readVarUint(inner); n > 0; n--) {
    ids.push(decoding.readVarUint(inner));
    decoding.readVarUint(inner); // clock
    decoding.readVarString(inner); // state
  }
  return ids;
}

describe('#810 the awareness byte bucket, through the real gateway and Hocuspocus: what a peer is owed', () => {
  let http: Server;
  let gateway: CollaborationGateway;
  let adapter: CollabWsAdapter;
  let url: string;
  const clients: WebSocket[] = [];

  beforeAll(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const bounds = new CollabSocketBounds({ limitLog: new SocketLimitLog({ warn: () => undefined }) });
    const authentication = { async onAuthenticate({ token }: { token: string }) { return { user: { id: `user-${token}` } }; } };
    gateway = new CollaborationGateway(
      authentication as never,
      {} as never, // persistence: nothing stored
      {} as never, // logger
      { getRedisUrl: () => 'redis://localhost:6379', isCollabDisableRedis: () => true } as never,
      { getHandlers: () => ({}) } as never,
      bounds,
    );
    http = createServer();
    adapter = new CollabWsAdapter(bounds);
    adapter.handleUpgrade('/collab', http).on('connection', (ws, req) => gateway.handleConnection(ws as never, req));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/collab`;
  });

  afterAll(async () => {
    for (const c of clients.splice(0)) c.terminate();
    await sleep(200);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([gateway.destroy(adapter), new Promise((r) => (timer = setTimeout(r, 3_000)))]);
    clearTimeout(timer);
    await new Promise((r) => http.close(r));
    jest.restoreAllMocks();
  }, 10_000);

  /** An authenticated socket on DOC_NAME; `onFrame` sees every frame the server sends it. */
  const open = (token: string, onFrame: (data: Uint8Array) => void = () => undefined): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      clients.push(ws);
      ws.on('error', reject);
      ws.once('open', () => ws.send(authFrame(token, DOC_NAME)));
      ws.on('message', (data: Buffer) => {
        const frame = new Uint8Array(data);
        if (authReplyOf(frame) === 'authenticated') resolve(ws);
        onFrame(frame);
      });
    });

  it(`the peer receives at most ${COLLAB_AWARENESS_BURST_BYTES} B plus ${COLLAB_AWARENESS_REFILL_BYTES_PER_SECOND} B/s of the sender's awareness`, async () => {
    let peerBytes = 0;
    let peerFrames = 0;
    let counting = false;
    await open('peer', (frame) => {
      if (!counting || !awarenessClients(frame)?.includes(SENDER_CLIENT_ID)) return;
      peerBytes += frame.byteLength;
      peerFrames++;
    });
    const sender = await open('sender');
    const frames = Array.from({ length: FRAMES }, (_, i) => awarenessFrame([{ clientID: SENDER_CLIENT_ID, clock: i + 1, state: null, json: STATE_JSON }]));
    const frameBytes = frames[0].byteLength;
    expect(frameBytes).toBeGreaterThan(7 * 1024); // each frame costs its length, far over the 512 B minimum

    counting = true;
    const started = performance.now();
    for (const f of frames) {
      sender.send(f);
      await sleep(SPACING_MS);
    }
    await sleep(300); // every admitted frame relayed
    const seconds = (performance.now() - started) / 1000;
    counting = false;

    // anti-vacuity: the relay path works, and the burst itself got through (about 14 frames of this size)
    expect(peerFrames).toBeGreaterThanOrEqual(5);
    // the bound: never more than the bucket admits, over the whole (over-estimated) duration of the flood
    expect(peerBytes).toBeLessThanOrEqual(COLLAB_AWARENESS_BURST_BYTES + COLLAB_AWARENESS_REFILL_BYTES_PER_SECOND * seconds);
    expect(peerBytes).toBeLessThan(FRAMES * frameBytes / 4); // what a per-frame charge would have let through
    expect(sender.readyState).toBe(WebSocket.OPEN); // a drop, never a refusal
  }, 20_000);
});
