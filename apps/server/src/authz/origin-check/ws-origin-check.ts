import type { Socket } from 'socket.io';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { originCheckAllows, signalsFromHeaders } from './origin-check';

/** The error a refused handshake gets (`connect_error` on the client). Carries no detail. */
export const SOCKET_ORIGIN_CHECK_ERROR = 'origin_check';

/**
 * Cross-site WebSocket hijacking check for the notifications socket — NOT upstream Docmost code (wiki-v2 #655).
 *
 * The socket.io gateway authenticates from the session cookie at the handshake, and a browser attaches that cookie
 * to a WebSocket opened by any same-site page. So every handshake gets the HTTP guard's decision
 * ({@link originCheckAllows}) on its own headers, with the same trusted list `[APP_URL]`. A browser always sends
 * `Origin` on a WebSocket; a non-browser client that sends no signal is allowed, and then still needs the cookie.
 *
 * Registered as namespace middleware by `ws/ws.gateway.ts` `afterInit` (seam #161), so it runs before the gateway's
 * `handleConnection`: a refused socket never authenticates, never joins a room and never reaches a message handler.
 * Dev: Vite's `/socket.io` proxy rewrites `Origin` to the engine's `APP_URL` while `Host` stays the dev server's,
 * which the trusted list covers.
 */
export function socketOriginCheck(
  environmentService: EnvironmentService,
): (socket: Socket, next: (err?: Error) => void) => void {
  return (socket, next) => {
    if (originCheckAllows(signalsFromHeaders(socket.handshake.headers), [environmentService.getAppUrl()])) {
      next();
      return;
    }
    next(new Error(SOCKET_ORIGIN_CHECK_ERROR));
  };
}
