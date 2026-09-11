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
