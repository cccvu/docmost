/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * Every bound the collab socket path adds on top of Hocuspocus 4.7.1, in one place. Each is wired at one seam:
 * the ws server (adapter/collab-ws.adapter.ts), the Hocuspocus options and the per-socket checks
 * (collaboration.gateway.ts, seam #3), the per-user auth rate and connection cap (authentication.extension.ts, seam
 * #213), and the ws error log (collaboration.module.ts, seam #227).
 */
import type { ServerOptions } from 'ws';
import { PAGE_MAX_YDOC_BYTES_CEILING } from '../page-write/page-size';

/** The largest inbound frame: the API page-size cap's ceiling (8 MiB), ~15x the largest real page (0.52 MB). */
export const COLLAB_MAX_PAYLOAD_BYTES = PAGE_MAX_YDOC_BYTES_CEILING;

/**
 * ws server options (Hocuspocus never configures ws). `maxPayload` bounds one inbound message (close 1009 past it);
 * `maxFragments` and `maxBufferedChunks` replace ws's defaults (131k and 1M, about 100 MB of Buffer objects per
 * socket). @types/ws 8.18.1 does not declare the last two; ws 8.21.0 reads both (`websocket-server.js`).
 */
export const COLLAB_WS_SERVER_OPTIONS: ServerOptions & { maxFragments: number; maxBufferedChunks: number } = {
  maxPayload: COLLAB_MAX_PAYLOAD_BYTES,
  maxFragments: 1024, // a browser sends each message as one frame
  maxBufferedChunks: 65_536, // one maxPayload message in 128-byte TCP reads
};

/** Hocuspocus 4.7.1 options; the rest stay at upstream defaults (1000 queued messages, 60 s `timeout`). */
export const COLLAB_HOCUSPOCUS_OPTIONS = {
  maxPendingDocuments: 4, // Docmost opens one document per socket; the default is 100 concurrent onAuthenticate runs
  maxUnauthenticatedQueueSize: COLLAB_MAX_PAYLOAD_BYTES, // one maximum honest offline frame fits before auth
} as const;

/**
 * Distinct document names one socket may ever address (frame-address.ts), checked before RedisSync keys a name in Redis
 * and before Hocuspocus's own `maxPendingDocuments`. Docmost opens one document per socket (page-editor.tsx makes a
 * websocket per page editor); this is that limit's value, so an honest socket never meets either.
 */
export const COLLAB_DOCUMENTS_PER_SOCKET = COLLAB_HOCUSPOCUS_OPTIONS.maxPendingDocuments;

/**
 * Auth frames one socket may ever send (frame-address.ts). The provider sends one per document when the socket opens
 * (HocuspocusProvider.onOpen); a token refetch reopens the socket (collab-reconnect.ts), so it never re-authenticates on
 * the same socket. Two per document of COLLAB_DOCUMENTS_PER_SOCKET is headroom. Each Auth that Hocuspocus 4.7.1 refuses
 * clears that document's state, so without this a socket could re-run `onAuthenticate` (and its token verify) forever.
 */
export const COLLAB_AUTH_FRAMES_PER_SOCKET = 2 * COLLAB_DOCUMENTS_PER_SOCKET;

/**
 * Outbound: terminate when ws's `bufferedAmount` exceeds this many maxPayloads plus the largest frame sent so far. One
 * maxPayload above the largest frame: an honest slow client holds at most the largest frame it was sent (a SyncStep2)
 * plus what is relayed while it drains it, and the largest relayed frame is one peer frame (at most maxPayload). Past
 * that it is behind by more than the biggest thing it could be owed.
 */
export const COLLAB_OUTBOUND_BUFFER_FACTOR = 1;

/**
 * Authenticated collab connections (one per document per socket) one user may hold in this process
 * (user-connections.ts). Docmost opens one per page editor; an editor in a hidden tab idle for five minutes
 * disconnects (page-editor.tsx), so a user's live count is the pages they had open in the last minutes, across their
 * devices. 32 is several times that. It bounds the native memory one account can hold: 32 sockets, each at most
 * COLLAB_OUTBOUND_BUFFER_FACTOR x 8 MiB plus its largest frame, and a stalled one is cut off (socket-keepalive.ts).
 */
export const COLLAB_CONNECTIONS_PER_USER = 32;

/** onAuthenticate runs per user id: burst 64 (a tab opens one document per socket), then one per second. */
export const COLLAB_AUTH_BURST = 64;
export const COLLAB_AUTH_REFILL_PER_SECOND = 1;

/** Violation log lines (`COLLAB_SOCKET_LIMIT`) per minute, process-wide; the rest are counted. */
export const COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE = 30;
