import { describe, it, expect, vi } from "vitest";
import {
  applyProbe,
  createNewVersionChecker,
  extractEntryScriptSrc,
  fetchIndexHtml,
  initialNewVersionState,
  NEW_VERSION_PROBE_INTERVAL_MS,
  normalizeEntrySrc,
  shouldProbe,
} from "./new-version-check";

// What Vite emits for the production index.html (the entry is content-hashed under /assets/).
const viteHtml = (hash: string) => `<!doctype html>
<html lang="en">
  <head>
    <title>Wiki</title>
    <script type="module" crossorigin src="/assets/index-${hash}.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-react-Zz9.js">
    <link rel="stylesheet" crossorigin href="/assets/index-${hash}.css">
  </head>
  <body>
    <div id="root"></div>
    <script>window.CONFIG = {"APP_URL":"x"};</script>
  </body>
</html>`;

describe("extractEntryScriptSrc", () => {
  it("returns the hashed module entry from a production index.html", () => {
    expect(extractEntryScriptSrc(viteHtml("AbC123"))).toBe("/assets/index-AbC123.js");
  });

  it("accepts any attribute order and quoting", () => {
    expect(
      extractEntryScriptSrc(`<script src='/assets/index-1.js' crossorigin type=module></script>`),
    ).toBe("/assets/index-1.js");
  });

  it("ignores modulepreload links, classic scripts and the inline config script", () => {
    const html = `<link rel="modulepreload" href="/assets/a-1.js"><script src="/assets/legacy-1.js"></script><script>window.CONFIG={}</script>`;
    expect(extractEntryScriptSrc(html)).toBeNull();
  });

  it("returns null for the Vite dev server's unhashed entry", () => {
    expect(
      extractEntryScriptSrc(`<script type="module" src="/src/main.tsx"></script>`),
    ).toBeNull();
  });

  it("returns null for non-HTML", () => {
    expect(extractEntryScriptSrc('{"error":"nope"}')).toBeNull();
    expect(extractEntryScriptSrc("")).toBeNull();
  });
});

describe("normalizeEntrySrc", () => {
  it("compares by path, so an absolute and a relative src of the same file agree", () => {
    expect(normalizeEntrySrc("https://wiki.example/assets/index-1.js")).toBe("/assets/index-1.js");
    expect(normalizeEntrySrc("/assets/index-1.js")).toBe("/assets/index-1.js");
  });

  it("is null for anything outside /assets/", () => {
    expect(normalizeEntrySrc("/src/main.tsx")).toBeNull();
    expect(normalizeEntrySrc(null)).toBeNull();
    expect(normalizeEntrySrc("")).toBeNull();
  });
});

describe("shouldProbe (throttle)", () => {
  it("probes first, then not again inside the interval", () => {
    const s0 = initialNewVersionState();
    expect(shouldProbe(s0, 1_000)).toBe(true);
    const s1 = { ...s0, lastProbeAt: 1_000 };
    expect(shouldProbe(s1, 1_000 + NEW_VERSION_PROBE_INTERVAL_MS - 1)).toBe(false);
    expect(shouldProbe(s1, 1_000 + NEW_VERSION_PROBE_INTERVAL_MS)).toBe(true);
  });

  it("never probes again once it has nudged", () => {
    const s = { ...initialNewVersionState(), lastProbeAt: 0, nudged: true };
    expect(shouldProbe(s, 10 * NEW_VERSION_PROBE_INTERVAL_MS)).toBe(false);
  });

  it("enforces at least 10 minutes between probes", () => {
    expect(NEW_VERSION_PROBE_INTERVAL_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
});

describe("applyProbe (two consecutive agreeing probes)", () => {
  const RUN = "/assets/index-old.js";
  const NEW = "/assets/index-new.js";
  const run = (probes: (string | null)[]) => {
    let state = initialNewVersionState();
    const nudges: boolean[] = [];
    for (const p of probes) {
      const r = applyProbe(state, RUN, p);
      state = r.state;
      nudges.push(r.nudge);
    }
    return { state, nudges };
  };

  it("same entry as running: never nudges", () => {
    expect(run([RUN, RUN, RUN]).nudges).toEqual([false, false, false]);
  });

  it("one differing probe: no nudge yet", () => {
    expect(run([NEW]).nudges).toEqual([false]);
  });

  it("two consecutive differing probes on the same new entry: nudges exactly once", () => {
    const { nudges, state } = run([NEW, NEW]);
    expect(nudges).toEqual([false, true]);
    expect(state.nudged).toBe(true);
    // Any later probe never nudges again.
    expect(applyProbe(state, RUN, NEW).nudge).toBe(false);
  });

  it("ECS overlap (old and new tasks alternate behind the ALB): never nudges", () => {
    expect(run([NEW, RUN, NEW, RUN, NEW]).nudges.some(Boolean)).toBe(false);
  });

  it("two DIFFERENT new entries in a row do not agree: no nudge until one repeats", () => {
    expect(run([NEW, "/assets/index-newer.js"]).nudges).toEqual([false, false]);
    expect(run([NEW, "/assets/index-newer.js", "/assets/index-newer.js"]).nudges).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("an unknown probe (error / non-HTML / no entry) never nudges and breaks the streak", () => {
    expect(run([NEW, null, NEW]).nudges).toEqual([false, false, false]);
    expect(run([null, null]).nudges).toEqual([false, false]);
  });
});

describe("fetchIndexHtml", () => {
  const response = (body: string, init: { status?: number; type?: string }) =>
    new Response(body, {
      status: init.status ?? 200,
      headers: init.type ? { "content-type": init.type } : {},
    });

  it("probes / with no-store and same-origin credentials, and returns the HTML", async () => {
    const fetchImpl = vi.fn(async () => response(viteHtml("x"), { type: "text/html; charset=utf-8" }));
    await expect(fetchIndexHtml(fetchImpl)).resolves.toContain("/assets/index-x.js");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("returns null for a non-2xx or a non-HTML response", async () => {
    await expect(
      fetchIndexHtml(async () => response(viteHtml("x"), { status: 503, type: "text/html" })),
    ).resolves.toBeNull();
    await expect(
      fetchIndexHtml(async () => response("{}", { type: "application/json" })),
    ).resolves.toBeNull();
    await expect(fetchIndexHtml(async () => response("<html>", {}))).resolves.toBeNull();
  });

  it("returns null when the fetch itself fails", async () => {
    await expect(
      fetchIndexHtml(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).resolves.toBeNull();
  });
});

describe("createNewVersionChecker (injected fetch + clock)", () => {
  const RUN = "/assets/index-old.js";
  const setup = (running: string | null, pages: (string | null)[]) => {
    let now = 0;
    const fetchHtml = vi.fn(async () => {
      const next = pages.shift();
      return next === undefined ? null : next;
    });
    const onNudge = vi.fn();
    const checker = createNewVersionChecker({
      running,
      fetchHtml,
      now: () => now,
      onNudge,
    });
    return {
      checker,
      fetchHtml,
      onNudge,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it("does nothing when the running entry is unknown (e.g. the Vite dev server)", async () => {
    const t = setup(null, [viteHtml("new"), viteHtml("new")]);
    await t.checker.check();
    t.advance(NEW_VERSION_PROBE_INTERVAL_MS);
    await t.checker.check();
    expect(t.fetchHtml).not.toHaveBeenCalled();
    expect(t.onNudge).not.toHaveBeenCalled();
  });

  it("throttles: a burst of focus/visibility events inside the interval fetches once", async () => {
    const t = setup(RUN, [viteHtml("old"), viteHtml("old")]);
    await Promise.all([t.checker.check(), t.checker.check()]);
    t.advance(NEW_VERSION_PROBE_INTERVAL_MS - 1);
    await t.checker.check();
    expect(t.fetchHtml).toHaveBeenCalledTimes(1);
  });

  it("nudges once after two consecutive differing probes, then stops probing", async () => {
    const t = setup(RUN, [viteHtml("new"), viteHtml("new"), viteHtml("new")]);
    await t.checker.check();
    expect(t.onNudge).not.toHaveBeenCalled();
    t.advance(NEW_VERSION_PROBE_INTERVAL_MS);
    await t.checker.check();
    expect(t.onNudge).toHaveBeenCalledTimes(1);
    t.advance(NEW_VERSION_PROBE_INTERVAL_MS);
    await t.checker.check();
    expect(t.onNudge).toHaveBeenCalledTimes(1);
    expect(t.fetchHtml).toHaveBeenCalledTimes(2);
  });

  it("a failed or non-HTML probe between two differing ones prevents the nudge", async () => {
    const t = setup(RUN, [viteHtml("new"), null, viteHtml("new")]);
    for (let i = 0; i < 3; i += 1) {
      await t.checker.check();
      t.advance(NEW_VERSION_PROBE_INTERVAL_MS);
    }
    expect(t.onNudge).not.toHaveBeenCalled();
  });

  it("an index.html with no hashed entry never nudges", async () => {
    const t = setup(RUN, ["<html><body>maintenance</body></html>", "<html></html>"]);
    await t.checker.check();
    t.advance(NEW_VERSION_PROBE_INTERVAL_MS);
    await t.checker.check();
    expect(t.onNudge).not.toHaveBeenCalled();
  });
});
