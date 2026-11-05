import { createLowlight } from "lowlight";

/**
 * CCC (issue #407): the editor's lowlight instance, created EMPTY so no highlight.js grammar is on the
 * eager graph (~40 KB br every page view paid for, code block or not). `loadCodeGrammars()` fetches
 * them as one lazy chunk; `CodeHighlightLoader` then asks each mounted editor to re-decorate.
 *
 * Until then code renders as plain text: an explicit language misses the registry and auto-detect over
 * an empty registry returns an empty tree, so no decoration and no throw.
 */
export const lowlight = createLowlight();

let pending: Promise<void> | null = null;
let loaded = false;
// Cached so useSyncExternalStore sees one stable snapshot; recomputed only when the registry changes.
let languages: string[] = [];
const listeners = new Set<() => void>();

/**
 * Register the grammars once (memoized). On failure the memo is reset so the next editor mount retries,
 * and code stays plain meanwhile. Deliberately no reload-on-chunk-error (unlike lazy-with-reload.ts):
 * highlighting is cosmetic, and reloading a page someone may be typing in is not.
 */
export function loadCodeGrammars(): Promise<void> {
  if (!pending) {
    pending = import("./grammars")
      .then(({ registerCodeGrammars }) => {
        registerCodeGrammars(lowlight);
        languages = lowlight.listLanguages().sort();
        loaded = true;
        listeners.forEach((listener) => listener());
      })
      .catch((err) => {
        pending = null;
        console.error(
          "[ccc] code highlighting grammars failed to load (#407)",
          err,
        );
        throw err;
      });
  }
  return pending;
}

export function isCodeGrammarsLoaded(): boolean {
  return loaded;
}

/** Sorted registered language names; the same array instance until the next registration. */
export function getCodeLanguages(): string[] {
  return languages;
}

export function subscribeCodeLanguages(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
