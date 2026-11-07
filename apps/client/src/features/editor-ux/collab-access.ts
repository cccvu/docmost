import { jwtDecode } from "jwt-decode";

/**
 * CCC fork addition (cccvu/wiki-v2#501) — how an open editor reacts when the server narrows its collab access.
 *
 * The fork's live-access revalidator closes a collab connection whose user lost access (restricted, removed,
 * demoted to reader). Hocuspocus closes it PER DOCUMENT: the server sends a CLOSE message and the websocket
 * stays open, so upstream's editor noticed nothing — no status, still editable, and everything typed afterwards
 * was silently held back. These rules turn that into a visible, correct state:
 *
 *   - a server-side close while the socket is still connected → reconnect now, so the server re-decides
 *     (a demoted user comes back read-only; a user who lost access is refused);
 *   - an authentication refusal that is NOT an expired token → refetch the collab token ONCE and retry (#537:
 *     the token is bound to the session that minted it, so a refusal can mean that session ended while a newer
 *     one is live, e.g. the user signed in again); a second refusal with no successful authentication in
 *     between, or a refetch that fails, means access is lost: stop editing and show the connection-lost
 *     status. An expired token keeps upstream's refresh-and-retry;
 *   - a successful authentication → the server's scope decides whether the editor may edit.
 *
 * Pure and dependency-free so it is unit-tested without a provider; page-editor.tsx wires it (seam 169).
 */

export interface CollabAccessState {
  /** The server refused this document (not a token expiry). */
  lost: boolean;
  /** The server authenticated the connection read-only. */
  readOnly: boolean;
  /** A non-expiry refusal already refetched the token; the next one is final (reset by `authenticated`). */
  refreshed: boolean;
}

export const initialCollabAccess: CollabAccessState = {
  lost: false,
  readOnly: false,
  refreshed: false,
};

export type CollabAccessEvent =
  | { kind: "server-close"; socketConnected: boolean }
  | { kind: "auth-failed"; tokenExpired: boolean }
  | { kind: "refresh-failed" }
  | { kind: "authenticated"; scope: string | undefined };

export interface CollabAccessStep {
  state: CollabAccessState;
  /** Re-open the socket so every attached document re-authenticates. */
  reconnect: boolean;
  /** Refetch the collab token, then reconnect with it (report a failure as `refresh-failed`). */
  refreshToken: boolean;
  /** Show the connection-lost status (the editor can no longer sync this document). */
  markDisconnected: boolean;
}

export function nextCollabAccess(
  prev: CollabAccessState,
  event: CollabAccessEvent,
): CollabAccessStep {
  switch (event.kind) {
    case "server-close":
      // A raw socket close is already handled by the provider (it reconnects and re-authenticates). Only a
      // per-document CLOSE on a live socket leaves the document unauthenticated with nothing to recover it.
      return {
        state: prev,
        reconnect: event.socketConnected,
        refreshToken: false,
        markDisconnected: false,
      };
    case "auth-failed":
      if (event.tokenExpired) {
        return {
          state: prev,
          reconnect: false,
          refreshToken: true,
          markDisconnected: false,
        };
      }
      if (!prev.refreshed) {
        return {
          state: { ...prev, refreshed: true },
          reconnect: false,
          refreshToken: true,
          markDisconnected: false,
        };
      }
      return lostStep(prev);
    case "refresh-failed":
      return lostStep(prev);
    case "authenticated":
      return {
        state: {
          lost: false,
          readOnly: event.scope === "readonly",
          refreshed: false,
        },
        reconnect: false,
        refreshToken: false,
        markDisconnected: false,
      };
  }
}

function lostStep(prev: CollabAccessState): CollabAccessStep {
  return {
    state: { ...prev, lost: true },
    reconnect: false,
    refreshToken: false,
    markDisconnected: true,
  };
}

/** The editor may edit only if the page allows it AND the server still lets this connection write. */
export function collabAllowsEditing(state: CollabAccessState): boolean {
  return !state.lost && !state.readOnly;
}

/**
 * The collab token the provider will send on its next authentication. A refresh writes the new token to
 * `remote.configuration.token`; the value captured when the editor mounted goes stale after the first refresh,
 * and deciding "expired?" from it misreads every later refusal as an expiry (refetch → reconnect → refused,
 * forever, never reaching the lost state).
 */
export function currentCollabToken(
  configured: unknown,
  initial: string | undefined,
): string | undefined {
  return typeof configured === "string" && configured ? configured : initial;
}

/** Expired (or unreadable/missing — refresh it rather than declare access lost). */
export function isCollabTokenExpired(
  token: string | undefined,
  nowMs: number,
): boolean {
  if (!token) return true;
  try {
    const { exp } = jwtDecode(token);
    return typeof exp !== "number" || nowMs / 1000 >= exp;
  } catch {
    return true;
  }
}
