// cccvu/wiki-v2#847 — the browser's broken-copy detector (collab-copy-health.ts) on real Y.Docs, no IndexedDB: the
// y-indexeddb replay is played by a stand-in with the same origin and `synced` behaviour (y-indexeddb 9.0.12
// `fetchUpdates`: one `Y.transact(doc, …, persistence, false)`, then `synced = true` synchronously on success).
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import {
  type CollabCopyBreak,
  watchCollabCopyHealth,
} from "./collab-copy-health";
import { isWedged as wedged, wedgeWithKeyedSplit } from "./collab-copy-health.testkit";

/** Bytes yjs throws on: a struct count with no structs behind it. */
const MALFORMED = Uint8Array.from([5, 1, 7, 0, 9]);

/** Let every queued microtask (and the ones they queue) run. */
async function drain(rounds = 20) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function watched(local: { doc: Y.Doc; synced?: boolean }) {
  const reports: CollabCopyBreak[] = [];
  const stop = watchCollabCopyHealth(local, (why) => reports.push(why));
  stops.push(stop);
  return { reports, stop };
}
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
});

describe("wedged: a transaction cleanup that threw (bug M2)", () => {
  it("is reported once, at the next microtask, never synchronously", async () => {
    const doc = new Y.Doc();
    const { reports } = watched({ doc });
    const thrown = wedgeWithKeyedSplit(doc);
    expect(String(thrown)).toMatch(/Unexpected case/);
    expect(wedged(doc)).toBe(true); // precondition: the document really is wedged
    expect(reports).toEqual([]);
    await Promise.resolve();
    expect(reports).toEqual(["wedged"]);
    // a wedged document never emits another batch; an edit now reports nothing more
    doc.getText("t").insert(0, "after");
    await drain();
    expect(reports).toEqual(["wedged"]);
  });

  it("emits no update after the wedge (what the detector is for)", () => {
    const doc = new Y.Doc();
    wedgeWithKeyedSplit(doc);
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    doc.getText("t").insert(0, "lost");
    expect(updates).toEqual([]);
  });
});

describe("replay: y-indexeddb's replay of the stored copy", () => {
  it("a replay that throws (synced stays false) is reported once", async () => {
    const doc = new Y.Doc();
    const local = { doc, synced: false };
    const { reports } = watched(local);
    expect(() =>
      Y.transact(doc, () => Y.applyUpdate(doc, MALFORMED), local, false),
    ).toThrow();
    expect(wedged(doc)).toBe(false); // not a wedge: only the replay failed
    expect(reports).toEqual([]);
    await drain();
    expect(reports).toEqual(["replay"]);
  });

  it("a replay that succeeds (synced set right after) reports nothing", async () => {
    const doc = new Y.Doc();
    const stored = new Y.Doc();
    stored.getText("t").insert(0, "stored");
    const local = { doc, synced: false };
    const { reports } = watched(local);
    Y.transact(
      doc,
      () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(stored)),
      local,
      false,
    );
    local.synced = true; // y-indexeddb's afterApplyUpdatesCallback, synchronously
    await drain();
    expect(doc.getText("t").toString()).toBe("stored");
    expect(reports).toEqual([]);
  });

  it("a throw during a trim-time replay (synced already true) is not reported unless it wedges (the residual)", async () => {
    const doc = new Y.Doc();
    const local = { doc, synced: true };
    const { reports } = watched(local);
    expect(() =>
      Y.transact(doc, () => Y.applyUpdate(doc, MALFORMED), local, false),
    ).toThrow();
    await drain();
    expect(reports).toEqual([]);
  });

  it("a failed transaction from any other origin is not a replay", async () => {
    const doc = new Y.Doc();
    const local = { doc, synced: false };
    const { reports } = watched(local);
    expect(() =>
      Y.transact(doc, () => Y.applyUpdate(doc, MALFORMED), "provider", false),
    ).toThrow();
    await drain();
    expect(reports).toEqual([]);
  });

  it("a copy that does not say whether it synced (no `synced` field) is never a replay failure", async () => {
    const doc = new Y.Doc();
    const local = { doc };
    const { reports } = watched(local);
    expect(() =>
      Y.transact(doc, () => Y.applyUpdate(doc, MALFORMED), local, false),
    ).toThrow();
    await drain();
    expect(reports).toEqual([]);
  });
});

describe("honest editing reports nothing", () => {
  it("edits, nested and observer transactions, a new batch from afterAllTransactions, undo/redo, remote updates and a replay", async () => {
    const doc = new Y.Doc();
    const local = { doc, synced: false };
    const { reports } = watched(local);

    // a successful replay first, as on every page open
    const stored = new Y.Doc();
    stored.getXmlFragment("default").insert(0, [new Y.XmlElement("paragraph")]);
    Y.transact(
      doc,
      () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(stored)),
      local,
      false,
    );
    local.synced = true;
    await drain();

    const fragment = doc.getXmlFragment("default");
    const text = doc.getText("t");
    const undo = new Y.UndoManager([fragment, text], {
      trackedOrigins: new Set([null, "editor"]),
      captureTimeout: 0,
    });
    // an observer that transacts (as a binding does), once
    let echoed = false;
    text.observe(() => {
      if (echoed) return;
      echoed = true;
      doc.getMap("meta").set("touched", true);
    });
    // an afterAllTransactions listener that starts a new batch, once
    let restarted = false;
    doc.on("afterAllTransactions", () => {
      if (restarted) return;
      restarted = true;
      doc.getMap("meta").set("restarted", true);
    });

    // a second editor, synced both ways (its updates arrive with the provider's origin)
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "peer-sync") Y.applyUpdate(doc, u, "provider");
    });
    doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "provider") Y.applyUpdate(peer, u, "peer-sync");
    });

    for (let i = 0; i < 30; i++) {
      Y.transact(
        doc,
        () => {
          const p = new Y.XmlElement("paragraph");
          const t = new Y.XmlText();
          t.insert(0, `line ${i}`);
          p.insert(0, [t]);
          fragment.insert(fragment.length, [p]);
          Y.transact(doc, () => text.insert(text.length, `${i}`)); // nested
          if (i % 3 === 0) fragment.delete(0, 1);
          if (i % 4 === 0) text.delete(0, 1);
        },
        "editor",
      );
      if (i % 5 === 0) undo.undo();
      if (i % 7 === 0) undo.redo();
      peer.getText("t").insert(0, `peer ${i} `);
      const remote = peer.getXmlFragment("default");
      if (i % 6 === 0 && remote.length > 0) remote.delete(0, 1);
      await drain(3);
    }
    await drain();

    expect(echoed).toBe(true);
    expect(restarted).toBe(true);
    expect(wedged(doc)).toBe(false);
    expect(reports).toEqual([]);
  });
});

describe("unsubscribe", () => {
  it("the returned function stops reporting, even for a batch already in flight", async () => {
    const doc = new Y.Doc();
    const { reports, stop } = watched({ doc });
    wedgeWithKeyedSplit(doc);
    stop();
    await drain();
    expect(reports).toEqual([]);
  });

  it("removes every listener it added", () => {
    const doc = new Y.Doc();
    const observers = (doc as unknown as { _observers: Map<string, Set<unknown>> })
      ._observers;
    const count = () =>
      ["beforeAllTransactions", "afterAllTransactions", "beforeTransaction"].map(
        (e) => observers.get(e)?.size ?? 0,
      );
    const before = count();
    const stop = watchCollabCopyHealth({ doc }, () => undefined);
    expect(count()).toEqual(before.map((n) => n + 1));
    stop();
    expect(count()).toEqual(before);
  });

  it("reports once, then removes its listeners", async () => {
    const doc = new Y.Doc();
    const local = { doc, synced: false };
    const { reports } = watched(local);
    expect(() =>
      Y.transact(doc, () => Y.applyUpdate(doc, MALFORMED), local, false),
    ).toThrow();
    await drain();
    expect(() =>
      Y.transact(doc, () => Y.applyUpdate(doc, MALFORMED), local, false),
    ).toThrow();
    await drain();
    expect(reports).toEqual(["replay"]);
    const observers = (doc as unknown as { _observers: Map<string, Set<unknown>> })
      ._observers;
    expect(observers.get("beforeAllTransactions")?.size ?? 0).toBe(0);
  });
});

/**
 * The real y-indexeddb (not the stand-in above), over a minimal IndexedDB that answers each request as a macrotask, as
 * the browser does. These pin the two library behaviours the `replay` arm rests on: the replay transaction's origin is
 * the persistence object, and `synced = true` is set synchronously after it. If a y-indexeddb bump set `synced` later
 * (after an `await`), every honest page open would be refused `client:local-copy`; the first test goes red instead.
 */
describe("replay: the real y-indexeddb 9.0.12 (#847 bump tripwire)", () => {
  const RE_VALIDATE =
    "y-indexeddb changed: re-validate collab-copy-health.ts's `replay` arm (the replay's origin, and `synced` set " +
    "synchronously after it) against the new source, then update this pin (ADR 0036 #847 amendment, upgrade procedure).";

  type Range = { lower?: number; lowerOpen?: boolean; upper?: number; upperOpen?: boolean } | null | undefined;
  type Request = { result?: unknown; onsuccess?: (e: { target: Request }) => void; onerror?: unknown };

  /** Only what y-indexeddb 9.0.12 calls through lib0/indexeddb on open: open, getAll, add, a key cursor, count. */
  function fakeIndexedDb(stored: Uint8Array[]) {
    const records = new Map<number, unknown>();
    let next = 0;
    for (const update of stored) records.set(++next, update);
    const inRange = (key: number, range: Range) =>
      !range ||
      ((range.lower === undefined || (range.lowerOpen ? key > range.lower : key >= range.lower)) &&
        (range.upper === undefined || (range.upperOpen ? key < range.upper : key <= range.upper)));
    const keys = (range: Range) => [...records.keys()].filter((k) => inRange(k, range)).sort((a, b) => a - b);
    const answer = (result: () => unknown): Request => {
      const request: Request = {};
      setTimeout(() => {
        request.result = result();
        request.onsuccess?.({ target: request });
      }, 0);
      return request;
    };
    const store = {
      add: (value: unknown) => answer(() => (records.set(++next, value), next)),
      getAll: (range: Range) => answer(() => keys(range).map((k) => records.get(k))),
      count: (range: Range) => answer(() => keys(range).length),
      openKeyCursor: (range: Range, direction: string) => {
        const order = direction === "prev" ? keys(range).reverse() : keys(range);
        const request: Request = {};
        let i = 0;
        const step = () =>
          setTimeout(() => {
            const key = order[i++];
            request.result = key === undefined ? null : { key, continue: step };
            request.onsuccess?.({ target: request });
          }, 0);
        step();
        return request;
      },
    };
    const db = { transaction: () => ({ objectStore: () => store }), createObjectStore: () => store, close: () => {} };
    return {
      indexedDB: {
        open: () => {
          const request: Request & { onupgradeneeded?: (e: { target: { result: unknown } }) => void } = {};
          setTimeout(() => {
            request.onupgradeneeded?.({ target: { result: db } });
            request.result = db;
            request.onsuccess?.({ target: request });
          }, 0);
          return request;
        },
      },
      IDBKeyRange: {
        lowerBound: (lower: number, lowerOpen = false) => ({ lower, lowerOpen }),
        upperBound: (upper: number, upperOpen = false) => ({ upper, upperOpen }),
      },
    };
  }

  function open(stored: Uint8Array[]) {
    const fake = fakeIndexedDb(stored);
    vi.stubGlobal("indexedDB", fake.indexedDB);
    vi.stubGlobal("IDBKeyRange", fake.IDBKeyRange);
    const doc = new Y.Doc();
    const local = new IndexeddbPersistence(`ccc-847-${Math.random()}`, doc);
    const { reports } = watched(local); // bound right after construction, as the controller does
    return { doc, local, reports };
  }

  /** Until `done()` or 2 s (real macrotasks: the fake answers each request with a timer). */
  async function until(done: () => boolean) {
    for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the version these behaviours were read from", () => {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve("y-indexeddb"));
    while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
    if (version !== "9.0.12") throw new Error(`${RE_VALIDATE}\n(installed y-indexeddb ${version})`);
  });

  it("an honest stored copy replays and reports nothing (synced is set synchronously after the replay)", async () => {
    const stored = new Y.Doc();
    stored.getText("t").insert(0, "stored");
    const { doc, local, reports } = open([Y.encodeStateAsUpdate(stored)]);
    let replays = 0;
    doc.on("beforeTransaction", (tr: Y.Transaction) => {
      if (tr.origin === local) replays++;
    });
    await local.whenSynced;
    await drain();
    expect(replays).toBe(1); // anti-vacuity: the replay really ran, under the persistence object's origin
    expect(doc.getText("t").toString()).toBe("stored");
    expect(local.synced).toBe(true);
    expect(reports).toEqual([]);
    local.destroy();
  });

  it("a stored copy whose replay throws is reported as a broken replay", async () => {
    // y-indexeddb never catches the replay's throw, so the open rejects unhandled (in the browser too). Take it here,
    // so the runner does not fail the file on an error this test expects.
    const rejections: unknown[] = [];
    const runner = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", (reason) => rejections.push(reason));
    try {
      const { local, reports } = open([MALFORMED]);
      await until(() => reports.length > 0 && rejections.length > 0);
      expect(rejections).toHaveLength(1);
      expect(local.synced).toBe(false);
      expect(reports).toEqual(["replay"]);
      local.destroy();
    } finally {
      process.removeAllListeners("unhandledRejection");
      for (const listener of runner) process.on("unhandledRejection", listener);
    }
  });
});
