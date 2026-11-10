/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * The socket Hocuspocus writes to, on both gateway paths (RedisSync and standalone), with an outbound bound.
 *
 * Hocuspocus's `Connection.send` never looks at `bufferedAmount`, so a client that stops reading keeps the server
 * queueing every broadcast, awareness echo and SyncStep2 it is owed, without limit, in ws's send buffer. On each
 * send this terminates the raw socket (and drops the frame) when sending it would take `bufferedAmount` past
 * COLLAB_OUTBOUND_BUFFER_FACTOR x COLLAB_MAX_PAYLOAD_BYTES plus the largest frame this socket has been sent, this one
 * included. The frame is counted BEFORE it is queued, so a socket never holds more than that: 16 MiB for frames up to
 * maxPayload, however many of them it is owed. An honest slow client draining one big SyncStep2 stays under it: the
 * allowance grows with that frame, and what is relayed meanwhile fits in one maxPayload (limits.ts). This checks only
 * when something is sent; a socket owed nothing more
 * that stops reading is cut off by the stall check on the keepalive tick (socket-keepalive.ts).
 *
 * `readyState` is the raw socket's once it is closing, so Hocuspocus stops sending to a socket the client closed
 * (the backported WsSocketWrapper keeps its own, which only its own `close()` moves).
 */
import type { WebSocketLike } from '@hocuspocus/server';
import { COLLAB_MAX_PAYLOAD_BYTES, COLLAB_OUTBOUND_BUFFER_FACTOR } from './limits';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

/** The `ws` WebSocket surface used here. */
export interface RawCollabSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  terminate(): void;
}

const OPEN = 1;

export class BoundedCollabSocket implements WebSocketLike {
  private largestSent = 0;

  constructor(
    private readonly raw: RawCollabSocket,
    private readonly inner: WebSocketLike,
    private readonly limitLog: SocketLimitLog = collabSocketLimitLog,
  ) {}

  /** The ws socket underneath (socket-documents.ts keys a socket's document connections by it). */
  get rawSocket(): RawCollabSocket {
    return this.raw;
  }

  get readyState(): number {
    return Math.max(this.inner.readyState, this.raw.readyState);
  }

  send(message: Uint8Array): void {
    if (this.readyState !== OPEN) return;
    const largest = Math.max(this.largestSent, message.byteLength);
    const allowance = COLLAB_OUTBOUND_BUFFER_FACTOR * COLLAB_MAX_PAYLOAD_BYTES + largest;
    const buffered = this.raw.bufferedAmount;
    if (buffered + message.byteLength > allowance) {
      this.limitLog.log('outbound_buffer', { bufferedBytes: buffered, frameBytes: message.byteLength, allowanceBytes: allowance });
      this.raw.terminate();
      return;
    }
    this.largestSent = largest;
    this.inner.send(message);
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }
}
