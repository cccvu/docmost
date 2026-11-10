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
 * when something is sent; a socket owed nothing more that stops reading is cut off by the stall check on the keepalive
 * tick (socket-keepalive.ts).
 *
 * `readyState` is the raw socket's once it is closing, so Hocuspocus stops sending to a socket the client closed
 * (the backported WsSocketWrapper keeps its own, which only its own `close()` moves).
 *
 * It also holds the socket's pre-auth slot (preauth-slots.ts) from construction (the connection, on both gateway paths)
 * until the first `Authenticated` reply it sends: the one place that sees the replies of documents this node owns and
 * of documents RedisSync proxies to another node.
 */
import * as decoding from 'lib0/decoding';
import type { WebSocketLike } from '@hocuspocus/server';
import { COLLAB_MAX_PAYLOAD_BYTES, COLLAB_OUTBOUND_BUFFER_FACTOR } from './limits';
import { collabPreAuthSlots, type CollabPreAuthSlots, type PreAuthSocket } from './preauth-slots';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

const AUTH = 2; // Hocuspocus MessageType.Auth
const AUTHENTICATED = 2; // @hocuspocus/common AuthMessageType.Authenticated

/** True when `frame` is a Hocuspocus `Authenticated` reply: [documentName][Auth][Authenticated][scope]. Never throws. */
export function isAuthenticatedReply(frame: Uint8Array): boolean {
  try {
    const d = decoding.createDecoder(frame);
    decoding.readVarString(d);
    return decoding.readVarUint(d) === AUTH && decoding.readVarUint(d) === AUTHENTICATED;
  } catch {
    return false;
  }
}

/** The `ws` WebSocket surface used here. */
export interface RawCollabSocket extends PreAuthSocket {
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
    private readonly preAuth: CollabPreAuthSlots = collabPreAuthSlots,
  ) {
    preAuth.hold(raw);
  }

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
    if (this.preAuth.holds(this.raw) && isAuthenticatedReply(message)) this.preAuth.release(this.raw);
    this.inner.send(message);
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }
}
