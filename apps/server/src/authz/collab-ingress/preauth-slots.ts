/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * A process-wide bound on UNAUTHENTICATED collab sockets. A socket has no user before it authenticates, so the per-user
 * bounds cannot cover it, and without this the total is bounded only at the edge, which a client reaching the load
 * balancer directly skips.
 *
 * - **At the upgrade** (`verifyCollabUpgrade`, the ws server's `verifyClient`, seam §226): past
 *   COLLAB_PREAUTH_SOCKETS held slots the upgrade is refused `503` with `Retry-After`, before ws creates a socket or
 *   reads a frame byte. The browser sees a failed connection, which the provider retries with backoff.
 * - **A slot is held** from the upgrade (`holdCollabPreAuth`, called by the ws adapter with the upgraded TCP socket,
 *   seam §226) until the socket's first `Authenticated` reply is SENT (`BoundedCollabSocket.send`, which sees the
 *   replies of documents this node owns and of documents RedisSync proxies to another node alike), or the socket closes.
 * - **Bytes**: while it holds a slot, every byte the socket's TCP socket delivers is counted (Node's public `data`
 *   event, so a partial frame ws is still assembling counts too); past COLLAB_PREAUTH_BYTES it is terminated
 *   (`preauth_bytes`). Its pre-auth queue and any partial frame are made of those bytes, so one unauthenticated socket
 *   holds at most COLLAB_PREAUTH_BYTES of them.
 * - **A deadline**: a socket still unauthenticated COLLAB_PREAUTH_DEADLINE_MS after it opened is terminated
 *   (`preauth_deadline`). Hocuspocus 4.7.1's own deadline is its `timeout` (60 s, checked every 60 s, so up to 120 s),
 *   which is also its idle timeout, so it cannot be shortened alone.
 * - **A refused authentication** closes the socket (`BoundedCollabSocket.send` sees the `PermissionDenied` reply) and
 *   `closing` shortens its deadline to COLLAB_PREAUTH_CLOSE_GRACE_MS; it keeps its slot and its byte count until it has
 *   closed, so a socket on its way out cannot hold memory the bound does not count.
 *
 * ws's check runs synchronously and the adapter's upgrade callback follows in the same call (no `await` between the
 * 503 decision and the slot being taken), so concurrent upgrades cannot all pass one free slot.
 */
import type { IncomingMessage } from 'http';
import {
  COLLAB_PREAUTH_BYTES,
  COLLAB_PREAUTH_CLOSE_GRACE_MS,
  COLLAB_PREAUTH_DEADLINE_MS,
  COLLAB_PREAUTH_SOCKETS,
} from './limits';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

/** The ws socket surface used here. */
export interface PreAuthSocket {
  terminate(): void;
  once?(event: 'close', listener: () => void): unknown;
}

/** The upgraded TCP socket surface used here (a `net.Socket`). */
export interface PreAuthTransport {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

type Held = { timer: ReturnType<typeof setTimeout>; detach: () => void };

export class CollabPreAuthSlots {
  private readonly held = new Map<object, Held>();

  constructor(
    private readonly cap: number = COLLAB_PREAUTH_SOCKETS,
    private readonly deadlineMs: number = COLLAB_PREAUTH_DEADLINE_MS,
    private readonly limitLog: SocketLimitLog = collabSocketLimitLog,
    private readonly bytesCap: number = COLLAB_PREAUTH_BYTES,
    private readonly closeGraceMs: number = COLLAB_PREAUTH_CLOSE_GRACE_MS,
  ) {}

  /** At the upgrade: false (logged) when the process already holds the cap. Takes nothing. */
  admit(): boolean {
    if (this.held.size < this.cap) return true;
    this.limitLog.log('preauth_sockets', { held: this.held.size });
    return false;
  }

  /**
   * After the upgrade: hold a slot until the socket authenticates or closes, count what its TCP socket delivers (when
   * one is given), and terminate it at the deadline or past the byte cap.
   */
  hold(socket: PreAuthSocket, transport?: PreAuthTransport): void {
    if (this.held.has(socket)) return;
    let bytes = 0;
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= this.bytesCap || !this.held.has(socket)) return;
      this.limitLog.log('preauth_bytes', { bytes });
      this.release(socket);
      socket.terminate();
    };
    transport?.on('data', onData);
    const entry: Held = {
      timer: this.deadline(socket, this.deadlineMs, 'preauth_deadline'),
      detach: () => transport?.off('data', onData),
    };
    this.held.set(socket, entry);
    socket.once?.('close', () => this.release(socket));
  }

  /** The socket's first Authenticated reply was sent, or it closed: free its slot and stop counting. Idempotent. */
  release(socket: object): void {
    const entry = this.held.get(socket);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.detach();
    this.held.delete(socket);
  }

  /** Its authentication was refused and it is being closed: it keeps its slot, now for COLLAB_PREAUTH_CLOSE_GRACE_MS. */
  closing(socket: PreAuthSocket): void {
    const entry = this.held.get(socket);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = this.deadline(socket, this.closeGraceMs, 'preauth_close_grace');
  }

  /** True while `socket` holds a slot (it has not authenticated yet). */
  holds(socket: object): boolean {
    return this.held.has(socket);
  }

  /** Slots held (specs and diagnostics). */
  get size(): number {
    return this.held.size;
  }

  private deadline(socket: PreAuthSocket, ms: number, limit: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (!this.held.has(socket)) return;
      this.release(socket);
      this.limitLog.log(limit, { deadlineMs: ms });
      socket.terminate();
    }, ms);
    timer.unref?.();
    return timer;
  }
}

/** The process's slots: checked and taken at the upgrade (the ws adapter), released by `BoundedCollabSocket`. */
export const collabPreAuthSlots = new CollabPreAuthSlots();

type VerifyCallback = (verified: boolean, code?: number, message?: string, headers?: Record<string, string>) => void;

/** Answer an upgrade from `slots`, synchronously: admitted, or a 503 with `Retry-After`. */
export function answerCollabUpgrade(slots: CollabPreAuthSlots, done: VerifyCallback): void {
  if (slots.admit()) done(true);
  else done(false, 503, 'Service Unavailable', { 'Retry-After': '5' });
}

/**
 * The collab ws server's `verifyClient`. Exactly two parameters: ws calls the two-argument form with a callback (and
 * answers 401 for the one-argument form), and this answers it synchronously, so ws completes the upgrade and calls the
 * adapter's callback (`holdCollabPreAuth`) in the same call.
 */
export function verifyCollabUpgrade(_info: { req: IncomingMessage }, done: VerifyCallback): void {
  answerCollabUpgrade(collabPreAuthSlots, done);
}

/** The ws adapter's upgrade callback: the new ws socket takes its slot, counting the TCP socket it was upgraded from. */
export function holdCollabPreAuth(ws: PreAuthSocket, transport: PreAuthTransport): void {
  collabPreAuthSlots.hold(ws, transport);
}
