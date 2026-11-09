import { describe, expect, it, vi } from "vitest";
import { clearLocalCollabCopy } from "./collab-local-copy";

// cccvu/wiki-v2#781 — Discard must leave no local copy for the reload to replay.
/** A fake `indexedDB.deleteDatabase` whose request settles with the given event. */
function fakeIdb(outcome: "success" | "blocked" | "error", log: string[]) {
  return {
    deleteDatabase(name: string) {
      log.push(`delete:${name}`);
      const req: Record<string, (() => void) | null> = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => req[`on${outcome}`]?.());
      return req as unknown as IDBOpenDBRequest;
    },
  };
}

describe("clearLocalCollabCopy", () => {
  const local = (log: string[]) => ({
    name: "page.p1",
    clearData: vi.fn(async () => {
      log.push("clearData");
    }),
  });

  it("calls IndexeddbPersistence.clearData(), then waits until the database is really gone", async () => {
    const log: string[] = [];
    await clearLocalCollabCopy(local(log), fakeIdb("success", log));
    expect(log).toEqual(["clearData", "delete:page.p1"]);
  });

  it("rejects while another tab holds the database open (a reload would hang behind the delete)", async () => {
    const log: string[] = [];
    await expect(
      clearLocalCollabCopy(local(log), fakeIdb("blocked", log)),
    ).rejects.toThrow();
  });

  it("rejects on a delete error and when there is no local copy to clear", async () => {
    await expect(
      clearLocalCollabCopy(local([]), fakeIdb("error", [])),
    ).rejects.toThrow();
    await expect(
      clearLocalCollabCopy(undefined, fakeIdb("success", [])),
    ).rejects.toThrow();
  });
});
