/**
 * CCC collab integration — NOT upstream Docmost code (#790, #810, ADR 0036).
 *
 * The collab connect's refusals: the shape every bound's refusal is thrown in, the reasons the client sees, and the
 * wrapper that gives the connect's own 4xx refusals the same quiet shape.
 *
 * A refusal is `{ reason }` with NO `message`. Hocuspocus 4.7.1 logs `error.message` of a failed hook
 * (`Hocuspocus.hooks`: `[onAuthenticate] <message>`), once per attempt, so a refusal a client can trigger at will would
 * otherwise write a line per attempt; each refusal logs its own rate-limited `COLLAB_SOCKET_LIMIT` line instead
 * (socket-limit-log.ts). Hocuspocus answers the client with permission-denied carrying the reason (4.7.1
 * `ClientConnection`: `error.reason ?? "permission-denied"`). The editor (collab-access.ts), not the provider, paces
 * what follows: Hocuspocus provider 4.7.1 reconnects a socket that had received a frame after a fixed ~1 s, with no
 * backoff, so the editor closes the socket itself. COLLAB_AUTH_RATE_REASON and COLLAB_USER_CONNECTIONS_REASON (and a
 * 1013 or 4429 close) are "try later": it reopens after its own jittered wait (5 s doubling to 60 s), never refetching
 * the token and never marking the editor lost. Any other reason (this module's COLLAB_INVALID_TOKEN_REASON included) is
 * a refusal: it closes the socket, refetches the token once (every time for an expired token), and after a second
 * refusal with no authentication between shows the connection lost and retries after a jittered 30–60 s.
 */
import { HttpException } from '@nestjs/common';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

/** The collab authentication rates, per session and per user (auth-rate.ts). */
export const COLLAB_AUTH_RATE_REASON = 'ccc:collab-auth-rate-limited';
/** The per-user connection cap (user-connections.ts); also the reason of its over-cap close at `connected`. */
export const COLLAB_USER_CONNECTIONS_REASON = 'ccc:collab-user-connections';
/**
 * A collab token that does not verify, or names no session (authentication.extension.ts, seam #213). The reason is the
 * one Hocuspocus sends for a refusal that names none, so the client sees what it saw before; the editor decides
 * "expired?" from the token it sent, never from the reason (collab-access.ts). Such a token never reaches the auth
 * rates, which need a verified user and session; how many times one socket may try is bounded by its Auth frames
 * (frame-admission.ts). The connect's own access refusals (`quietCollabAuthRefusals`) answer with it too.
 */
export const COLLAB_INVALID_TOKEN_REASON = 'permission-denied';

export interface CollabAuthRefusal {
  readonly reason: string;
}

/** The thrown value of every bound's refusal in `onAuthenticate`: `{ reason }`, never a `message`. */
export function collabAuthRefusal(reason: string): CollabAuthRefusal {
  return { reason };
}

/** The cause `invalidCollabTokenRefusal` takes for a verified collab token that names no session (#537 mints none). */
export const COLLAB_TOKEN_WITHOUT_SESSION = Symbol('collab token without a session');

/** What is logged about a refused token: its kind only. */
export type InvalidCollabTokenKind = 'expired' | 'invalid' | 'no_session';

function invalidTokenKind(cause: unknown): InvalidCollabTokenKind {
  if (cause === COLLAB_TOKEN_WITHOUT_SESSION) return 'no_session';
  return (cause as { name?: unknown } | null)?.name === 'TokenExpiredError' ? 'expired' : 'invalid';
}

/**
 * A collab token that does not verify (`cause` is what the verify threw) or names no session
 * (COLLAB_TOKEN_WITHOUT_SESSION): logged, rate-limited, as `COLLAB_SOCKET_LIMIT {"limit":"invalid_token","kind":…}`
 * with the kind only (never the token, the error's message or an unverified `sub`), and refused with
 * COLLAB_INVALID_TOKEN_REASON. Collab tokens live 24 h, so an expired one is a rare honest event and a stream of
 * invalid ones is a probe.
 */
export function invalidCollabTokenRefusal(cause: unknown, limitLog: SocketLimitLog = collabSocketLimitLog): CollabAuthRefusal {
  limitLog.log('invalid_token', { kind: invalidTokenKind(cause) });
  return collabAuthRefusal(COLLAB_INVALID_TOKEN_REASON);
}

/** The hook `quietCollabAuthRefusals` wraps (the authentication extension's, seam #213). */
export interface CollabAuthenticator<P, R> {
  onAuthenticate(payload: P): Promise<R>;
}

/**
 * The authentication extension's `onAuthenticate`, with its 4xx refusals made quiet (#810 L1). The connect refuses with
 * Nest's HttpExceptions (no such user, a disabled one, a session no longer live, no such page, no access), whose
 * `message` Hocuspocus would log once per attempt (`[onAuthenticate] Unauthorized`). Here an HttpException with a status
 * below 500 is logged, rate-limited, as `COLLAB_SOCKET_LIMIT {"limit":"auth_refused","status":…}` and rethrown as
 * `{ reason: COLLAB_INVALID_TOKEN_REASON }`: what Hocuspocus already sent for it (an HttpException has no `reason`), so
 * the wire is unchanged. Everything else is rethrown as it is: a failed read or PDP call and a 5xx keep Hocuspocus's
 * per-attempt line (an outage is worth one), and the `{ reason }` refusals already carry no message.
 *
 * The wrapper has no `priority`, so Hocuspocus's priority sort keeps the extension where the gateway lists it (seam #3),
 * and only the one hook: the authentication extension defines no other.
 */
export function quietCollabAuthRefusals<P, R>(
  extension: CollabAuthenticator<P, R>,
  limitLog: SocketLimitLog = collabSocketLimitLog,
): CollabAuthenticator<P, R> {
  return {
    onAuthenticate: (payload: P) =>
      extension.onAuthenticate(payload).catch((error: unknown) => {
        if (error instanceof HttpException && error.getStatus() < 500) {
          limitLog.log('auth_refused', { status: error.getStatus() });
          throw collabAuthRefusal(COLLAB_INVALID_TOKEN_REASON);
        }
        throw error;
      }),
  };
}
