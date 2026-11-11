/**
 * CCC collab integration — NOT upstream Docmost code (#790, #810, ADR 0036).
 *
 * The collab connect's refusals that are bounds, not access decisions: the shape every one of them is thrown in, and
 * the reasons the client sees.
 *
 * A refusal is `{ reason }` with NO `message`. Hocuspocus 4.7.1 logs `error.message` of a failed hook
 * (`Hocuspocus.hooks`), once per attempt, so a refusal a client can trigger at will would otherwise write a line per
 * attempt; each bound logs its own rate-limited `COLLAB_SOCKET_LIMIT` line instead (socket-limit-log.ts). Hocuspocus
 * answers the client with permission-denied carrying the reason (4.7.1 `ClientConnection`:
 * `error.reason ?? "permission-denied"`), which the editor treats as any other refusal (collab-access.ts: refetch the
 * token once, then the connection-lost state).
 */

/** The per-user collab authentication rate (auth-rate.ts). */
export const COLLAB_AUTH_RATE_REASON = 'ccc:collab-auth-rate-limited';
/** The per-user connection cap (user-connections.ts); also the reason of its over-cap close at `connected`. */
export const COLLAB_USER_CONNECTIONS_REASON = 'ccc:collab-user-connections';
/**
 * A collab token that does not verify (authentication.extension.ts, seam #213). The reason is the one Hocuspocus sends
 * for a refusal that names none, so the client sees what it saw before; the editor decides "expired?" from the token it
 * sent, never from the reason (page-editor.tsx, collab-access.ts). Such a token never reaches the per-user rate, which
 * needs the verified user id; how many times one socket may try is bounded by its Auth frames (frame-admission.ts).
 */
export const COLLAB_INVALID_TOKEN_REASON = 'permission-denied';

export interface CollabAuthRefusal {
  readonly reason: string;
}

/** The thrown value of every bound's refusal in `onAuthenticate`: `{ reason }`, never a `message`. */
export function collabAuthRefusal(reason: string): CollabAuthRefusal {
  return { reason };
}

export function invalidCollabTokenRefusal(): CollabAuthRefusal {
  return collabAuthRefusal(COLLAB_INVALID_TOKEN_REASON);
}
