/**
 * CCC realtime integration — NOT upstream Docmost code (wiki-v2 #830, ADR 0036).
 *
 * The bounds on the /socket.io server (socket.io 4.8.3 → engine.io 6.6.2 → ws 8.21.0), the notifications and tree-event
 * socket. Before #830 it ran with ws's and socket.io's defaults, so:
 * - ws answered every client ping (`autoPong`), and a client that pings without reading queued about 214 B of heap per
 *   6-byte ping (node:22, measured), the same gap #810 closed on /collab (socket-pong.ts);
 * - ws accepted 131k fragments and 1M buffered chunks per message (collab capped both in #790, limits.ts);
 * - anyone could open a socket: the gateway authenticated only after the namespace CONNECT;
 * - a failed auth (`client.emit('Unauthorized'); client.disconnect()` in ws.gateway.ts) left the engine.io connection
 *   open with no time limit, because a bare `disconnect()` leaves only the namespace. A client that then writes `'3'`
 *   (an unsolicited pong refreshes engine.io's ping timer) and never reads stayed up indefinitely, and could re-send
 *   CONNECT to rerun the gateway's DB liveness check at will (200 CONNECTs in one write = 200 checks, measured).
 *
 * Everything here goes through documented socket.io / engine.io / ws APIs only. Nothing replaces engine.io's ws server
 * after construction, mutates `engine.opts`, or calls `engine.init()`:
 * - REALTIME_GATEWAY_OPTIONS is spread into the gateway's `@WebSocketGateway({...})` (seam §161), so engine.io receives
 *   `wsEngine` and socket.io receives `connectTimeout` at construction (Nest passes gateway options to
 *   `new Server(httpServer, options)`);
 * - `hardenRealtimeServer` installs an `io.engine.use(...)` middleware (the upgrade gate) and an `io.use(...)` namespace
 *   middleware (one CONNECT per engine connection, and closing the engine on a server namespace disconnect). It is
 *   called once, from RealtimeSocketBoundsModule's `onModuleInit`.
 *
 * The specs pin the behaviour itself (realtime-socket-bounds.spec.ts, .wiring.spec.ts), so a library upgrade that
 * changes these semantics fails CI instead of silently weakening the bounds.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as cookie from 'cookie';
import type { Server, Socket } from 'socket.io';
import { type ServerOptions, type WebSocket, WebSocketServer } from 'ws';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { COLLAB_WS_SERVER_OPTIONS } from '../collab-ingress/limits';
import { answerCollabPings } from '../collab-ingress/socket-pong';
import { type AuthCookieEnv, readDocmostAuthCookie } from '../session-cookie/docmost-auth-cookie';

/**
 * The ws options /socket.io takes from /collab (limits.ts): no automatic pong (the one-in-flight pong below answers
 * instead), 1024 fragments and 65 536 buffered chunks per message (ws's defaults are 131k and 1M), and deflate pinned
 * off. Not `maxPayload`: engine.io passes its own (`maxHttpBufferSize`, 1e6), which stays.
 */
const REALTIME_WS_OPTIONS = {
  autoPong: COLLAB_WS_SERVER_OPTIONS.autoPong,
  maxFragments: COLLAB_WS_SERVER_OPTIONS.maxFragments,
  maxBufferedChunks: COLLAB_WS_SERVER_OPTIONS.maxBufferedChunks,
  perMessageDeflate: COLLAB_WS_SERVER_OPTIONS.perMessageDeflate,
};

/**
 * The ws server engine.io builds for /socket.io (its documented `wsEngine` option: "the WebSocket server implementation
 * to use"). engine.io constructs it with `{ noServer, clientTracking, perMessageDeflate, maxPayload }`; this merges in
 * REALTIME_WS_OPTIONS and, through ws's public `handleUpgrade`, installs the one-in-flight pong (socket-pong.ts, RFC 6455
 * §5.5.3) on each new socket before ws reads a frame from it. Stateless, so one module-level class serves every server.
 */
export class RealtimeWsServer extends WebSocketServer {
  constructor(options: ServerOptions = {}, callback?: () => void) {
    super({ ...options, ...REALTIME_WS_OPTIONS } as ServerOptions, callback);
  }

  override handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    upgradeHead: Buffer,
    callback: (client: WebSocket, request: IncomingMessage) => void,
  ): void {
    super.handleUpgrade(request, socket, upgradeHead, (ws, req) => {
      answerCollabPings(ws);
      callback(ws, req);
    });
  }
}

/**
 * Spread into ws.gateway.ts's `@WebSocketGateway({...})` (seam §161).
 * - `wsEngine` is engine.io's documented server option (above).
 * - `connectTimeout` is socket.io's documented server option: an engine connection that has joined no namespace by then
 *   is closed. socket.io's default is 45 s; an honest client sends its CONNECT right after the upgrade, so 10 s is ample
 *   and bounds a socket that passed the upgrade gate and then sends nothing.
 */
export const REALTIME_GATEWAY_OPTIONS: { wsEngine: typeof RealtimeWsServer; connectTimeout: number } = {
  wsEngine: RealtimeWsServer,
  connectTimeout: 10_000,
};

/** Resolves when the upgrade's Cookie header carries a signature-valid ACCESS JWT; rejects (or throws) otherwise. */
export type RealtimeAccessVerifier = (cookieHeader: string | undefined) => Promise<void>;

export interface RealtimeHardeningDeps {
  verifyAccessToken: RealtimeAccessVerifier;
}

/** The error a refused second CONNECT ends in (the engine is closing, so socket.io sends the client no CONNECT_ERROR). */
const REALTIME_ONE_CONNECT_ERROR = 'one_connect_per_connection';

/**
 * Install the upgrade gate and the namespace bounds on a constructed socket.io server. Call once per server.
 *
 * (a) `io.engine.use`: engine.io runs its middlewares on every request and upgrade before ws builds a socket; a
 * `next(err)` aborts an upgrade with `400 Bad Request` and destroys the raw socket. The gate runs the gateway's own first
 * step (cookie parse, resolved cookie name, `verifyJwt(…, ACCESS)`: an HMAC, no DB), so no socket exists without a
 * signature-valid ACCESS JWT. Liveness (DB) and the PDP listing stay in the gateway. Every throw and every rejection ends
 * in exactly one `next(err)`: `cookie.parse(undefined)` throws, and an escaped throw would leave the raw socket hanging
 * (main.ts swallows uncaught errors), the very hold this gate exists to prevent.
 *
 * (b) `io.use` (the main namespace, the only one the SPA uses):
 * - one CONNECT per engine connection. An honest socket.io client sends one, and after a server disconnect it closes
 *   its engine and opens a new one. A second CONNECT closes the engine connection and is refused, so a client cannot
 *   rerun the gateway's DB liveness check on one connection.
 * - a server namespace disconnect (the gateway's failed-auth `client.disconnect()`) closes the engine connection too.
 *   The listener is registered here, before socket.io emits `connection`, so it is in place even when the gateway
 *   rejects synchronously. `conn.close()` flushes the queued `Unauthorized` and DISCONNECT packets first; a client that
 *   never reads is still ended by the ping timeout, because a closing engine socket ignores pongs.
 */
export function hardenRealtimeServer(io: Server, deps: RealtimeHardeningDeps): void {
  io.engine.use((req: IncomingMessage, _res: unknown, next: (err?: Error) => void) => {
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        next(err);
      } catch {
        // engine.io's own continuation threw: nothing answered, so the raw socket must not be left open
        req.socket?.destroy();
      }
    };
    let pending: Promise<void>;
    try {
      pending = deps.verifyAccessToken(req.headers?.cookie); // a synchronous throw lands in the catch below
    } catch {
      settle(new Error('unauthorized'));
      return;
    }
    pending.then(
      () => settle(),
      () => settle(new Error('unauthorized')),
    );
  });

  const connects = new WeakMap<object, number>();
  io.use((socket: Socket, next: (err?: Error) => void) => {
    const conn = socket.conn;
    const seen = (connects.get(conn) ?? 0) + 1;
    connects.set(conn, seen);
    if (seen > 1) {
      conn.close();
      next(new Error(REALTIME_ONE_CONNECT_ERROR));
      return;
    }
    socket.once('disconnect', (reason: string) => {
      if (reason === 'server namespace disconnect') conn.close();
    });
    next();
  });
}

/**
 * The production verifier: exactly the gateway's first step (ws.gateway.ts `handleConnection`), with the same `cookie`
 * import, the resolved cookie name (`__Host-authToken` over https, #310), and the ACCESS token type. A parity fitness
 * (realtime-socket-bounds.fitness.spec.ts) pins that the gateway still authenticates this way.
 */
export function realtimeAccessVerifier(
  tokenService: { verifyJwt(token: string, tokenType: string): Promise<unknown> },
  env: AuthCookieEnv,
): RealtimeAccessVerifier {
  return async (cookieHeader) => {
    const cookies = cookie.parse(cookieHeader);
    await tokenService.verifyJwt(readDocmostAuthCookie(cookies, env), JwtType.ACCESS);
  };
}
