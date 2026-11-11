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
 * Each frame still queued also counts COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES (#810): the heap ws spends on it, which
 * `bufferedAmount` does not show, so a flood of tiny frames is cut at about 15,000 of them (8 MiB / 564 B), not 161,000.
 * Frames are queued on the raw ws socket through the process byte budget (socket-bytes.ts), which passes ws the send
 * callback that counts them pending and charges them to the process total; `inner` (the backported WsSocketWrapper,
 * whose own send takes no callback) is only closed.
 *
 * `readyState` is the raw socket's once it is closing, so Hocuspocus stops sending to a socket the client closed
 * (the backported WsSocketWrapper keeps its own, which only its own `close()` moves).
 *
 * It also ends the socket's pre-auth slot (preauth-slots.ts, taken at the upgrade): the first `Authenticated` reply it
 * sends frees the slot, and a `PermissionDenied` reply sent while the socket holds one closes the socket (4401,
 * `permission-denied`, after the reply, so the editor still reads it and runs its token refetch), which then keeps the
 * slot only until it has closed. This is the one place that sees the replies of documents this node owns and of
 * documents RedisSync proxies to another node, so the close stays here rather than in a second wrapper on the send path.
 * Without the close, Hocuspocus 4.7.1 leaves a refused socket open and the provider reconnecting it keeps a slot for as
 * long as the editor stays open. Every other close the server starts while the socket holds a slot (`close`: Hocuspocus
 * closing a socket whose Auth frame it cannot decode, here or relayed from the node that owns the document) shortens the
 * slot the same way (#810): a closing handshake can take ws 30 s, and a complete but malformed Auth frame must not buy
 * the socket the overall pre-auth deadline. Built only by `CollabSocketBounds.open` (socket-bounds.ts).
 */
import * as decoding from 'lib0/decoding';
import { MessageType, type WebSocketLike } from '@hocuspocus/server';
import { AuthMessageType, WsReadyStates } from '@hocuspocus/common';
import { COLLAB_MAX_PAYLOAD_BYTES, COLLAB_OUTBOUND_BUFFER_FACTOR, COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES } from './limits';
import type { CollabPreAuthSlots, PreAuthSocket } from './preauth-slots';
import type { BytesSocket, CollabSocketBytes } from './socket-bytes';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

/** The socket close after a refused authentication (the 4401 Hocuspocus's own Unauthorized close uses). */
export const COLLAB_DENIED_CLOSE_CODE = 4401;

/** A Hocuspocus Auth reply, [documentName][Auth][Authenticated | PermissionDenied]…: which one, or null. Never throws. */
export function authReplyOf(frame: Uint8Array): 'authenticated' | 'denied' | null {
  try {
    const d = decoding.createDecoder(frame);
    decoding.readVarString(d);
    if (decoding.readVarUint(d) !== MessageType.Auth) return null;
    const subtype = decoding.readVarUint(d);
    return subtype === AuthMessageType.Authenticated ? 'authenticated' : subtype === AuthMessageType.PermissionDenied ? 'denied' : null;
  } catch {
    return null;
  }
}

/** The `ws` WebSocket surface used here. */
export interface RawCollabSocket extends PreAuthSocket, BytesSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  terminate(): void;
}

export interface BoundedCollabSocketOptions {
  /** The process's pre-auth slots, the same instance the ws adapter took this socket's slot from (socket-bounds.ts). */
  preAuth: CollabPreAuthSlots;
  /**
   * The process's byte budget (socket-bytes.ts), the same instance the ws adapter tracked this socket on: every frame
   * is queued through it, which counts the frames still pending. Required: a default would be a second budget.
   */
  bytes: CollabSocketBytes;
  limitLog?: SocketLimitLog;
}

export class BoundedCollabSocket implements WebSocketLike {
  private largestSent = 0;
  private readonly preAuth: CollabPreAuthSlots;
  private readonly bytes: CollabSocketBytes;
  private readonly limitLog: SocketLimitLog;

  constructor(
    private readonly raw: RawCollabSocket,
    private readonly inner: WebSocketLike,
    { preAuth, bytes, limitLog = collabSocketLimitLog }: BoundedCollabSocketOptions,
  ) {
    this.preAuth = preAuth;
    this.bytes = bytes;
    this.limitLog = limitLog;
  }

  /** The ws socket underneath (socket-documents.ts keys a socket's document connections by it). */
  get rawSocket(): RawCollabSocket {
    return this.raw;
  }

  get readyState(): number {
    return Math.max(this.inner.readyState, this.raw.readyState);
  }

  send(message: Uint8Array): void {
    if (this.readyState !== WsReadyStates.Open) return;
    const largest = Math.max(this.largestSent, message.byteLength);
    const allowance = COLLAB_OUTBOUND_BUFFER_FACTOR * COLLAB_MAX_PAYLOAD_BYTES + largest;
    const queued = this.bytes.queued(this.raw);
    if (queued + message.byteLength + COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES > allowance) {
      this.limitLog.log('outbound_buffer', {
        bufferedBytes: this.raw.bufferedAmount,
        pendingFrames: this.bytes.pendingFrames(this.raw),
        frameBytes: message.byteLength,
        allowanceBytes: allowance,
      });
      this.bytes.release(this.raw); // its queue goes with it: no longer the process budget's
      this.raw.terminate();
      return;
    }
    this.largestSent = largest;
    const reply = this.preAuth.holds(this.raw) ? authReplyOf(message) : null;
    if (reply === 'authenticated') {
      this.preAuth.release(this.raw);
      this.bytes.authenticated(this.raw);
    }
    this.bytes.send(this.raw, message);
    if (reply === 'denied') {
      this.preAuth.closing(this.raw);
      this.inner.close(COLLAB_DENIED_CLOSE_CODE, 'permission-denied');
    }
  }

  close(code?: number, reason?: string): void {
    if (this.preAuth.holds(this.raw)) this.preAuth.closing(this.raw);
    this.inner.close(code, reason);
  }
}
