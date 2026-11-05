// #407: the lazy grammar loader + language store. The grammar chunk is mocked so each test controls
// whether registration succeeds; modules are reset per test because the memo is module state.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";

const grammars = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("./grammars", () => ({ registerCodeGrammars: grammars.register }));

type Store = typeof import("./lowlight");
let store: Store;

beforeEach(async () => {
  vi.resetModules();
  grammars.register.mockReset();
  // Registered out of order on purpose: the store must hand out a SORTED list.
  grammars.register.mockImplementation((ll: Store["lowlight"]) => {
    ll.register("python", python);
    ll.register("bash", bash);
  });
  store = await import("./lowlight");
});

afterEach(() => vi.restoreAllMocks());

describe("loadCodeGrammars (#407)", () => {
  it("starts empty: no language registered before the load", () => {
    expect(store.lowlight.listLanguages()).toEqual([]);
    expect(store.isCodeGrammarsLoaded()).toBe(false);
    expect(store.getCodeLanguages()).toEqual([]);
  });

  it("is memoized: concurrent and later calls share one registration", async () => {
    const a = store.loadCodeGrammars();
    const b = store.loadCodeGrammars();
    expect(b).toBe(a);
    await a;
    await store.loadCodeGrammars();
    expect(grammars.register).toHaveBeenCalledTimes(1);
    expect(grammars.register).toHaveBeenCalledWith(store.lowlight);
    expect(store.isCodeGrammarsLoaded()).toBe(true);
  });

  it("on failure resets the memo, logs, stays unloaded, and the next call retries", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    grammars.register.mockImplementationOnce(() => {
      throw new Error("chunk failed");
    });

    await expect(store.loadCodeGrammars()).rejects.toThrow("chunk failed");
    expect(error).toHaveBeenCalledTimes(1);
    expect(store.isCodeGrammarsLoaded()).toBe(false);
    expect(store.getCodeLanguages()).toEqual([]);

    await store.loadCodeGrammars();
    expect(grammars.register).toHaveBeenCalledTimes(2);
    expect(store.isCodeGrammarsLoaded()).toBe(true);
  });

  it("notifies subscribers once on load, and not after they unsubscribe", async () => {
    const kept = vi.fn();
    const dropped = vi.fn();
    store.subscribeCodeLanguages(kept);
    const unsubscribe = store.subscribeCodeLanguages(dropped);
    unsubscribe();

    await store.loadCodeGrammars();
    await store.loadCodeGrammars();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("keeps one snapshot instance between registrations (useSyncExternalStore contract)", async () => {
    const before = store.getCodeLanguages();
    expect(store.getCodeLanguages()).toBe(before);

    await store.loadCodeGrammars();
    const after = store.getCodeLanguages();
    expect(after).not.toBe(before);
    expect(after).toEqual(["bash", "python"]);
    expect(store.getCodeLanguages()).toBe(after);
  });
});

describe("prefetchCodeGrammarsWhenIdle (#407)", () => {
  type Ric = typeof window.requestIdleCallback;
  const original = window.requestIdleCallback;
  afterEach(() => {
    if (original) window.requestIdleCallback = original;
    else delete (window as { requestIdleCallback?: Ric }).requestIdleCallback;
    vi.useRealTimers();
  });

  // Let a (mocked) dynamic import + registration settle: a few macrotasks, not one.
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("schedules one load via requestIdleCallback with a timeout, and loads only when it runs", async () => {
    const ric = vi.fn<Ric>(() => 1);
    window.requestIdleCallback = ric;

    store.prefetchCodeGrammarsWhenIdle();
    expect(ric).toHaveBeenCalledTimes(1);
    expect(ric.mock.calls[0][1]).toEqual({ timeout: expect.any(Number) });
    expect(ric.mock.calls[0][1]!.timeout).toBeGreaterThan(0);
    await settle();
    expect(grammars.register).not.toHaveBeenCalled();

    ric.mock.calls[0][0]({ didTimeout: false, timeRemaining: () => 50 });
    await settle();
    expect(grammars.register).toHaveBeenCalledTimes(1);
    expect(store.isCodeGrammarsLoaded()).toBe(true);
  });

  it("falls back to setTimeout without requestIdleCallback", async () => {
    delete (window as { requestIdleCallback?: Ric }).requestIdleCallback;
    vi.useFakeTimers();

    store.prefetchCodeGrammarsWhenIdle();
    expect(grammars.register).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(grammars.register).toHaveBeenCalledTimes(1);
    expect(store.isCodeGrammarsLoaded()).toBe(true);
  });

  it("schedules once per page, and shares the memo with the editor-mount load", async () => {
    const ric = vi.fn<Ric>(() => 1);
    window.requestIdleCallback = ric;

    store.prefetchCodeGrammarsWhenIdle();
    store.prefetchCodeGrammarsWhenIdle();
    expect(ric).toHaveBeenCalledTimes(1);

    const mounted = store.loadCodeGrammars(); // the editor got there first
    ric.mock.calls[0][0]({ didTimeout: false, timeRemaining: () => 50 });
    await mounted;
    await settle();
    expect(grammars.register).toHaveBeenCalledTimes(1);
    expect(store.lowlight.listLanguages().sort()).toEqual(["bash", "python"]);
  });

  it("swallows a failed load (no unhandled rejection); the next load retries", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    grammars.register.mockImplementationOnce(() => {
      throw new Error("chunk failed");
    });
    const ric = vi.fn<Ric>(() => 1);
    window.requestIdleCallback = ric;

    try {
      store.prefetchCodeGrammarsWhenIdle();
      expect(() =>
        ric.mock.calls[0][0]({ didTimeout: true, timeRemaining: () => 0 }),
      ).not.toThrow();
      await settle();
      expect(error).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
      expect(store.isCodeGrammarsLoaded()).toBe(false);

      await store.loadCodeGrammars();
      expect(store.isCodeGrammarsLoaded()).toBe(true);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
