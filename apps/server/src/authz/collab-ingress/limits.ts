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
  // #810: ws's own pong answers every ping, and a client that pings without reading queues a pong per 6-byte ping
  // (about 210 B of heap each, invisible to every bound). The bounds answer pings themselves, one pong in flight
  // (socket-pong.ts).
  autoPong: false,
  // #810: ws's default, pinned: deflate would queue frames in ws's sender (`_bufferedBytes`) behind an async zlib stage
  // with per-socket zlib memory, which the byte accounting (socket-bytes.ts) does not model.
  perMessageDeflate: false,
};

/**
 * Bytes ONE socket may send before it is authenticated (preauth-slots.ts, counted on its TCP socket, so a partial frame
 * ws is still assembling counts too): the largest frame the server accepts at all (`maxPayload`) plus
 * COLLAB_PREAUTH_HEADROOM_BYTES. Before it is authenticated an honest provider sends its Auth frame, its SyncStep1 and
 * its awareness state, and what it holds that the socket has not sent: keystrokes made while the token verifies, edits
 * queued while it was offline, and a page's cached copy that its local store (y-indexeddb) loaded after the socket
 * opened. A SyncStep1 is the page's whole state vector, about 7 bytes for every client id that ever wrote to the page,
 * which is never pruned, so on a page written to by many sessions (every API write and every editing session adds one)
 * it can be hundreds of KiB. These are wire bytes (frame headers, the Auth frame's token, that SyncStep1), so a cap of
 * exactly one maximal frame would cut a provider whose cached copy is near `maxPayload` before it authenticated, and it
 * would resend the same bytes on every reconnect (#810 N5). The bound on the total is the next constant.
 */
export const COLLAB_PREAUTH_HEADROOM_BYTES = 1024 * 1024;
export const COLLAB_PREAUTH_SOCKET_BYTES = COLLAB_MAX_PAYLOAD_BYTES + COLLAB_PREAUTH_HEADROOM_BYTES;
/**
 * Bytes ALL unauthenticated sockets together may hold (preauth-slots.ts). Past it, the socket holding the most is
 * terminated, until the total is back under: an honest unauthenticated socket holds a few KiB to a few hundred, so a
 * client that fills the budget loses its own largest sockets first.
 */
export const COLLAB_PREAUTH_TOTAL_BYTES = 128 * 1024 * 1024;
/**
 * Unauthenticated collab sockets per process (preauth-slots.ts): past it the upgrade is refused 503. Together they hold
 * at most COLLAB_PREAUTH_TOTAL_BYTES of received bytes (their pre-auth queues and partial frames are both made of them)
 * plus their objects (ws, Hocuspocus, timers: budgeted at 64 KiB each), so at most 128 MiB + 512 x 64 KiB = 160 MiB of
 * native memory. The task is 4096 MiB and its V8 and Go heap caps sum to 3072 MiB (docmost 1024, its conversion worker
 * 1024, platform 512, SpiceDB 512; ecs.tf, check-infra-config §27), so everything outside a heap (Buffers, ws, stacks,
 * code) shares the remaining 1024 MiB; this bound takes under a sixth of it.
 *
 * Holding the pool: the edge allows each client address 2000 requests per 5 minutes (the WAF's rate rules, on both the
 * proxied and the direct path). The count is per 5-minute window, so one address CAN burst 512 upgrades at once. A socket
 * that sends no Auth frame holds its slot for COLLAB_PREAUTH_AUTH_FRAME_MS, so that address holds the whole pool about
 * four times before its window blocks it (roughly 20 s of refused collab opens per 5 minutes). A complete Auth frame the
 * server refuses, malformed or not verifying, ends in a server close, after which the socket keeps its slot at most
 * COLLAB_PREAUTH_CLOSE_GRACE_MS (bounded-socket.ts); only an authentication still running (its reads, or a relay to a
 * node that does not answer) holds a slot until COLLAB_PREAUTH_DEADLINE_MS. Held continuously, at its average rate, one
 * address holds about 2000 / 300 s x 5 s = 34 silent sockets, under a fifteenth of the pool, so a sustained hold takes
 * about sixteen addresses. An honest socket holds its slot for one token verify and its reads.
 */
export const COLLAB_PREAUTH_SOCKETS = 512;
/**
 * Unauthenticated collab sockets ONE client address may hold (preauth-slots.ts, #810): past it that address's upgrade is
 * refused 429 with `Retry-After`, while other addresses still get the rest of the pool. The address is the platform's
 * trusted-proxy walk (client-address.ts), active once the platform has served its trust list (client-trust.ts); until
 * then there is no share, as before #810.
 *
 * 128 = COLLAB_PREAUTH_SOCKETS / 4, so emptying the pool takes at least four addresses (a spec pins 512 / S >= 4). The
 * honest need is the collab sockets one NAT has in pre-auth at once, which is about one in steady state (a socket is
 * pre-auth for one token verify and its reads) and peaks in a deploy's reconnect wave: #312's 3x rule bounds a campus or
 * VPN egress at 85 (busiest measured peak 11), and 300 tabs behind one NAT are all admitted within about 3 s (128 at
 * once, the rest on the provider's 1 s-and-up retries). Re-size from `288-front-door.sh limit-conn-report`: the smallest
 * of 64 or 128 that is at least twice the legitimate per-address peak, never above 128 (past that one address could hold
 * a quarter of the pool and the share stops protecting it). The share defends against one source; many addresses
 * remain a residual (ADR 0036).
 */
export const COLLAB_PREAUTH_SOCKETS_PER_ADDRESS = 128;
/**
 * A socket that has not sent a complete Auth frame this long after it opened is terminated (preauth-slots.ts,
 * `preauth_first_auth`). An honest provider sends its Auth at once: HocuspocusProvider.onOpen awaits `sendToken()` on a
 * token page-editor.tsx already holds as a string, and a token refetch finishes before the socket is reopened, so the
 * frame arrives about one round trip after the upgrade. Five seconds covers two TCP retransmits (1 s, then 2 s) and a
 * main thread busy through a deploy's reconnect wave; a tab frozen past it is cut and reconnects once it thaws (#810 N1).
 */
export const COLLAB_PREAUTH_AUTH_FRAME_MS = 5_000;
/**
 * A socket not authenticated this long after it opened is terminated (preauth-slots.ts, `preauth_deadline`): absolute
 * from the upgrade, never extended by an Auth frame. It bounds the authentication itself (the token verify, the reads,
 * a RedisSync relay to the node that owns the document). 4.7.1's own deadline is 60–120 s.
 */
export const COLLAB_PREAUTH_DEADLINE_MS = 10_000;
/**
 * After the server closes an unauthenticated socket (a refused authentication, or any other close Hocuspocus or a bound
 * starts, such as a malformed Auth frame), one that has not finished closing by then is terminated.
 */
export const COLLAB_PREAUTH_CLOSE_GRACE_MS = 2_000;

/** Hocuspocus 4.7.1 options; the rest stay at upstream defaults (1000 queued messages, 60 s `timeout`). */
export const COLLAB_HOCUSPOCUS_OPTIONS = {
  maxPendingDocuments: 1, // Docmost opens one document per socket (page-editor.tsx); the default is 100
  maxUnauthenticatedQueueSize: COLLAB_PREAUTH_SOCKET_BYTES, // never more than the socket may send before it is authenticated
} as const;

/**
 * Distinct document names one socket may ever address (frame-admission.ts), checked before RedisSync keys a name in Redis
 * and before Hocuspocus's own `maxPendingDocuments`. Docmost opens one document per socket (page-editor.tsx makes a
 * websocket per page editor); this is that limit's value, so an honest socket never meets either. One, not more: once a
 * socket has authenticated, Hocuspocus 4.7.1 applies no deadline to a second document it never authenticates, so its
 * pre-auth queue (and the socket) would stay for good.
 */
export const COLLAB_DOCUMENTS_PER_SOCKET = COLLAB_HOCUSPOCUS_OPTIONS.maxPendingDocuments;

/**
 * Auth frames one socket may ever send (frame-admission.ts). The provider sends one per document when the socket opens
 * (HocuspocusProvider.onOpen); a token refetch reopens the socket (collab-reconnect.ts), so it never re-authenticates on
 * the same socket. Two per document of COLLAB_DOCUMENTS_PER_SOCKET is headroom. Each Auth that Hocuspocus 4.7.1 refuses
 * clears that document's state, so without this a socket could re-run `onAuthenticate` (and its token verify) forever.
 */
export const COLLAB_AUTH_FRAMES_PER_SOCKET = 2 * COLLAB_DOCUMENTS_PER_SOCKET;

/**
 * Outbound: terminate rather than send a frame that would take ws's `bufferedAmount`, plus
 * COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES for each frame still queued (this one included, #810), past this many maxPayloads
 * plus the largest frame sent so far (this one included). One maxPayload above the largest frame: an honest slow client holds
 * at most the largest frame it was sent (a SyncStep2) plus what is relayed while it drains it, and the largest relayed
 * frame is one peer frame (at most maxPayload). Past that it is behind by more than the biggest thing it could be owed.
 * A socket therefore never holds more than 8 MiB plus its largest frame (16 MiB for any frame up to maxPayload).
 */
export const COLLAB_OUTBOUND_BUFFER_FACTOR = 1;

/**
 * Heap a frame queued in ws's send buffer costs on top of the bytes `bufferedAmount` counts (#810): ws's two Writable
 * entries, the header and the payload view. Measured with ws 8.21.0 on a loopback socket the client never reads, on
 * node:22-slim (the production base image, Node 22.23.4): 397 B of heap + 8 B of ArrayBuffer for a distinct payload,
 * 310 + 8 B for one shared with other sockets (a broadcast); Node 24.21: 421 and 326 (socket-bytes.sizing.spec.ts).
 * 512 covers both with a quarter to spare. Without it a 50-byte frame counts as 52, so a socket fed tiny frames could
 * queue 8 MiB / 52 = 161k of them, about 62 MB of heap, and one account's 31 paused readers past the 1 GiB heap.
 */
export const COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES = 512;
/**
 * Heap a TCP read costs on top of its bytes while ws holds it as part of a frame it is still assembling (#810): the
 * Buffer object and ws's chunk list entry. Measured the same way (128-byte reads): 230-232 B on node:22-slim, 238-246 B
 * on Node 24.21. Without it, 65,536 reads of 128 B (`maxBufferedChunks`) hold about 15 MB of heap counted as 8 MiB.
 */
export const COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES = 256;
/**
 * Bytes ALL collab sockets together may hold once counted (socket-bytes.ts, #810): every socket's queued outbound
 * frames (`bufferedAmount` plus COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES a frame, a payload shared by several sockets
 * counted once) and, once it is authenticated, its inbound partial frame (the bytes since its last message plus
 * COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES a read). Past it every socket is re-sampled and, if the total is still over, the
 * sockets holding the most (their fair share of a shared payload) are terminated until it is back to
 * COLLAB_SOCKET_TOTAL_LOW_WATER_BYTES (`socket_total_bytes`), so the clients filling it lose their own largest sockets.
 * The per-socket bounds alone let one account's 32 sockets hold 32 x (16 MiB out + an 8 MiB inbound frame) and their
 * per-frame heap, past docmost's 1 GiB heap; this caps every account together. What it counts is partly native (the
 * payloads and reads) and partly V8 heap (the per-frame and per-read overheads): all heap, it is an eighth of the 1 GiB
 * heap; all native, it and COLLAB_PREAUTH_TOTAL_BYTES are a quarter of the 1024 MiB the task leaves outside its heap
 * caps. An honest socket holds what one reader of its page is owed (a SyncStep2 of at most a few MiB, its share of a
 * broadcast), so it is cut only when it holds more than the sockets of the clients filling the budget.
 */
export const COLLAB_SOCKET_TOTAL_BYTES = 128 * 1024 * 1024;
/**
 * Where a cut stops: 7/8 of the budget, so each pass (which re-samples every socket, O(sockets)) buys at least 16 MiB of
 * growth before the next one, and a holder parked just under the line cannot force one on every send.
 */
export const COLLAB_SOCKET_TOTAL_LOW_WATER_BYTES = 112 * 1024 * 1024;

/**
 * Authenticated collab connections (one per document per socket) one user may hold in this process
 * (user-connections.ts). Docmost opens one per page editor; an editor in a hidden tab idle for five minutes
 * disconnects (page-editor.tsx), so a user's live count is the pages they had open in the last minutes, across their
 * devices. 32 is several times that. It bounds the native memory one account can hold: 32 sockets, each at most
 * COLLAB_OUTBOUND_BUFFER_FACTOR x 8 MiB plus its largest frame, and a stalled one is cut off (socket-keepalive.ts);
 * COLLAB_SOCKET_TOTAL_BYTES bounds every account together (#810).
 */
export const COLLAB_CONNECTIONS_PER_USER = 32;

/**
 * Awareness and QueryAwareness frames per socket (frame-admission.ts): a burst of COLLAB_AWARENESS_BURST, then
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

/**
 * Violation log lines (`COLLAB_SOCKET_LIMIT`) per limit per minute (socket-limit-log.ts, #810); the rest are counted and
 * written as one `log_suppressed` line per limit when the window ends. Per limit, so a stranger's junk on one limit
 * (frame_address, preauth_sockets) never crowds out another's lines (auth_rate, user_sync_budget). About 25 limits, so
 * at most about 250 lines a minute plus the summaries.
 */
export const COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE = 10;
