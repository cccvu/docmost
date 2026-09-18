// CCC (issue #309): reload-once recovery for lazy chunks.
//
// After a deploy, a tab that was already open still holds the OLD chunk hashes. The server answers a
// missing `/assets/<oldhash>.js` with `200 text/html` (the SPA fallback), the browser rejects the module
// (wrong MIME type), React.lazy caches that rejection for the life of the document, and with no error
// boundary above <Routes> the whole app unmounts to a blank page. One reload fetches the new index.html
// and hashes; a sessionStorage stamp caps it at once per CHUNK_RELOAD_WINDOW_MS so it can never loop.
//
// No `vite:preloadError` listener: Vite's preload helper dispatches that event and then RETHROWS when
// nobody calls preventDefault, so the rejection reaches the factory's catch below anyway. Catching at
// the factory is independent of Vite's helper and also covers a plain `import()` MIME rejection (a
// chunk with no CSS/preload deps never goes through the helper).
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export const CHUNK_RELOAD_KEY = "ccc:chunk-reload-at";
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

export interface ChunkReloadEnv {
  now(): number;
  /** null = no usable storage → no loop guard is possible → never auto-reload. */
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  reload(): void;
}

/** The browser env. Resolved lazily (per call) so importing this module touches no browser global. */
export function defaultChunkReloadEnv(): ChunkReloadEnv {
  let storage: ChunkReloadEnv["storage"] = null;
  try {
    // The accessor itself throws in some private/blocked-storage modes.
    storage = typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    storage = null;
  }
  return {
    now: Date.now,
    storage,
    reload: () => window.location.reload(),
  };
}

/**
 * Reload the document once per window. Returns true iff it triggered a reload. Every "cannot guard"
 * branch (no storage, unreadable or unwritable stamp) returns false WITHOUT reloading: a reload we
 * cannot record is a reload we cannot stop repeating.
 */
export function recoverFromChunkLoadError(
  env: ChunkReloadEnv = defaultChunkReloadEnv(),
): boolean {
  const { storage } = env;
  if (!storage) return false;

  let last: number;
  try {
    last = Number(storage.getItem(CHUNK_RELOAD_KEY));
  } catch {
    return false;
  }
  const now = env.now();
  if (Number.isFinite(last) && last > 0 && now - last < CHUNK_RELOAD_WINDOW_MS) {
    return false;
  }

  try {
    storage.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  env.reload();
  return true;
}

/**
 * `React.lazy` whose chunk-load failure reloads the document once (see above). On the reload path the
 * returned promise never settles, so React keeps the <Suspense> fallback up while the reload takes over
 * instead of caching a rejection or flashing an error. If a reload already happened inside the window
 * the original error propagates to the nearest error boundary, exactly as a bare lazy() would.
 */
export function lazyWithReload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  env?: ChunkReloadEnv,
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((err: unknown) => {
      // Resolve the env HERE, not at definition time: module evaluation must not read browser globals,
      // and tests inject their own env.
      if (recoverFromChunkLoadError(env ?? defaultChunkReloadEnv())) {
        return new Promise<never>(() => {});
      }
      throw err;
    }),
  );
}
