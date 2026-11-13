import type { IncomingHttpHeaders, Server } from 'http';
import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';

/**
 * Request-RECEIPT bounds for the Docmost http server — CCC code, NOT upstream Docmost (issue #763).
 *
 * Mounted by `RequestTimeoutModule` (see there for why this is not in `main.ts`). Two bounds:
 *  - `DOCMOST_REQUEST_TIMEOUT_MS`: Node's own whole-request receipt limit (`http.Server#requestTimeout`), for
 *    every request, multipart uploads included;
 *  - `DOCMOST_BUFFERED_BODY_TIMEOUT_MS`: a tighter deadline for the bodies Fastify BUFFERS (everything that is
 *    not multipart), because those hold memory while they arrive.
 */

/**
 * 900 s: the longest any request may take to ARRIVE (request line + headers + full body).
 *
 * WHY THIS EXISTS: Fastify defaults `requestTimeout` to 0 and copies it onto the http server it builds, which
 * overrides Node's own 300 s default and disables the bound. The front door streams bodies to us
 * (`proxy_request_buffering off`) and its `client_body_timeout` limits only the gap between two reads, so a
 * client that drips a body a byte at a time held a request open indefinitely. Slow HEADERS were already cut at
 * Node's 60 s `headersTimeout`; only bodies had no limit.
 *
 * SIZING (1024-based sizes, the slowest sustained upload rate that still finishes inside 900 s):
 *  - the largest body is a zip import at prod's `FILE_IMPORT_SIZE_LIMIT=99mb` = 103,809,024 B, which needs
 *    ≥ 0.92 Mbit/s here (it would need 2.77 Mbit/s at Node's 300 s, which breaks on hotel Wi-Fi, a phone
 *    hotspot or a loaded VPN);
 *  - a 50 MiB attachment (`FILE_UPLOAD_SIZE_LIMIT` default) needs ≥ 0.47 Mbit/s;
 *  - the platform's /v1 upload relay aborts at 120 s (`DOCMOST_UPLOAD_TIMEOUT_MS` default), so a relayed upload
 *    is never cut by Docmost first.
 * Re-tune if the measured p99 upload throughput for `/api/pages/import-zip` / `/api/files/upload` (ALB logs) is
 * under 1 Mbit/s.
 *
 * WHAT IT COSTS AN ATTACKER: behind the front door, concurrent holds are capped per IP by nginx (256) whatever
 * this value is. On the direct ALB path holds per IP scale with T (WAF rate × T); the memory-holding case there
 * is bounded by `DOCMOST_BUFFERED_BODY_TIMEOUT_MS` below, so T mostly sets how often a dripper must reconnect.
 *
 * SEMANTICS (Node 22, proven by `request-timeout.behaviour.spec.ts`):
 *  - the clock runs from the first byte of the request until llhttp completes the message, so it also counts
 *    time the SERVER spends not reading: a sink applying backpressure (an S3 upload slower than the client)
 *    counts against it;
 *  - the response is not counted, nor keep-alive idle time between requests, nor an upgraded WebSocket
 *    (`/collab`, `/socket.io`): upgrades leave Node's connection list;
 *  - Node checks every `connectionsCheckingInterval` (30 s default; changing it needs the constructor option,
 *    i.e. `main.ts`), so the cut lands in [T, T + 30 s];
 *  - Node stops enforcing it once `server.close()` starts; shutdown stays bounded by the ECS `stopTimeout`
 *    (90 s).
 * It MUST stay above `headersTimeout` (60 s): see `applyRequestTimeout`.
 */
export const DOCMOST_REQUEST_TIMEOUT_MS = 900_000;

/**
 * 60 s: the longest a NON-multipart body may take to arrive once its headers are in.
 *
 * Non-multipart bodies (JSON, urlencoded, text, SCIM JSON; all ≤ Fastify's 1 MiB `bodyLimit`) are fully BUFFERED
 * by the content-type parser before any Nest guard runs, so an UNAUTHENTICATED client that sends almost all of
 * a 1 MiB JSON body and then drips the rest holds ~1 MiB of native (Buffer) memory per request — outside every
 * heap cap (AGENTS.md #679) — until a deadline cuts it. On the direct ALB path holds per IP are the WAF rate
 * (~6.67/s) × the deadline: ~6,000 (≈ 5.6 GiB) at 900 s, ~400 at 60 s. A legitimate 1 MiB body needs only
 * ~140 kbit/s to arrive in time.
 *
 * Multipart is exempt: its handlers stream the body AFTER auth, and a body sent to a route that answered 401
 * first is read and discarded, never held (≈ 0 memory). It keeps the 900 s `DOCMOST_REQUEST_TIMEOUT_MS` bound,
 * which large uploads need.
 */
export const DOCMOST_BUFFERED_BODY_TIMEOUT_MS = 60_000;

/**
 * Sets `server.requestTimeout`. THROWS unless `ms > server.headersTimeout`.
 *
 * Node validates `headersTimeout <= requestTimeout` only in the `http.Server` CONSTRUCTOR (both are plain
 * properties after that), and its C++ connection check then SILENTLY SWAPS them when `headersTimeout` is the
 * larger (`node_http_parser.cc`, `Expired`: `if (request_timeout > 0 && headers_timeout > request_timeout)
 * std::swap`). So a value at or below `headersTimeout` (60 s by default) would quietly become a 60 s body limit,
 * and a future "tighten it to 30 s" change would do nothing it says. Refusing it at boot makes that loud.
 */
export function applyRequestTimeout(
  server: Pick<Server, 'requestTimeout' | 'headersTimeout'>,
  ms: number = DOCMOST_REQUEST_TIMEOUT_MS,
): void {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`requestTimeout must be a positive finite number of ms, got ${ms} (#763)`);
  }
  if (ms <= server.headersTimeout) {
    throw new Error(
      `requestTimeout ${ms} ms must exceed headersTimeout ${server.headersTimeout} ms: Node would silently ` +
        `swap them and enforce ${server.headersTimeout} ms on bodies (#763)`,
    );
  }
  server.requestTimeout = ms;
}

/** Node's own 408 (`_http_server.js` `requestTimeoutResponse`), so the client sees why it was cut. */
const REQUEST_TIMEOUT_RESPONSE = 'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n';

/**
 * True when the request's framing says a body follows (RFC 9112 §6.3): any `Transfer-Encoding`, or a
 * `Content-Length` other than 0. A request with neither has no body.
 *
 * This, not `request.raw.complete`, decides whether to arm: at `onRequest` Node has emitted the request from
 * the headers callback, so `complete` is still FALSE even for a bodyless GET (it flips a moment later, in the
 * same parse). Arming on `!complete` alone would start a timer for every request.
 */
function hasRequestBody(headers: IncomingHttpHeaders): boolean {
  if (headers['transfer-encoding'] !== undefined) return true;
  const length = headers['content-length'];
  return length !== undefined && Number(length) !== 0;
}

function isMultipart(headers: IncomingHttpHeaders): boolean {
  const type = headers['content-type'];
  return typeof type === 'string' && type.trimStart().toLowerCase().startsWith('multipart/');
}

/**
 * A Fastify `onRequest` hook that cuts a NON-multipart request whose body has not fully arrived within `ms`
 * of its headers (see `DOCMOST_BUFFERED_BODY_TIMEOUT_MS`).
 *
 * It arms only for a request that has a body, is not multipart and is not already complete. When the timer
 * fires and THAT request's body is still incomplete, it writes Node's 408 and destroys the socket. The timer
 * is cleared when the request ends or closes, or its socket closes, and is `unref()`ed.
 *
 * Keep-alive safety: the fire-time check reads `complete` on the request that armed it, never on the socket,
 * so a stale timer can never cut the NEXT request on a reused keep-alive socket (it sees its own, completed,
 * request and does nothing), and a bodyless request never arms one at all.
 */
export function bufferedBodyDeadlineHook(
  ms: number = DOCMOST_BUFFERED_BODY_TIMEOUT_MS,
): (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => void {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`buffered-body deadline must be a positive finite number of ms, got ${ms} (#763)`);
  }

  return function bufferedBodyDeadline(request, reply, done): void {
    const raw = request.raw;
    const socket = raw.socket;
    if (!socket || raw.complete || !hasRequestBody(raw.headers) || isMultipart(raw.headers)) {
      done();
      return;
    }

    const clear = (): void => {
      clearTimeout(timer);
      raw.removeListener('end', clear);
      raw.removeListener('close', clear);
      socket.removeListener('close', clear);
    };

    const timer = setTimeout(() => {
      clear();
      if (raw.complete || socket.destroyed) return;
      if (socket.writable && !reply.raw.headersSent) socket.write(REQUEST_TIMEOUT_RESPONSE);
      socket.destroy();
    }, ms);
    timer.unref();

    raw.once('end', clear);
    raw.once('close', clear);
    socket.once('close', clear);
    done();
  };
}
