import { describe, it, expect, vi } from "vitest";
import type { ChunkReloadEnv } from "@/features/layout/lazy-with-reload";
import { CHUNK_RELOAD_KEY } from "@/features/layout/lazy-with-reload";
import {
  IDENTITY_RELOAD_KEY,
  IDENTITY_RELOAD_WINDOW_MS,
  RECONCILE_PATH,
  RECONCILE_TIMEOUT_MS,
  createIdentityReconciler,
  parseReconcileBody,
  shouldReload,
} from "./identity-reconcile";

const A = "user-a";
const B = "user-b";

function fakeEnv(at = 1_000_000) {
  const map = new Map<string, string>();
  const clock = { at };
  const env: ChunkReloadEnv & { clock: typeof clock; map: typeof map } = {
    now: () => clock.at,
    storage: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
    },
    reload: vi.fn(),
    clock,
    map,
  };
  return env;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(
  answer: () => Promise<unknown>,
  opts: { user: string | undefined } = { user: B },
) {
  const env = fakeEnv();
  const post = vi.fn(answer);
  const state = { user: opts.user };
  const reconciler = createIdentityReconciler({
    api: { post } as never,
    currentUserId: () => state.user,
    reloadEnv: env,
  });
  return { env, post, state, reconciler };
}

const ok = (data: unknown) => () => Promise.resolve({ status: 200, data });

describe("parseReconcileBody", () => {
  it("accepts the contract shape", () => {
    expect(parseReconcileBody({ superseded: false, docmostUserId: A })).toEqual(
      { superseded: false, docmostUserId: A },
    );
    expect(
      parseReconcileBody({ superseded: true, docmostUserId: null }),
    ).toEqual({ superseded: true, docmostUserId: null });
  });

  it.each([
    ["null", null],
    ["a string", "superseded"],
    ["an array", [true]],
    ["missing superseded", { docmostUserId: A }],
    ["string superseded", { superseded: "true", docmostUserId: A }],
    ["numeric superseded", { superseded: 1, docmostUserId: A }],
    ["missing docmostUserId", { superseded: false }],
    ["numeric docmostUserId", { superseded: false, docmostUserId: 7 }],
  ])("rejects %s", (_name, body) => {
    expect(parseReconcileBody(body)).toBeNull();
  });
});

describe("shouldReload", () => {
  it("reloads on superseded even when the ids match", () => {
    expect(shouldReload({ superseded: true, docmostUserId: B }, B)).toBe(true);
  });
  it("reloads on an id mismatch", () => {
    expect(shouldReload({ superseded: false, docmostUserId: A }, B)).toBe(true);
  });
  it("keeps a matching id", () => {
    expect(shouldReload({ superseded: false, docmostUserId: B }, B)).toBe(
      false,
    );
  });
  it("treats a null mapping with a cached user as a mismatch", () => {
    expect(shouldReload({ superseded: false, docmostUserId: null }, B)).toBe(
      true,
    );
  });
});

describe("createIdentityReconciler (wiki-v2 #761)", () => {
  it("POSTs the reconcile path with no body and a timeout", async () => {
    const { post, reconciler } = setup(
      ok({ superseded: false, docmostUserId: B }),
    );
    await reconciler.trigger();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(RECONCILE_PATH, undefined, {
      timeout: RECONCILE_TIMEOUT_MS,
    });
  });

  it("reloads once when superseded and stamps its own key", async () => {
    const { env, reconciler } = setup(
      ok({ superseded: true, docmostUserId: A }),
    );
    await reconciler.trigger();
    expect(env.reload).toHaveBeenCalledTimes(1);
    expect(env.map.get(IDENTITY_RELOAD_KEY)).toBe(String(env.clock.at));
    expect(env.map.has(CHUNK_RELOAD_KEY)).toBe(false);
  });

  it("reloads on an id mismatch without superseded", async () => {
    const { env, reconciler } = setup(
      ok({ superseded: false, docmostUserId: A }),
    );
    await reconciler.trigger();
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when the ids match", async () => {
    const { env, post, reconciler } = setup(
      ok({ superseded: false, docmostUserId: B }),
    );
    await reconciler.trigger();
    expect(post).toHaveBeenCalledTimes(1);
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("never reloads twice inside the window, and again after it", async () => {
    const { env, reconciler } = setup(
      ok({ superseded: true, docmostUserId: A }),
    );
    await reconciler.trigger();
    env.clock.at += IDENTITY_RELOAD_WINDOW_MS - 1;
    await reconciler.trigger();
    expect(env.reload).toHaveBeenCalledTimes(1);
    env.clock.at += 1;
    await reconciler.trigger();
    expect(env.reload).toHaveBeenCalledTimes(2);
  });

  it("is not blocked by a recent chunk-load reload stamp", async () => {
    const { env, reconciler } = setup(
      ok({ superseded: true, docmostUserId: A }),
    );
    env.map.set(CHUNK_RELOAD_KEY, String(env.clock.at));
    await reconciler.trigger();
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads when it cannot record the stamp", async () => {
    const { env, reconciler } = setup(
      ok({ superseded: true, docmostUserId: A }),
    );
    env.storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    await reconciler.trigger();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it.each([
    ["401", { response: { status: 401 } }],
    ["503", { response: { status: 503 } }],
    ["a network error", new Error("Network Error")],
  ])("does nothing on %s", async (_name, err) => {
    const { env, post, reconciler } = setup(() => Promise.reject(err));
    await expect(reconciler.trigger()).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);
    expect(env.reload).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty body", ""],
    ["an HTML page", "<!doctype html>"],
    ["a wrong-typed field", { superseded: "yes", docmostUserId: A }],
  ])("does nothing on %s", async (_name, data) => {
    const { env, post, reconciler } = setup(ok(data));
    await reconciler.trigger();
    expect(post).toHaveBeenCalledTimes(1);
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("reloads once on a null mapping while a user is cached (#761: null = no wiki user yet)", async () => {
    const { env, post, reconciler } = setup(
      ok({ superseded: false, docmostUserId: null }),
    );
    await reconciler.trigger();
    expect(post).toHaveBeenCalledTimes(1);
    expect(env.reload).toHaveBeenCalledTimes(1);
    expect(env.map.get(IDENTITY_RELOAD_KEY)).toBe(String(env.clock.at));
    env.clock.at += IDENTITY_RELOAD_WINDOW_MS - 1;
    await reconciler.trigger();
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a null mapping when the user went away in flight", async () => {
    const d = deferred<unknown>();
    const { env, state, reconciler } = setup(() => d.promise);
    const p = reconciler.trigger();
    state.user = undefined;
    d.resolve({ status: 200, data: { superseded: false, docmostUserId: null } });
    await p;
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("sends nothing when no user is signed in", async () => {
    const { post, env, reconciler } = setup(
      ok({ superseded: true, docmostUserId: A }),
      { user: undefined },
    );
    await reconciler.trigger();
    expect(post).not.toHaveBeenCalled();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("does not reload when the user went away while the request was in flight", async () => {
    const d = deferred<unknown>();
    const { env, state, reconciler } = setup(() => d.promise);
    const p = reconciler.trigger();
    state.user = undefined;
    d.resolve({ status: 200, data: { superseded: true, docmostUserId: A } });
    await p;
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("compares against the user current when the answer arrives", async () => {
    const d = deferred<unknown>();
    const { env, state, reconciler } = setup(() => d.promise);
    const p = reconciler.trigger();
    state.user = A; // the cached user caught up meanwhile
    d.resolve({ status: 200, data: { superseded: false, docmostUserId: A } });
    await p;
    expect(env.reload).not.toHaveBeenCalled();
  });

  it("keeps at most one request in flight and frees the slot after", async () => {
    const d = deferred<unknown>();
    const { post, reconciler } = setup(() => d.promise);
    const p1 = reconciler.trigger();
    const p2 = reconciler.trigger();
    const p3 = reconciler.trigger();
    expect(post).toHaveBeenCalledTimes(1);
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    d.resolve({ status: 200, data: { superseded: false, docmostUserId: B } });
    await p1;
    post.mockImplementation(ok({ superseded: false, docmostUserId: B }));
    await reconciler.trigger();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("frees the slot after a failure too", async () => {
    const { post, reconciler } = setup(() =>
      Promise.reject(new Error("Network Error")),
    );
    await reconciler.trigger();
    await reconciler.trigger();
    expect(post).toHaveBeenCalledTimes(2);
  });
});
