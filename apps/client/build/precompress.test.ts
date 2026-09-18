// @vitest-environment node
//
// Unit tests for the fork-owned Vite build plugin (issue #309). They exercise the PURE helpers
// (no Vite, no Rolldown) so the compression, initial-set and budget logic is proven on a synthetic
// bundle and a temp dir — the real build wires the same functions through the plugin hooks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import {
  brotliBytes,
  brotliSize,
  checkBudget,
  compressSiblings,
  findLazyViolations,
  gzipBytes,
  gzipSize,
  initialSet,
  precompressAndBudget,
  shouldPrecompress,
  type BundleLike,
} from "./precompress";

describe("shouldPrecompress", () => {
  it.each([
    ["assets/index-abc.js", 4096, true],
    ["assets/index-abc.mjs", 4096, true],
    ["assets/index-abc.css", 4096, true],
    ["manifest.json", 4096, true],
    ["assets/logo-abc.svg", 4096, true],
    ["assets/index-abc.js.map", 4096, true],
    ["robots.txt", 4096, true],
    ["sitemap.xml", 4096, true],
    ["site.webmanifest", 4096, true],
    // the server rewrites index.html at boot (window.CONFIG) — a .br sibling would be STALE
    ["index.html", 1 << 20, false],
    ["nested/page.html", 1 << 20, false],
    // binary / already-compressed formats
    ["assets/logo-abc.png", 4096, false],
    ["assets/font-abc.woff2", 4096, false],
    ["assets/index-abc.js.br", 4096, false],
    ["assets/index-abc.js.gz", 4096, false],
    // below the size floor a sibling costs a request but saves nothing
    ["assets/tiny-abc.js", 1023, false],
    ["assets/tiny-abc.js", 1024, true],
  ])("%s (%d bytes) -> %s", (file, size, expected) => {
    expect(shouldPrecompress(file, size)).toBe(expected);
  });
});

describe("brotliSize / gzipSize", () => {
  it("report the compressed byte count of compressible input", () => {
    const buf = Buffer.from("const x = 1;\n".repeat(2000));
    expect(brotliSize(buf)).toBeLessThan(buf.length / 10);
    expect(gzipSize(buf)).toBeLessThan(buf.length / 10);
    expect(brotliSize(buf)).toBeGreaterThan(0);
    expect(gzipSize(buf)).toBeGreaterThan(0);
  });
  it("accept strings too", () => {
    expect(brotliSize("x".repeat(5000))).toBeLessThan(200);
  });
});

describe("compressSiblings", () => {
  let dir: string;
  const compressible =
    "export const s = " + JSON.stringify("hello world ".repeat(4000)) + ";\n";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccc-precompress-"));
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "index-abc.js"), compressible);
    writeFileSync(
      join(dir, "assets", "index-abc.css"),
      ".a{color:red}\n".repeat(500),
    );
    writeFileSync(
      join(dir, "index.html"),
      "<html>" + "<p>x</p>".repeat(2000) + "</html>",
    );
    writeFileSync(join(dir, "assets", "noise-abc.json"), randomBytes(8192)); // incompressible
    writeFileSync(join(dir, "assets", "tiny-abc.js"), "export const t = 1;\n"); // < 1024 B
    writeFileSync(join(dir, "assets", "logo-abc.png"), randomBytes(4096));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes .br and .gz siblings that decompress to the source", () => {
    const result = compressSiblings(dir);
    const js = join(dir, "assets", "index-abc.js");
    expect(existsSync(js + ".br")).toBe(true);
    expect(existsSync(js + ".gz")).toBe(true);
    expect(brotliDecompressSync(readFileSync(js + ".br")).toString()).toBe(
      compressible,
    );
    expect(gunzipSync(readFileSync(js + ".gz")).toString()).toBe(compressible);
    expect(statSync(js + ".br").size).toBeLessThan(statSync(js).size);
    expect(statSync(js + ".gz").size).toBeLessThan(statSync(js).size);
    expect(existsSync(join(dir, "assets", "index-abc.css.br"))).toBe(true);
    expect(existsSync(join(dir, "assets", "index-abc.css.gz"))).toBe(true);
    expect(result.written).toEqual(
      expect.arrayContaining([
        "assets/index-abc.js.br",
        "assets/index-abc.js.gz",
        "assets/index-abc.css.br",
        "assets/index-abc.css.gz",
      ]),
    );
    expect(result.written).toHaveLength(4);
  });

  it("never precompresses HTML (the server rewrites index.html at boot)", () => {
    compressSiblings(dir);
    expect(existsSync(join(dir, "index.html.br"))).toBe(false);
    expect(existsSync(join(dir, "index.html.gz"))).toBe(false);
  });

  it("skips files whose compressed form would not be smaller, tiny files and binaries", () => {
    const result = compressSiblings(dir);
    expect(existsSync(join(dir, "assets", "noise-abc.json.br"))).toBe(false);
    expect(existsSync(join(dir, "assets", "noise-abc.json.gz"))).toBe(false);
    expect(existsSync(join(dir, "assets", "tiny-abc.js.br"))).toBe(false);
    expect(existsSync(join(dir, "assets", "logo-abc.png.br"))).toBe(false);
    expect(result.skipped).toContain("assets/noise-abc.json");
  });

  it("is idempotent: a second run writes nothing and leaves the siblings intact", () => {
    compressSiblings(dir);
    const before = statSync(join(dir, "assets", "index-abc.js.br")).mtimeMs;
    const again = compressSiblings(dir);
    expect(again.written).toEqual([]);
    expect(statSync(join(dir, "assets", "index-abc.js.br")).mtimeMs).toBe(
      before,
    );
    // and it does not compress its own output (.br/.gz never get siblings)
    expect(existsSync(join(dir, "assets", "index-abc.js.br.br"))).toBe(false);
    expect(existsSync(join(dir, "assets", "index-abc.js.gz.br"))).toBe(false);
  });
});

const chunk = (
  over: Partial<Extract<BundleLike[string], { type: "chunk" }>> & {
    fileName: string;
  },
): Extract<BundleLike[string], { type: "chunk" }> => ({
  type: "chunk",
  isEntry: false,
  imports: [],
  dynamicImports: [],
  moduleIds: [],
  code: "",
  ...over,
});
const asset = (
  fileName: string,
  source = "x",
): Extract<BundleLike[string], { type: "asset" }> => ({
  type: "asset",
  fileName,
  source,
});

const syntheticBundle = (): BundleLike => ({
  "assets/index-a.js": chunk({
    fileName: "assets/index-a.js",
    isEntry: true,
    imports: ["assets/vendor-b.js"],
    dynamicImports: ["assets/lazy-c.js"],
    moduleIds: ["/repo/src/main.tsx"],
    viteMetadata: { importedCss: new Set(["assets/index-a.css"]) },
  }),
  "assets/vendor-b.js": chunk({
    fileName: "assets/vendor-b.js",
    imports: ["assets/shared-d.js", "not-in-bundle-external"],
    moduleIds: [
      "/repo/node_modules/.pnpm/react@19/node_modules/react/index.js",
    ],
    viteMetadata: { importedCss: new Set(["assets/vendor-b.css"]) },
  }),
  "assets/shared-d.js": chunk({ fileName: "assets/shared-d.js" }),
  "assets/lazy-c.js": chunk({
    fileName: "assets/lazy-c.js",
    imports: ["assets/lazy-e.js", "assets/shared-d.js"],
    moduleIds: [
      "/repo/node_modules/.pnpm/mermaid@11/node_modules/mermaid/dist/mermaid.core.mjs",
    ],
    viteMetadata: { importedCss: new Set(["assets/lazy-c.css"]) },
  }),
  "assets/lazy-e.js": chunk({ fileName: "assets/lazy-e.js" }),
  "assets/index-a.css": asset("assets/index-a.css"),
  "assets/vendor-b.css": asset("assets/vendor-b.css"),
  "assets/lazy-c.css": asset("assets/lazy-c.css"),
});

describe("initialSet", () => {
  it("is the entry plus the transitive closure of its STATIC imports", () => {
    const set = initialSet(syntheticBundle());
    expect([...set.chunks].sort()).toEqual([
      "assets/index-a.js",
      "assets/shared-d.js",
      "assets/vendor-b.js",
    ]);
  });
  it("excludes chunks reachable only through dynamicImports", () => {
    const set = initialSet(syntheticBundle());
    expect(set.chunks).not.toContain("assets/lazy-c.js");
    expect(set.chunks).not.toContain("assets/lazy-e.js");
  });
  it("counts the CSS of initial chunks and not the CSS of lazy chunks", () => {
    const set = initialSet(syntheticBundle());
    expect([...set.css].sort()).toEqual([
      "assets/index-a.css",
      "assets/vendor-b.css",
    ]);
    expect(set.css).not.toContain("assets/lazy-c.css");
  });
  it("lists the entry first", () => {
    expect(initialSet(syntheticBundle()).chunks[0]).toBe("assets/index-a.js");
  });
});

describe("findLazyViolations", () => {
  const lazy = ["mermaid", "@mermaid-js", "@excalidraw", "katex"];
  it("returns [] when the must-stay-lazy packages live only in lazy chunks", () => {
    const bundle = syntheticBundle();
    expect(findLazyViolations(bundle, initialSet(bundle), lazy)).toEqual([]);
  });
  it("names the offending initial chunk and package", () => {
    const bundle = syntheticBundle();
    const vendor = bundle["assets/vendor-b.js"] as Extract<
      BundleLike[string],
      { type: "chunk" }
    >;
    vendor.moduleIds.push(
      "/repo/node_modules/.pnpm/katex@0.16/node_modules/katex/dist/katex.mjs",
    );
    vendor.moduleIds.push(
      "/repo/node_modules/.pnpm/@mermaid-js+x@1/node_modules/@mermaid-js/x/index.js",
    );
    const v = findLazyViolations(bundle, initialSet(bundle), lazy);
    expect(v).toHaveLength(2);
    expect(v.join("\n")).toContain("assets/vendor-b.js");
    expect(v.join("\n")).toContain("katex");
    expect(v.join("\n")).toContain("@mermaid-js");
  });
  it("matches on the package boundary (mermaid-foo is not mermaid)", () => {
    const bundle = syntheticBundle();
    const vendor = bundle["assets/vendor-b.js"] as Extract<
      BundleLike[string],
      { type: "chunk" }
    >;
    vendor.moduleIds.push(
      "/repo/node_modules/.pnpm/mermaid-foo@1/node_modules/mermaid-foo/index.js",
    );
    expect(findLazyViolations(bundle, initialSet(bundle), lazy)).toEqual([]);
  });
  it("tolerates Windows separators", () => {
    const bundle = syntheticBundle();
    const vendor = bundle["assets/vendor-b.js"] as Extract<
      BundleLike[string],
      { type: "chunk" }
    >;
    vendor.moduleIds.push(
      "C:\\repo\\node_modules\\.pnpm\\katex@0.16\\node_modules\\katex\\dist\\katex.mjs",
    );
    expect(findLazyViolations(bundle, initialSet(bundle), lazy)).toHaveLength(
      1,
    );
  });
});

describe("checkBudget", () => {
  const budget = { initialJsBrotli: 700_000, initialCssBrotli: 80_000 };
  it("passes at exactly the budget", () => {
    expect(
      checkBudget(
        { initialJsBrotli: 700_000, initialCssBrotli: 80_000 },
        budget,
      ),
    ).toEqual([]);
  });
  it("fails one byte over the JS budget", () => {
    const msgs = checkBudget(
      { initialJsBrotli: 700_001, initialCssBrotli: 0 },
      budget,
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/JS/);
  });
  it("fails one byte over the CSS budget", () => {
    const msgs = checkBudget(
      { initialJsBrotli: 0, initialCssBrotli: 80_001 },
      budget,
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/CSS/);
  });
});

describe("precompressAndBudget (plugin factory)", () => {
  it("is a build-only Vite plugin named ccc:precompress", () => {
    const plugin = precompressAndBudget();
    expect(plugin.name).toBe("ccc:precompress");
    expect(plugin.apply).toBe("build");
    expect(typeof plugin.generateBundle).toBe("function");
    expect(typeof plugin.closeBundle).toBe("function");
  });
});

// ── Plugin hooks driven directly (no Vite) ───────────────────────────────────────────────────────

/** The slice of Rollup's PluginContext the hooks call. `error` throws like the real one does. */
type HookCtx = {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};
const hookCtx = (): HookCtx => ({
  warn: vi.fn(),
  error: vi.fn((m: unknown) => {
    throw new Error(String(m));
  }),
});

/** The hooks with `this` bound to our context. Vite may wrap a hook as `{ handler }`; unwrap either. */
function pluginHooks(plugin: ReturnType<typeof precompressAndBudget>) {
  const unwrap = (h: unknown): unknown =>
    typeof h === "function" ? h : (h as { handler?: unknown } | undefined)?.handler;
  return {
    configResolved: unwrap(plugin.configResolved) as (
      this: HookCtx,
      config: unknown,
    ) => void,
    generateBundle: unwrap(plugin.generateBundle) as (
      this: HookCtx,
      options: unknown,
      bundle: BundleLike,
    ) => void,
    closeBundle: unwrap(plugin.closeBundle) as (
      this: HookCtx,
      error?: Error,
    ) => void,
  };
}

/** The fields of ResolvedConfig the plugin reads, with a silent logger so the size table stays out of the test log. */
const fakeConfig = (root: string, outDir = "dist") => ({
  root,
  build: { outDir, write: true },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

const entryCode =
  "export const s = " + JSON.stringify("hello world ".repeat(4000)) + ";\n";
/** One entry chunk, compressible, no CSS — brotli lands well above 1 B and well below 1 MB. */
const oneEntryBundle = (): BundleLike => ({
  "assets/index-abc.js": chunk({
    fileName: "assets/index-abc.js",
    isEntry: true,
    code: entryCode,
    moduleIds: ["/repo/src/main.tsx"],
    viteMetadata: { importedCss: new Set() },
  }),
});
const TINY_BUDGET = { initialJsBrotli: 1, initialCssBrotli: 1 };
const ROOMY_BUDGET = { initialJsBrotli: 1_000_000, initialCssBrotli: 1_000_000 };

describe("precompressAndBudget strict mode", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccc-precompress-strict-"));
    // Neither env may leak in from the developer's shell: the plugin reads both.
    vi.stubEnv("BUNDLE_BUDGET_STRICT", undefined);
    vi.stubEnv("BUNDLE_REPORT_PATH", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  /** Run configResolved + generateBundle on a fresh plugin; returns the ctx and what generateBundle threw. */
  function runGenerate(opts: Parameters<typeof precompressAndBudget>[0]) {
    const plugin = precompressAndBudget(opts);
    const hooks = pluginHooks(plugin);
    const ctx = hookCtx();
    hooks.configResolved.call(ctx, fakeConfig(root));
    let thrown: unknown;
    try {
      hooks.generateBundle.call(ctx, {}, oneEntryBundle());
    } catch (e) {
      thrown = e;
    }
    return { hooks, ctx, thrown };
  }

  it("strict: true — a budget violation fails the build via this.error, naming the budget", () => {
    const { ctx, thrown } = runGenerate({ strict: true, budget: TINY_BUDGET });
    expect(thrown).toBeInstanceOf(Error);
    expect(ctx.error).toHaveBeenCalledTimes(1);
    const message = String(ctx.error.mock.calls[0][0]);
    expect(message).toMatch(/bundle invariant violation/);
    expect(message).toMatch(/initial JS [\d,]+ brotli exceeds the budget of 1 /);
    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it("strict: false — the same violation only warns and tells you how to make it fail", () => {
    const { ctx, thrown } = runGenerate({ strict: false, budget: TINY_BUDGET });
    expect(thrown).toBeUndefined();
    expect(ctx.warn).toHaveBeenCalledTimes(1);
    const message = String(ctx.warn.mock.calls[0][0]);
    expect(message).toMatch(/exceeds the budget of 1 /);
    expect(message).toContain("BUNDLE_BUDGET_STRICT=1");
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it("strict omitted + BUNDLE_BUDGET_STRICT=1 — the env alone selects the error path", () => {
    vi.stubEnv("BUNDLE_BUDGET_STRICT", "1");
    const { ctx, thrown } = runGenerate({ budget: TINY_BUDGET });
    expect(thrown).toBeInstanceOf(Error);
    expect(ctx.error).toHaveBeenCalledTimes(1);
    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it("strict omitted + env unset — warns only (the default is advisory)", () => {
    const { ctx, thrown } = runGenerate({ budget: TINY_BUDGET });
    expect(thrown).toBeUndefined();
    expect(ctx.warn).toHaveBeenCalledTimes(1);
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it("a passing budget neither warns nor errors, in either mode", () => {
    for (const strict of [true, false]) {
      const { ctx, thrown } = runGenerate({ strict, budget: ROOMY_BUDGET });
      expect(thrown, `strict=${strict}`).toBeUndefined();
      expect(ctx.warn, `strict=${strict}`).not.toHaveBeenCalled();
      expect(ctx.error, `strict=${strict}`).not.toHaveBeenCalled();
    }
  });

  describe("closeBundle after generateBundle", () => {
    // Vite runs closeBundle even after a failed build, and `dist` already holds the copied public/
    // files by then: a failed build must not be decorated with siblings.
    const appJs = () => join(root, "dist", "assets", "app-abc.js");
    beforeEach(() => {
      mkdirSync(join(root, "dist", "assets"), { recursive: true });
      writeFileSync(appJs(), "export const a = " + JSON.stringify("app ".repeat(2000)) + ";\n");
    });

    it("writes NO .br/.gz siblings after a strict-mode failure", () => {
      const { hooks, ctx, thrown } = runGenerate({ strict: true, budget: TINY_BUDGET });
      expect(thrown).toBeInstanceOf(Error);
      hooks.closeBundle.call(ctx, undefined);
      expect(existsSync(appJs() + ".br")).toBe(false);
      expect(existsSync(appJs() + ".gz")).toBe(false);
    });

    it("writes NO siblings when Vite hands closeBundle a build error", () => {
      const { hooks, ctx, thrown } = runGenerate({ strict: true, budget: ROOMY_BUDGET });
      expect(thrown).toBeUndefined();
      hooks.closeBundle.call(ctx, new Error("some other plugin failed"));
      expect(existsSync(appJs() + ".br")).toBe(false);
      expect(existsSync(appJs() + ".gz")).toBe(false);
    });

    it("control: the same flow with a passing budget DOES write the siblings", () => {
      const { hooks, ctx, thrown } = runGenerate({ strict: true, budget: ROOMY_BUDGET });
      expect(thrown).toBeUndefined();
      hooks.closeBundle.call(ctx, undefined);
      expect(existsSync(appJs() + ".br")).toBe(true);
      expect(existsSync(appJs() + ".gz")).toBe(true);
      expect(brotliDecompressSync(readFileSync(appJs() + ".br")).toString()).toBe(
        readFileSync(appJs(), "utf8"),
      );
    });

    it("control: a NON-strict violation still writes the siblings (the build did not fail)", () => {
      const { hooks, ctx, thrown } = runGenerate({ strict: false, budget: TINY_BUDGET });
      expect(thrown).toBeUndefined();
      hooks.closeBundle.call(ctx, undefined);
      expect(existsSync(appJs() + ".br")).toBe(true);
      expect(existsSync(appJs() + ".gz")).toBe(true);
    });
  });
});

describe("compressSiblings cache", () => {
  type Cache = NonNullable<Parameters<typeof compressSiblings>[1]>;
  let dir: string;
  const rel = "assets/index-abc.js";
  const source =
    "export const s = " + JSON.stringify("on-disk source ".repeat(4000)) + ";\n";
  // A DIFFERENT, still-compressible payload: if its bytes end up on disk, the cache was used.
  const sentinel = "cached sentinel content ".repeat(2000);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccc-precompress-cache-"));
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, rel), source);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const js = () => join(dir, rel);

  it("uses the cached .br/.gz when the cached raw equals the on-disk source", () => {
    const cache: Cache = new Map([
      [rel, { raw: Buffer.from(source), br: brotliBytes(sentinel), gz: gzipBytes(sentinel) }],
    ]);
    const result = compressSiblings(dir, cache);
    expect(result.written).toEqual([rel + ".br", rel + ".gz"]);
    // valid streams, but they decompress to the SENTINEL, not the source: the cache was used
    expect(brotliDecompressSync(readFileSync(js() + ".br")).toString()).toBe(sentinel);
    expect(gunzipSync(readFileSync(js() + ".gz")).toString()).toBe(sentinel);
    expect(result.brBytes).toBe(brotliBytes(sentinel).length);
  });

  it("ignores a cache entry whose raw differs from the on-disk source (a later plugin rewrote the file)", () => {
    const cache: Cache = new Map([
      [
        rel,
        {
          raw: Buffer.from(source + "// rewritten after generateBundle\n"),
          br: brotliBytes(sentinel),
          gz: gzipBytes(sentinel),
        },
      ],
    ]);
    compressSiblings(dir, cache);
    expect(brotliDecompressSync(readFileSync(js() + ".br")).toString()).toBe(source);
    expect(gunzipSync(readFileSync(js() + ".gz")).toString()).toBe(source);
  });

  it("ignores a cache entry keyed under a different path", () => {
    const cache: Cache = new Map([
      [
        "assets/other-abc.js",
        { raw: Buffer.from(source), br: brotliBytes(sentinel), gz: gzipBytes(sentinel) },
      ],
    ]);
    compressSiblings(dir, cache);
    expect(brotliDecompressSync(readFileSync(js() + ".br")).toString()).toBe(source);
  });
});
