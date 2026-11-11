// cccvu/wiki-v2#827 — the editor's side of a page's lineage epoch: where the copy lives, what the socket claims,
// whether the copy is dirty, and how an epoch change is met (a clean copy switches, a dirty one asks first).
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@mantine/notifications", () => ({ notifications: { show: toast } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CollabAccessState, initialCollabAccess } from "./collab-access";
import {
  COLLAB_EPOCH_QUERY,
  COLLAB_EPOCH_STORAGE_PREFIX,
  COLLAB_UNSYNCED_KEY,
  CollabLocalCopy,
  collabLocalCopyName,
  deleteStaleCollabCopies,
  isCollabLocalCopyOf,
  readCollabEpoch,
  trackCollabCopy,
  useCollabEpoch,
  withCollabEpoch,
  writeCollabEpoch,
} from "./collab-epoch";

let seq = 0;
/** A page id no other test used (switched epochs are remembered per page for the life of the module). */
const freshPage = () => `p${(seq += 1)}-${Math.random().toString(36).slice(2)}`;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

afterEach(() => {
  toast.mockReset();
  vi.restoreAllMocks();
});

describe("the stored epoch", () => {
  it("is 0 when absent, unreadable or not an epoch the server writes", () => {
    for (const stored of [undefined, "", "-1", "01", "1.5", "x", "9999999999999999"]) {
      const page = freshPage();
      const storage = memoryStorage(
        stored === undefined ? {} : { [COLLAB_EPOCH_STORAGE_PREFIX + page]: stored },
      );
      expect([stored, readCollabEpoch(page, storage)]).toEqual([stored, 0]);
    }
    expect(readCollabEpoch(freshPage(), throwing)).toBe(0);
    expect(readCollabEpoch(freshPage(), null)).toBe(0);
  });

  it("reads back what was written, per page", () => {
    const storage = memoryStorage();
    const a = freshPage();
    const b = freshPage();
    writeCollabEpoch(a, 4, storage);
    expect(storage.data.get(COLLAB_EPOCH_STORAGE_PREFIX + a)).toBe("4");
    expect(readCollabEpoch(a, memoryStorage())).toBe(4); // this view's switch wins over another storage's value
    expect(readCollabEpoch(b, storage)).toBe(0);
    writeCollabEpoch(a, 0, storage);
    expect(storage.data.has(COLLAB_EPOCH_STORAGE_PREFIX + a)).toBe(false);
  });

  // A browser that cannot store it still switches (once per page view) instead of looping on the same refusal.
  it("a storage that throws never throws to the editor, and the switch still holds for this view", () => {
    const page = freshPage();
    expect(() => writeCollabEpoch(page, 2, throwing)).not.toThrow();
    expect(readCollabEpoch(page, throwing)).toBe(2);
  });
});

describe("the local copy's name and the socket URL", () => {
  it("epoch 0 keeps the pre-#827 name (existing copies stay valid); a later epoch is its own database", () => {
    expect(collabLocalCopyName("abc", 0)).toBe("page.abc");
    expect(collabLocalCopyName("abc", 3)).toBe("page.abc.e3");
  });

  it("recognizes only this page's copies", () => {
    expect(isCollabLocalCopyOf("abc", "page.abc")).toBe(true);
    expect(isCollabLocalCopyOf("abc", "page.abc.e12")).toBe(true);
    for (const name of ["page.abcd", "page.ab", "page.abc.e", "page.abc.e01", "page.abc.ex", "page.abc.e1.x", "x-page.abc"]) {
      expect([name, isCollabLocalCopyOf("abc", name)]).toEqual([name, false]);
    }
  });

  it("claims the epoch on the socket URL, keeping the path and any query", () => {
    expect(withCollabEpoch("wss://wiki.example/collab", 0)).toBe(
      `wss://wiki.example/collab?${COLLAB_EPOCH_QUERY}=0`,
    );
    expect(withCollabEpoch("ws://localhost:3000/collab?a=1", 5)).toBe(
      "ws://localhost:3000/collab?a=1&cccEpoch=5",
    );
    expect(withCollabEpoch("ws://h/collab?cccEpoch=1", 2)).toBe("ws://h/collab?cccEpoch=2");
    expect(withCollabEpoch("/collab", 1)).toBe("/collab?cccEpoch=1"); // not absolute: appended
  });

  it("the query parameter is the one the server reads (cccEpoch)", () => {
    expect(COLLAB_EPOCH_QUERY).toBe("cccEpoch");
  });
});

describe("deleteStaleCollabCopies", () => {
  const fakeIdb = (names: string[] | null) => {
    const deleted: string[] = [];
    return {
      deleted,
      deleteDatabase: (name: string) => {
        deleted.push(name);
        return {} as IDBOpenDBRequest;
      },
      ...(names === null
        ? {}
        : { databases: async () => names.map((name) => ({ name, version: 1 })) }),
    };
  };

  it("deletes this page's copies of every other epoch, never the kept one or another page's", async () => {
    const idb = fakeIdb(["page.p", "page.p.e1", "page.p.e2", "page.q", "page.p.e2x", "other"]);
    await deleteStaleCollabCopies("p", 2, [], idb);
    expect(idb.deleted.sort()).toEqual(["page.p", "page.p.e1"]);
  });

  it("without indexedDB.databases() (older browsers) it deletes the known previous copy", async () => {
    const idb = fakeIdb(null);
    await deleteStaleCollabCopies("p", 1, ["page.p", "page.q", "page.p.e1"], idb);
    expect(idb.deleted).toEqual(["page.p"]);
  });

  it("is best-effort: a listing or a delete that throws rejects nothing", async () => {
    await expect(
      deleteStaleCollabCopies("p", 1, ["page.p"], {
        databases: async () => {
          throw new Error("no");
        },
        deleteDatabase: () => {
          throw new Error("no");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

/** A y-indexeddb stand-in: its doc, and a custom store the marker lives in. */
function fakeLocal(store = new Map<string, unknown>()) {
  const doc = new Y.Doc();
  const sets: unknown[] = [];
  const local = {
    doc,
    store,
    sets,
    failGet: false,
    failSet: false,
    async get(key: string) {
      if (local.failGet) throw new Error("closed");
      return store.get(key);
    },
    async set(key: string, value: number) {
      if (local.failSet) throw new Error("quota");
      sets.push(value);
      store.set(key, value);
      return value;
    },
  };
  return local;
}

function fakeProvider() {
  const handlers = new Set<(e: { number?: number }) => void>();
  return {
    on: (_: "unsyncedChanges", fn: (e: { number?: number }) => void) => void handlers.add(fn),
    off: (_: "unsyncedChanges", fn: (e: { number?: number }) => void) => void handlers.delete(fn),
    unsynced: (number: number) => handlers.forEach((fn) => fn({ number })),
    handlers,
  };
}

describe("the dirty marker (ccc-unsynced)", () => {
  it("a local edit marks the copy dirty; the server acknowledging every frame marks it clean", async () => {
    const local = fakeLocal();
    const provider = fakeProvider();
    const copy = trackCollabCopy(local, provider);
    expect(await copy.isDirty()).toBe(false);
    local.doc.getText("t").insert(0, "typed");
    expect(await copy.isDirty()).toBe(true);
    expect(local.store.get(COLLAB_UNSYNCED_KEY)).toBe(1);
    local.doc.getText("t").insert(0, "more"); // written once per change of state, not per keystroke
    provider.unsynced(2);
    provider.unsynced(0);
    expect(await copy.isDirty()).toBe(false);
    expect(local.sets).toEqual([1, 0]);
  });

  it("the local copy's own replay and the server's updates are not local edits", async () => {
    const local = fakeLocal();
    const provider = fakeProvider();
    const copy = trackCollabCopy(local, provider);
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "from elsewhere");
    Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(remote), local); // y-indexeddb's replay origin
    Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(remote), provider); // the provider's origin
    expect(await copy.isDirty()).toBe(false);
    expect(local.sets).toEqual([]);
  });

  it("a copy left dirty by an earlier session is dirty until this session's acknowledgement", async () => {
    const store = new Map<string, unknown>([[COLLAB_UNSYNCED_KEY, 1]]);
    const local = fakeLocal(store);
    const provider = fakeProvider();
    const copy = trackCollabCopy(local, provider);
    expect(await copy.isDirty()).toBe(true);
    provider.unsynced(0);
    expect(await copy.isDirty()).toBe(false);
    expect(store.get(COLLAB_UNSYNCED_KEY)).toBe(0);
  });

  it("fails dirty: an unreadable marker, or a marker write that failed after this session's edit", async () => {
    const local = fakeLocal();
    const copy = trackCollabCopy(local, fakeProvider());
    local.failGet = true;
    expect(await copy.isDirty()).toBe(true);
    local.failGet = false;
    local.failSet = true;
    local.doc.getText("t").insert(0, "typed");
    expect(await copy.isDirty()).toBe(true);
  });

  it("destroy stops listening", async () => {
    const local = fakeLocal();
    const provider = fakeProvider();
    const copy = trackCollabCopy(local, provider);
    copy.destroy();
    expect(provider.handlers.size).toBe(0);
    local.doc.getText("t").insert(0, "after");
    expect(local.sets).toEqual([]);
  });

  it("y-indexeddb tags its replay with itself and has a custom store (the marker's assumptions)", () => {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve("y-indexeddb"));
    while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
    const src = readFileSync(join(dir, "src", "y-indexeddb.js"), "utf8");
    expect(src).toMatch(/Y\.transact\(idbPersistence\.doc, \(\) => \{[\s\S]*?\}, idbPersistence, false\)/);
    expect(src).toMatch(/\['custom'\]/);
  });
});

describe("useCollabEpoch", () => {
  const stale = (to: number): CollabAccessState => ({
    ...initialCollabAccess,
    refused: true,
    refusalKind: "compacted",
    epochChangedTo: to,
  });

  function setup(page: string, dirty: boolean | "error") {
    const controller = {
      state: initialCollabAccess,
      isCopyDirty: vi.fn(() =>
        dirty === "error" ? Promise.reject(new Error("x")) : Promise.resolve(dirty),
      ),
    };
    const ref = { current: controller };
    const beforeSwitch = vi.fn();
    const hook = renderHook(
      ({ access }: { access: CollabAccessState }) =>
        useCollabEpoch(page, access, ref, beforeSwitch),
      { initialProps: { access: initialCollabAccess } },
    );
    const refuse = (to: number) => {
      controller.state = stale(to);
      hook.rerender({ access: controller.state });
    };
    return { hook, controller, beforeSwitch, refuse };
  }

  it("starts at the stored epoch", () => {
    const page = freshPage();
    writeCollabEpoch(page, 3);
    const { hook } = setup(page, false);
    expect(hook.result.current.epoch).toBe(3);
    expect(hook.result.current.compactedTo).toBeNull();
  });

  it("a clean copy switches to the new epoch with a toast, rebuilds the providers, and deletes the old copy", async () => {
    const page = freshPage();
    const deleted: string[] = [];
    vi.stubGlobal("indexedDB", {
      deleteDatabase: (name: string) => deleted.push(name),
    });
    const { hook, beforeSwitch, refuse } = setup(page, false);
    refuse(2);
    await waitFor(() => expect(hook.result.current.epoch).toBe(2));
    expect(beforeSwitch).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(hook.result.current.compactedTo).toBeNull();
    expect(readCollabEpoch(page)).toBe(2);
    expect(window.localStorage.getItem(COLLAB_EPOCH_STORAGE_PREFIX + page)).toBe("2");
    await waitFor(() => expect(deleted).toEqual([`page.${page}`]));
    vi.unstubAllGlobals();
  });

  it.each([
    ["dirty", true],
    ["unreadable", "error"],
  ] as const)("a %s copy stays on its epoch, read-only, and asks (the compacted notice)", async (_, dirty) => {
    const page = freshPage();
    const { hook, beforeSwitch, refuse } = setup(page, dirty);
    refuse(5);
    await waitFor(() => expect(hook.result.current.compactedTo).toBe(5));
    expect(hook.result.current.epoch).toBe(0);
    expect(beforeSwitch).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(readCollabEpoch(page)).toBe(0);
    // the notice's Discard (after it cleared the old copy) opens the current version
    act(() => hook.result.current.openCurrentVersion());
    expect(hook.result.current.epoch).toBe(5);
    expect(hook.result.current.compactedTo).toBeNull();
    expect(beforeSwitch).toHaveBeenCalledTimes(1);
    expect(readCollabEpoch(page)).toBe(5);
  });

  it("does nothing without an epoch change, and openCurrentVersion does nothing before one", async () => {
    const { hook, controller, beforeSwitch } = setup(freshPage(), false);
    act(() => hook.result.current.openCurrentVersion());
    await Promise.resolve();
    expect(controller.isCopyDirty).not.toHaveBeenCalled();
    expect(beforeSwitch).not.toHaveBeenCalled();
    expect(hook.result.current.epoch).toBe(0);
  });

  it("an answer that arrives after unmount changes nothing", async () => {
    const page = freshPage();
    let resolve!: (dirty: boolean) => void;
    const { hook, controller, beforeSwitch, refuse } = setup(page, false);
    controller.isCopyDirty.mockImplementation(() => new Promise((r) => (resolve = r)));
    refuse(2);
    hook.unmount();
    resolve(false);
    await Promise.resolve();
    expect(beforeSwitch).not.toHaveBeenCalled();
    expect(readCollabEpoch(page)).toBe(0);
  });
});
