/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * A per-user cap on authenticated collab connections in this process: COLLAB_CONNECTIONS_PER_USER (limits.ts). Each
 * socket's outbound buffer is bounded (bounded-socket.ts) and a stalled one is cut off (socket-keepalive.ts), but
 * sockets are cheap, so without this one account could hold any number of them, each owed whole-document SyncStep2s.
 *
 * Counted where it is exact, so it never leaks: a connection is HELD from Hocuspocus's `connected` hook (the document
 * connection exists) to its `onDisconnect` (it closed: socket close, a revalidator or refusal close, shutdown), keyed by
 * Hocuspocus's socket id and the document name, which name exactly one document connection. An authentication that
 * fails, or whose socket closes before the connection is set up, never reaches `connected`, so it holds nothing.
 *
 * Enforced twice:
 * - `admitCollabUserConnection` (through `CollabSocketBounds.admitUser`), in `onAuthenticate` right after the
 *   per-session auth rate and before any user, session, page or PDP read (authentication.extension.ts, seam #213): a user already at
 *   the cap is refused without a DB call;
 * - the `connected` hook: authentications run concurrently, so several can pass that check together; one that would
 *   take the user past the cap is closed there (`connection.close`, then its socket, which would otherwise stay open
 *   holding no document), and the editor reconnects after its try-later wait, to be refused at the first check.
 * A refusal throws COLLAB_USER_CONNECTIONS_REASON (auth-refusal.ts: no `message`, so Hocuspocus logs nothing), logged
 * once, rate-limited, as `COLLAB_SOCKET_LIMIT {"limit":"user_connections"}`. The editor waits out the refusal and the
 * close alike (collab-access.ts: its try-later backoff, 5 s doubling to 60 s, jittered; never a token refetch).
 *
 * The extension defines only `connected` and `onDisconnect`, never throws from either (a throw would skip every later
 * extension's hook), and ranks just below the update guard so its `connected` runs before any extension's that awaits.
 *
 * It is also the drain's late-connection rule (#810). Once the gateway's `destroy` has begun (the bounds' `draining`,
 * socket-bounds.ts), every connection established after that is closed here at once: an Auth already inside
 * `onAuthenticate` when `closeConnections` ran, or one RedisSync proxied from another node that still sees this node's
 * lock. Kept open, its document would never unload, and `destroy` would wait for the SIGKILL with the lock held. It
 * closes the SOCKET first, 1013 (try again later): the socket then reads as closing, so the document close after it
 * sends no CLOSE frame. The editor answers a document CLOSE by reopening at once (collab-access.ts), and the raw 1013
 * with the provider's backoff, by when the next node holds the document. A proxied connection's 1013 is relayed to the
 * node holding the real socket (CollabProxySocket); only 4408 is not.
 */
import { COLLAB_USER_CONNECTIONS_REASON, collabAuthRefusal } from './auth-refusal';
import { COLLAB_CONNECTIONS_PER_USER } from './limits';
import type { CollabSocketDocuments, CountedConnection } from './socket-documents';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

export interface CollabUserConnectionsOptions {
  /** Connections one user may hold in this process: COLLAB_CONNECTIONS_PER_USER. */
  cap?: number;
  limitLog?: SocketLimitLog;
}

export class CollabUserConnections {
  private readonly held = new Map<string, Set<string>>();
  private readonly cap: number;
  private readonly limitLog: SocketLimitLog;

  constructor({ cap = COLLAB_CONNECTIONS_PER_USER, limitLog = collabSocketLimitLog }: CollabUserConnectionsOptions = {}) {
    this.cap = cap;
    this.limitLog = limitLog;
  }

  /** False (logged) when `userId` already holds the cap. Takes nothing. */
  admit(userId: string): boolean {
    if ((this.held.get(userId)?.size ?? 0) < this.cap) return true;
    this.limitLog.log('user_connections', { userId, held: this.cap });
    return false;
  }

  /** Hold one connection; false (logged, nothing held) when it would take `userId` past the cap. Idempotent per key. */
  hold(userId: string, key: string): boolean {
    let keys = this.held.get(userId);
    if (keys?.has(key)) return true;
    if ((keys?.size ?? 0) >= this.cap) {
      this.limitLog.log('user_connections', { userId, held: this.cap });
      return false;
    }
    if (!keys) this.held.set(userId, (keys = new Set()));
    keys.add(key);
    return true;
  }

  /** Release a held connection; a key never held (or already released) is a no-op. */
  release(userId: string, key: string): void {
    const keys = this.held.get(userId);
    if (!keys?.delete(key)) return;
    if (keys.size === 0) this.held.delete(userId);
  }

  /** Connections `userId` holds (for the specs). */
  count(userId: string): number {
    return this.held.get(userId)?.size ?? 0;
  }
}

/**
 * In `onAuthenticate` (through `CollabSocketBounds.admitUser`): throws `{ reason }` (no `message`) when `userId` already
 * holds the cap in `connections`, the registry the gateway's `connected` hook writes.
 */
export function admitCollabUserConnection(userId: string, connections: CollabUserConnections): void {
  if (!connections.admit(String(userId))) throw collabAuthRefusal(COLLAB_USER_CONNECTIONS_REASON);
}

/** The subset of Hocuspocus 4.7.1's `connected` / `onDisconnect` payloads read here. */
interface ConnectionHookPayload {
  socketId?: string;
  documentName?: string;
  context?: { user?: { id?: unknown } };
}
interface ConnectedPayload extends ConnectionHookPayload {
  connection?: CountedConnection & {
    close(event?: { code?: number; reason?: string }): void;
    webSocket?: { close?(code?: number, reason?: string): void };
  };
}

const keyOf = (p: ConnectionHookPayload): string | null =>
  p.socketId && p.documentName ? `${p.socketId}\u0000${p.documentName}` : null;
const userOf = (p: ConnectionHookPayload): string | null => {
  const id = p.context?.user?.id;
  return id === undefined || id === null || id === '' ? null : String(id);
};

/** Hocuspocus close code for the over-cap close (the update guard's refusals use 4422). */
export const COLLAB_USER_CONNECTIONS_CLOSE_CODE = 4429;

/** The close of a connection established while the process drains (#810): RFC 6455 1013, retried with backoff. */
export const COLLAB_DRAINING_CLOSE = { code: 1013, reason: 'Try Again Later' } as const;

export class CollabUserConnectionsExtension {
  /** Below the update guard (10 000), above RedisSync (1000) and every default-priority extension (100). */
  readonly priority = 9_000;
  readonly extensionName = 'CollabUserConnections';

  /**
   * Both registries are the process's own, from `CollabSocketBounds` (socket-bounds.ts), which builds this once; so is
   * `draining`, true from the start of the gateway's `destroy` (#810).
   */
  constructor(
    readonly connections: CollabUserConnections,
    readonly socketDocuments: CollabSocketDocuments,
    private readonly draining: () => boolean = () => false,
  ) {}

  async connected(payload: ConnectedPayload): Promise<void> {
    try {
      if (this.draining()) {
        // #810: the socket first, so the document close sends no CLOSE frame (see the header); nothing is held
        payload.connection?.webSocket?.close?.(COLLAB_DRAINING_CLOSE.code, COLLAB_DRAINING_CLOSE.reason);
        payload.connection?.close(COLLAB_DRAINING_CLOSE);
        return;
      }
      this.socketDocuments.track(payload.connection); // every connection, a user's or not (socket-documents.ts)
      const user = userOf(payload);
      const key = keyOf(payload);
      if (!user || !key) return; // not a user's connection: nothing to count
      if (!this.connections.hold(user, key)) {
        const refusal = { code: COLLAB_USER_CONNECTIONS_CLOSE_CODE, reason: COLLAB_USER_CONNECTIONS_REASON };
        payload.connection?.close(refusal);
        // The socket too: it holds no document now (one per socket in Docmost); the editor waits out either close, then reconnects.
        payload.connection?.webSocket?.close?.(refusal.code, refusal.reason);
      }
    } catch {
      // never throw from a hook: it would skip every later extension's `connected`
    }
  }

  async onDisconnect(payload: ConnectionHookPayload): Promise<void> {
    try {
      const user = userOf(payload);
      const key = keyOf(payload);
      if (user && key) this.connections.release(user, key);
    } catch {
      // never throw from a hook: it would skip every later extension's `onDisconnect`
    }
  }
}
