import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ANNOUNCEMENT_DISMISSED_KEY,
  readDismissedVersion,
  storeDismissedVersion,
} from "./announcement-storage";

// wiki-v2 #939 — the per-version dismissal. NOT upstream Docmost code.

const mem = new Map<string, string>();
const memStorage = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  get length() {
    return mem.size;
  },
} as Storage;

beforeEach(() => {
  mem.clear();
  vi.stubGlobal("localStorage", memStorage);
});
afterEach(() => vi.unstubAllGlobals());

describe("announcement dismissal storage", () => {
  it("reads null when nothing is stored", () => {
    expect(readDismissedVersion()).toBeNull();
  });

  it("round-trips a version", () => {
    storeDismissedVersion(7);
    expect(mem.get(ANNOUNCEMENT_DISMISSED_KEY)).toBe('{"version":7}');
    expect(readDismissedVersion()).toBe(7);
  });

  it.each([["garbage"], ['"7"'], ['{"version":"7"}'], ["{}"], ["null"]])(
    "reads a malformed value (%s) as not dismissed",
    (raw) => {
      mem.set(ANNOUNCEMENT_DISMISSED_KEY, raw);
      expect(readDismissedVersion()).toBeNull();
    },
  );

  it("never throws when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readDismissedVersion()).toBeNull();
    expect(() => storeDismissedVersion(1)).not.toThrow();
  });
});
