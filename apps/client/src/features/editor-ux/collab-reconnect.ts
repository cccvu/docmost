import { WebSocketStatus } from "@hocuspocus/provider";

/**
 * CCC fork addition (cccvu/wiki-v2#501, #537) — how the editor re-opens the collab socket so every attached
 * document re-authenticates, and how it refetches the collab token first. Carried out by
 * `collab-access-controller.ts` (wired by seam 169); the decision of WHEN to do either stays in `collab-access.ts`.
 * #810: the controller closes the socket before every refetch (the server closes a refused socket, and the
 * provider would reconnect it in 1 s with the old token), so `reopen` usually finds it closed and connects directly.
 */

/** The slice of `HocuspocusProviderWebsocket` the reconnect uses. */
export interface ReconnectableSocket {
  status: WebSocketStatus | string;
  connect(): unknown;
  disconnect(): void;
  on(event: "disconnect", fn: () => void): unknown;
  off(event: "disconnect", fn: () => void): unknown;
}

/**
 * Re-open the socket. On a connected socket, reconnect on the socket's own `disconnect` event, never on a timer:
 * `disconnect()` keeps the status Connected until the browser's close event and `connect()` is a no-op while it
 * reads Connected, so a timer that fires before a slow close strands the editor with nothing left to reconnect it.
 * A socket that is not connected emits no `disconnect` (its `disconnect()` only cancels the retry), so it is
 * connected directly. `isCurrent` is false once the editor unmounted or moved to another page: do nothing then.
 */
export function reopenCollabSocket(
  socket: ReconnectableSocket,
  isCurrent: () => boolean,
): void {
  if (!isCurrent()) return;
  if (socket.status !== WebSocketStatus.Connected) {
    socket.connect();
    return;
  }
  const reopen = () => {
    socket.off("disconnect", reopen);
    if (isCurrent()) socket.connect();
  };
  socket.on("disconnect", reopen);
  socket.disconnect();
}

/**
 * #810: whether page-editor.tsx's visibility effect should open the socket: the tab is visible, the header reads
 * disconnected, and nothing is retrying the socket (`shouldConnect` is false only after `disconnect()`: the effect's
 * own idle close, or the access controller's lost / try-later close). A socket the provider is already retrying is
 * left alone: `connect()` cancels the provider's backoff and dials at once, and an effect that ran on every status
 * render (the unstable `resetIdle` in its deps) turned that into a reconnect per round trip (42 in 15 s).
 */
export function reopensOnVisible(
  documentState: string,
  status: WebSocketStatus | string,
  socket: { shouldConnect: boolean },
): boolean {
  return (
    documentState === "visible" &&
    status === WebSocketStatus.Disconnected &&
    !socket.shouldConnect
  );
}

export interface CollabTokenRefetch {
  /** The collab-token query's refetch (TanStack Query: resolves with the query result, even on an error). */
  refetch: () => Promise<{ isSuccess: boolean; data?: { token?: string } }>;
  /** Hand the new token to the provider for its next authentication. */
  setToken: (token: string) => void;
  /** Re-open the socket so the documents re-authenticate with the new token. */
  reopen: () => void;
  /** The refetch failed (an error, or no token): report `refresh-failed`. */
  onFailed: () => void;
  /** False once the editor unmounted or moved to another page: a late result then changes nothing. */
  isCurrent: () => boolean;
}

/**
 * Refetch the collab token, then reconnect with it. Only a SUCCESSFUL query counts: a failed refetch resolves with
 * the previous cached token, and re-sending that would be refused again.
 */
export function refetchCollabTokenAndReopen(
  io: CollabTokenRefetch,
): Promise<void> {
  const failed = () => {
    if (io.isCurrent()) io.onFailed();
  };
  return io.refetch().then((result) => {
    if (!io.isCurrent()) return;
    const token = result.isSuccess ? result.data?.token : undefined;
    if (!token) return failed();
    io.setToken(token);
    io.reopen();
  }, failed);
}
