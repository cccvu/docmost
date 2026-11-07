import { describe, expect, it, vi } from "vitest";
import { WebSocketStatus } from "@hocuspocus/provider";
import {
  refetchCollabTokenAndReopen,
  reopenCollabSocket,
  type ReconnectableSocket,
} from "./collab-reconnect";

/**
 * A socket that behaves like @hocuspocus/provider 3.4.4's HocuspocusProviderWebsocket: `disconnect()` keeps the
 * status Connected until the browser's close event (`close()` here), and `connect()` is a no-op while Connected.
 */
function fakeSocket(status: WebSocketStatus = WebSocketStatus.Connected) {
  const listeners = new Set<() => void>();
  const socket = {
    status: status as string,
    connects: 0,
    disconnects: 0,
    connect() {
      if (socket.status === WebSocketStatus.Connected) return; // upstream no-op
      socket.connects += 1;
      socket.status = WebSocketStatus.Connecting;
    },
    disconnect() {
      socket.disconnects += 1;
    },
    on(_event: "disconnect", fn: () => void) {
      listeners.add(fn);
    },
    off(_event: "disconnect", fn: () => void) {
      listeners.delete(fn);
    },
    /** The browser's close event, however late it arrives. */
    close() {
      socket.status = WebSocketStatus.Disconnected;
      [...listeners].forEach((fn) => fn());
    },
    listenerCount: () => listeners.size,
  };
  return socket satisfies ReconnectableSocket;
}

describe("reopenCollabSocket", () => {
  it("reconnects a connected socket only once its close lands, however slow the close is", () => {
    vi.useFakeTimers();
    try {
      const socket = fakeSocket();
      reopenCollabSocket(socket, () => true);
      expect(socket.disconnects).toBe(1);
      vi.advanceTimersByTime(5_000); // a slow close: no timer may have fired a no-op connect
      expect(socket.connects).toBe(0);
      socket.close();
      expect(socket.connects).toBe(1);
      expect(socket.listenerCount()).toBe(0); // one-shot
      socket.close(); // a later, unrelated close is the provider's business
      expect(socket.connects).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("connects a socket that is not connected directly (its disconnect() would emit nothing)", () => {
    for (const status of [
      WebSocketStatus.Disconnected,
      WebSocketStatus.Connecting,
    ]) {
      const socket = fakeSocket(status);
      reopenCollabSocket(socket, () => true);
      expect(socket.disconnects).toBe(0);
      expect(socket.connects).toBe(1);
    }
  });

  it("does nothing once the editor is gone, and does not reconnect if it goes during the close", () => {
    const gone = fakeSocket();
    reopenCollabSocket(gone, () => false);
    expect(gone.disconnects).toBe(0);

    let current = true;
    const leaving = fakeSocket();
    reopenCollabSocket(leaving, () => current);
    current = false; // unmounted before the close event
    leaving.close();
    expect(leaving.connects).toBe(0);
  });
});

describe("refetchCollabTokenAndReopen", () => {
  const io = (
    refetch: () => Promise<{ isSuccess: boolean; data?: { token?: string } }>,
    isCurrent: () => boolean = () => true,
  ) => ({
    refetch,
    setToken: vi.fn(),
    reopen: vi.fn(),
    onFailed: vi.fn(),
    isCurrent,
  });

  it("a successful refetch sets the new token, then reopens", async () => {
    const order: string[] = [];
    const deps = io(async () => ({ isSuccess: true, data: { token: "new" } }));
    deps.setToken.mockImplementation(() => order.push("token"));
    deps.reopen.mockImplementation(() => order.push("reopen"));
    await refetchCollabTokenAndReopen(deps);
    expect(deps.setToken).toHaveBeenCalledWith("new");
    expect(order).toEqual(["token", "reopen"]);
    expect(deps.onFailed).not.toHaveBeenCalled();
  });

  it("a failed query never re-sends its stale cached token: it reports the failure", async () => {
    const deps = io(async () => ({
      isSuccess: false,
      data: { token: "stale" },
    }));
    await refetchCollabTokenAndReopen(deps);
    expect(deps.setToken).not.toHaveBeenCalled();
    expect(deps.reopen).not.toHaveBeenCalled();
    expect(deps.onFailed).toHaveBeenCalledTimes(1);
  });

  it("a success without a token, or a rejected refetch, is a failure", async () => {
    const empty = io(async () => ({ isSuccess: true, data: {} }));
    await refetchCollabTokenAndReopen(empty);
    expect(empty.onFailed).toHaveBeenCalledTimes(1);
    expect(empty.reopen).not.toHaveBeenCalled();

    const rejected = io(() => Promise.reject(new Error("network")));
    await refetchCollabTokenAndReopen(rejected);
    expect(rejected.onFailed).toHaveBeenCalledTimes(1);
    expect(rejected.reopen).not.toHaveBeenCalled();
  });

  it("a late result after the editor is gone changes nothing (no reopen, no lost status on the next page)", async () => {
    const ok = io(
      async () => ({ isSuccess: true, data: { token: "new" } }),
      () => false,
    );
    await refetchCollabTokenAndReopen(ok);
    expect(ok.setToken).not.toHaveBeenCalled();
    expect(ok.reopen).not.toHaveBeenCalled();

    const failed = io(
      async () => ({ isSuccess: false }),
      () => false,
    );
    await refetchCollabTokenAndReopen(failed);
    expect(failed.onFailed).not.toHaveBeenCalled();

    const rejected = io(
      () => Promise.reject(new Error("x")),
      () => false,
    );
    await refetchCollabTokenAndReopen(rejected);
    expect(rejected.onFailed).not.toHaveBeenCalled();
  });
});
