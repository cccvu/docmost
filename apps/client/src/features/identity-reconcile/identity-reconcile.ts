// CCC (wiki-v2 #761): wiki-boot identity reconcile.
//
// The wiki session (Docmost's `authToken`) and the platform session (`__Host-wiki_session`) are separate
// cookies. A sign-in as A elsewhere (the console, another tab) replaces the platform session, but a tab that
// was opened as B keeps rendering B's cached user. The platform's `POST /bff/docmost/session/reconcile`
// compares the two server-side: it revokes and clears a wiki token that belongs to someone else
// (`superseded: true`) and reports which Docmost user the platform session maps to (`docmostUserId`).
// When the answer disagrees with what this tab shows, ONE guarded reload lets the existing 401 self-heal
// (lib/api-client.ts) mint a wiki session for the real identity.
//
// Advisory only. Authorization stays server-side: this never grants or denies anything, it only refreshes a
// stale UI. Every failure (401 = no platform session, 503, network, a malformed body) does nothing, because
// ADR 0034 keeps the wiki alive when the platform session merely lapses.
import type { AxiosInstance } from "axios";
import {
  reloadOncePerWindow,
  type ChunkReloadEnv,
} from "@/features/layout/lazy-with-reload";

export const RECONCILE_PATH = "/bff/docmost/session/reconcile";
/** Its own stamp, so a chunk-load reload never spends (or is blocked by) this reason's budget. */
export const IDENTITY_RELOAD_KEY = "ccc:identity-reload-at";
export const IDENTITY_RELOAD_WINDOW_MS = 60_000;
/** A hung request must not hold the single in-flight slot forever. */
export const RECONCILE_TIMEOUT_MS = 10_000;

export interface ReconcileResult {
  superseded: boolean;
  docmostUserId: string | null;
}

/** Strict shape check: anything else is treated as "no answer". */
export function parseReconcileBody(body: unknown): ReconcileResult | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const { superseded, docmostUserId } = body as Record<string, unknown>;
  if (typeof superseded !== "boolean") return null;
  if (docmostUserId === null) return { superseded, docmostUserId: null };
  if (typeof docmostUserId !== "string") return null;
  return { superseded, docmostUserId };
}

/**
 * True when this tab shows the wrong person: the server superseded the wiki token, or the platform identity
 * maps to a different Docmost user than the one cached here. A `null` mapping is a mismatch too: the platform
 * answers 503 when it cannot read the mapping, so `null` means its identity has no wiki user yet, and the
 * signed-in user cached here is therefore someone else. Callers pass only a signed-in user's id.
 */
export function shouldReload(
  result: ReconcileResult,
  currentUserId: string,
): boolean {
  if (result.superseded) return true;
  return result.docmostUserId !== currentUserId;
}

export interface IdentityReconcilerDeps {
  /** The bare platform client (lib/platform-client.ts): no interceptors, so a 401 never redirects. */
  api: Pick<AxiosInstance, "post">;
  /** The signed-in wiki user's id, read when the answer arrives; undefined = not signed in / inactive. */
  currentUserId(): string | undefined;
  reloadEnv?: ChunkReloadEnv;
}

export interface IdentityReconciler {
  /** Ask once. A trigger while a request is in flight joins it (at most one request at a time). */
  trigger(): Promise<void>;
}

export function createIdentityReconciler(
  deps: IdentityReconcilerDeps,
): IdentityReconciler {
  let inFlight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    if (!deps.currentUserId()) return;
    let body: unknown;
    try {
      const res = await deps.api.post(RECONCILE_PATH, undefined, {
        timeout: RECONCILE_TIMEOUT_MS,
      });
      body = res?.data;
    } catch {
      return; // 401 / 503 / network / timeout: leave the tab alone
    }
    const result = parseReconcileBody(body);
    if (!result) return;
    // Re-read the user AFTER the answer: a tab that signed out meanwhile has nothing to reconcile.
    const current = deps.currentUserId();
    if (!current || !shouldReload(result, current)) return;
    reloadOncePerWindow(
      IDENTITY_RELOAD_KEY,
      deps.reloadEnv,
      IDENTITY_RELOAD_WINDOW_MS,
    );
  };

  return {
    trigger() {
      if (!inFlight) {
        inFlight = run().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}
