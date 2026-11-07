// CCC (issue #145): notice that a newer client build is live, so a long-open tab can offer a reload.
//
// lazy-with-reload.ts only recovers AFTER a stale tab asks for a chunk that no longer exists. A tab that
// sits on one page (e.g. editing) never does, and keeps running the old bundle against the new server.
//
// The build id is free: Vite content-hashes the entry script (`/assets/index-<hash>.js`), and index.html is
// served `no-cache, no-store, must-revalidate` (ADR 0020), so a fresh GET of `/` names the live build.
// (APP_VERSION is the upstream package version and does not change between fork deploys.)
//
// Rules, all pure and tested here:
// - Probe at most once per NEW_VERSION_PROBE_INTERVAL_MS.
// - Nudge only after TWO CONSECUTIVE probes name the SAME entry that differs from the running one. During
//   a rolling deploy the old and new ECS tasks both sit behind the ALB, so single probes alternate.
// - A failed fetch, a non-2xx or non-HTML answer, or HTML with no hashed entry is "unknown": never a
//   nudge, and it breaks the streak.
// - Nudge at most once per document. If the running entry is unknown (the Vite dev server), do nothing.

export const NEW_VERSION_PROBE_INTERVAL_MS = 10 * 60_000;
export const NEW_VERSION_CONFIRMATIONS = 2;
const PROBE_TIMEOUT_MS = 10_000;

/** The hashed entry's path, or null for anything that is not a built `/assets/` script. */
export function normalizeEntrySrc(src: string | null | undefined): string | null {
  if (!src) return null;
  let path: string;
  try {
    path = new URL(src, "http://entry.invalid").pathname;
  } catch {
    return null;
  }
  return path.startsWith("/assets/") ? path : null;
}

/** The first `<script type="module" src="/assets/…">` in an HTML string, normalized; else null. */
export function extractEntryScriptSrc(html: string): string | null {
  for (const tag of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = tag[1];
    if (!/\btype\s*=\s*["']?module["']?(?=[\s>]|$)/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const entry = normalizeEntrySrc(src ? (src[1] ?? src[2] ?? src[3]) : null);
    if (entry) return entry;
  }
  return null;
}

export interface NewVersionState {
  lastProbeAt: number | null;
  /** The differing entry seen by the last probe(s), and how many consecutive probes named it. */
  candidate: string | null;
  streak: number;
  nudged: boolean;
}

export function initialNewVersionState(): NewVersionState {
  return { lastProbeAt: null, candidate: null, streak: 0, nudged: false };
}

export function shouldProbe(state: NewVersionState, now: number): boolean {
  if (state.nudged) return false;
  return state.lastProbeAt === null || now - state.lastProbeAt >= NEW_VERSION_PROBE_INTERVAL_MS;
}

/** Fold one probe result (the live entry, or null = unknown) into the state. */
export function applyProbe(
  state: NewVersionState,
  running: string,
  live: string | null,
): { state: NewVersionState; nudge: boolean } {
  if (state.nudged) return { state, nudge: false };
  if (live === null || live === running) {
    return { state: { ...state, candidate: null, streak: 0 }, nudge: false };
  }
  const streak = live === state.candidate ? state.streak + 1 : 1;
  const nudge = streak >= NEW_VERSION_CONFIRMATIONS;
  return { state: { ...state, candidate: live, streak, nudged: nudge }, nudge };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** GET `/` uncached. Returns its HTML, or null for any failure, non-2xx or non-HTML answer. */
export async function fetchIndexHtml(fetchImpl: FetchLike = fetch): Promise<string | null> {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl("/", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "text/html" },
      signal: controller?.signal,
    });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface NewVersionCheckerEnv {
  /** The running document's entry src (any form); null/unknown disables the checker. */
  running: string | null;
  fetchHtml: () => Promise<string | null>;
  now: () => number;
  onNudge: () => void;
}

export function createNewVersionChecker(env: NewVersionCheckerEnv): { check(): Promise<void> } {
  const running = normalizeEntrySrc(env.running);
  let state = initialNewVersionState();
  return {
    async check() {
      if (running === null) return;
      const now = env.now();
      if (!shouldProbe(state, now)) return;
      // Stamped before the await, so a focus + visibilitychange pair starts one probe, not two.
      state = { ...state, lastProbeAt: now };
      let html: string | null = null;
      try {
        html = await env.fetchHtml();
      } catch {
        html = null;
      }
      const result = applyProbe(state, running, html === null ? null : extractEntryScriptSrc(html));
      state = result.state;
      if (result.nudge) env.onNudge();
    },
  };
}
