import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Loader contract for the runtime brand bundle (issue #30 follow-up). The module memoizes its load and
 * holds module-level state, so each case re-imports a fresh copy after `vi.resetModules()`.
 */

function jsonResponse(body: unknown, contentType = "application/json"): Response {
  return {
    ok: true,
    headers: { get: () => contentType },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function htmlResponse(): Response {
  return {
    ok: true,
    headers: { get: () => "text/html; charset=utf-8" },
    json: async () => {
      throw new Error("not json");
    },
    text: async () => "<!doctype html>",
  } as unknown as Response;
}

async function freshModule() {
  vi.resetModules();
  return import("./brand-config");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadBrandConfig", () => {
  it("loads, normalizes, and installs a same-origin bundle", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/brand/manifest.json") {
        return jsonResponse({
          name: "Example Wiki",
          institutionName: "Example University",
          collegeName: "Example College",
          assets: {
            icon: "/brand/v-icon.png",
            wordmarkSvg: "/brand/wordmark.svg",
            favicon16: "/brand/favicon-16x16.png",
            favicon32: "/brand/favicon-32x32.png",
            appleTouchIcon: "/brand/apple-touch-icon.png",
            // Must be dropped: only same-origin /brand/ URLs are accepted.
            injected: "https://evil.example/x.png",
          },
          webManifest: "/brand/site.webmanifest",
        });
      }
      return {
        ok: true,
        headers: { get: () => "image/svg+xml" },
        text: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await freshModule();
    const config = await mod.loadBrandConfig();

    expect(fetchMock).toHaveBeenCalledWith(
      "/brand/manifest.json",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(config.name).toBe("Example Wiki");
    expect(config.institutionName).toBe("Example University");
    expect(config.assets.icon).toBe("/brand/v-icon.png");
    expect(config.assets.wordmarkSvg).toBe("/brand/wordmark.svg");
    expect(config.wordmarkSvg).toContain("<svg");
    expect(config.webManifest).toBe("/brand/site.webmanifest");
    expect((config.assets as Record<string, string>).injected).toBeUndefined();

    // Each request carries its OWN deadline signal — a stale abort from one request can never poison
    // another (a shared signal let an abort land between a 200 manifest's headers and its body read).
    const manifestCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const wordmarkCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(manifestCall[1].signal).toBeDefined();
    expect(wordmarkCall[1].signal).toBeDefined();
    expect(wordmarkCall[1].signal).not.toBe(manifestCall[1].signal);

    // Memoized: a second call reuses the first load (no extra fetches).
    await mod.loadBrandConfig();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The document identity is swapped from neutral to branded.
    expect(document.title).toBe("Example Wiki");
    expect(
      document.head
        .querySelector('link[rel="icon"][sizes="32x32"]')
        ?.getAttribute("href"),
    ).toBe("/brand/favicon-32x32.png");
    expect(
      document.head
        .querySelector('link[rel="apple-touch-icon"]')
        ?.getAttribute("href"),
    ).toBe("/brand/apple-touch-icon.png");
    expect(
      document.head
        .querySelector('link[rel="manifest"]')
        ?.getAttribute("href"),
    ).toBe("/brand/site.webmanifest");
  });

  it("falls back to neutral on Docmost's SPA fallback (200 text/html)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse()));
    const mod = await freshModule();
    const config = await mod.loadBrandConfig();
    expect(config).toEqual(mod.NEUTRAL_BRAND);
    expect(document.title).not.toBe("Example Wiki");
  });

  it("falls back to neutral when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const mod = await freshModule();
    const config = await mod.loadBrandConfig();
    expect(config).toEqual(mod.NEUTRAL_BRAND);
  });

  it("retries a 5xx once, then falls back to neutral when it persists", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();
    const config = await mod.loadBrandConfig();
    expect(config).toEqual(mod.NEUTRAL_BRAND);
    expect(document.title).not.toBe("Example Wiki");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to neutral when the deadline aborts the manifest fetch (both attempts)", async () => {
    const abortError = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(abortError)));
    const mod = await freshModule();
    const config = await mod.loadBrandConfig();
    expect(config).toEqual(mod.NEUTRAL_BRAND);
  });

  it("retries a transient manifest failure once with a fresh clock, then loads the bundle", async () => {
    let manifestCalls = 0;
    const signals: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/brand/manifest.json") {
        manifestCalls += 1;
        signals.push(init?.signal);
        // First attempt: headers arrive (200) but the body read stalls past the deadline and the
        // abort surfaces as a rejected json() — the CI cold-boot failure signature (run 35550624904).
        if (manifestCalls === 1) {
          throw Object.assign(new Error("The operation was aborted."), {
            name: "AbortError",
          });
        }
        return jsonResponse({ name: "Example Wiki", assets: {} });
      }
      return { ok: false, status: 404 } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();
    const config = await mod.loadBrandConfig();
    expect(manifestCalls).toBe(2);
    expect(config.name).toBe("Example Wiki");
    expect(document.title).toBe("Example Wiki");
    // Fresh-clock invariant: the retry must carry a NEW signal, not the (already-fired) attempt-1 one —
    // hoisting a single signal across both attempts is the exact poisoning that caused the CI red.
    expect(signals).toHaveLength(2);
    expect(signals[1]).toBeDefined();
    expect(signals[1]).not.toBe(signals[0]);
  });

  it("recovers the bundle when a 5xx is followed by a 200 (server errors are transient)", async () => {
    let manifestCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/brand/manifest.json") {
          manifestCalls += 1;
          if (manifestCalls === 1) {
            return { ok: false, status: 503 } as unknown as Response;
          }
          return jsonResponse({ name: "Example Wiki", assets: {} });
        }
        return { ok: false, status: 404 } as unknown as Response;
      }),
    );
    const mod = await freshModule();
    const config = await mod.loadBrandConfig();
    expect(manifestCalls).toBe(2);
    expect(config.name).toBe("Example Wiki");
  });

  it("does NOT retry a clean miss (4xx) — standalone deployments must not pay for it", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();
    const config = await mod.loadBrandConfig();
    expect(config).toEqual(mod.NEUTRAL_BRAND);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the branded identity when only the wordmark fetch fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/brand/manifest.json") {
        return jsonResponse({
          name: "Example Wiki",
          assets: { icon: "/brand/v-icon.png", wordmarkSvg: "/brand/wordmark.svg" },
        });
      }
      return { ok: false, status: 404 } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();
    const config = await mod.loadBrandConfig();
    expect(config.name).toBe("Example Wiki");
    expect(config.wordmarkSvg).toBeUndefined();
    expect(config.assets.icon).toBe("/brand/v-icon.png");
  });

  it("drops an asset URL that escapes the /brand/ prefix", async () => {
    const mod = await freshModule();
    expect(mod.sanitizeBrandAssetUrl("/brand/v-icon.png")).toBe(
      "/brand/v-icon.png",
    );
    expect(mod.sanitizeBrandAssetUrl("https://evil.example/x.png")).toBeUndefined();
    expect(mod.sanitizeBrandAssetUrl("/other/x.png")).toBeUndefined();
    expect(mod.sanitizeBrandAssetUrl("/brand/../secrets.png")).toBeUndefined();
  });
});
