import { EventEmitter } from 'node:events';
import * as encoding from 'lib0/encoding';
import { OutgoingMessage } from '@hocuspocus/server';
import { BoundedCollabSocket } from './bounded-socket';
import {
  COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES,
  COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES,
  COLLAB_SOCKET_TOTAL_BYTES,
  COLLAB_SOCKET_TOTAL_LOW_WATER_BYTES,
} from './limits';
import { CollabSocketBounds } from './socket-bounds';
import { CollabSocketBytes } from './socket-bytes';
import { SocketLimitLog } from './socket-limit-log';

/**
 * #810: the process-wide byte budget (socket-bytes.ts), through `CollabSocketBounds` as the adapter and the gateway
 * wire it: `holdUpgraded` tracks a socket, `open` hands Hocuspocus the bounded socket that queues every frame through
 * the budget. The fake ws socket behaves as ws does for what the budget reads: `bufferedAmount` counts each queued
 * frame (header + payload) until the client reads it, and each frame's send callback runs once it is written, in
 * order. A client that never reads is "paused".
 */
const KiB = 1024;
const MiB = 1024 * KiB;
const OVH = COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES;
const CHUNK = COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES;
/** ws's frame header for an unmasked server frame of `n` payload bytes. */
const header = (n: number) => (n < 126 ? 2 : n < 65_536 ? 4 : 10);

class PausedWs extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  private readonly queue: Array<{ left: number; cb: (err?: Error) => void }> = [];
  readonly terminate = jest.fn(() => {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.queue.length = 0;
    this.bufferedAmount = 0;
    this.emit('close', 1006, Buffer.from(''));
  });
  send(m: Uint8Array, cb: (err?: Error) => void): void {
    const n = m.byteLength + header(m.byteLength);
    this.bufferedAmount += n;
    this.queue.push({ left: n, cb });
  }
  /** The client reads `bytes` (all of it by default): each frame it finished gets its callback, in order. */
  drain(bytes = this.bufferedAmount): void {
    this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
    while (this.queue.length && bytes > 0) {
      const head = this.queue[0];
      const took = Math.min(head.left, bytes);
      head.left -= took;
      bytes -= took;
      if (head.left === 0) this.queue.shift()!.cb();
    }
  }
  close(): void {
    this.terminate();
  }
  ping(): void {}
  pong(): void {}
}
class Transport extends EventEmitter {
  /** A TCP read of `n` bytes. */
  read(n: number): void {
    this.emit('data', Buffer.alloc(n));
  }
}

/** A SyncStep1 for a page: a frame the frame check admits. */
const SYNC_STEP1 = (() => {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, 'page.01890a5d-ac96-774b-bcce-b302099a8057');
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint8Array(e, new Uint8Array([0]));
  return Buffer.from(encoding.toUint8Array(e));
})();

let sockets: PausedWs[] = [];
let budgets: CollabSocketBytes[] = [];

/** Bounds whose byte budget is `budget` (low water 7/8 of it), and a socket opened on them as the gateway does. */
function rig(budget = COLLAB_SOCKET_TOTAL_BYTES, lowWater = (budget / 8) * 7) {
  const warn = jest.fn();
  const limitLog = new SocketLimitLog({ warn });
  const bytes = new CollabSocketBytes({ budget, lowWater, limitLog });
  budgets.push(bytes);
  const bounds = new CollabSocketBounds({ bytes, limitLog, pingIntervalMs: 60_000 });
  const open = () => {
    const ws = new PausedWs();
    const transport = new Transport();
    sockets.push(ws);
    bounds.holdUpgraded(ws as never, transport, {} as never);
    bounds.preAuth.release(ws); // as if authenticated, unless a spec drives the Authenticated reply itself
    let bounded!: BoundedCollabSocket;
    bounds.open(ws as never, { readyState: 1, send: jest.fn(), close: jest.fn() }, (socket) => ((bounded = socket), { touch: () => undefined }), () => undefined);
    return { ws, transport, bounded };
  };
  const limitLines = () => warn.mock.calls.map(([line]) => line as string).filter((l) => l.includes('"socket_total_bytes"'));
  return { bounds, bytes, open, limitLines };
}

afterEach(() => {
  // the leak check: every socket closed, every budget back to nothing
  const [open, built] = [sockets, budgets];
  sockets = [];
  budgets = [];
  for (const ws of open) ws.close();
  for (const bytes of built) {
    expect(bytes.total).toBe(0);
    expect(bytes.size).toBe(0);
    expect(bytes.sharedPayloads).toBe(0);
  }
});

describe('#810 the process byte budget: cut the largest holder', () => {
  it('three paused sockets: past the budget the largest is cut and logged, the others stay', () => {
    const { bytes, open, limitLines } = rig(1 * MiB);
    const a = open();
    const b = open();
    const c = open();
    a.bounded.send(new Uint8Array(200 * KiB));
    b.bounded.send(new Uint8Array(500 * KiB));
    c.bounded.send(new Uint8Array(200 * KiB));
    expect(b.ws.terminate).not.toHaveBeenCalled();
    b.bounded.send(new Uint8Array(150 * KiB)); // 1,050 KiB + headers + overheads: over 1 MiB
    expect(b.ws.terminate).toHaveBeenCalledTimes(1);
    expect(a.ws.terminate).not.toHaveBeenCalled();
    expect(c.ws.terminate).not.toHaveBeenCalled();
    const held = 650 * KiB + header(500 * KiB) + header(150 * KiB) + 2 * OVH;
    const total = 1050 * KiB + header(500 * KiB) + header(150 * KiB) + 2 * header(200 * KiB) + 4 * OVH;
    expect(limitLines()).toEqual([`COLLAB_SOCKET_LIMIT {"limit":"socket_total_bytes","heldBytes":${held},"totalBytes":${total},"budgetBytes":${MiB}}`]);
    expect(bytes.total).toBe(400 * KiB + 2 * header(200 * KiB) + 2 * OVH); // what a and c hold
    expect(bytes.size).toBe(2);
  });

  it('cuts down to the low water, largest first, in one pass', () => {
    const { bytes, open } = rig(1 * MiB, 512 * KiB);
    const s = [open(), open(), open(), open()];
    [100, 300, 250, 300].forEach((k, i) => s[i].bounded.send(new Uint8Array(k * KiB)));
    expect(s.some((x) => x.ws.terminate.mock.calls.length)).toBe(false);
    s[0].bounded.send(new Uint8Array(100 * KiB)); // 1,050 KiB: over; down to <= 512 KiB takes the two 300s
    expect(s.map((x) => x.ws.terminate.mock.calls.length)).toEqual([0, 1, 0, 1]);
    expect(bytes.total).toBeLessThanOrEqual(512 * KiB);
  });

  it('drains and closes bring the total back to 0', () => {
    const { bytes, open } = rig(1 * MiB);
    const a = open();
    const b = open();
    for (let i = 0; i < 10; i++) a.bounded.send(new Uint8Array(10 * KiB));
    b.bounded.send(new Uint8Array(300 * KiB));
    expect(bytes.total).toBe(400 * KiB + 10 * header(10 * KiB) + header(300 * KiB) + 11 * OVH);
    expect(bytes.pendingFrames(a.ws)).toBe(10);
    a.ws.drain();
    expect(bytes.pendingFrames(a.ws)).toBe(0); // every callback ran: the overheads are gone at once
    bytes.resample(a.ws); // the keepalive tick's sample: the payload bytes it read are gone too
    expect(bytes.total).toBe(300 * KiB + header(300 * KiB) + OVH);
    b.ws.close(); // closed with a frame still queued: released whole
    expect(bytes.total).toBe(0);
    expect(bytes.size).toBe(1);
  });

  it('the keepalive tick re-samples a socket', () => {
    jest.useFakeTimers();
    try {
      const { bytes, bounds } = rig(1 * MiB);
      const ws = new PausedWs();
      sockets.push(ws);
      bounds.holdUpgraded(ws as never, new Transport(), {} as never);
      bounds.preAuth.release(ws);
      let bounded!: BoundedCollabSocket;
      bounds.open(ws as never, { readyState: 1, send: jest.fn(), close: jest.fn() }, (s) => ((bounded = s), { touch: () => undefined }), () => undefined);
      bounded.send(new Uint8Array(100 * KiB));
      ws.drain();
      expect(bytes.total).toBe(100 * KiB + header(100 * KiB)); // stale until sampled
      jest.advanceTimersByTime(60_000);
      expect(bytes.total).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('#810 a shared broadcast payload is counted once', () => {
  const PEERS = 40;
  const BROADCAST = 4_200_000; // 128 MiB / 32 is 4.19 MB: per peer, 40 copies would be 168 MB

  it(`a ${BROADCAST / 1e6} MB broadcast to ${PEERS} paused peers cuts no one`, () => {
    const { bytes, open, limitLines } = rig(); // the production budget
    const peers = Array.from({ length: PEERS }, () => open());
    const update = new Uint8Array(BROADCAST); // Hocuspocus 4.7.1 Document.broadcast: ONE encode, the same array to every peer
    for (const p of peers) p.bounded.send(update);
    expect(peers.filter((p) => p.ws.terminate.mock.calls.length)).toHaveLength(0);
    expect(limitLines()).toEqual([]);
    expect(bytes.sharedPayloads).toBe(1);
    expect(bytes.total).toBe(BROADCAST + PEERS * (header(BROADCAST) + OVH));
    // the peers read it one by one; the payload leaves the total with the last of them
    for (const p of peers.slice(0, -1)) {
      p.ws.drain();
      bytes.resample(p.ws);
    }
    expect(bytes.sharedPayloads).toBe(1);
    expect(bytes.total).toBe(BROADCAST + header(BROADCAST) + OVH);
    peers[PEERS - 1].ws.drain();
    bytes.resample(peers[PEERS - 1].ws);
    expect(bytes.sharedPayloads).toBe(0);
    expect(bytes.total).toBe(0);
  });

  it('anti-vacuity: the same bytes as a distinct array per peer are counted per peer, and the budget cuts', () => {
    const { open, limitLines } = rig();
    const peers = Array.from({ length: PEERS }, () => open());
    const backing = new ArrayBuffer(BROADCAST);
    for (const p of peers) p.bounded.send(new Uint8Array(backing)); // a new view each: nothing says it is shared
    expect(peers.filter((p) => p.ws.terminate.mock.calls.length).length).toBeGreaterThan(0);
    expect(limitLines().length).toBeGreaterThan(0);
  });

  it('a shared payload counts each holder at its share when choosing whom to cut', () => {
    const { open } = rig(3.5 * MiB, 2.5 * MiB);
    const viewers = Array.from({ length: 8 }, () => open());
    const update = new Uint8Array(2 * MiB);
    for (const v of viewers) v.bounded.send(update); // 2 MiB once: a quarter MiB a viewer
    const flooder = open();
    flooder.bounded.send(new Uint8Array(1 * MiB));
    flooder.bounded.send(new Uint8Array(900 * KiB)); // over 3.5 MiB
    // the flooder holds 1.9 MiB, each viewer its quarter of the 2 MiB update: the flooder goes, and that is enough
    // (counting the whole update against every viewer would cut all eight before it, freeing nothing until the last)
    expect(flooder.ws.terminate).toHaveBeenCalledTimes(1);
    expect(viewers.filter((v) => v.ws.terminate.mock.calls.length)).toHaveLength(0);
  });

  it('a frame the kernel took at once (the buffer did not grow) is not refcounted', () => {
    const { bytes, open } = rig();
    const a = open();
    const update = new Uint8Array(64 * KiB);
    a.ws.send = jest.fn((_m: Uint8Array, cb: () => void) => process.nextTick(cb)) as never; // written at once
    a.bounded.send(update);
    expect(bytes.sharedPayloads).toBe(0);
    expect(bytes.pendingFrames(a.ws)).toBe(1); // its overhead counts until its callback
    expect(bytes.total).toBe(OVH);
  });
});

describe('#810 a stale sample never cuts an honest socket', () => {
  it('a socket that drained since its last sample is re-sampled before anyone is cut', () => {
    const { bytes, open, limitLines } = rig(1 * MiB);
    const reader = open();
    reader.bounded.send(new Uint8Array(600 * KiB)); // a SyncStep2...
    reader.ws.drain(); // ...it has read since (its callback ran), but nothing sampled it again
    expect(bytes.total).toBe(600 * KiB + header(600 * KiB)); // the stale sample
    const b = open();
    const c = open();
    b.bounded.send(new Uint8Array(250 * KiB));
    c.bounded.send(new Uint8Array(250 * KiB)); // cached: 1,100 KiB, over; sampled: 500 KiB, under
    expect(reader.ws.terminate).not.toHaveBeenCalled();
    expect(b.ws.terminate).not.toHaveBeenCalled();
    expect(c.ws.terminate).not.toHaveBeenCalled();
    expect(limitLines()).toEqual([]);
    expect(bytes.total).toBe(500 * KiB + 2 * header(250 * KiB) + 2 * OVH);
  });
});

describe('#810 a pass that cuts no one is not repeated on every send', () => {
  it('a holder parked just under the budget, and honest peers draining around it: a pass per 1/16 of the low-water gap', () => {
    const { bytes, open, limitLines } = rig(1 * MiB); // low water 896 KiB: a no-cut pass buys 8 KiB
    const parked = open();
    parked.bounded.send(new Uint8Array(1020 * KiB)); // held for real, 4 KiB under the budget
    const peers = Array.from({ length: 200 }, () => open());
    for (const p of peers) {
      p.bounded.send(new Uint8Array(1 * KiB)); // read at once, but nothing samples it again: stale
      p.ws.drain();
    }
    expect(limitLines()).toEqual([]); // nobody was ever really over: nobody is cut
    expect(parked.ws.terminate).not.toHaveBeenCalled();
    // 200 KiB of stale samples: a pass per ~8 KiB of it, not one per send
    expect(bytes.passes).toBeGreaterThan(5);
    expect(bytes.passes).toBeLessThanOrEqual(30);
  });

  it('the total passes the budget by at most that before a pass cuts', () => {
    const { bytes, open } = rig(1 * MiB);
    const parked = open();
    parked.bounded.send(new Uint8Array(1020 * KiB));
    const peer = open();
    peer.bounded.send(new Uint8Array(4 * KiB)); // a real 1 KiB over: a pass
    expect(bytes.passes).toBe(1);
    expect(parked.ws.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('#810 the inbound partial frame, once authenticated', () => {
  const authenticated = () => new OutgoingMessage('page.x').writeAuthenticated(false).toUint8Array();

  it('is the pre-auth budget’s before the Authenticated reply, this one’s after, and cut past it', () => {
    const { bounds, bytes, limitLines } = rig(1 * MiB);
    const ws = new PausedWs();
    const transport = new Transport();
    sockets.push(ws);
    bounds.holdUpgraded(ws as never, transport, {} as never);
    let bounded!: BoundedCollabSocket;
    bounds.open(ws as never, { readyState: 1, send: jest.fn(), close: jest.fn() }, (s) => ((bounded = s), { touch: () => undefined }), () => undefined);
    transport.read(300 * KiB); // part of a large frame, before it authenticated
    expect(bytes.total).toBe(0);
    expect(bounds.preAuth.bytes).toBe(300 * KiB);
    const reply = authenticated();
    bounded.send(reply); // the first Authenticated reply: the slot is freed, the partial frame moves here
    expect(bounds.preAuth.holds(ws)).toBe(false);
    expect(bytes.total).toBe(300 * KiB + CHUNK + reply.byteLength + header(reply.byteLength) + OVH);
    transport.read(400 * KiB);
    expect(ws.terminate).not.toHaveBeenCalled();
    ws.emit('message', SYNC_STEP1); // the frame completed: ws hands its bytes over, no longer a partial frame
    expect(bytes.total).toBe(reply.byteLength + header(reply.byteLength) + OVH);
    ws.drain();
    for (let i = 0; i < 4; i++) transport.read(300 * KiB); // a new partial frame past 1 MiB
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(limitLines()).toHaveLength(1);
    expect(limitLines()[0]).toMatch(/"heldBytes":\d+,"totalBytes":\d+,"budgetBytes":1048576\}$/);
    transport.read(300 * KiB); // after the cut: nothing counts
    expect(bytes.total).toBe(0);
  });

  it('control: an unauthenticated socket’s reads never count here', () => {
    const { bounds, bytes } = rig(1 * MiB);
    const ws = new PausedWs();
    const transport = new Transport();
    sockets.push(ws);
    bounds.holdUpgraded(ws as never, transport, {} as never);
    for (let i = 0; i < 8; i++) transport.read(256 * KiB);
    expect(bytes.total).toBe(0);
    expect(ws.terminate).not.toHaveBeenCalled();
  });
});

describe('#810 release', () => {
  it('a cut releases once; a send callback after it is ignored', () => {
    const { bytes, open } = rig(1 * MiB);
    const a = open();
    a.bounded.send(new Uint8Array(100 * KiB));
    const cb = (a.ws as unknown as { queue: Array<{ cb: () => void }> }).queue[0].cb;
    bytes.release(a.ws);
    bytes.release(a.ws);
    cb();
    expect(bytes.total).toBe(0);
    expect(bytes.pendingFrames(a.ws)).toBe(0);
  });

  it('the production constants: 128 MiB, low water 112 MiB', () => {
    expect(COLLAB_SOCKET_TOTAL_BYTES).toBe(128 * MiB);
    expect(COLLAB_SOCKET_TOTAL_LOW_WATER_BYTES).toBe(112 * MiB);
    expect(OVH).toBe(512);
    expect(CHUNK).toBe(256);
  });
});
