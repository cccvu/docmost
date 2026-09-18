// Fork-owned Vite build plugin (issue #309: SPA asset delivery).
//
// Two jobs, both zero-dependency (node:zlib / node:fs / node:path only — the fork adds NO npm deps):
//
//  1. `generateBundle` — measure the INITIAL SET (the entry chunk + the transitive closure of its
//     STATIC imports + the CSS those chunks reference) and print a `file | raw | gzip | br | initial?`
//     table for every JS/CSS output. Then enforce two invariants: (a) no `mustStayLazy` package may
//     land in an initial chunk (a lazy feature that leaks into the eager graph silently re-inflates the
//     first paint), and (b) the initial JS / CSS brotli totals stay under `budget`. In strict mode
//     (`strict: true` or `BUNDLE_BUDGET_STRICT=1`) a violation FAILS the build; otherwise it warns.
//
//  2. `closeBundle` — after Vite has written `dist`, write `<file>.br` + `<file>.gz` siblings for every
//     compressible text asset >= 1 KiB. `@fastify/static { preCompressed: true }` picks the sibling that
//     matches Accept-Encoding and falls back to identity. HTML is NEVER precompressed: the server rewrites
//     `dist/index.html` on disk at boot (it injects `window.CONFIG`), so an `index.html.br` sibling would
//     be stale and serve a config-less page.
//
// The pure helpers are exported so the unit tests (precompress.test.ts) hit real logic without Vite.
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";
import type { Plugin, ResolvedConfig, Rollup } from "vite";

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────

/** Text formats worth a precompressed sibling. Binary/already-compressed formats (images, fonts) are not. */
export const PRECOMPRESS_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".mjs",
  ".css",
  ".svg",
  ".json",
  ".txt",
  ".xml",
  ".webmanifest",
  ".map",
]);

/** Below this a sibling costs a stat/open on every request and saves almost nothing on the wire. */
export const PRECOMPRESS_MIN_BYTES = 1024;

const SIBLING_EXTENSIONS = [".br", ".gz"] as const;

export function shouldPrecompress(
  fileName: string,
  sizeBytes: number,
): boolean {
  if (sizeBytes < PRECOMPRESS_MIN_BYTES) return false;
  return PRECOMPRESS_EXTENSIONS.has(extname(fileName).toLowerCase());
}

const toBuffer = (input: Buffer | Uint8Array | string): Buffer =>
  typeof input === "string"
    ? Buffer.from(input, "utf8")
    : Buffer.isBuffer(input)
      ? input
      : Buffer.from(input);

/** Brotli at max quality, text mode, with the size hint — the same settings the siblings are written with. */
export function brotliBytes(input: Buffer | Uint8Array | string): Buffer {
  const buf = toBuffer(input);
  return brotliCompressSync(buf, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
}

/** gzip level 9. node:zlib writes mtime=0 into the header, so the output is deterministic for a given input. */
export function gzipBytes(input: Buffer | Uint8Array | string): Buffer {
  return gzipSync(toBuffer(input), { level: zlibConstants.Z_BEST_COMPRESSION });
}

export function brotliSize(input: Buffer | Uint8Array | string): number {
  return brotliBytes(input).length;
}

export function gzipSize(input: Buffer | Uint8Array | string): number {
  return gzipBytes(input).length;
}

export interface CompressSiblingsResult {
  /** Sibling files written, relative to `dir`, POSIX separators. */
  written: string[];
  /** Eligible sources for which at least one sibling was NOT written (already present, or not smaller). */
  skipped: string[];
  /** Number of eligible source files considered. */
  files: number;
  /** Raw bytes of every eligible source. */
  rawBytes: number;
  /** Brotli bytes of every eligible source (sum of the .br siblings, written or pre-existing). */
  brBytes: number;
}

/** Pre-computed compressed forms keyed by the file's path relative to the out dir (see the plugin). */
type CompressedCache = Map<string, { raw: Buffer; br: Buffer; gz: Buffer }>;

const posix = (p: string): string => p.split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Write `<file>.br` / `<file>.gz` next to every eligible file under `dir`. A sibling is written only when
 * it is smaller than the source; an existing sibling at least as new as its source is left alone, so a
 * re-run writes nothing. `.br`/`.gz` files are never themselves compressed. HTML is never eligible.
 */
export function compressSiblings(
  dir: string,
  cache?: CompressedCache,
): CompressSiblingsResult {
  const result: CompressSiblingsResult = {
    written: [],
    skipped: [],
    files: 0,
    rawBytes: 0,
    brBytes: 0,
  };
  for (const file of walk(dir).sort()) {
    const ext = extname(file).toLowerCase();
    if ((SIBLING_EXTENSIONS as readonly string[]).includes(ext)) continue;
    const stat = statSync(file);
    if (!shouldPrecompress(file, stat.size)) continue;
    const rel = posix(relative(dir, file));
    result.files += 1;
    result.rawBytes += stat.size;

    const source = readFileSync(file);
    const cached = cache?.get(rel);
    const fresh = cached && cached.raw.equals(source) ? cached : undefined;
    let skipped = false;
    for (const sib of SIBLING_EXTENSIONS) {
      const target = file + sib;
      if (existsSync(target)) {
        const sibStat = statSync(target);
        if (sibStat.size > 0 && sibStat.mtimeMs >= stat.mtimeMs) {
          if (sib === ".br") result.brBytes += sibStat.size;
          skipped = true;
          continue;
        }
      }
      const compressed =
        sib === ".br"
          ? (fresh?.br ?? brotliBytes(source))
          : (fresh?.gz ?? gzipBytes(source));
      if (compressed.length >= source.length) {
        skipped = true;
        continue;
      }
      writeFileSync(target, compressed);
      if (sib === ".br") result.brBytes += compressed.length;
      result.written.push(rel + sib);
    }
    if (skipped) result.skipped.push(rel);
  }
  return result;
}

/** The subset of Rollup's OutputBundle the helpers read — so tests can pass a plain object. */
export type BundleLike = {
  [fileName: string]:
    | {
        type: "chunk";
        fileName: string;
        isEntry: boolean;
        imports: string[];
        dynamicImports: string[];
        moduleIds: string[];
        code: string;
        viteMetadata?: { importedCss: Set<string> };
      }
    | { type: "asset"; fileName: string; source: string | Uint8Array };
};

export interface InitialSet {
  /** Chunk file names in discovery order: entries first, then their static-import closure. */
  chunks: string[];
  /** CSS asset file names referenced by the initial chunks. */
  css: string[];
}

/**
 * The INITIAL SET = every `isEntry` chunk + the transitive closure of `imports` (static only — a chunk
 * reachable solely through `dynamicImports` is lazy and excluded) + the CSS those chunks reference.
 * This is exactly what the browser fetches before first paint (Vite emits `<link rel="modulepreload">`
 * for each static import of the entry).
 */
export function initialSet(bundle: BundleLike): InitialSet {
  const chunks: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const [fileName, out] of Object.entries(bundle)) {
    if (out.type === "chunk" && out.isEntry) queue.push(fileName);
  }
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    const out = bundle[name];
    if (!out || out.type !== "chunk") continue; // an external or an unknown import — not in the bundle
    seen.add(name);
    chunks.push(name);
    for (const dep of out.imports) if (!seen.has(dep)) queue.push(dep);
  }
  const css = new Set<string>();
  for (const name of chunks) {
    const out = bundle[name];
    if (out?.type === "chunk")
      for (const c of out.viteMetadata?.importedCss ?? []) css.add(c);
  }
  return { chunks, css: [...css] };
}

/**
 * Report every (initial chunk, package) pair where a module of a `mustStayLazy` package was bundled into
 * an initial chunk. Matching is on the package boundary of the LAST `node_modules/` segment, so pnpm's
 * `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/…` layout resolves to `<pkg>`, and `mermaid-foo`
 * does not match `mermaid`. A scope (`@mermaid-js`) matches every package under it.
 */
export function findLazyViolations(
  bundle: BundleLike,
  initial: InitialSet,
  mustStayLazy: string[],
): string[] {
  const violations: string[] = [];
  for (const chunkName of initial.chunks) {
    const out = bundle[chunkName];
    if (!out || out.type !== "chunk") continue;
    const hits = new Map<string, string>();
    for (const rawId of out.moduleIds) {
      const id = rawId.replace(/\\/g, "/");
      for (const pkg of mustStayLazy) {
        if (hits.has(pkg)) continue;
        if (id.includes(`/node_modules/${pkg}/`)) hits.set(pkg, id);
      }
    }
    for (const [pkg, id] of hits) {
      violations.push(
        `${chunkName}: must-stay-lazy package "${pkg}" is in the initial set (${id})`,
      );
    }
  }
  return violations;
}

export interface BundleBudget {
  /** Brotli bytes allowed for the initial JS set (entry + static-import closure). */
  initialJsBrotli: number;
  /** Brotli bytes allowed for the CSS the initial chunks reference. */
  initialCssBrotli: number;
}

export function checkBudget(
  sizes: BundleBudget,
  budget: BundleBudget,
): string[] {
  const msgs: string[] = [];
  if (sizes.initialJsBrotli > budget.initialJsBrotli) {
    msgs.push(
      `initial JS ${fmt(sizes.initialJsBrotli)} brotli exceeds the budget of ${fmt(budget.initialJsBrotli)} ` +
        `(+${fmt(sizes.initialJsBrotli - budget.initialJsBrotli)})`,
    );
  }
  if (sizes.initialCssBrotli > budget.initialCssBrotli) {
    msgs.push(
      `initial CSS ${fmt(sizes.initialCssBrotli)} brotli exceeds the budget of ${fmt(budget.initialCssBrotli)} ` +
        `(+${fmt(sizes.initialCssBrotli - budget.initialCssBrotli)})`,
    );
  }
  return msgs;
}

// ── Reporting ────────────────────────────────────────────────────────────────────────────────────

const fmt = (n: number): string => n.toLocaleString("en-US");

export interface SizeRow {
  file: string;
  kind: "js" | "css";
  raw: number;
  gzip: number;
  br: number;
  initial: boolean;
}

export interface BundleReport {
  rows: SizeRow[];
  initial: InitialSet;
  totals: {
    initialJsRaw: number;
    initialJsBrotli: number;
    initialCssRaw: number;
    initialCssBrotli: number;
  };
  lazyViolations: string[];
  budgetViolations: string[];
  budget?: BundleBudget;
  strict: boolean;
}

function renderTable(report: BundleReport): string {
  const head = ["file", "raw", "gzip", "br", "initial?"];
  const body = report.rows.map((r) => [
    r.file,
    fmt(r.raw),
    fmt(r.gzip),
    fmt(r.br),
    r.initial ? "yes" : "",
  ]);
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
      .join(" | ");
  const out: string[] = [
    line(head),
    widths.map((w) => "-".repeat(w)).join("-+-"),
    ...body.map(line),
  ];
  const t = report.totals;
  out.push("");
  out.push(
    `initial JS : ${report.initial.chunks.length} chunk(s), ${fmt(t.initialJsRaw)} raw -> ${fmt(t.initialJsBrotli)} br` +
      (report.budget
        ? ` (budget ${fmt(report.budget.initialJsBrotli)} br)`
        : ""),
  );
  out.push(
    `initial CSS: ${report.initial.css.length} file(s), ${fmt(t.initialCssRaw)} raw -> ${fmt(t.initialCssBrotli)} br` +
      (report.budget
        ? ` (budget ${fmt(report.budget.initialCssBrotli)} br)`
        : ""),
  );
  return out.join("\n");
}

// ── The plugin ───────────────────────────────────────────────────────────────────────────────────

export interface PrecompressOptions {
  /** Brotli budgets for the initial set. Omit to only report. */
  budget?: BundleBudget;
  /** Package names (or scopes) that must never be bundled into an initial chunk. */
  mustStayLazy?: string[];
  /** Fail the build on a violation. Defaults to `process.env.BUNDLE_BUDGET_STRICT === "1"`. */
  strict?: boolean;
}

export function precompressAndBudget(opts: PrecompressOptions = {}): Plugin {
  let config: ResolvedConfig | undefined;
  // Set when a strict-mode violation fails the build: Vite still runs closeBundle (without the error),
  // and the out dir already holds the copied `public/` files — do not decorate a failed build.
  let failed = false;
  // Compressed forms computed in generateBundle, reused by closeBundle when the on-disk bytes are
  // identical (they are, unless a later plugin rewrote the file) — halves the brotli-11 cost.
  const cache: CompressedCache = new Map();

  return {
    name: "ccc:precompress",
    apply: "build",

    configResolved(resolved) {
      config = resolved;
    },

    generateBundle(_options, bundle) {
      const strict = opts.strict ?? process.env.BUNDLE_BUDGET_STRICT === "1";
      const like = bundle as unknown as BundleLike;
      const initial = initialSet(like);
      const initialChunks = new Set(initial.chunks);
      const initialCss = new Set(initial.css);

      const rows: SizeRow[] = [];
      for (const [fileName, out] of Object.entries(
        bundle as Rollup.OutputBundle,
      )) {
        const ext = extname(fileName).toLowerCase();
        let kind: SizeRow["kind"] | undefined;
        let source: Buffer | undefined;
        if (out.type === "chunk" && (ext === ".js" || ext === ".mjs")) {
          kind = "js";
          source = Buffer.from(out.code, "utf8");
        } else if (out.type === "asset" && ext === ".css") {
          kind = "css";
          source = toBuffer(out.source);
        }
        if (!kind || !source) continue;
        const br = brotliBytes(source);
        const gz = gzipBytes(source);
        if (shouldPrecompress(fileName, source.length))
          cache.set(fileName, { raw: source, br, gz });
        rows.push({
          file: fileName,
          kind,
          raw: source.length,
          gzip: gz.length,
          br: br.length,
          initial:
            kind === "js"
              ? initialChunks.has(fileName)
              : initialCss.has(fileName),
        });
      }
      rows.sort((a, b) => b.raw - a.raw || a.file.localeCompare(b.file));

      const totals = {
        initialJsRaw: 0,
        initialJsBrotli: 0,
        initialCssRaw: 0,
        initialCssBrotli: 0,
      };
      for (const r of rows) {
        if (!r.initial) continue;
        if (r.kind === "js") {
          totals.initialJsRaw += r.raw;
          totals.initialJsBrotli += r.br;
        } else {
          totals.initialCssRaw += r.raw;
          totals.initialCssBrotli += r.br;
        }
      }

      const report: BundleReport = {
        rows,
        initial,
        totals,
        lazyViolations: findLazyViolations(
          like,
          initial,
          opts.mustStayLazy ?? [],
        ),
        budgetViolations: opts.budget
          ? checkBudget(
              {
                initialJsBrotli: totals.initialJsBrotli,
                initialCssBrotli: totals.initialCssBrotli,
              },
              opts.budget,
            )
          : [],
        budget: opts.budget,
        strict,
      };

      const log = config?.logger ?? console;
      log.info(
        `\n[ccc:precompress] bundle size report (#309)\n${renderTable(report)}\n`,
      );

      const reportPath = process.env.BUNDLE_REPORT_PATH;
      if (reportPath) {
        const abs = resolve(reportPath);
        const outDir = config
          ? resolve(config.root, config.build.outDir)
          : undefined;
        if (outDir && (abs === outDir || abs.startsWith(outDir + sep))) {
          this.warn(
            `BUNDLE_REPORT_PATH=${reportPath} points inside the build output — refusing to write the report there`,
          );
        } else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(
            abs,
            JSON.stringify(
              {
                ...report,
                initial: { chunks: initial.chunks, css: initial.css },
              },
              null,
              2,
            ),
          );
          log.info(`[ccc:precompress] wrote ${abs}`);
        }
      }

      const problems = [...report.lazyViolations, ...report.budgetViolations];
      if (problems.length) {
        const message = `[ccc:precompress] ${problems.length} bundle invariant violation(s):\n  - ${problems.join("\n  - ")}`;
        if (strict) {
          failed = true;
          this.error(message); // throws — fails the build
        } else {
          this.warn(
            `${message}\n  (set BUNDLE_BUDGET_STRICT=1 to fail the build)`,
          );
        }
      }
    },

    closeBundle(error) {
      if (error || failed || !config || config.build.write === false) return;
      const outDir = resolve(config.root, config.build.outDir);
      if (!existsSync(outDir)) return;
      const started = Date.now();
      const result = compressSiblings(outDir, cache);
      cache.clear();
      const log = config.logger ?? console;
      log.info(
        `[ccc:precompress] wrote ${result.written.length} .br/.gz sibling(s) in ${relative(config.root, outDir) || "."} ` +
          `(${fmt(result.rawBytes)} raw -> ${fmt(result.brBytes)} br across ${result.files} file(s), ` +
          `${result.skipped.length} skipped, ${Date.now() - started} ms)`,
      );
    },
  };
}
