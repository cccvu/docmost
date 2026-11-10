import { BoundedCollabSocket } from './bounded-socket';
import { COLLAB_MAX_PAYLOAD_BYTES, COLLAB_OUTBOUND_BUFFER_FACTOR } from './limits';
import { SocketLimitLog } from './socket-limit-log';

/**
 * #790: the outbound bound. A fake raw socket whose `bufferedAmount` the test moves: it grows by every frame the inner
 * socket sends and shrinks only when the test drains it (the client reading).
 */
const MiB = 1024 * 1024;

function harness() {
  const raw = { readyState: 1, bufferedAmount: 0, terminate: jest.fn(() => (raw.readyState = 2)) };
  const sent: number[] = [];
  const inner = {
    readyState: 1,
    send: jest.fn((m: Uint8Array) => {
      sent.push(m.byteLength);
      raw.bufferedAmount += m.byteLength;
    }),
    close: jest.fn(),
  };
  const warn = jest.fn();
  const socket = new BoundedCollabSocket(raw, inner, new SocketLimitLog({ warn }));
  const frame = (bytes: number) => new Uint8Array(bytes);
  return { raw, inner, sent, warn, socket, frame };
}

describe('#790 BoundedCollabSocket', () => {
  it('the allowance is one max payload above the largest frame sent (1 x 8 MiB)', () => {
    expect(COLLAB_OUTBOUND_BUFFER_FACTOR * COLLAB_MAX_PAYLOAD_BYTES).toBe(8 * MiB);
  });

  it("passes an honest slow client draining a maximal SyncStep2 while a peer's maximal paste is relayed to it", () => {
    const { raw, sent, socket, frame, warn } = harness();
    socket.send(frame(COLLAB_MAX_PAYLOAD_BYTES)); // the largest document a client could have written, as one SyncStep2
    for (let i = 0; i < 50; i++) socket.send(frame(512)); // awareness and typing while it drains
    raw.bufferedAmount -= 1 * MiB; // it has read a little
    socket.send(frame(COLLAB_MAX_PAYLOAD_BYTES)); // a peer pastes the largest frame the server accepts
    for (let i = 0; i < 50; i++) {
      socket.send(frame(512));
      raw.bufferedAmount = Math.max(0, raw.bufferedAmount - 64 * 1024);
    }
    expect(raw.terminate).not.toHaveBeenCalled();
    expect(sent).toHaveLength(102);
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a slow client that is draining one SyncStep2 larger than the whole allowance', () => {
    const { raw, sent, socket, frame, warn } = harness();
    socket.send(frame(40 * MiB)); // a 40 MB document's SyncStep2 (editor edits are not size-capped)
    // the client reads slowly: awareness and updates keep arriving while it drains
    for (let i = 0; i < 400; i++) {
      socket.send(frame(2048));
      raw.bufferedAmount = Math.max(0, raw.bufferedAmount - 100 * 1024);
    }
    expect(raw.terminate).not.toHaveBeenCalled();
    expect(sent).toHaveLength(401);
    expect(warn).not.toHaveBeenCalled();
  });

  it('terminates a client that never reads, owed SyncStep2 after SyncStep2, and drops the frame', () => {
    const { raw, sent, socket, frame, warn } = harness();
    for (let i = 0; i < 20; i++) socket.send(frame(8 * MiB));
    // passes while buffered <= 8 MiB + 8 MiB before the send: 0, 8, 16 -> three frames, the fourth terminates
    expect(sent).toEqual(Array(3).fill(8 * MiB));
    expect(raw.terminate).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([
      [`COLLAB_SOCKET_LIMIT {"limit":"outbound_buffer","bufferedBytes":${24 * MiB},"allowanceBytes":${16 * MiB}}`],
    ]);
  });

  it('terminates a client that never reads small broadcasts once past the allowance', () => {
    const { raw, sent, socket, frame } = harness();
    const n = (8 * MiB) / (64 * 1024) + 10;
    for (let i = 0; i < n; i++) socket.send(frame(64 * 1024));
    expect(raw.terminate).toHaveBeenCalledTimes(1);
    expect(sent.length).toBe((8 * MiB) / (64 * 1024) + 2);
  });

  it('reports the raw socket closing, so Hocuspocus stops sending to a socket the client closed', () => {
    const { raw, inner, socket, frame } = harness();
    expect(socket.readyState).toBe(1);
    raw.readyState = 3;
    expect(socket.readyState).toBe(3);
    socket.send(frame(10));
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
