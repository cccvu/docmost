/**
 * Runtime brand configuration (issue #30 follow-up).
 *
 * This module is the fork's ONLY source of institution branding. The public AGPL fork ships no
 * institution trademarks or names — `features/brand/assets/` is gone and the favicons are upstream
 * defaults. When a `/brand/manifest.json` bundle is served (same-origin, by the proprietary platform),
 * the app fetches it at boot and renders that identity; otherwise it renders a neutral "Wiki".
 *
 * The fetch fails CLOSED to {@link NEUTRAL_BRAND}: a missing bundle, a network error, a non-JSON body, or
 * a timeout all leave the generic identity. Note Docmost's server answers unknown paths with its SPA
 * fallback (`200 text/html`), so the status alone is never trusted — the content type is checked too.
 */

export interface BrandAssets {
  icon?: string;
  wordmarkSvg?: string;
  favicon16?: string;
  favicon32?: string;
  appleTouchIcon?: string;
  appIcon192?: string;
  appIcon512?: string;
}

export interface BrandConfig {
  name: string;
  institutionName?: string;
  collegeName?: string;
  assets: BrandAssets;
  webManifest?: string;
  /** Inline wordmark SVG markup, fetched from `assets.wordmarkSvg` (fill=currentColor themes with ink). */
  wordmarkSvg?: string;
}

/** What the app renders with no bundle: a generic wiki with no institution marks. */
export const NEUTRAL_BRAND: BrandConfig = { name: "Wiki", assets: {} };

/** Same-origin path served by the platform (services/platform/assets/brand). */
const BRAND_MANIFEST_URL = "/brand/manifest.json";
const BRAND_ASSET_PREFIX = "/brand/";
/** Per-request deadline (manifest attempt, manifest retry, wordmark each re-arm it), so a single hung
 *  request cannot poison the others and a transient stall is survivable instead of silently dropping
 *  the brand. There is deliberately NO aggregate cap: the documented worst-case first-paint bound is
 *  ~3 s when /brand/manifest.json hangs (two 1.5 s attempts) and ~4.5 s composed with a hung wordmark —
 *  accepted because a hung /brand is a broken deployment anyway, and the healthy path stays ~ms.
 *  (The old single shared 1.5 s deadline bounded total paint tightly but let one stale abort silently
 *  downgrade a completed 200 manifest into the neutral identity — the CI run-35550624904 failure.) */
const LOAD_TIMEOUT_MS = 1500;

let brand: BrandConfig = NEUTRAL_BRAND;
let loadPromise: Promise<BrandConfig> | null = null;
const listeners = new Set<() => void>();

export function getBrandConfig(): BrandConfig {
  return brand;
}

export function subscribeBrand(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: install a config (and notify subscribers) without a network round trip. */
export function setBrandConfigForTest(next: BrandConfig): void {
  brand = next;
  listeners.forEach((listener) => listener());
}

/**
 * Fetch the manifest and the wordmark artwork once, then install the config. Each request carries its
 * OWN deadline, and a transient failure of the manifest request (network error, abort — e.g. a body
 * read that stalls past the deadline on a cold box —, or a JSON parse hiccup) is retried ONCE with a
 * fresh clock. A completed 200 response must not be silently downgraded to the neutral identity by an
 * abort that lands between the headers and the body read; the cases that fall back WITHOUT a retry
 * are definitive misses (4xx, non-JSON — a standalone deployment answers 404 on every boot), while
 * 5xx and network/abort/parse failures are treated as transient and retried once.
 * `main.tsx` awaits this before the first render so every `getAppName()` title is correct immediately.
 */
export function loadBrandConfig(): Promise<BrandConfig> {
  loadPromise ??= (async () => {
    const config = await fetchBrandConfig();
    if (config.assets.wordmarkSvg) {
      config.wordmarkSvg =
        (await fetchWordmarkSvg(config.assets.wordmarkSvg)) ?? undefined;
    }
    brand = config;
    listeners.forEach((listener) => listener());
    applyBrandDocument(config);
    return config;
  })();
  return loadPromise;
}

async function fetchBrandConfig(): Promise<BrandConfig> {
  const first = await fetchBrandConfigAttempt();
  if (first !== null) return first;
  const retried = await fetchBrandConfigAttempt();
  if (retried !== null) return retried;
  console.warn(
    "[brand] /brand manifest unreachable after one retry (transient fetch/abort/parse failure) — rendering the neutral identity",
  );
  return NEUTRAL_BRAND;
}

/** `null` = transient failure (retryable); a BrandConfig = definitive result (incl. a clean miss). */
async function fetchBrandConfigAttempt(): Promise<BrandConfig | null> {
  try {
    const response = await fetch(BRAND_MANIFEST_URL, {
      headers: { accept: "application/json" },
      signal: timeoutSignal(LOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      // A 5xx is as transient as a network error (the platform hiccuped, not the bundle);
      // 4xx is a definitive miss — a standalone deployment answers 404 on every boot.
      return response.status >= 500 ? null : NEUTRAL_BRAND;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return NEUTRAL_BRAND;
    return normalizeBrandConfig((await response.json()) as Partial<BrandConfig>);
  } catch {
    return null;
  }
}

function normalizeBrandConfig(raw: Partial<BrandConfig>): BrandConfig {
  const assets: BrandAssets = {};
  for (const key of Object.keys(raw.assets ?? {}) as (keyof BrandAssets)[]) {
    const url = sanitizeBrandAssetUrl(raw.assets?.[key]);
    if (url) assets[key] = url;
  }
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : NEUTRAL_BRAND.name;
  return {
    name,
    institutionName: textOrUndefined(raw.institutionName),
    collegeName: textOrUndefined(raw.collegeName),
    assets,
    webManifest: sanitizeBrandAssetUrl(raw.webManifest),
  };
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The bundle is trusted (same-origin, ours) — but fail closed to `/brand/` relative URLs all the same. */
export function sanitizeBrandAssetUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  if (!url.startsWith(BRAND_ASSET_PREFIX)) return undefined;
  if (url.includes("..") || url.includes("\\") || url.includes("//")) return undefined;
  return url;
}

async function fetchWordmarkSvg(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: timeoutSignal(LOAD_TIMEOUT_MS) });
    if (!response.ok) return null;
    const markup = (await response.text()).trim();
    return markup.startsWith("<svg") ? markup : null;
  } catch {
    return null;
  }
}

/** Swap the document's static neutral identity for the runtime brand (title, favicons, PWA manifest). */
function applyBrandDocument(config: BrandConfig): void {
  const { assets } = config;
  if (assets.favicon32) setLink("icon", assets.favicon32, "32x32");
  if (assets.favicon16) setLink("icon", assets.favicon16, "16x16");
  if (assets.appleTouchIcon) setLink("apple-touch-icon", assets.appleTouchIcon);
  if (config.webManifest) setLink("manifest", config.webManifest);
  setMeta("apple-mobile-web-app-title", config.name);
  document.title = config.name;
}

function setLink(rel: string, href: string, sizes?: string): void {
  const selector = sizes ? `link[rel="${rel}"][sizes="${sizes}"]` : `link[rel="${rel}"]`;
  let element = document.head.querySelector<HTMLLinkElement>(selector);
  if (!element) {
    element = document.createElement("link");
    element.rel = rel;
    document.head.appendChild(element);
  }
  if (sizes) element.setAttribute("sizes", sizes);
  element.href = href;
}

function setMeta(name: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.name = name;
    document.head.appendChild(element);
  }
  element.content = content;
}

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
