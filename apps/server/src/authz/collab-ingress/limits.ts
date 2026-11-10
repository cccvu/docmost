/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * The socket and per-user bounds the collab path adds on top of Hocuspocus 4.7.1 (the keepalive and stall timing live in
 * socket-keepalive.ts, the per-frame guard rules and their constants in update-guard.ts). Each is wired at one seam:
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

/**
 * Bytes one socket may send before it is authenticated (preauth-slots.ts, counted on its TCP socket, so a partial frame
 * ws is still assembling counts too); past it the socket is terminated. An honest provider sends only its Auth frame,
 * its SyncStep1 (a state vector: a few bytes per client id the document has seen), its awareness state (at most 8 KiB)
 * and any keystrokes made while the token verifies before it is authenticated; offline content is exchanged after (its
 * Step2 answers the server's Step1). A socket cut off here reconnects, and the content syncs then.
 */
export const COLLAB_PREAUTH_BYTES = 256 * 1024;
/**
 * Unauthenticated collab sockets per process (preauth-slots.ts): past it the upgrade is refused 503. Each holds at most
 * COLLAB_PREAUTH_BYTES of received bytes (its pre-auth queue and any partial frame are both made of them) plus its
 * objects (ws, Hocuspocus, timers: budgeted at 64 KiB), so all of them together hold at most 512 x 320 KiB = 160 MiB of
 * native memory. The task is 4096 MiB and its V8 and Go heap caps sum to 3072 MiB (docmost 1024, its conversion worker
 * 1024, platform 512, SpiceDB 512; ecs.tf, check-infra-config §27), so everything outside a heap (Buffers, ws, stacks,
 * code) shares the remaining 1024 MiB; this bound takes under a sixth of it.
 *
 * The pool is sized so that no one source can hold it: the edge allows each client address 2000 requests per 5 minutes
 * (the WAF's rate rules, on both the proxied and the direct path), so with COLLAB_PREAUTH_DEADLINE_MS one source holds
 * at most about 2000 / 300 s x 10 s = 67 unauthenticated sockets at a time, under a seventh of the pool. A socket whose
 * authentication is refused is closed at once (bounded-socket.ts), so it holds its slot for one round trip, and an
 * honest socket for one token verify and its reads.
 */
export const COLLAB_PREAUTH_SOCKETS = 512;
/** A socket not authenticated this long after it opened is terminated (preauth-slots.ts). 4.7.1's own is 60–120 s. */
export const COLLAB_PREAUTH_DEADLINE_MS = 10_000;
/** After an authentication is refused the socket is closed; one that has not finished closing by then is terminated. */
export const COLLAB_PREAUTH_CLOSE_GRACE_MS = 2_000;

/** Hocuspocus 4.7.1 options; the rest stay at upstream defaults (1000 queued messages, 60 s `timeout`). */
export const COLLAB_HOCUSPOCUS_OPTIONS = {
  maxPendingDocuments: 1, // Docmost opens one document per socket (page-editor.tsx); the default is 100
  maxUnauthenticatedQueueSize: COLLAB_PREAUTH_BYTES, // never more than the socket may send before it is authenticated
} as const;

/**
 * Distinct document names one socket may ever address (frame-address.ts), checked before RedisSync keys a name in Redis
 * and before Hocuspocus's own `maxPendingDocuments`. Docmost opens one document per socket (page-editor.tsx makes a
 * websocket per page editor); this is that limit's value, so an honest socket never meets either. One, not more: once a
 * socket has authenticated, Hocuspocus 4.7.1 applies no deadline to a second document it never authenticates, so its
 * pre-auth queue (and the socket) would stay for good.
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
 * Outbound: terminate rather than send a frame that would take ws's `bufferedAmount` past this many maxPayloads plus
 * the largest frame sent so far (this one included). One maxPayload above the largest frame: an honest slow client holds
 * at most the largest frame it was sent (a SyncStep2) plus what is relayed while it drains it, and the largest relayed
 * frame is one peer frame (at most maxPayload). Past that it is behind by more than the biggest thing it could be owed.
 * A socket therefore never holds more than 8 MiB plus its largest frame (16 MiB for any frame up to maxPayload).
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

/**
 * Awareness and QueryAwareness frames per socket (frame-address.ts): a burst of COLLAB_AWARENESS_BURST, then
 * COLLAB_AWARENESS_REFILL_PER_SECOND. Hocuspocus relays each awareness frame to every peer. Past it the frame is DROPPED,
 * never refused: awareness is a lossy last-state channel (every frame carries each client's whole state at a higher
 * clock, so a later frame supersedes a dropped one), and an honest provider can exceed any fixed rate: it sends one
 * frame per selection change (Docmost sets no `flushDelay`), and a mouse-drag selection changes it once per pointer
 * event, at the display's refresh rate (120 Hz and up). A refusal would end that editor's session for a cursor. A
 * dropped final frame leaves peers a stale cursor until the next change or y-protocols' 15 s renewal.
 */
export const COLLAB_AWARENESS_BURST = 200;
export const COLLAB_AWARENESS_REFILL_PER_SECOND = 40;

/** onAuthenticate runs per user id: burst 64 (a tab opens one document per socket), then one per second. */
export const COLLAB_AUTH_BURST = 64;
export const COLLAB_AUTH_REFILL_PER_SECOND = 1;

/** Violation log lines (`COLLAB_SOCKET_LIMIT`) per minute, process-wide; the rest are counted. */
export const COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE = 30;
