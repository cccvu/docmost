import { afterEach, beforeEach, describe, it, expect, vi, type Mock } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ChunkReloadEnv } from "@/features/layout/lazy-with-reload";
import { RECONCILE_PATH } from "./identity-reconcile";
import { useIdentityReconcile } from "./use-identity-reconcile";

const postMock = vi.fn();
vi.mock("@/lib/platform-client", () => ({
  default: { post: (...a: unknown[]) => postMock(...a) },
}));

const A = "user-a";
const B = "user-b";

function fakeEnv(): ChunkReloadEnv & { reload: Mock<() => void> } {
  const map = new Map<string, string>();
  return {
    now: () => 1_000_000,
    storage: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
    },
    reload: vi.fn<() => void>(),
  };
}

let visibility: DocumentVisibilityState = "visible";
const flush = () => act(async () => {});
const answer = (data: unknown) =>
  postMock.mockImplementation(() => Promise.resolve({ status: 200, data }));

beforeEach(() => {
  postMock.mockReset();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  (window as unknown as { CONFIG?: Record<string, unknown> }).CONFIG = {
    NATIVE_AUTH_ENABLED: false,
  };
});

afterEach(() => {
  delete (window as unknown as { CONFIG?: unknown }).CONFIG;
});

function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useIdentityReconcile (wiki-v2 #761)", () => {
  it("reconciles on mount and reloads once on superseded", async () => {
    answer({ superseded: true, docmostUserId: A });
    const env = fakeEnv();
    renderHook(() => useIdentityReconcile(B, env));
    await flush();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock.mock.calls[0][0]).toBe(RECONCILE_PATH);
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads on an id mismatch and not on a match", async () => {
    answer({ superseded: false, docmostUserId: A });
    const mismatch = fakeEnv();
    const h1 = renderHook(() => useIdentityReconcile(B, mismatch));
    await flush();
    expect(mismatch.reload).toHaveBeenCalledTimes(1);
    h1.unmount();

    const match = fakeEnv();
    renderHook(() => useIdentityReconcile(A, match));
    await flush();
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(match.reload).not.toHaveBeenCalled();
  });

  it("re-checks when the tab becomes visible, not when it is hidden", async () => {
    answer({ superseded: false, docmostUserId: B });
    renderHook(() => useIdentityReconcile(B, fakeEnv()));
    await flush();
    expect(postMock).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await flush();
    expect(postMock).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await flush();
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("re-checks on window focus", async () => {
    answer({ superseded: false, docmostUserId: B });
    renderHook(() => useIdentityReconcile(B, fakeEnv()));
    await flush();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces triggers that arrive while a request is in flight", async () => {
    let resolve!: (v: unknown) => void;
    postMock.mockImplementation(
      () => new Promise((res) => (resolve = res)),
    );
    renderHook(() => useIdentityReconcile(B, fakeEnv()));
    window.dispatchEvent(new Event("focus"));
    setVisibility("visible");
    await flush();
    expect(postMock).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolve({ status: 200, data: { superseded: false, docmostUserId: B } }),
    );
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("removes its listeners on unmount", async () => {
    answer({ superseded: false, docmostUserId: B });
    const winAdd = vi.spyOn(window, "addEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");
    const h = renderHook(() => useIdentityReconcile(B, fakeEnv()));
    await flush();
    const focusFn = winAdd.mock.calls.find((c) => c[0] === "focus")?.[1];
    const visFn = docAdd.mock.calls.find((c) => c[0] === "visibilitychange")?.[1];
    expect(focusFn).toBeTypeOf("function");
    expect(visFn).toBeTypeOf("function");
    h.unmount();
    expect(winRemove).toHaveBeenCalledWith("focus", focusFn);
    expect(docRemove).toHaveBeenCalledWith("visibilitychange", visFn);
    for (const s of [winAdd, winRemove, docAdd, docRemove]) s.mockRestore();
    window.dispatchEvent(new Event("focus"));
    setVisibility("visible");
    await flush();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("reloads on a null mapping for a signed-in user", async () => {
    answer({ superseded: false, docmostUserId: null });
    const env = fakeEnv();
    renderHook(() => useIdentityReconcile(B, env));
    await flush();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a null mapping when signed out", async () => {
    answer({ superseded: false, docmostUserId: null });
    const env = fakeEnv();
    renderHook(() => useIdentityReconcile(undefined, env));
    await flush();
    expect(postMock).not.toHaveBeenCalled();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("does nothing when signed out", async () => {
    answer({ superseded: true, docmostUserId: A });
    const env = fakeEnv();
    renderHook(() => useIdentityReconcile(undefined, env));
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(postMock).not.toHaveBeenCalled();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("does nothing in native mode", async () => {
    (window as unknown as { CONFIG: Record<string, unknown> }).CONFIG = {
      NATIVE_AUTH_ENABLED: true,
    };
    answer({ superseded: true, docmostUserId: A });
    const env = fakeEnv();
    renderHook(() => useIdentityReconcile(B, env));
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(postMock).not.toHaveBeenCalled();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("starts once a user signs in", async () => {
    answer({ superseded: false, docmostUserId: B });
    const h = renderHook(({ id }) => useIdentityReconcile(id, fakeEnv()), {
      initialProps: { id: undefined as string | undefined },
    });
    await flush();
    expect(postMock).not.toHaveBeenCalled();
    h.rerender({ id: B });
    await flush();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("does not reload after unmount even if the answer says superseded", async () => {
    let resolve!: (v: unknown) => void;
    postMock.mockImplementation(
      () => new Promise((res) => (resolve = res)),
    );
    const env = fakeEnv();
    const h = renderHook(() => useIdentityReconcile(B, env));
    await flush();
    h.unmount();
    await act(async () =>
      resolve({ status: 200, data: { superseded: true, docmostUserId: A } }),
    );
    expect(env.reload).not.toHaveBeenCalled();
  });

  it.each([
    ["401", { response: { status: 401 } }],
    ["503", { response: { status: 503 } }],
  ])("leaves the tab alone on %s", async (_n, err) => {
    postMock.mockImplementation(() => Promise.reject(err));
    const env = fakeEnv();
    renderHook(() => useIdentityReconcile(B, env));
    await flush();
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(env.reload).not.toHaveBeenCalled();
  });
});
