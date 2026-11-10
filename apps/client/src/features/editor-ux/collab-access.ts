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
 *     status. An expired token refetches every time, as upstream did; a refetch that fails is lost there too
 *     (upstream left that editor editable with nothing syncing);
 *   - a successful authentication → the server's scope decides whether the editor may edit;
 *   - #781: the server's collab ingress guard refuses a frame it will not apply with that same per-document CLOSE,
 *     and the provider reports it as code 1000, so the REASON is the only signal:
 *       - `ccc:collab-update-refused:<rule>` → detach the provider (a refused provider stays attached and keeps
 *         sending), stop editing, show the refusal notice, and never reconnect: this browser's copy would be
 *         replayed and refused again. Final until the page reloads. #790: close the editor's socket too (each page
 *         editor has its own); with nothing attached it would otherwise idle, or reconnect every 30 s (the
 *         provider's message timeout), for as long as the tab stays open. Reload and Discard reload the page, so
 *         they need no socket;
 *       - `ccc:collab-update-unresolved` → the server could not decide; reconnect ONCE. The retry is spent until
 *         `sync-acked` (every frame this provider sent was applied), NOT until the next authentication, which
 *         happens before the replay is judged; a second one before that is treated as refused.
 *   - #790: a SOCKET close with code 1009 (the server's ws "message too big": this browser sent a frame over the
 *     server's maxPayload) is refused too. The provider would reconnect and resend the same frame (its Step2 answer
 *     to the server's Step1) every second, forever. Only a raw socket close carries a code other than 1000.
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
  /** #781: the server refused a frame from this editor; the provider is detached. Final until a reload. */
  refused: boolean;
  /** #781: an `unresolved` close already reconnected; the next one is refused (reset only by `sync-acked`). */
  unresolvedRetried: boolean;
}

export const initialCollabAccess: CollabAccessState = {
  lost: false,
  readOnly: false,
  refreshed: false,
  refused: false,
  unresolvedRetried: false,
};

/** #781: the server's close reasons (`apps/server/src/authz/collab-ingress`). */
export const COLLAB_UPDATE_REFUSED_PREFIX = "ccc:collab-update-refused:";
export const COLLAB_UPDATE_UNRESOLVED = "ccc:collab-update-unresolved";

/** #790: the ws close code for a message over the server's `maxPayload` (RFC 6455 "Message Too Big"). */
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009;

export function classifyCollabCloseReason(
  reason: string | undefined,
  code?: number,
): "refused" | "unresolved" | "other" {
  if (code === WS_CLOSE_MESSAGE_TOO_BIG) return "refused";
  if (typeof reason !== "string") return "other";
  if (reason.startsWith(COLLAB_UPDATE_REFUSED_PREFIX)) return "refused";
  if (reason === COLLAB_UPDATE_UNRESOLVED) return "unresolved";
  return "other";
}

export type CollabAccessEvent =
  | {
      kind: "server-close";
      socketConnected: boolean;
      reason?: string;
      /** #790: the close code (a document CLOSE is always 1000; a raw socket close carries the socket's own). */
      code?: number;
    }
  | { kind: "auth-failed"; tokenExpired: boolean }
  | { kind: "refresh-failed" }
  | { kind: "authenticated"; scope: string | undefined }
  /** #781: the provider's unsynced-changes count reached 0 — the server applied every frame it was sent. */
  | { kind: "sync-acked" };

export interface CollabAccessStep {
  state: CollabAccessState;
  /** Re-open the socket so every attached document re-authenticates. */
  reconnect: boolean;
  /** Refetch the collab token, then reconnect with it (report a failure as `refresh-failed`). */
  refreshToken: boolean;
  /** Show the connection-lost status (the editor can no longer sync this document). */
  markDisconnected: boolean;
  /** #781: detach the provider so it stops sending (and keep it detached). */
  detach: boolean;
  /** #790: close the editor's socket after the detach, and never reopen it (nothing is attached to it any more). */
  disconnectSocket: boolean;
}

const NO_ACTION = {
  reconnect: false,
  refreshToken: false,
  markDisconnected: false,
  detach: false,
  disconnectSocket: false,
} as const;

export function nextCollabAccess(
  prev: CollabAccessState,
  event: CollabAccessEvent,
): CollabAccessStep {
  // #781: refused is final. The provider is detached, so nothing should arrive; if something does, ignore it.
  if (prev.refused) return { state: prev, ...NO_ACTION };
  switch (event.kind) {
    case "server-close": {
      const reason = classifyCollabCloseReason(event.reason, event.code);
      if (reason === "refused") return refusedStep(prev);
      if (reason === "unresolved") {
        if (prev.unresolvedRetried) return refusedStep(prev);
        // Reconnect once (a closing socket is reconnected by the provider itself).
        return {
          ...NO_ACTION,
          state: { ...prev, unresolvedRetried: true },
          reconnect: event.socketConnected,
        };
      }
      // A raw socket close is already handled by the provider (it reconnects and re-authenticates). Only a
      // per-document CLOSE on a live socket leaves the document unauthenticated with nothing to recover it.
      return { ...NO_ACTION, state: prev, reconnect: event.socketConnected };
    }
    case "sync-acked":
      if (!prev.unresolvedRetried) return { state: prev, ...NO_ACTION };
      return { state: { ...prev, unresolvedRetried: false }, ...NO_ACTION };
    case "auth-failed":
      if (event.tokenExpired) {
        return { ...NO_ACTION, state: prev, refreshToken: true };
      }
      if (!prev.refreshed) {
        return {
          ...NO_ACTION,
          state: { ...prev, refreshed: true },
          refreshToken: true,
        };
      }
      return lostStep(prev);
    case "refresh-failed":
      return lostStep(prev);
    case "authenticated":
      return {
        ...NO_ACTION,
        state: {
          ...prev, // #781: `unresolvedRetried` survives: authenticating says nothing about the replay
          lost: false,
          readOnly: event.scope === "readonly",
          refreshed: false,
        },
      };
  }
}

function lostStep(prev: CollabAccessState): CollabAccessStep {
  return {
    ...NO_ACTION,
    state: { ...prev, lost: true },
    markDisconnected: true,
  };
}

/**
 * #781: stop sending and stop editing. No `markDisconnected`: the header's "connection lost. Retrying..." would be
 * untrue (nothing retries); the refusal notice says what happened and offers the recovery.
 */
function refusedStep(prev: CollabAccessState): CollabAccessStep {
  return {
    ...NO_ACTION,
    state: { ...prev, refused: true },
    detach: true,
    disconnectSocket: true,
  };
}

/** The editor may edit only if the page allows it AND the server still lets this connection write. */
export function collabAllowsEditing(state: CollabAccessState): boolean {
  return !state.lost && !state.readOnly && !state.refused;
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
