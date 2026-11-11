import { BoundedCollabSocket } from './bounded-socket';
import { COLLAB_MAX_PAYLOAD_BYTES, COLLAB_OUTBOUND_BUFFER_FACTOR, COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES } from './limits';
import { CollabPreAuthSlots } from './preauth-slots';
import { CollabSocketBytes } from './socket-bytes';
import { SocketLimitLog } from './socket-limit-log';

/**
 * #790: the outbound bound. A fake raw ws socket whose `bufferedAmount` grows by every frame queued on it and shrinks
 * only when the test drains it (the client reading), which also calls each fully written frame's send callback, in
 * order, as ws does. #810: each frame still queued counts COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES too.
 */
const MiB = 1024 * 1024;
const OVH = COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES;

function harness() {
  const queue: Array<{ left: number; cb: () => void }> = [];
  const raw = {
    readyState: 1,
    bufferedAmount: 0,
    terminate: jest.fn(() => (raw.readyState = 2)),
    send: jest.fn((m: Uint8Array, cb: () => void) => {
      sent.push(m.byteLength);
      raw.bufferedAmount += m.byteLength;
      queue.push({ left: m.byteLength, cb });
    }),
  };
  /** The client reads `bytes`: frames it finished get their callback. */
  const drain = (bytes: number) => {
    raw.bufferedAmount = Math.max(0, raw.bufferedAmount - bytes);
    while (queue.length && bytes > 0) {
      const head = queue[0];
      const took = Math.min(head.left, bytes);
      head.left -= took;
      bytes -= took;
      if (head.left === 0) queue.shift()!.cb();
    }
  };
  const sent: number[] = [];
  const inner = { readyState: 1, send: jest.fn(), close: jest.fn() };
  const warn = jest.fn();
  const bytes = new CollabSocketBytes({ limitLog: new SocketLimitLog({ warn }) });
  const socket = new BoundedCollabSocket(raw, inner, { preAuth: new CollabPreAuthSlots(), bytes, limitLog: new SocketLimitLog({ warn }) });
  const frame = (n: number) => new Uint8Array(n);
  return { raw, inner, sent, warn, socket, frame, drain, bytes };
}

describe('#790 BoundedCollabSocket', () => {
  it('the allowance is one max payload above the largest frame sent (1 x 8 MiB)', () => {
    expect(COLLAB_OUTBOUND_BUFFER_FACTOR * COLLAB_MAX_PAYLOAD_BYTES).toBe(8 * MiB);
  });

  it("passes an honest slow client draining a maximal SyncStep2 while a peer's maximal paste is relayed to it", () => {
    const { raw, sent, socket, frame, warn, drain } = harness();
    socket.send(frame(COLLAB_MAX_PAYLOAD_BYTES)); // the largest document a client could have written, as one SyncStep2
    for (let i = 0; i < 50; i++) socket.send(frame(512)); // awareness and typing while it drains
    drain(1 * MiB); // it has read a little
    socket.send(frame(COLLAB_MAX_PAYLOAD_BYTES)); // a peer pastes the largest frame the server accepts
    for (let i = 0; i < 50; i++) {
      socket.send(frame(512));
      drain(64 * 1024);
    }
    expect(raw.terminate).not.toHaveBeenCalled();
    expect(sent).toHaveLength(102);
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a slow client that is draining one SyncStep2 larger than the whole allowance', () => {
    const { raw, sent, socket, frame, warn, drain } = harness();
    socket.send(frame(40 * MiB)); // a 40 MB document's SyncStep2 (editor edits are not size-capped)
    // the client reads slowly: awareness and updates keep arriving while it drains
    for (let i = 0; i < 400; i++) {
      socket.send(frame(2048));
      drain(100 * 1024);
    }
    expect(raw.terminate).not.toHaveBeenCalled();
    expect(sent).toHaveLength(401);
    expect(warn).not.toHaveBeenCalled();
  });

  it('terminates a client that never reads, owed SyncStep2 after SyncStep2, and drops the frame', () => {
    const { raw, sent, socket, frame, warn } = harness();
    for (let i = 0; i < 20; i++) socket.send(frame(7 * MiB));
    // the frame and its overhead are counted before it is queued: 0 + 7 and 7 + 7 fit 8 MiB + 7 MiB, 14 + 7 does not
    expect(sent).toEqual(Array(2).fill(7 * MiB));
    expect(raw.bufferedAmount).toBe(14 * MiB);
    expect(raw.terminate).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([
      [`COLLAB_SOCKET_LIMIT {"limit":"outbound_buffer","bufferedBytes":${14 * MiB},"pendingFrames":2,"frameBytes":${7 * MiB},"allowanceBytes":${15 * MiB}}`],
    ]);
  });

  it('never holds more than 8 MiB plus its largest frame, whatever mix of frame sizes it is owed', () => {
    for (const sizes of [
      [1 * MiB, 2 * MiB, 4 * MiB, 8 * MiB, 8 * MiB, 8 * MiB], // each frame bigger than the last: the allowance grows with it
      [8 * MiB, 7 * MiB, 8 * MiB - 1, 8 * MiB, 6 * MiB],
      Array(400).fill(100 * 1024),
    ]) {
      const { raw, socket, frame } = harness();
      let peak = 0;
      for (const n of sizes) {
        socket.send(frame(n));
        peak = Math.max(peak, raw.bufferedAmount);
      }
      expect(peak).toBeLessThanOrEqual(COLLAB_OUTBOUND_BUFFER_FACTOR * COLLAB_MAX_PAYLOAD_BYTES + Math.max(...sizes));
    }
  });

  it('terminates a client that never reads small broadcasts once past the allowance (each frame with its overhead)', () => {
    const { raw, sent, socket, frame } = harness();
    const n = (8 * MiB) / (64 * 1024) + 10;
    for (let i = 0; i < n; i++) socket.send(frame(64 * 1024));
    expect(raw.terminate).toHaveBeenCalledTimes(1);
    // k frames fit while k x (64 KiB + 512) <= 8 MiB + 64 KiB: exactly 128 (129 before #810 counted the overhead)
    expect(sent.length).toBe(Math.floor((8 * MiB + 64 * 1024) / (64 * 1024 + OVH)));
    expect(sent.length).toBe(128);
  });

  it('#810: a flood of tiny frames to a client that never reads is cut at about 15,000 frames, not 161,000', () => {
    const { raw, sent, socket, frame, bytes } = harness();
    for (let i = 0; i < 200_000 && raw.readyState === 1; i++) socket.send(frame(50));
    expect(raw.terminate).toHaveBeenCalledTimes(1);
    // (8 MiB + 50) / (50 + 512): the 50-byte frames' own bytes alone would allow 167,773 (161k on the wire with headers)
    expect(sent.length).toBe(Math.floor((8 * MiB + 50) / (50 + OVH)));
    expect(sent.length).toBeLessThan(15_000);
    // the heap they hold is bounded by the allowance: at the measured ~400 B a frame (limits.ts), under 6 MB
    expect(sent.length * 400).toBeLessThan(6 * 1000 * 1000);
    expect(bytes.pendingFrames(raw)).toBe(0); // cut: released, pending forgotten
  });

  it('#810: a drained frame (its send callback) stops counting its overhead', () => {
    const { raw, socket, frame, drain, bytes } = harness();
    for (let i = 0; i < 10; i++) socket.send(frame(100));
    expect(bytes.pendingFrames(raw)).toBe(10);
    expect(bytes.queued(raw)).toBe(10 * (100 + OVH));
    drain(350); // three and a half frames read
    expect(bytes.pendingFrames(raw)).toBe(7);
    expect(bytes.queued(raw)).toBe(650 + 7 * OVH);
    drain(650);
    expect(bytes.queued(raw)).toBe(0);
  });

  it('reports the raw socket closing, so Hocuspocus stops sending to a socket the client closed', () => {
    const { raw, inner, socket, frame } = harness();
    expect(socket.readyState).toBe(1);
    raw.readyState = 3;
    expect(socket.readyState).toBe(3);
    socket.send(frame(10));
    expect(raw.send).not.toHaveBeenCalled();
    expect(inner.send).not.toHaveBeenCalled();
    inner.readyState = 3;
    raw.readyState = 1;
    expect(socket.readyState).toBe(3);
  });

  it('close goes to the inner socket', () => {
    const { inner, socket } = harness();
    socket.close(4401, 'x');
    expect(inner.close).toHaveBeenCalledWith(4401, 'x');
  });
});
