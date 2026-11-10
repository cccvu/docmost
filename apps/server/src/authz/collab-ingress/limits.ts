/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * Every bound the collab socket path adds on top of Hocuspocus 4.7.1, in one place. Each is wired at one seam:
 * the ws server (adapter/collab-ws.adapter.ts), the Hocuspocus options and the per-socket checks
 * (collaboration.gateway.ts, seam #3), and the per-user auth rate (authentication.extension.ts, seam #213).
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

/** Outbound: terminate when ws's `bufferedAmount` exceeds this many maxPayloads plus the largest frame sent so far. */
export const COLLAB_OUTBOUND_BUFFER_FACTOR = 4;

/** onAuthenticate runs per user id: burst 64 (a tab opens one document per socket), then one per second. */
export const COLLAB_AUTH_BURST = 64;
export const COLLAB_AUTH_REFILL_PER_SECOND = 1;

/** Violation log lines (`COLLAB_SOCKET_LIMIT`) per minute, process-wide; the rest are counted. */
export const COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE = 30;
