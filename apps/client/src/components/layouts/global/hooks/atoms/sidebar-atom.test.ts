import { describe, it, expect, beforeEach } from "vitest";
import { createStore } from "jotai";

// This vitest/node env does not expose a `localStorage` global, and the atom module reads it
// at import time (via atomWithWebStorage). Install a minimal in-memory shim BEFORE importing
// the module under test, then dynamic-import it so the read resolves against the shim.
if (!(globalThis as unknown as { localStorage?: Storage }).localStorage) {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const { clampSidebarWidth, sidebarWidthAtom } = await import("./sidebar-atom");
const {
  SIDEBAR_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
} = await import("@/features/layout/layout-tokens.ts");

describe("clampSidebarWidth", () => {
  it("clamps a too-small value up to the minimum", () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 40)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("clamps a too-large value down to the maximum", () => {
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 500)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("keeps an in-range value, rounded to a whole pixel", () => {
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampSidebarWidth(320.7)).toBe(321);
  });

  it("coerces a numeric string (localStorage rehydrate returns the raw string)", () => {
    expect(clampSidebarWidth("340")).toBe(340);
  });

  it("falls back to the default for a non-finite or garbage value", () => {
    expect(clampSidebarWidth("not-a-number")).toBe(SIDEBAR_WIDTH);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH);
    expect(clampSidebarWidth(null)).toBe(SIDEBAR_WIDTH);
    expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH);
  });
});

describe("sidebarWidthAtom", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reads the default width when nothing is persisted", () => {
    const store = createStore();
    expect(store.get(sidebarWidthAtom)).toBe(SIDEBAR_WIDTH);
  });

  it("clamps and persists on write, and reads back the clamped value", () => {
    const store = createStore();
    store.set(sidebarWidthAtom, SIDEBAR_MAX_WIDTH + 999);
    expect(store.get(sidebarWidthAtom)).toBe(SIDEBAR_MAX_WIDTH);
    // Persisted under the SAME key the standalone console reads (cross-app persistence).
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(
      String(SIDEBAR_MAX_WIDTH),
    );
  });

  it("persists an in-range width verbatim", () => {
    const store = createStore();
    store.set(sidebarWidthAtom, 400);
    expect(store.get(sidebarWidthAtom)).toBe(400);
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("400");
  });
});
