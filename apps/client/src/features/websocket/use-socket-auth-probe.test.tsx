// CCC (wiki-v2 #830) — NOT upstream Docmost code.
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createStore, Provider, type PrimitiveAtom } from "jotai";
import type { Socket } from "socket.io-client";
import { socketAtom } from "@/features/websocket/atoms/socket-atom.ts";
import {
  SOCKET_AUTH_PROBE_AFTER,
  useSocketAuthProbe,
} from "./use-socket-auth-probe";

// The client builds without strictNullChecks, so `atom<Socket | null>(null)` types as read-only there.
const writableSocketAtom = socketAtom as unknown as PrimitiveAtom<Socket | null>;

const getMyInfo = vi.fn();
vi.mock("@/features/user/services/user-service", () => ({
  getMyInfo: () => getMyInfo(),
}));

class Emitter {
  private handlers = new Map<string, Set<() => void>>();
  on(event: string, fn: () => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return this;
  }
  off(event: string, fn: () => void) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
  emit(event: string) {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn();
  }
  count() {
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }
}

function fakeSocket() {
  const manager = new Emitter();
  const socket = Object.assign(new Emitter(), { connected: false, io: manager });
  return { socket, manager };
}

function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(socket: ReturnType<typeof fakeSocket>["socket"]) {
  const store = createStore();
  store.set(writableSocketAtom, socket as unknown as Socket);
  const wrapper = ({ children }: React.PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  return { store, ...renderHook(() => useSocketAuthProbe(), { wrapper }) };
}

const flush = () => act(async () => {});
const fail = (manager: Emitter, n: number) => {
  for (let i = 0; i < n; i++) manager.emit("reconnect_error");
};

beforeEach(() => {
  getMyInfo.mockReset();
});

describe("useSocketAuthProbe (wiki-v2 #830)", () => {
  it("probes /users/me exactly once after the third consecutive reconnect error", async () => {
    getMyInfo.mockResolvedValue({});
    const { socket, manager } = fakeSocket();
    mount(socket);
    fail(manager, SOCKET_AUTH_PROBE_AFTER - 1);
    expect(getMyInfo).not.toHaveBeenCalled();
    fail(manager, 1);
    expect(getMyInfo).toHaveBeenCalledTimes(1);
    await flush();
  });

  it("never starts a second probe while one is in flight", async () => {
    const pending = deferred();
    getMyInfo.mockReturnValue(pending.promise);
    const { socket, manager } = fakeSocket();
    mount(socket);
    fail(manager, SOCKET_AUTH_PROBE_AFTER);
    fail(manager, SOCKET_AUTH_PROBE_AFTER * 2);
    expect(getMyInfo).toHaveBeenCalledTimes(1);
    pending.resolve({});
    await flush();
  });

  it("a successful probe resets the count: the next one needs three more errors", async () => {
    getMyInfo.mockResolvedValue({});
    const { socket, manager } = fakeSocket();
    mount(socket);
    fail(manager, SOCKET_AUTH_PROBE_AFTER);
    await flush();
    fail(manager, SOCKET_AUTH_PROBE_AFTER - 1);
    expect(getMyInfo).toHaveBeenCalledTimes(1);
    fail(manager, 1);
    expect(getMyInfo).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("a failed probe is swallowed and does not stop later probes", async () => {
    getMyInfo.mockRejectedValueOnce(new Error("503")).mockResolvedValue({});
    const { socket, manager } = fakeSocket();
    mount(socket);
    fail(manager, SOCKET_AUTH_PROBE_AFTER);
    await flush();
    fail(manager, SOCKET_AUTH_PROBE_AFTER);
    expect(getMyInfo).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("connect and reconnect reset the count", async () => {
    getMyInfo.mockResolvedValue({});
    const { socket, manager } = fakeSocket();
    mount(socket);
    fail(manager, SOCKET_AUTH_PROBE_AFTER - 1);
    socket.emit("connect");
    fail(manager, SOCKET_AUTH_PROBE_AFTER - 1);
    manager.emit("reconnect");
    fail(manager, SOCKET_AUTH_PROBE_AFTER - 1);
    expect(getMyInfo).not.toHaveBeenCalled();
  });

  it("does not probe while the socket is connected", () => {
    const { socket, manager } = fakeSocket();
    socket.connected = true;
    mount(socket);
    fail(manager, SOCKET_AUTH_PROBE_AFTER * 2);
    expect(getMyInfo).not.toHaveBeenCalled();
  });

  it("removes its listeners on unmount and on a socket change", () => {
    const first = fakeSocket();
    const { store, unmount } = mount(first.socket);
    expect(first.manager.count()).toBe(2);
    expect(first.socket.count()).toBe(1);

    const second = fakeSocket();
    act(() => store.set(writableSocketAtom, second.socket as unknown as Socket));
    expect(first.manager.count()).toBe(0);
    expect(first.socket.count()).toBe(0);
    expect(second.manager.count()).toBe(2);

    unmount();
    expect(second.manager.count()).toBe(0);
    expect(second.socket.count()).toBe(0);
    fail(second.manager, SOCKET_AUTH_PROBE_AFTER);
    expect(getMyInfo).not.toHaveBeenCalled();
  });
});
