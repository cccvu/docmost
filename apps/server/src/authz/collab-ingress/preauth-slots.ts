/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * A process-wide bound on UNAUTHENTICATED collab sockets. A socket has no user before it authenticates, so the per-user
 * bounds cannot cover it, and without this the total is bounded only at the edge, which a client reaching the load
 * balancer directly skips.
 *
 * - **At the upgrade** (`CollabSocketBounds.verifyUpgrade`, the ws server's `verifyClient`, seam §226): past
 *   COLLAB_PREAUTH_SOCKETS held slots the upgrade is refused `503` with `Retry-After`, before ws creates a socket or
 *   reads a frame byte. The browser sees a failed connection, which the provider retries with backoff.
 * - **A slot is held** from the upgrade (`CollabSocketBounds.holdUpgraded`, called by the ws adapter with the upgraded
 *   TCP socket, seam §226) until the socket's first `Authenticated` reply is SENT (`BoundedCollabSocket.send`, which
 *   sees the replies of documents this node owns and of documents RedisSync proxies to another node alike), or the
 *   socket closes.
 * - **Bytes**: while it holds a slot, every byte the socket's TCP socket delivers is counted (Node's public `data`
 *   event, so a partial frame ws is still assembling counts too). Its pre-auth queue and any partial frame are made of
 *   those bytes. One socket past COLLAB_PREAUTH_SOCKET_BYTES is terminated (`preauth_bytes`); and when all of them
 *   together pass COLLAB_PREAUTH_TOTAL_BYTES, the one holding the most is terminated (`preauth_total_bytes`) until the
 *   total is back under, so a client that fills the budget loses its own largest sockets, not the honest small ones.
 * - **Two deadlines** (#810 N1): a socket that has not sent a complete Auth frame COLLAB_PREAUTH_AUTH_FRAME_MS after
 *   it opened is terminated (`preauth_first_auth`). Its FIRST Auth frame (`authArrived`, called by the gateway's frame
 *   check on both paths, before RedisSync or Hocuspocus reads it) moves that deadline, once, to
 *   COLLAB_PREAUTH_DEADLINE_MS after the upgrade (`preauth_deadline`): absolute, so no later frame extends it. A silent
 *   socket, the cheapest way to hold a slot, holds it half as long. The first-Auth timer re-checks one `setImmediate`
 *   later, so an Auth frame already read in the same turn of the event loop is not cut. Hocuspocus 4.7.1's own deadline
 *   is its `timeout` (60 s, checked every 60 s, so up to 120 s), which is also its idle timeout, so it cannot be
 *   shortened alone.
 * - **A server close**: a refused authentication (`BoundedCollabSocket.send` sees the `PermissionDenied` reply) or any
 *   other close the server starts while the socket is unauthenticated (`BoundedCollabSocket.close`: Hocuspocus closes a
 *   socket whose Auth frame it cannot decode) calls `closing`, which shortens its deadline to
 *   COLLAB_PREAUTH_CLOSE_GRACE_MS, once; it keeps its slot and its byte count until it has closed, so a socket on its way
 *   out cannot hold memory the bound does not count, and a complete but malformed Auth buys no more than the grace.
 *
 * ws's check runs synchronously and the adapter's upgrade callback follows in the same call (no `await` between the
 * 503 decision and the slot being taken), so concurrent upgrades cannot all pass one free slot.
 *
 * One instance per process, owned by `CollabSocketBounds` (socket-bounds.ts), which the adapter takes the slot from and
 * every `BoundedCollabSocket` releases it to: an adapter and a gateway on different instances would leak every slot.
 */
import {
  COLLAB_PREAUTH_AUTH_FRAME_MS,
  COLLAB_PREAUTH_CLOSE_GRACE_MS,
  COLLAB_PREAUTH_DEADLINE_MS,
  COLLAB_PREAUTH_SOCKET_BYTES,
  COLLAB_PREAUTH_SOCKETS,
  COLLAB_PREAUTH_TOTAL_BYTES,
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

/** Where a held socket is: no Auth frame yet, its first Auth arrived (authenticating), or the server is closing it. */
type Phase = 'awaiting_auth' | 'authenticating' | 'closing';
type Held = {
  socket: PreAuthSocket;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
  bytes: number;
  openedAt: number;
  phase: Phase;
};

/** Every bound defaults to its limits.ts constant; specs override them by name. */
export interface CollabPreAuthSlotsOptions {
  /** Slots (unauthenticated sockets) the process may hold: COLLAB_PREAUTH_SOCKETS. */
  cap?: number;
  /** From the upgrade to the first Authenticated reply: COLLAB_PREAUTH_DEADLINE_MS. */
  deadlineMs?: number;
  /** From the upgrade to the first complete Auth frame: COLLAB_PREAUTH_AUTH_FRAME_MS (never more than `deadlineMs`). */
  firstAuthMs?: number;
  /** A refused socket's slot while it closes: COLLAB_PREAUTH_CLOSE_GRACE_MS. */
  closeGraceMs?: number;
  /** Bytes one unauthenticated socket may deliver: COLLAB_PREAUTH_SOCKET_BYTES. */
  socketBytes?: number;
  /** Bytes all of them together may deliver: COLLAB_PREAUTH_TOTAL_BYTES. */
  totalBytes?: number;
  limitLog?: SocketLimitLog;
}

export class CollabPreAuthSlots {
  private readonly held = new Map<object, Held>();
  private totalBytes = 0;
  private readonly cap: number;
  private readonly deadlineMs: number;
  private readonly firstAuthMs: number;
  private readonly closeGraceMs: number;
  private readonly socketBytesCap: number;
  private readonly totalBytesCap: number;
  private readonly limitLog: SocketLimitLog;

  constructor({
    cap = COLLAB_PREAUTH_SOCKETS,
    deadlineMs = COLLAB_PREAUTH_DEADLINE_MS,
    firstAuthMs = COLLAB_PREAUTH_AUTH_FRAME_MS,
    closeGraceMs = COLLAB_PREAUTH_CLOSE_GRACE_MS,
    socketBytes = COLLAB_PREAUTH_SOCKET_BYTES,
    totalBytes = COLLAB_PREAUTH_TOTAL_BYTES,
    limitLog = collabSocketLimitLog,
  }: CollabPreAuthSlotsOptions = {}) {
    this.cap = cap;
    this.deadlineMs = deadlineMs;
    this.firstAuthMs = Math.min(firstAuthMs, deadlineMs);
    this.closeGraceMs = closeGraceMs;
    this.socketBytesCap = socketBytes;
    this.totalBytesCap = totalBytes;
    this.limitLog = limitLog;
  }

  /** At the upgrade: false (logged) when the process already holds the cap. Takes nothing. */
  admit(): boolean {
    if (this.held.size < this.cap) return true;
    this.limitLog.log('preauth_sockets', { held: this.held.size });
    return false;
  }

  /**
   * After the upgrade: hold a slot until the socket authenticates or closes, count what its TCP socket delivers (when
   * one is given), and terminate it past the byte cap, or at the first-Auth deadline unless `authArrived` moves it.
   */
  hold(socket: PreAuthSocket, transport?: PreAuthTransport): void {
    if (this.held.has(socket)) return;
    const onData = (chunk: Buffer) => {
      const entry = this.held.get(socket);
      if (!entry) return;
      entry.bytes += chunk.length;
      this.totalBytes += chunk.length;
      if (entry.bytes > this.socketBytesCap) {
        this.limitLog.log('preauth_bytes', { bytes: entry.bytes });
        this.cut(entry);
      }
      while (this.totalBytes > this.totalBytesCap) {
        const largest = this.largest();
        if (!largest) break;
        this.limitLog.log('preauth_total_bytes', { bytes: largest.bytes, totalBytes: this.totalBytes });
        this.cut(largest);
      }
    };
    transport?.on('data', onData);
    const entry: Held = {
      socket,
      timer: this.firstAuthDeadline(socket),
      detach: () => transport?.off('data', onData),
      bytes: 0,
      openedAt: Date.now(),
      phase: 'awaiting_auth',
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
    this.totalBytes -= entry.bytes;
    this.held.delete(socket);
  }

  /** Bytes all unauthenticated sockets hold (specs and diagnostics). */
  get bytes(): number {
    return this.totalBytes;
  }

  private cut(entry: Held): void {
    this.release(entry.socket);
    entry.socket.terminate();
  }

  /** The unauthenticated socket holding the most bytes (O(slots), only once the total is over its budget). */
  private largest(): Held | null {
    let top: Held | null = null;
    for (const entry of this.held.values()) if (!top || entry.bytes > top.bytes) top = entry;
    return top;
  }

  /**
   * The socket's first complete Auth frame was admitted (frame-admission.ts): its deadline moves, once, from the first-Auth
   * deadline to COLLAB_PREAUTH_DEADLINE_MS after the upgrade. A later Auth, or one after a close began, changes nothing.
   */
  authArrived(socket: object): void {
    const entry = this.held.get(socket);
    if (!entry || entry.phase !== 'awaiting_auth') return;
    entry.phase = 'authenticating';
    clearTimeout(entry.timer);
    entry.timer = this.deadline(entry.socket, Math.max(0, this.deadlineMs - (Date.now() - entry.openedAt)), 'preauth_deadline', this.deadlineMs);
  }

  /**
   * The server is closing it (a refused authentication, or any close the server started before it authenticated): it
   * keeps its slot, now for at most COLLAB_PREAUTH_CLOSE_GRACE_MS. Only the first call shortens; a later one changes
   * nothing, so repeated closes never extend the grace.
   */
  closing(socket: PreAuthSocket): void {
    const entry = this.held.get(socket);
    if (!entry || entry.phase === 'closing') return;
    entry.phase = 'closing';
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

  /** Terminate `socket` (logged as `limit` with `loggedMs`) `ms` from now unless it has left its slot by then. */
  private deadline(socket: PreAuthSocket, ms: number, limit: string, loggedMs: number = ms): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.expire(socket, limit, loggedMs), ms);
    timer.unref?.();
    return timer;
  }

  /**
   * The first-Auth deadline. Node runs expired timers before it reads sockets, so an Auth frame already waiting in the
   * kernel would be read only after this fires: the check waits one `setImmediate` (after that read) and cuts the socket
   * only if no Auth arrived and nothing else moved its deadline.
   */
  private firstAuthDeadline(socket: PreAuthSocket): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      setImmediate(() => {
        if (this.held.get(socket)?.phase !== 'awaiting_auth') return;
        this.expire(socket, 'preauth_first_auth', this.firstAuthMs);
      });
    }, this.firstAuthMs);
    timer.unref?.();
    return timer;
  }

  private expire(socket: PreAuthSocket, limit: string, deadlineMs: number): void {
    if (!this.held.has(socket)) return;
    this.release(socket);
    this.limitLog.log(limit, { deadlineMs });
    socket.terminate();
  }
}

export type VerifyCallback = (verified: boolean, code?: number, message?: string, headers?: Record<string, string>) => void;

/** Answer an upgrade from `slots`, synchronously: admitted, or a 503 with `Retry-After`. */
export function answerCollabUpgrade(slots: CollabPreAuthSlots, done: VerifyCallback): void {
  if (slots.admit()) done(true);
  else done(false, 503, 'Service Unavailable', { 'Retry-After': '5' });
}
