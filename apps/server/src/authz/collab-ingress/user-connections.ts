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
 * - `admitCollabUserConnection`, in `onAuthenticate` right after the per-user auth rate and before any user, session,
 *   page or PDP read (authentication.extension.ts, seam #213): a user already at the cap is refused without a DB call;
 * - the `connected` hook: authentications run concurrently, so several can pass that check together; one that would
 *   take the user past the cap is closed there (`connection.close`), and the editor sees a close it reconnects from,
 *   to be refused at the first check.
 * A refusal throws `{ reason }` with no `message` (Hocuspocus logs `error.message`), logged once, rate-limited, as
 * `COLLAB_SOCKET_LIMIT {"limit":"user_connections"}`. The editor treats it as any refusal (collab-access.ts: refetch the
 * token once, then the connection-lost state).
 *
 * The extension defines only `connected` and `onDisconnect`, never throws from either (a throw would skip every later
 * extension's hook), and ranks just below the update guard so its `connected` runs before any extension's that awaits.
 */
import { COLLAB_CONNECTIONS_PER_USER } from './limits';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

export const COLLAB_USER_CONNECTIONS_REASON = 'ccc:collab-user-connections';

export class CollabUserConnections {
  private readonly held = new Map<string, Set<string>>();

  constructor(
    private readonly cap: number = COLLAB_CONNECTIONS_PER_USER,
    private readonly limitLog: SocketLimitLog = collabSocketLimitLog,
  ) {}

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

const processConnections = new CollabUserConnections();

/** In `onAuthenticate`: throws `{ reason }` (no `message`) when `userId` already holds the cap. */
export function admitCollabUserConnection(userId: string, connections: CollabUserConnections = processConnections): void {
  if (!connections.admit(String(userId))) throw { reason: COLLAB_USER_CONNECTIONS_REASON };
}

/** The subset of Hocuspocus 4.7.1's `connected` / `onDisconnect` payloads read here. */
interface ConnectionHookPayload {
  socketId?: string;
  documentName?: string;
  context?: { user?: { id?: unknown } };
}
interface ConnectedPayload extends ConnectionHookPayload {
  connection?: { close(event?: { code?: number; reason?: string }): void };
}

const keyOf = (p: ConnectionHookPayload): string | null =>
  p.socketId && p.documentName ? `${p.socketId}\u0000${p.documentName}` : null;
const userOf = (p: ConnectionHookPayload): string | null => {
  const id = p.context?.user?.id;
  return id === undefined || id === null || id === '' ? null : String(id);
};

/** Hocuspocus close code for the over-cap close (the update guard's refusals use 4422). */
export const COLLAB_USER_CONNECTIONS_CLOSE_CODE = 4429;

export class CollabUserConnectionsExtension {
  /** Below the update guard (10 000), above RedisSync (1000) and every default-priority extension (100). */
  readonly priority = 9_000;
  readonly extensionName = 'CollabUserConnections';

  constructor(readonly connections: CollabUserConnections = processConnections) {}

  async connected(payload: ConnectedPayload): Promise<void> {
    try {
      const user = userOf(payload);
      const key = keyOf(payload);
      if (!user || !key) return; // not a user's connection: nothing to count
      if (!this.connections.hold(user, key)) {
        payload.connection?.close({ code: COLLAB_USER_CONNECTIONS_CLOSE_CODE, reason: COLLAB_USER_CONNECTIONS_REASON });
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
