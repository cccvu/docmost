// The ledger-echo incident (#781 lineage) — after a refusal the page header must not say "Real-time editor connection
// lost. Retrying..." (nothing retries; the refusal notice says what happened).
//
// The REAL @hocuspocus/provider 4.7.1 runs over the scripted socket, with the collab access controller, and its
// `onStatus`/`onSynced` callbacks feed a model of the three page-editor.tsx pieces that touch the header (seam 169;
// collab-access.test.ts pins that page-editor holds exactly these lines):
//   - `onStatus` writes the provider's status to the atom;
//   - the 7.5 s check: still connecting, or not synced → `collabHeaderStatus(Disconnected, refused)`;
//   - the refusal effect: `collabHeaderStatus(status, refused)` whenever either changes;
// and of ConnectionWarning (page-header-menu.tsx): "Retrying..." once the atom has read disconnected or connecting for
// 5 s. Effects re-run when their dependencies change, as React runs them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from "@hocuspocus/provider";
import { createCollabAccessController } from "./collab-access-controller";
import { COLLAB_HEADER_QUIET, collabHeaderStatus } from "./collab-header-status";
import {
  installedProviderVersion,
  ScriptedSocket,
  serverFrames,
} from "./collab-scripted-socket.testkit";

const DOC = "page.p1";
const TOKEN = `e30.${btoa(JSON.stringify({ exp: 4_000_000_000 })).replace(/=+$/, "")}.sig`;

/** What page-editor runs: `full` (this change), `guard` (only the 7.5 s check gated), `upstream` (neither). */
type Wiring = "full" | "guard" | "upstream";

const live: { socket: HocuspocusProviderWebsocket; remote: HocuspocusProvider }[] = [];

function pageHeader(wiring: Wiring) {
  const h = {
    status: "",
    remoteSynced: false,
    refused: false,
    retrying: false,
    syncedEvents: [] as boolean[],
  };
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let warningTimer: ReturnType<typeof setTimeout> | undefined;

  // ConnectionWarning
  const warning = () => {
    if (["disconnected", "connecting"].includes(h.status)) {
      warningTimer ??= setTimeout(() => (h.retrying = true), 5000);
    } else {
      clearTimeout(warningTimer);
      warningTimer = undefined;
      h.retrying = false;
    }
  };
  const setStatus = (next: string) => {
    if (next === h.status) return; // a jotai atom set to the same value re-renders nothing
    h.status = next;
    warning();
    effects();
  };
  const effects = () => {
    // the 7.5 s check, re-armed on [status, isSynced, refused]
    clearTimeout(checkTimer);
    const status = h.status;
    const isSynced = h.remoteSynced; // the local (IndexedDB) sync is immediate here
    const refused = h.refused;
    checkTimer = setTimeout(() => {
      if (status === WebSocketStatus.Connecting || !isSynced) {
        setStatus(
          wiring === "upstream"
            ? WebSocketStatus.Disconnected
            : collabHeaderStatus(WebSocketStatus.Disconnected, refused),
        );
      }
    }, 7500);
    // the refusal effect, on [status, refused]
    if (wiring === "full") {
      const next = collabHeaderStatus(h.status, h.refused);
      if (next !== h.status) setStatus(next);
    }
  };

  const socket = new HocuspocusProviderWebsocket({
    url: "ws://collab.test/collab",
    WebSocketPolyfill: ScriptedSocket,
  });
  const access = createCollabAccessController({
    socket,
    initialToken: TOKEN,
    refetchToken: async () => ({ isSuccess: true, data: { token: TOKEN } }),
    onState: (state) => {
      if (state.refused !== h.refused) {
        h.refused = state.refused;
        effects();
      }
    },
    markDisconnected: () => setStatus(WebSocketStatus.Disconnected),
    random: () => 1,
    network: null,
  });
  const remote = new HocuspocusProvider({
    websocketProvider: socket,
    name: DOC,
    document: new Y.Doc(),
    token: TOKEN,
    onStatus: ({ status }) => setStatus(status),
    onSynced: ({ state }) => {
      h.syncedEvents.push(state);
      if (state !== h.remoteSynced) {
        h.remoteSynced = state;
        effects();
      }
    },
  });
  access.bind(remote);
  remote.attach();
  effects(); // mount
  live.push({ socket, remote });
  return { h, access };
}

const last = () => ScriptedSocket.instances[ScriptedSocket.instances.length - 1];
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Open the socket, authenticate, and (optionally) complete the first sync. */
async function connect(sync: boolean) {
  const s = last();
  s.open();
  await flush();
  s.receive(serverFrames.authenticated(DOC));
  if (sync) {
    const serverDoc = new Y.Doc();
    s.receive(serverFrames.syncStep1(DOC, serverDoc));
    s.receive(serverFrames.syncStep2(DOC, serverDoc));
  }
  await flush();
  return s;
}

const REFUSED_ROOT = "ccc:collab-update-refused:root";
const refusals: [string, (s: ScriptedSocket) => void][] = [
  ["a document CLOSE (root)", (s) => s.receive(serverFrames.close(DOC, REFUSED_ROOT))],
  ["a raw 1009 socket close", (s) => s.serverClose(1009)],
  ["a raw 4422 socket close with the refused reason", (s) => s.serverClose(4422, "ccc:collab-update-refused:schema")],
];

beforeEach(() => {
  vi.useFakeTimers();
  ScriptedSocket.reset();
});

afterEach(() => {
  for (const { socket, remote } of live.splice(0)) {
    remote.destroy();
    socket.destroy();
  }
  vi.useRealTimers();
});

describe("collabHeaderStatus", () => {
  it("passes every status through until a refusal, then reads quiet (the atom's initial value)", () => {
    for (const status of ["", "connecting", "connected", "disconnected"]) {
      expect(collabHeaderStatus(status, false)).toBe(status);
      expect(collabHeaderStatus(status, true)).toBe(COLLAB_HEADER_QUIET);
    }
    expect(COLLAB_HEADER_QUIET).toBe("");
  });
});

describe("the header after a refusal, through the real 4.7.1 provider", () => {
  it("runs @hocuspocus/provider 4.7.1", () => {
    expect(installedProviderVersion()).toBe("4.7.1");
  });

  // Before the first sync (the incident: the IndexedDB echo is sent on connect, ahead of the sync) and after it.
  describe.each([
    ["before the first sync", false],
    ["after the first sync", true],
  ])("%s", (_label, sync) => {
    it.each(refusals)("%s: the header never says Retrying, and reads quiet", async (_name, refuse) => {
      const { h, access } = pageHeader("full");
      const s = await connect(sync);
      expect(h.remoteSynced).toBe(sync);
      refuse(s);
      await flush();
      expect(access.state.refused).toBe(true);
      await vi.advanceTimersByTimeAsync(13_000);
      expect(h.retrying).toBe(false);
      expect(["disconnected", "connecting"]).not.toContain(h.status);
      expect(h.status).toBe(COLLAB_HEADER_QUIET);
      expect(ScriptedSocket.instances).toHaveLength(1); // nothing retried, as the header now says
    });
  });

  // Anti-vacuity: each half of the wiring is needed. Upstream's wiring said "Retrying..." for each of these, and
  // gating only the 7.5 s check still says it after a raw close: the socket marks itself disconnected and the still
  // attached provider forwards that status before the controller sees the close and detaches.
  it.each([
    ["upstream", "a document CLOSE (root)", false],
    ["upstream", "a raw 1009 socket close", true],
    ["guard", "a raw 1009 socket close", true],
    ["guard", "a raw 4422 socket close with the refused reason", true],
  ] as const)("%s wiring, %s (synced: %s) says Retrying", async (wiring, name, sync) => {
    const refuse = refusals.find(([n]) => n === name)![1];
    const { h, access } = pageHeader(wiring);
    const s = await connect(sync);
    refuse(s);
    await flush();
    expect(access.state.refused).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(h.retrying).toBe(true);
  });

  // Why a document CLOSE after the first sync never needed the fix: 4.7.1 emits `synced` only when it becomes true
  // (`onClose` sets it false silently), and the controller detaches before closing the socket, so the header keeps
  // reading connected.
  it("a document CLOSE after the first sync leaves the header connected even with upstream's wiring", async () => {
    const { h, access } = pageHeader("upstream");
    const s = await connect(true);
    s.receive(serverFrames.close(DOC, REFUSED_ROOT));
    await flush();
    expect(access.state.refused).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(h.syncedEvents).toEqual([true]); // never a `synced: false`
    expect(h.status).toBe(WebSocketStatus.Connected);
    expect(h.retrying).toBe(false);
  });

  // #842: an `unresolved` close is retried up to 6 times. While it retries, "Retrying..." is true; once the budget is
  // spent it is a refusal, and the header goes quiet like any other.
  it("unresolved: once its retries run out the header reads quiet and never says Retrying again", async () => {
    const { h, access } = pageHeader("full");
    let s = await connect(true);
    for (let i = 0; i < 6; i += 1) {
      s.receive(serverFrames.close(DOC, "ccc:collab-update-unresolved"));
      await vi.advanceTimersByTimeAsync(8_000); // the longest wait (random 1)
      expect(access.state.refused).toBe(false);
      s = await connect(false);
    }
    expect(ScriptedSocket.instances).toHaveLength(7);
    s.receive(serverFrames.close(DOC, "ccc:collab-update-unresolved"));
    await flush();
    expect(access.state.refused).toBe(true);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(h.retrying).toBe(false);
    expect(h.status).toBe(COLLAB_HEADER_QUIET);
    expect(ScriptedSocket.instances).toHaveLength(7); // nothing retries, as the header now says
  });

  // Control: the fix changes nothing before a refusal. A connection that never syncs still reads disconnected.
  it("without a refusal, the 7.5 s check still marks an unsynced editor disconnected (and Retrying)", async () => {
    const { h, access } = pageHeader("full");
    await connect(false);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(access.state.refused).toBe(false);
    expect(h.status).toBe(WebSocketStatus.Disconnected);
    expect(h.retrying).toBe(true);
  });
});
