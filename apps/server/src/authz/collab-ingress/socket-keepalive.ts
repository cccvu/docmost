/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * Keeps a quiet but healthy collab socket from being reaped by Hocuspocus 4.x's idle timeout.
 *
 * Hocuspocus 3.4.4 pinged every socket itself and closed one that missed a pong. 4.x sends no pings: its
 * `ClientConnection` closes a connection when nothing arrived for `timeout` (60 s), and counts only inbound frames
 * and `touch()` as arrivals. An editor that has nothing to say (a hidden tab whose awareness timer the browser
 * throttles to once a minute) would then be cut off and reconnect. Hocuspocus's own `Server` heartbeats through
 * crossws and forwards each pong to `touch()` (4.7.1, #1179); Docmost runs its own `ws` server, so this does the same:
 * a protocol-level ping every `COLLAB_PING_INTERVAL_MS` (answered by the browser's network stack, never throttled)
 * and every pong is a `touch()`.
 *
 * `touch()` refreshes only the idle clock. Before a connection has authenticated, Hocuspocus measures its deadline
 * from when the socket opened, which nothing here (or any inbound frame) moves.
 */
export const COLLAB_PING_INTERVAL_MS = 30_000;

/** The `ws` WebSocket surface used here. */
export interface PingableSocket {
  readonly readyState: number;
  ping(): void;
  on(event: 'pong', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
}

const OPEN = 1;

export function keepCollabSocketAlive(
  ws: PingableSocket,
  touch: () => void,
  intervalMs: number = COLLAB_PING_INTERVAL_MS,
): void {
  ws.on('pong', () => touch());
  const timer = setInterval(() => {
    if (ws.readyState !== OPEN) return;
    try {
      ws.ping();
    } catch {
      // the socket closed between the check and the ping; its close listener clears this timer
    }
  }, intervalMs);
  timer.unref?.();
  ws.once('close', () => clearInterval(timer));
}
