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
 *   The total also charges each read COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES (#810), the heap ws holds per read while it
 *   assembles a frame, the same constant the post-auth byte budget charges (socket-bytes.ts): without it a socket that
 *   delivers a partial frame in tiny TCP reads holds up to `maxBufferedChunks` (65,536) reads of about 230 B of heap
 *   each, about 15 MB, counted as the 64 KiB of bytes it carried. The charge never leaves the socket before it is
 *   released (a frame ws completed no longer holds its reads, so it over-counts, the safe direction), and it is NOT
 *   added to the per-socket count: one socket's cap stays bytes only, so an honest Auth, however its reads are split,
 *   is never cut by it; only the process total, where the socket charged the most is the one cut, sees it.
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
 * - **Per address** (#810): once the platform's trust list is known (client-trust.ts), each upgrade is keyed by its
 *   client address (client-address.ts) and one key holds at most COLLAB_PREAUTH_SOCKETS_PER_ADDRESS slots; past it the
 *   upgrade is refused `429` with `Retry-After` (a 4xx, so one address stays out of the ALB 5xx alarm; `503` stays the
 *   signal that the whole pool is full). An upgrade with two X-Forwarded-For lines, or whose address is not an IP, is
 *   refused `400`: keying it would hand its sender a second share. While the trust is unknown none of this applies, and
 *   the upgrade is decided exactly as before #810 (two X-Forwarded-For lines included), so a missing platform answer
 *   never collapses proxied users into one key. The key is stashed per request at the decision and taken by `hold`,
 *   so the count cannot drift from the decision; every exit (`release`) gives it back.
 *
 * ws's check runs synchronously and the adapter's upgrade callback follows in the same call (no `await` between the
 * 503 decision and the slot being taken), so concurrent upgrades cannot all pass one free slot (nor one address's).
 *
 * One instance per process, owned by `CollabSocketBounds` (socket-bounds.ts), which the adapter takes the slot from and
 * every `BoundedCollabSocket` releases it to: an adapter and a gateway on different instances would leak every slot.
 */
import {
  COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES,
  COLLAB_PREAUTH_AUTH_FRAME_MS,
  COLLAB_PREAUTH_CLOSE_GRACE_MS,
  COLLAB_PREAUTH_DEADLINE_MS,
  COLLAB_PREAUTH_SOCKET_BYTES,
  COLLAB_PREAUTH_SOCKETS,
  COLLAB_PREAUTH_SOCKETS_PER_ADDRESS,
  COLLAB_PREAUTH_TOTAL_BYTES,
} from './limits';
import type { ClientAddressRequest, ClientKey } from './client-address';
import { collabSocketLimitLog, type SocketLimit, type SocketLimitLog } from './socket-limit-log';

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
  /** Bytes its TCP socket delivered (the per-socket cap). */
  bytes: number;
  /** What it adds to the process total: `bytes` plus the per-read overhead for every read. */
  charged: number;
  openedAt: number;
  phase: Phase;
  /** The client address key it counts against, when the share was active at its upgrade. */
  key?: string;
};

/** An upgrade's answer: admitted, the pool full (503), its address at its share (429), or not keyable (400). */
export type UpgradeDecision = 'ok' | 'pool' | 'address' | 'refused';

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
  /** Bytes (and per-read overhead) all of them together may hold: COLLAB_PREAUTH_TOTAL_BYTES. */
  totalBytes?: number;
  /** Charged to the total for every TCP read, on top of its bytes: COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES. */
  readOverhead?: number;
  /** Slots one client address may hold: COLLAB_PREAUTH_SOCKETS_PER_ADDRESS. */
  perAddress?: number;
  /** An upgrade's client key, or null while the share is off (CollabClientTrust.keyFor). Absent: always off. */
  clientKey?: (req: ClientAddressRequest) => ClientKey | null;
  limitLog?: SocketLimitLog;
}

export class CollabPreAuthSlots {
  private readonly held = new Map<object, Held>();
  /** Slots held per client key; a key at 0 is deleted, so it holds at most `cap` entries. */
  private readonly perKey = new Map<string, number>();
  /** Each admitted upgrade's key, from the decision to `hold` (the same synchronous ws call). */
  private readonly admitted = new WeakMap<object, string>();
  private totalBytes = 0;
  private readonly cap: number;
  private readonly deadlineMs: number;
  private readonly firstAuthMs: number;
  private readonly closeGraceMs: number;
  private readonly socketBytesCap: number;
  private readonly totalBytesCap: number;
  private readonly readOverhead: number;
  private readonly perAddressCap: number;
  private readonly clientKey: (req: ClientAddressRequest) => ClientKey | null;
  private readonly limitLog: SocketLimitLog;

  constructor({
    cap = COLLAB_PREAUTH_SOCKETS,
    deadlineMs = COLLAB_PREAUTH_DEADLINE_MS,
    firstAuthMs = COLLAB_PREAUTH_AUTH_FRAME_MS,
    closeGraceMs = COLLAB_PREAUTH_CLOSE_GRACE_MS,
    socketBytes = COLLAB_PREAUTH_SOCKET_BYTES,
    totalBytes = COLLAB_PREAUTH_TOTAL_BYTES,
    readOverhead = COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES,
    perAddress = COLLAB_PREAUTH_SOCKETS_PER_ADDRESS,
    clientKey = () => null,
    limitLog = collabSocketLimitLog,
  }: CollabPreAuthSlotsOptions = {}) {
    this.cap = cap;
    this.deadlineMs = deadlineMs;
    this.firstAuthMs = Math.min(firstAuthMs, deadlineMs);
    this.closeGraceMs = closeGraceMs;
    this.socketBytesCap = socketBytes;
    this.totalBytesCap = totalBytes;
    this.readOverhead = readOverhead;
    this.perAddressCap = perAddress;
    this.clientKey = clientKey;
    this.limitLog = limitLog;
  }

  /**
   * At the upgrade (synchronous, from ws's `verifyClient`): the answer for `req`. Takes nothing; an admitted request's
   * key is stashed for `hold`. While the share is off this is exactly `admit()`.
   */
  admitUpgrade(req: ClientAddressRequest): UpgradeDecision {
    const client = this.clientKey(req);
    if (client?.status === 'refused') {
      this.limitLog.log('client_address_refused', { why: client.why });
      return 'refused';
    }
    if (client?.status === 'keyed') {
      const held = this.perKey.get(client.key) ?? 0;
      if (held >= this.perAddressCap) {
        this.limitLog.log('client_address', { held, cap: this.perAddressCap, hop: client.hop, kind: client.kind });
        return 'address';
      }
    }
    if (!this.admit()) return 'pool';
    if (client?.status === 'keyed') this.admitted.set(req, client.key);
    return 'ok';
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
  hold(socket: PreAuthSocket, transport?: PreAuthTransport, req?: object): void {
    if (this.held.has(socket)) return;
    const key = req ? this.admitted.get(req) : undefined;
    if (req) this.admitted.delete(req);
    const onData = (chunk: Buffer) => {
      const entry = this.held.get(socket);
      if (!entry) return;
      entry.bytes += chunk.length;
      const charge = chunk.length + this.readOverhead;
      entry.charged += charge;
      this.totalBytes += charge;
      if (entry.bytes > this.socketBytesCap) {
        this.limitLog.log('preauth_bytes', { bytes: entry.bytes });
        this.cut(entry);
      }
      while (this.totalBytes > this.totalBytesCap) {
        const largest = this.largest();
        if (!largest) break;
        this.limitLog.log('preauth_total_bytes', { bytes: largest.charged, totalBytes: this.totalBytes });
        this.cut(largest);
      }
    };
    transport?.on('data', onData);
    const entry: Held = {
      socket,
      timer: this.firstAuthDeadline(socket),
      detach: () => transport?.off('data', onData),
      bytes: 0,
      charged: 0,
      openedAt: Date.now(),
      phase: 'awaiting_auth',
      key,
    };
    this.held.set(socket, entry);
    if (key !== undefined) this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    socket.once?.('close', () => this.release(socket));
  }

  /** The socket's first Authenticated reply was sent, or it closed: free its slot and stop counting. Idempotent. */
  release(socket: object): void {
    const entry = this.held.get(socket);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.detach();
    this.totalBytes -= entry.charged;
    this.held.delete(socket);
    if (entry.key !== undefined) {
      const left = (this.perKey.get(entry.key) ?? 1) - 1;
      if (left > 0) this.perKey.set(entry.key, left);
      else this.perKey.delete(entry.key);
    }
  }

  /** Slots `key` holds, and how many keys hold any (specs and diagnostics; never logged with the key). */
  heldBy(key: string): number {
    return this.perKey.get(key) ?? 0;
  }

  get addresses(): number {
    return this.perKey.size;
  }

  /** What all unauthenticated sockets are charged: their bytes plus the per-read overhead (specs and diagnostics). */
  get bytes(): number {
    return this.totalBytes;
  }

  private cut(entry: Held): void {
    this.release(entry.socket);
    entry.socket.terminate();
  }

  /** The unauthenticated socket charged the most (O(slots), only once the total is over its budget). */
  private largest(): Held | null {
    let top: Held | null = null;
    for (const entry of this.held.values()) if (!top || entry.charged > top.charged) top = entry;
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
  private deadline(socket: PreAuthSocket, ms: number, limit: SocketLimit, loggedMs: number = ms): ReturnType<typeof setTimeout> {
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

  private expire(socket: PreAuthSocket, limit: SocketLimit, deadlineMs: number): void {
    if (!this.held.has(socket)) return;
    this.release(socket);
    this.limitLog.log(limit, { deadlineMs });
    socket.terminate();
  }
}

export type VerifyCallback = (verified: boolean, code?: number, message?: string, headers?: Record<string, string>) => void;

/**
 * Answer an upgrade from `slots`, synchronously: admitted; the pool full, 503; its address at its share, 429 (a 4xx, so
 * one address stays out of the ALB 5xx alarm); both with `Retry-After` 5 (no later than the first-Auth deadline frees a
 * silent socket's slot); or not keyable (two X-Forwarded-For lines, an address that is not an IP), 400.
 */
export function answerCollabUpgrade(slots: CollabPreAuthSlots, req: ClientAddressRequest, done: VerifyCallback): void {
  switch (slots.admitUpgrade(req)) {
    case 'ok':
      return done(true);
    case 'address':
      return done(false, 429, 'Too Many Requests', { 'Retry-After': '5' });
    case 'refused':
      return done(false, 400, 'Bad Request');
    case 'pool':
      return done(false, 503, 'Service Unavailable', { 'Retry-After': '5' });
  }
}
