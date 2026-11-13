// CCC (wiki-v2 #830) — NOT upstream Docmost code.
import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { socketAtom } from "@/features/websocket/atoms/socket-atom.ts";
import { getMyInfo } from "@/features/user/services/user-service";

/** Consecutive failed reconnect attempts before the tab checks its own session. */
export const SOCKET_AUTH_PROBE_AFTER = 3;

/**
 * wiki-v2 #830: the server refuses a /socket.io upgrade (HTTP 400) that carries no valid access token, and
 * socket.io-client then retries every few seconds forever. A tab whose session is gone (signed out in another
 * tab, token lapsed, a #761 clear) would never notice. So after SOCKET_AUTH_PROBE_AFTER consecutive reconnect
 * errors it asks for /users/me once through the app's api client: a 401 there re-mints the wiki session
 * (remote mode) or goes to the login page (lib/api-client.ts). Any other outcome (a deploy, a network blip)
 * leaves socket.io retrying, and the count starts over. At most one probe is in flight.
 */
export function useSocketAuthProbe(): void {
  const socket = useAtomValue(socketAtom);
  // A ref, not effect state, so the single in-flight slot also spans a socket change or StrictMode re-run.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!socket) return;
    const manager = socket.io;
    let failures = 0;
    const reset = () => {
      failures = 0;
    };
    const onReconnectError = () => {
      if (socket.connected) return;
      failures += 1;
      if (failures < SOCKET_AUTH_PROBE_AFTER || inFlight.current) return;
      inFlight.current = true;
      getMyInfo()
        .catch(() => undefined) // the api client already acted on a 401; anything else: keep retrying
        .finally(() => {
          inFlight.current = false;
          reset();
        });
    };

    manager.on("reconnect_error", onReconnectError);
    manager.on("reconnect", reset);
    socket.on("connect", reset);
    return () => {
      manager.off("reconnect_error", onReconnectError);
      manager.off("reconnect", reset);
      socket.off("connect", reset);
    };
  }, [socket]);
}
