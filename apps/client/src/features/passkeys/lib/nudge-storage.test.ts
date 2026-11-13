import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PASSKEY_NUDGE_STORAGE_KEY,
  dismissPasskeyNudge,
  isPasskeyNudgeDismissed,
} from "./nudge-storage.ts";

// #818: the nudge's "Don't ask again on this device" lives in this browser's storage, and broken storage never breaks
// a sign-in. The test owns `window.localStorage` (Node's own global can shadow jsdom's under vitest).

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
  };
}

const original = Object.getOwnPropertyDescriptor(window, "localStorage");
let store: Storage;

function useStorage(getter: () => Storage) {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get: getter,
  });
}

beforeEach(() => {
  store = memoryStorage();
  useStorage(() => store);
});
afterEach(() => {
  if (original) Object.defineProperty(window, "localStorage", original);
  else delete (window as { localStorage?: Storage }).localStorage;
});

describe("passkey nudge storage", () => {
  it("is not dismissed until dismissPasskeyNudge, then it is", () => {
    expect(isPasskeyNudgeDismissed()).toBe(false);
    dismissPasskeyNudge();
    expect(isPasskeyNudgeDismissed()).toBe(true);
    expect(store.getItem(PASSKEY_NUDGE_STORAGE_KEY)).toBe("1");
  });

  it("only the exact flag counts as dismissed", () => {
    store.setItem(PASSKEY_NUDGE_STORAGE_KEY, "0");
    expect(isPasskeyNudgeDismissed()).toBe(false);
  });

  it("unreadable storage reads as not dismissed, and a failed write does not throw", () => {
    store.getItem = () => {
      throw new Error("SecurityError");
    };
    store.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(isPasskeyNudgeDismissed()).toBe(false);
    expect(() => dismissPasskeyNudge()).not.toThrow();
  });

  it("a window whose localStorage accessor throws reads as not dismissed", () => {
    useStorage(() => {
      throw new Error("SecurityError");
    });
    expect(isPasskeyNudgeDismissed()).toBe(false);
    expect(() => dismissPasskeyNudge()).not.toThrow();
  });
});
