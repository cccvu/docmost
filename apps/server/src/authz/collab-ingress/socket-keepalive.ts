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
 *
 * A pong proves the client's network stack is there, not that its application reads: 3.4.4 closed a socket that
 * missed a pong, and a client that stops reading still answers pings. So each tick also samples ws's `bufferedAmount`
 * and terminates (logged `COLLAB_SOCKET_LIMIT {"limit":"outbound_stalled"}`) a socket whose non-empty buffer has not
 * gone down across COLLAB_STALL_INTERVALS consecutive intervals: one minute in which it read nothing it was owed (the
 * ping itself adds two bytes a tick, so a stalled buffer grows). A slow client that drains anything at all between two
 * ticks passes; one that falls further behind than it reads for a whole minute is cut off, and it reconnects and
 * re-syncs. The send-time bound (bounded-socket.ts) caps the bytes in between. The stall check sees only what reaches
 * ws's buffer: a client that stops reading its socket altogether first fills the kernel's and any proxy's buffers
 * (megabytes, holding no Node memory), and it stops answering pings too, so Hocuspocus's idle timeout reaps it.
 *
 * Each tick also terminates (logged `COLLAB_SOCKET_LIMIT {"limit":"socket_empty"}`) a socket that has held a document
 * connection and held none for COLLAB_EMPTY_INTERVALS consecutive ticks (socket-documents.ts says why such a socket
 * would otherwise stay open for good, and why an honest editor never keeps one).
 *
 * Started for every socket by `CollabSocketBounds.open` (socket-bounds.ts), on both gateway paths.
 */
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

export const COLLAB_PING_INTERVAL_MS = 30_000;
export const COLLAB_STALL_INTERVALS = 2;
export const COLLAB_EMPTY_INTERVALS = 2;

/** The `ws` WebSocket surface used here. */
export interface PingableSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  ping(): void;
  terminate(): void;
  on(event: 'pong', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
}

const OPEN = 1;

export interface KeepCollabSocketAliveOptions {
  /**
   * True when the socket has held a document connection and holds none now: the reaper's registry (socket-documents.ts),
   * the same instance the `connected` hook writes (socket-bounds.ts). Required: a default would silently read another.
   */
  holdsNoDocument: (ws: PingableSocket) => boolean;
  /** Each tick, re-sample the socket's queued bytes for the process byte budget (socket-bytes.ts, #810). */
  sample?: (ws: PingableSocket) => void;
  intervalMs?: number;
  limitLog?: SocketLimitLog;
}

export function keepCollabSocketAlive(
  ws: PingableSocket,
  touch: () => void,
  { holdsNoDocument, sample, intervalMs = COLLAB_PING_INTERVAL_MS, limitLog = collabSocketLimitLog }: KeepCollabSocketAliveOptions,
): void {
  ws.on('pong', () => touch());
  let previous = 0;
  let stalled = 0;
  let empty = 0;
  const timer = setInterval(() => {
    if (ws.readyState !== OPEN) return;
    empty = holdsNoDocument(ws) ? empty + 1 : 0;
    if (empty >= COLLAB_EMPTY_INTERVALS) {
      limitLog.log('socket_empty', { emptyMs: empty * intervalMs });
      clearInterval(timer);
      ws.terminate();
      return;
    }
    sample?.(ws);
    const buffered = ws.bufferedAmount;
    stalled = buffered > 0 && previous > 0 && buffered >= previous ? stalled + 1 : 0;
    previous = buffered;
    if (stalled >= COLLAB_STALL_INTERVALS) {
      limitLog.log('outbound_stalled', { bufferedBytes: buffered, stalledMs: stalled * intervalMs });
      clearInterval(timer);
      ws.terminate();
      return;
    }
    try {
      ws.ping();
    } catch {
      // the socket closed between the check and the ping; its close listener clears this timer
    }
  }, intervalMs);
  timer.unref?.();
  ws.once('close', () => clearInterval(timer));
}
