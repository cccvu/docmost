/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * Which collab sockets hold no document connection any more, so the keepalive tick can reap them
 * (socket-keepalive.ts).
 *
 * Hocuspocus 4.7.1 closes a DOCUMENT connection and leaves the websocket up: on an update guard refusal (below the
 * socket's refusal budget), a per-user connection cap close, a revalidator or force-disconnect close. Once a socket has
 * authenticated, 4.7.1 applies only its idle clock to it, and the gateway's pong → `touch()` refreshes that clock, so
 * such a socket stays open for good. No per-user cap counts it, and it can still queue up to
 * `maxUnauthenticatedQueueSize` for a document it never authenticates and send Auth frames. An honest editor never keeps
 * one: Docmost opens one document per socket, and on any server close the editor either reopens its socket or closes it
 * (collab-access.ts).
 *
 * Counted per socket from the `connected` hook (user-connections.ts) to that connection's own `onClose`, which 4.7.1
 * fires exactly once, when the connection leaves its document (any close, the socket's included). Keyed by the
 * connection's `webSocket`, or the raw ws socket under it when that is the gateway's BoundedCollabSocket, so the
 * gateway's keepalive finds it by the ws socket it pings. A proxied connection (the RedisSync owner side) has its own
 * webSocket and is never looked up; its origin socket is never counted, so a socket whose documents another node owns
 * is never reaped here (a rolling deploy's overlap). WeakMap: an entry goes with its socket.
 *
 * One instance per process, owned by `CollabSocketBounds` (socket-bounds.ts): written by its user-connections extension's
 * `connected` hook, read by the keepalive it starts for every socket.
 */

/** The subset of a Hocuspocus 4.7.1 `Connection` read here. */
export interface CountedConnection {
  webSocket?: object;
  document?: { hasConnection?(connection: never): boolean };
  onClose?(callback: () => void): unknown;
}

type Entry = { live: number };

export class CollabSocketDocuments {
  private readonly sockets = new WeakMap<object, Entry>();

  /** In the `connected` hook. A connection that already left its document counts as held, then closed. Never throws. */
  track(connection: CountedConnection | undefined): void {
    const ws = connection?.webSocket;
    if (!ws) return;
    const key = (ws as { rawSocket?: object }).rawSocket ?? ws;
    let entry = this.sockets.get(key);
    if (!entry) this.sockets.set(key, (entry = { live: 0 }));
    if (typeof connection.onClose !== 'function' || !connection.document?.hasConnection?.(connection as never)) return;
    const held = entry;
    held.live += 1;
    connection.onClose(() => {
      held.live = Math.max(0, held.live - 1);
    });
  }

  /** True when `socket` has held a document connection and holds none now. */
  holdsNoDocument(socket: object): boolean {
    const entry = this.sockets.get(socket);
    return entry !== undefined && entry.live === 0;
  }
}
