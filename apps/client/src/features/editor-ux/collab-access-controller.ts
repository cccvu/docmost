import { WebSocketStatus } from "@hocuspocus/provider";
import {
  CollabAccessEvent,
  CollabAccessState,
  collabAwaitsRetry,
  collabRetryDelay,
  currentCollabToken,
  initialCollabAccess,
  isCollabTokenExpired,
  nextCollabAccess,
} from "./collab-access";
import {
  CollabTokenRefetch,
  ReconnectableSocket,
  refetchCollabTokenAndReopen,
  reopenCollabSocket,
} from "./collab-reconnect";
import {
  CollabCopyTracker,
  CollabLocalCopy,
  trackCollabCopy,
} from "./collab-epoch";

/**
 * CCC fork addition (cccvu/wiki-v2#810) — carries out the steps `collab-access.ts` decides for one page editor's
 * provider pair. page-editor.tsx (seam 169) builds the socket and the provider, then hands both to this controller
 * and keeps only the render-side reads (`state`, for editability, the refusal notice and the attach guard).
 *
 * What it does with a step, in order: mark the header disconnected; reopen the socket (on its own `disconnect`
 * event, collab-reconnect.ts); detach the provider (refused); close the socket (refused, lost, try later, and before
 * every token refetch); start the one retry timer (lost or try later, jittered by `collabRetryDelay`); refetch the
 * token and reopen with it.
 *
 * The retry timer only undoes this controller's own close: it opens the socket only while the editor still awaits a
 * retry and the socket is still closed by us (`shouldConnect` false). A socket something else already reopened (the
 * tab becoming visible again) is retrying on its own, with the provider's backoff, and `connect()` would restart that
 * backoff at zero.
 *
 * The one exception is the browser's `online` event: the network just came back, so a socket the provider is still
 * retrying (`shouldConnect` true, disconnected) is dialled once at once instead of waiting out a backoff that may
 * have grown to 30 s while offline. It never touches a socket this controller closed (a refusal, lost, try later:
 * their pacing stands) or one the tab closed while idle, and it fires once per network change, not per close.
 *
 * #827: it judges refusals against the epoch its copy claims (`epoch`), feeds the provider's `synced` (which resets
 * the try-later wait), and keeps the local copy's dirty marker (`local`, collab-epoch.ts) for `isCopyDirty`.
 */

/** The slice of `HocuspocusProviderWebsocket` the controller drives. */
export interface CollabControllerSocket extends ReconnectableSocket {
  /** False only after `disconnect()`: the provider is not trying to reconnect on its own. */
  shouldConnect: boolean;
}

/** The slice of `HocuspocusProvider` the controller drives and listens to. */
export interface CollabControllerProvider {
  configuration: { token?: unknown };
  detach(): void;
  on(event: string, fn: (...args: any[]) => void): unknown;
  off(event: string, fn: (...args: any[]) => void): unknown;
}

export interface CollabAccessControllerOptions {
  socket: CollabControllerSocket;
  /** The collab token the provider was built with (the expiry check prefers the provider's current one). */
  initialToken: string | undefined;
  /** The collab-token query's refetch (TanStack Query). */
  refetchToken: CollabTokenRefetch["refetch"];
  /** Every new state (render it: editability, the refusal notice). */
  onState: (state: CollabAccessState) => void;
  /** Show the connection-lost status in the header. */
  markDisconnected: () => void;
  /** For tests: the jitter source (default Math.random) and the clock (default Date.now). */
  random?: () => number;
  now?: () => number;
  /** Where the browser's `online` event fires (default `window`; none outside a browser). */
  network?: CollabNetworkEvents | null;
  /** #827: the lineage epoch this editor's copy and socket claim (default 0). */
  epoch?: number;
  /** #827: the page's local copy (y-indexeddb), whose dirty marker decides how an epoch change is met. */
  local?: CollabLocalCopy;
}

/** The slice of `window` the controller listens to. */
export interface CollabNetworkEvents {
  addEventListener(type: "online", fn: () => void): void;
  removeEventListener(type: "online", fn: () => void): void;
}

export interface CollabAccessController {
  /** The current access state. */
  readonly state: CollabAccessState;
  /** Listen to this editor's provider. Call once, right after constructing it with the controller's socket. */
  bind(provider: CollabControllerProvider): void;
  /** Feed one event (exported for tests; the bound provider's events arrive here). */
  handle(event: CollabAccessEvent): void;
  /** #827: whether the local copy may hold a change the server never acknowledged (no local copy: dirty). */
  isCopyDirty(): Promise<boolean>;
  /** The editor unmounted or moved to another page: stop the timer, and let late results change nothing. */
  destroy(): void;
}

export function createCollabAccessController(
  options: CollabAccessControllerOptions,
): CollabAccessController {
  const { socket } = options;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const network =
    options.network !== undefined
      ? options.network
      : typeof window !== "undefined"
        ? window
        : null;
  let state: CollabAccessState = initialCollabAccess;
  let provider: CollabControllerProvider | null = null;
  let destroyed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let copy: CollabCopyTracker | null = null;
  const epoch = options.epoch ?? 0;

  // False once destroyed, and once refused: a token refetch already in flight never reopens a refused socket.
  const isCurrent = () => !destroyed && !state.refused;

  const handle = (event: CollabAccessEvent) => {
    if (destroyed) return;
    const step = nextCollabAccess(state, event, epoch);
    if (step.state !== state) {
      state = step.state;
      options.onState(state);
    }
    if (step.markDisconnected) options.markDisconnected();
    if (step.reconnect) reopenCollabSocket(socket, isCurrent);
    if (step.detach) provider?.detach();
    if (step.disconnectSocket) socket.disconnect();
    if (step.retryAfterMs) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined;
          if (
            isCurrent() &&
            collabAwaitsRetry(state) &&
            !socket.shouldConnect
          ) {
            socket.connect();
          }
        },
        collabRetryDelay(step.retryAfterMs, random),
      );
    }
    if (step.refreshToken) {
      void refetchCollabTokenAndReopen({
        refetch: options.refetchToken,
        setToken: (token) => {
          if (provider) provider.configuration.token = token;
        },
        reopen: () => reopenCollabSocket(socket, isCurrent),
        onFailed: () => handle({ kind: "refresh-failed" }),
        isCurrent,
      });
    }
  };

  const onAuthenticationFailed = ({ reason }: { reason?: string } = {}) => {
    // Judge the token the provider actually sent: a refresh updates `configuration.token`, and the mount-time token
    // would read every later refusal as an expiry (a refetch loop).
    const token = currentCollabToken(
      provider?.configuration.token,
      options.initialToken,
    );
    handle({
      kind: "auth-failed",
      tokenExpired: isCollabTokenExpired(token, now()),
      reason,
    });
  };
  const onAuthenticated = ({ scope }: { scope?: string } = {}) =>
    handle({ kind: "authenticated", scope });
  // The provider's `close` carries both a raw socket close (its own code) and a per-document CLOSE (always 1000; the
  // reason is the signal). The socket's status tells them apart: a document CLOSE leaves it connected.
  const onClose = ({
    event,
  }: { event?: { code?: number; reason?: string } } = {}) =>
    handle({
      kind: "server-close",
      socketConnected: socket.status === WebSocketStatus.Connected,
      reason: event?.reason,
      code: event?.code,
    });
  const onUnsyncedChanges = ({ number }: { number?: number } = {}) => {
    if (number === 0) handle({ kind: "sync-acked" });
  };
  // #827: the page loaded and the server answered: the try-later wait (and a compaction) is over.
  const onSynced = ({ state: synced }: { state?: boolean } = {}) => {
    if (synced) handle({ kind: "synced" });
  };
  // The network is back: skip the provider's remaining backoff, only for a socket the provider itself is retrying.
  const onOnline = () => {
    if (
      isCurrent() &&
      socket.shouldConnect &&
      socket.status === WebSocketStatus.Disconnected
    ) {
      socket.connect();
    }
  };

  return {
    get state() {
      return state;
    },
    bind(next) {
      if (provider)
        throw new Error("collab access controller is already bound");
      provider = next;
      next.on("authenticationFailed", onAuthenticationFailed);
      next.on("authenticated", onAuthenticated);
      next.on("close", onClose);
      next.on("unsyncedChanges", onUnsyncedChanges);
      next.on("synced", onSynced);
      if (options.local) copy = trackCollabCopy(options.local, next);
      network?.addEventListener("online", onOnline);
    },
    handle,
    isCopyDirty() {
      return copy ? copy.isDirty() : Promise.resolve(true);
    },
    destroy() {
      destroyed = true;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      network?.removeEventListener("online", onOnline);
      if (provider) {
        provider.off("authenticationFailed", onAuthenticationFailed);
        provider.off("authenticated", onAuthenticated);
        provider.off("close", onClose);
        provider.off("unsyncedChanges", onUnsyncedChanges);
        provider.off("synced", onSynced);
      }
      copy?.destroy();
    },
  };
}
