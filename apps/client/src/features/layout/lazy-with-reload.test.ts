import { afterEach, describe, it, expect, vi } from "vitest";
import { Component, createElement, Suspense, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  defaultChunkReloadEnv,
  lazyWithReload,
  recoverFromChunkLoadError,
  type ChunkReloadEnv,
} from "./lazy-with-reload";

// A fake env: a controllable clock, a Map-backed sessionStorage stand-in and a spy reload. Nothing
// here touches window.location, so a bug can never reload the test runner's document.
function fakeEnv(over: Partial<ChunkReloadEnv> & { at?: number } = {}) {
  const map = new Map<string, string>();
  const clock = { at: over.at ?? 1_000_000 };
  const env: ChunkReloadEnv & { clock: typeof clock; map: typeof map } = {
    now: () => clock.at,
    storage: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => {
        map.set(k, v);
      },
    },
    reload: vi.fn(),
    clock,
    map,
    ...over,
  };
  return env;
}

// Minimal class boundary so a test can tell "the rejection reached React" from "React kept the
// fallback up". Renders the caught error's message under a testid.
class Boundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error
      ? createElement(
          "div",
          { "data-testid": "caught" },
          this.state.error.message,
        )
      : this.props.children;
  }
}

const tick = () => act(async () => {});

describe("recoverFromChunkLoadError (issue #309)", () => {
  it("reloads once and records the timestamp under CHUNK_RELOAD_KEY", () => {
    const env = fakeEnv({ at: 5_000 });
    expect(recoverFromChunkLoadError(env)).toBe(true);
    expect(env.reload).toHaveBeenCalledTimes(1);
    expect(env.map.get(CHUNK_RELOAD_KEY)).toBe("5000");
  });

  it("does NOT reload again inside the window (the loop guard)", () => {
    const env = fakeEnv({ at: 5_000 });
    expect(recoverFromChunkLoadError(env)).toBe(true);
    env.clock.at = 5_000 + CHUNK_RELOAD_WINDOW_MS - 1;
    expect(recoverFromChunkLoadError(env)).toBe(false);
    expect(env.reload).toHaveBeenCalledTimes(1);
    // the stored stamp is left alone: a refused reload must not extend the window
    expect(env.map.get(CHUNK_RELOAD_KEY)).toBe("5000");
  });

  it("reloads again once the window has elapsed", () => {
    const env = fakeEnv({ at: 5_000 });
    expect(recoverFromChunkLoadError(env)).toBe(true);
    env.clock.at = 5_000 + CHUNK_RELOAD_WINDOW_MS;
    expect(recoverFromChunkLoadError(env)).toBe(true);
    expect(env.reload).toHaveBeenCalledTimes(2);
    expect(env.map.get(CHUNK_RELOAD_KEY)).toBe(String(5_000 + CHUNK_RELOAD_WINDOW_MS));
  });

  it.each([
    ["garbage", "not-a-number"],
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["Infinity", "Infinity"],
  ])("treats a %s stored stamp as 'never reloaded' and reloads", (_label, stored) => {
    const env = fakeEnv({ at: 5_000 });
    env.map.set(CHUNK_RELOAD_KEY, stored);
    expect(recoverFromChunkLoadError(env)).toBe(true);
    expect(env.reload).toHaveBeenCalledTimes(1);
    expect(env.map.get(CHUNK_RELOAD_KEY)).toBe("5000");
  });

  it("never reloads without storage (no storage means no loop guard)", () => {
    const env = fakeEnv({ storage: null });
    expect(recoverFromChunkLoadError(env)).toBe(false);
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("does not reload when the stamp cannot be written (setItem throws)", () => {
    const env = fakeEnv({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
    });
    expect(recoverFromChunkLoadError(env)).toBe(false);
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("does not reload when the stamp cannot be read (getItem throws) even if setItem works", () => {
    // If the stamp can be written but never read back, every failure would look like the first one
    // and reload forever. An unreadable guard is no guard: fail closed.
    const setItem = vi.fn();
    const env = fakeEnv({
      storage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem,
      },
    });
    expect(recoverFromChunkLoadError(env)).toBe(false);
    expect(env.reload).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("defaultChunkReloadEnv", () => {
  it("uses Date.now and the document's sessionStorage in a browser", () => {
    const env = defaultChunkReloadEnv();
    expect(typeof env.now()).toBe("number");
    expect(env.storage).not.toBeNull();
    env.storage!.setItem("ccc:test-probe", "1");
    expect(window.sessionStorage.getItem("ccc:test-probe")).toBe("1");
    window.sessionStorage.removeItem("ccc:test-probe");
  });

  it("yields storage: null when the sessionStorage accessor throws (private mode / blocked)", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(defaultChunkReloadEnv().storage).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, "sessionStorage", original);
      else delete (window as { sessionStorage?: unknown }).sessionStorage;
    }
  });
});

describe("lazyWithReload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a real React.lazy that renders the resolved component through <Suspense>", async () => {
    const env = fakeEnv();
    const Real = (props: { label: string }) =>
      createElement("div", { "data-testid": "real" }, props.label);
    const Lazy = lazyWithReload(() => Promise.resolve({ default: Real }), env);
    expect((Lazy as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.lazy"));

    render(
      createElement(
        Suspense,
        { fallback: createElement("span", { "data-testid": "fallback" }) },
        createElement(Lazy, { label: "hello" }),
      ),
    );
    const real = await screen.findByTestId("real");
    expect(real.textContent).toBe("hello");
    expect(screen.queryByTestId("fallback")).toBeNull();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("first chunk failure: reloads the document once and keeps the fallback mounted (never settles)", async () => {
    const env = fakeEnv({ at: 42_000 });
    const failure = new TypeError(
      "Failed to fetch dynamically imported module: /assets/old-abc.js",
    );
    const factory = vi.fn(() => Promise.reject(failure));
    const Lazy = lazyWithReload(factory, env);

    render(
      createElement(
        Boundary,
        null,
        createElement(
          Suspense,
          { fallback: createElement("span", { "data-testid": "fallback" }) },
          createElement(Lazy, {}),
        ),
      ),
    );
    await tick();
    await tick();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(env.reload).toHaveBeenCalledTimes(1);
    expect(env.map.get(CHUNK_RELOAD_KEY)).toBe("42000");
    // the reload takes over; React must still be showing the fallback, and no error reached it
    expect(screen.getByTestId("fallback")).toBeTruthy();
    expect(screen.queryByTestId("caught")).toBeNull();
  });

  it("a failure after a reload inside the window propagates the ORIGINAL error (no loop)", async () => {
    // React logs a caught boundary error; keep the run quiet.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = fakeEnv({ at: 42_000 });
    env.map.set(CHUNK_RELOAD_KEY, String(42_000 - 1_000)); // a reload happened 1 s ago
    const failure = new TypeError(
      "Failed to fetch dynamically imported module: /assets/old-abc.js",
    );
    const Lazy = lazyWithReload(() => Promise.reject(failure), env);

    render(
      createElement(
        Boundary,
        null,
        createElement(
          Suspense,
          { fallback: createElement("span", { "data-testid": "fallback" }) },
          createElement(Lazy, {}),
        ),
      ),
    );

    const caught = await screen.findByTestId("caught");
    expect(caught.textContent).toBe(failure.message);
    expect(env.reload).not.toHaveBeenCalled();
    expect(env.map.get(CHUNK_RELOAD_KEY)).toBe(String(42_000 - 1_000));
    expect(screen.queryByTestId("fallback")).toBeNull();
  });

  it("resolves the env at failure time, not at definition time (no browser globals on import)", async () => {
    // A lazy defined with no env and a factory that never fails must not need window at all: nothing
    // about the env is read until the catch runs. Define, render to success, and assert the default
    // storage was never written.
    const Real = () => createElement("div", { "data-testid": "real" });
    const Lazy = lazyWithReload(() => Promise.resolve({ default: Real }));
    render(createElement(Suspense, { fallback: null }, createElement(Lazy, {})));
    await screen.findByTestId("real");
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull();
  });
});
