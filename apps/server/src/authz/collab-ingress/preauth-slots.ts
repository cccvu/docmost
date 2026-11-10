/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * A process-wide bound on UNAUTHENTICATED collab sockets. Before its first successful authentication a socket can hold
 * about 16 MiB of native memory: Hocuspocus 4.7.1's pre-auth queue (`maxUnauthenticatedQueueSize`, 8 MiB) plus a partial
 * frame of up to `maxPayload` (8 MiB) that ws buffers before anything sees it. Every other collab bound is per socket
 * or per user, and a socket has no user before it authenticates, so without this the total is bounded only at the
 * edge, which a client reaching the load balancer directly skips.
 *
 * - **At the upgrade** (`verifyCollabUpgrade`, the ws server's `verifyClient`, seam §226): past
 *   COLLAB_PREAUTH_SOCKETS held slots the upgrade is refused `503` with `Retry-After`, before ws creates a socket or
 *   reads a frame byte. The browser sees a failed connection, which the provider retries with backoff.
 * - **A slot is held** from the connection (`BoundedCollabSocket`'s constructor, on both gateway paths) until the
 *   socket's first `Authenticated` reply is SENT (`BoundedCollabSocket.send`, which sees the replies of documents this
 *   node owns and of documents RedisSync proxies to another node alike), or the socket closes.
 * - **A deadline**: a socket still unauthenticated COLLAB_PREAUTH_DEADLINE_MS after it opened is terminated (logged
 *   `preauth_deadline`). Hocuspocus 4.7.1's own deadline is its `timeout` (60 s, checked every 60 s, so up to 120 s),
 *   which is also its idle timeout, so it cannot be shortened alone.
 *
 * ws's check runs synchronously and its `connection` event follows in the same call (no `await` between the 503
 * decision and the slot being taken), so concurrent upgrades cannot all pass one free slot. ws's partial-frame buffer is
 * not reachable without its internals, so this cap (with `maxPayload`) is that buffer's bound.
 */
import type { IncomingMessage } from 'http';
import { COLLAB_PREAUTH_DEADLINE_MS, COLLAB_PREAUTH_SOCKETS } from './limits';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

/** The ws socket surface used here. */
export interface PreAuthSocket {
  terminate(): void;
  once?(event: 'close', listener: () => void): unknown;
}

export class CollabPreAuthSlots {
  private readonly held = new Map<object, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly cap: number = COLLAB_PREAUTH_SOCKETS,
    private readonly deadlineMs: number = COLLAB_PREAUTH_DEADLINE_MS,
    private readonly limitLog: SocketLimitLog = collabSocketLimitLog,
  ) {}

  /** At the upgrade: false (logged) when the process already holds the cap. Takes nothing. */
  admit(): boolean {
    if (this.held.size < this.cap) return true;
    this.limitLog.log('preauth_sockets', { held: this.held.size });
    return false;
  }

  /** At the connection: hold a slot until the socket authenticates or closes; terminate it at the deadline. */
  hold(socket: PreAuthSocket): void {
    if (this.held.has(socket)) return;
    const timer = setTimeout(() => {
      if (!this.held.delete(socket)) return;
      this.limitLog.log('preauth_deadline', { deadlineMs: this.deadlineMs });
      socket.terminate();
    }, this.deadlineMs);
    timer.unref?.();
    this.held.set(socket, timer);
    socket.once?.('close', () => this.release(socket));
  }

  /** The socket's first Authenticated reply was sent, or it closed: free its slot. Idempotent. */
  release(socket: object): void {
    const timer = this.held.get(socket);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.held.delete(socket);
  }

  /** True while `socket` holds a slot (it has not authenticated yet). */
  holds(socket: object): boolean {
    return this.held.has(socket);
  }

  /** Slots held (specs and diagnostics). */
  get size(): number {
    return this.held.size;
  }
}

/** The process's slots: checked at the upgrade (the ws adapter), held and released by `BoundedCollabSocket`. */
export const collabPreAuthSlots = new CollabPreAuthSlots();

type VerifyCallback = (verified: boolean, code?: number, message?: string, headers?: Record<string, string>) => void;

/** Answer an upgrade from `slots`, synchronously: admitted, or a 503 with `Retry-After`. */
export function answerCollabUpgrade(slots: CollabPreAuthSlots, done: VerifyCallback): void {
  if (slots.admit()) done(true);
  else done(false, 503, 'Service Unavailable', { 'Retry-After': '5' });
}

/**
 * The collab ws server's `verifyClient`. Exactly two parameters: ws calls the two-argument form with a callback (and
 * answers 401 for the one-argument form), and this answers it synchronously, so ws completes the upgrade and emits
 * `connection` in the same call.
 */
export function verifyCollabUpgrade(_info: { req: IncomingMessage }, done: VerifyCallback): void {
  answerCollabUpgrade(collabPreAuthSlots, done);
}
