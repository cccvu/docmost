// cccvu/wiki-v2#810 — the collab access controller driven through the REAL @hocuspocus/provider 4.7.1
// (HocuspocusProvider + HocuspocusProviderWebsocket, the options page-editor.tsx uses) over a scripted WebSocket,
// under fake timers. The pure rules are in collab-access.test.ts; this file pins what reaches the wire and when.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from "@hocuspocus/provider";
import {
  COLLAB_LOST_RETRY_MS,
  COLLAB_TRY_LATER_BASE_MS,
  collabAllowsEditing,
  collabRetryDelay,
} from "./collab-access";
import { createCollabAccessController } from "./collab-access-controller";
import { reopensOnVisible } from "./collab-reconnect";
import {
  applyClientSync,
  installedProviderVersion,
  ScriptedSocket,
  sentToken,
  serverFrames,
} from "./collab-scripted-socket.testkit";

const DOC = "page.p1";
/** An unsigned JWT that expires far in the future (jwt-decode only decodes). */
const jwt = (exp: number) =>
  `e30.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.sig`;
const TOKEN = jwt(4_000_000_000);
const FRESH = jwt(4_000_000_001); // what a refetch returns (readable: an unreadable token counts as expired)

type RefetchResult = { isSuccess: boolean; data?: { token?: string } };

const live: {
  socket: HocuspocusProviderWebsocket;
  remote: HocuspocusProvider;
}[] = [];

function setup(
  options: {
    refetch?: () => Promise<RefetchResult>;
    random?: () => number;
  } = {},
) {
  const socket = new HocuspocusProviderWebsocket({
    url: "ws://collab.test/collab",
    WebSocketPolyfill: ScriptedSocket,
  });
  const ydoc = new Y.Doc();
  const markDisconnected = vi.fn();
  const refetchToken = vi.fn(
    options.refetch ??
      (async (): Promise<RefetchResult> => ({
        isSuccess: true,
        data: { token: FRESH },
      })),
  );
  const access = createCollabAccessController({
    socket,
    initialToken: TOKEN,
    refetchToken,
    onState: () => {},
    markDisconnected,
    random: options.random ?? (() => 1),
  });
  const remote = new HocuspocusProvider({
    websocketProvider: socket,
    name: DOC,
    document: ydoc,
    token: TOKEN,
  });
  access.bind(remote);
  remote.attach();
  live.push({ socket, remote });
  return { socket, remote, ydoc, access, markDisconnected, refetchToken };
}

const sockets = () => ScriptedSocket.instances;
const last = () => sockets()[sockets().length - 1];
const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** Open the newest socket and let the client send its Auth and SyncStep1. */
async function openLatest() {
  last().open();
  await flush();
  return last();
}

beforeEach(() => {
  vi.useFakeTimers();
  ScriptedSocket.reset();
});

afterEach(() => {
  for (const { socket, remote } of live.splice(0)) {
    remote.destroy();
    socket.destroy();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the provider under test", () => {
  it("is @hocuspocus/provider 4.7.1 (a stale install must not pass these tests)", () => {
    expect(installedProviderVersion()).toBe("4.7.1");
  });

  it("is built by page-editor.tsx with only a url, so these tests run the production defaults", () => {
    const source = readFileSync(
      join(__dirname, "..", "editor", "page-editor.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /new HocuspocusProviderWebsocket\(\{\s*url: collaborationURL,\s*\}\)/,
    );
  });

  // Why the visibility effect must not call connect() while the provider retries: connect() dials at once.
  it("dials at once on an explicit connect() during its backoff (the semantics the visibility gate protects)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    ScriptedSocket.onConstruct = (s) =>
      setTimeout(() => s.failBeforeOpen(), 10);
    const { socket } = setup();
    await advance(10); // the first upgrade is refused; the next try waits the backoff
    expect(sockets()).toHaveLength(1);
    void socket.connect();
    expect(sockets()).toHaveLength(2); // no wait at all
  });
});

describe("reconnect pace (#810, final live check L2-2)", () => {
  // The bug: page-editor's visibility effect ran on EVERY status render (an unstable resetIdle in its deps) and called
  // connect() while the tab was visible and the status read disconnected, so a refused upgrade was retried at the
  // round trip's pace: 42 attempts in 15 s. Here the effect's decision runs on every status event (the worst case).
  function stormingVisibilityEffect(socket: HocuspocusProviderWebsocket) {
    socket.on("status", ({ status }: { status: WebSocketStatus }) => {
      if (reopensOnVisible("visible", status, socket)) void socket.connect();
    });
  }

  it("a refused upgrade is retried only on the provider's backoff, 1, 2, 4, 8 s apart (4 attempts in 15 s; the per-render reconnect made ~300 here, 42 live)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999); // the longest jittered waits
    ScriptedSocket.onConstruct = (s) =>
      setTimeout(() => s.failBeforeOpen(), 50);
    const { socket } = setup();
    stormingVisibilityEffect(socket);
    const at: number[] = [];
    let seen = 0;
    for (let t = 0; t <= 15_050; t += 50) {
      while (seen < sockets().length) {
        at.push(t);
        seen += 1;
      }
      await advance(50);
    }
    expect(at).toEqual(
      [0, 1_050, 3_100, 7_150, 15_200].filter((t) => t <= 15_050),
    );
    expect(sockets().length).toBeLessThanOrEqual(5);
  });

  it("whatever the jitter, two attempts are never less than 1 s apart", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // the shortest jittered waits
    ScriptedSocket.onConstruct = (s) =>
      setTimeout(() => s.failBeforeOpen(), 50);
    const { socket } = setup();
    stormingVisibilityEffect(socket);
    await advance(15_000);
    expect(sockets().length).toBeLessThanOrEqual(15);
    expect(sockets().length).toBeGreaterThanOrEqual(10); // and it does keep trying
  });
});

describe("an editor cut off before authentication (#810, review R5-N4)", () => {
  it("reconnects on the provider's backoff, re-authenticates, syncs the server's content and sends its own edit", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    const { remote, ydoc, access } = setup();
    const first = await openLatest();
    expect(sentToken(first)).toBe(TOKEN);
    // the server's pre-auth deadline (or byte bound) cuts it with no message
    first.serverClose(1006);
    await flush();
    ydoc.getText("t").insert(0, "offline edit "); // typed during the outage
    await advance(999);
    expect(sockets()).toHaveLength(1);
    await advance(1);
    expect(sockets()).toHaveLength(2);

    const serverDoc = new Y.Doc();
    serverDoc.getText("t").insert(0, "server content");
    const second = await openLatest();
    expect(sentToken(second)).toBe(TOKEN);
    const synced = vi.fn();
    remote.on("synced", synced);
    second.receive(serverFrames.authenticated(DOC));
    second.receive(serverFrames.syncStep1(DOC, serverDoc));
    second.receive(serverFrames.syncStep2(DOC, serverDoc));
    await flush();

    expect(synced).toHaveBeenCalled();
    expect(ydoc.getText("t").toString()).toContain("server content");
    applyClientSync(second, serverDoc);
    expect(serverDoc.getText("t").toString()).toContain("offline edit");
    expect(collabAllowsEditing(access.state)).toBe(true);
    expect(access.state.tryLaterAttempts).toBe(0);
  });
});

describe("try later (#810, F2, T2)", () => {
  it.each([
    [1, 5_000],
    [0, 2_500],
  ])(
    "an auth-rate refusal + 4401 builds no socket before the jittered wait (random %s ⇒ %s ms), and never refetches or goes lost",
    async (r, wait) => {
      expect(collabRetryDelay(COLLAB_TRY_LATER_BASE_MS, () => r)).toBe(wait);
      const { access, markDisconnected, refetchToken } = setup({
        random: () => r,
      });
      const first = await openLatest();
      first.receive(
        serverFrames.permissionDenied(DOC, "ccc:collab-auth-rate-limited"),
      );
      first.serverClose(4401); // bounded-socket.ts closes a refused socket
      await flush();
      expect(markDisconnected).toHaveBeenCalledTimes(1);
      expect(refetchToken).not.toHaveBeenCalled();
      expect(access.state.lost).toBe(false);
      expect(collabAllowsEditing(access.state)).toBe(true); // edits wait in the Y doc, as offline
      await advance(wait - 1);
      expect(sockets()).toHaveLength(1); // the provider's own 1 s reconnect never ran
      await advance(1);
      expect(sockets()).toHaveLength(2);
      // the retry is judged like any open: an authentication resets the wait
      const second = await openLatest();
      second.receive(serverFrames.authenticated(DOC));
      await flush();
      expect(access.state.tryLaterAttempts).toBe(0);
      expect(sockets()).toHaveLength(2);
    },
  );

  it("refusals in a row wait 5, 10, 20 s (random 1): one socket per wait, never the provider's 1 s", async () => {
    const { refetchToken } = setup({ random: () => 1 });
    const opened: number[] = [];
    let now = 0;
    for (const wait of [5_000, 10_000, 20_000]) {
      const s = await openLatest();
      opened.push(now);
      s.receive(
        serverFrames.permissionDenied(DOC, "ccc:collab-user-connections"),
      );
      s.serverClose(4401);
      await flush();
      const before = sockets().length;
      await advance(wait - 1);
      expect(sockets()).toHaveLength(before);
      await advance(1);
      expect(sockets()).toHaveLength(before + 1);
      now += wait;
    }
    expect(opened).toEqual([0, 5_000, 15_000]);
    expect(refetchToken).not.toHaveBeenCalled();
  });

  it.each([
    [4429, "ccc:collab-user-connections"],
    [1013, "ccc:collab-try-later"],
    [1013, "Try Again Later"],
  ])(
    "a socket close %s (%s) after authentication waits too, and stays editable",
    async (code, reason) => {
      const { access, markDisconnected } = setup({ random: () => 1 });
      const first = await openLatest();
      first.receive(serverFrames.authenticated(DOC));
      await flush();
      first.serverClose(code, reason);
      await flush();
      expect(markDisconnected).toHaveBeenCalledTimes(1);
      expect(collabAllowsEditing(access.state)).toBe(true);
      await advance(COLLAB_TRY_LATER_BASE_MS - 1);
      expect(sockets()).toHaveLength(1);
      await advance(1);
      expect(sockets()).toHaveLength(2);
    },
  );

  // Anti-vacuity for the waits above: an ordinary close after a message is the provider's fixed 1 s reconnect.
  it("an ordinary close after a message is reconnected by the provider in 1 s (what try-later replaces)", async () => {
    setup();
    const first = await openLatest();
    first.receive(serverFrames.authenticated(DOC));
    await flush();
    first.serverClose(1001, "going away");
    await advance(999);
    expect(sockets()).toHaveLength(1);
    await advance(1);
    expect(sockets()).toHaveLength(2);
  });

  it("the timer never redials a socket something else already reopened (the tab became visible)", async () => {
    const { socket } = setup({ random: () => 1 });
    const first = await openLatest();
    first.receive(
      serverFrames.permissionDenied(DOC, "ccc:collab-auth-rate-limited"),
    );
    first.serverClose(4401);
    await flush();
    expect(
      reopensOnVisible("visible", WebSocketStatus.Disconnected, socket),
    ).toBe(true);
    void socket.connect(); // the visibility effect
    expect(sockets()).toHaveLength(2);
    await advance(COLLAB_TRY_LATER_BASE_MS);
    expect(sockets()).toHaveLength(2); // the timer saw shouldConnect and stood down
  });
});

describe("token refetch closes the socket first (#810, review R4-F3)", () => {
  it("a refusal + 4401 opens no socket while the refetch is in flight, then exactly one, with the NEW token", async () => {
    let resolveRefetch!: (r: RefetchResult) => void;
    const { access, markDisconnected, refetchToken } = setup({
      refetch: () => new Promise((resolve) => (resolveRefetch = resolve)),
    });
    const first = await openLatest();
    first.receive(serverFrames.permissionDenied(DOC, "permission-denied"));
    first.serverClose(4401);
    await advance(5_000); // a slow refetch: the provider's 1 s reconnect would have re-sent the OLD token
    expect(refetchToken).toHaveBeenCalledTimes(1);
    expect(sockets()).toHaveLength(1);
    expect(access.state.lost).toBe(false);
    resolveRefetch({ isSuccess: true, data: { token: FRESH } });
    await flush();
    expect(sockets()).toHaveLength(2);
    const second = await openLatest();
    expect(sentToken(second)).toBe(FRESH);
    second.receive(serverFrames.authenticated(DOC));
    await flush();
    expect(access.state.lost).toBe(false);
    expect(markDisconnected).not.toHaveBeenCalled(); // "connection lost" never flashed
    expect(sockets()).toHaveLength(2);
  });
});

describe("lost (#790, #810)", () => {
  it("a refusal after the refetch is lost: no socket until the jittered COLLAB_LOST_RETRY_MS", async () => {
    const { access, markDisconnected } = setup({ random: () => 0 });
    const first = await openLatest();
    first.receive(serverFrames.permissionDenied(DOC, "permission-denied"));
    first.serverClose(4401);
    await flush(); // the refetch succeeds and reopens with the new token
    expect(sockets()).toHaveLength(2);
    const second = await openLatest();
    second.receive(serverFrames.permissionDenied(DOC, "permission-denied"));
    second.serverClose(4401);
    await flush();
    expect(access.state.lost).toBe(true);
    expect(markDisconnected).toHaveBeenCalledTimes(1);
    const wait = collabRetryDelay(COLLAB_LOST_RETRY_MS, () => 0);
    expect(wait).toBe(30_000);
    await advance(wait - 1);
    expect(sockets()).toHaveLength(2);
    await advance(1);
    expect(sockets()).toHaveLength(3);
  });
});

describe("destroy", () => {
  it("stops the retry timer, and a late refetch result changes nothing", async () => {
    let resolveRefetch!: (r: RefetchResult) => void;
    const first = setup({ random: () => 1 });
    const s1 = await openLatest();
    s1.receive(
      serverFrames.permissionDenied(DOC, "ccc:collab-auth-rate-limited"),
    );
    s1.serverClose(4401);
    await flush();
    first.access.destroy();
    await advance(COLLAB_LOST_RETRY_MS);
    expect(sockets()).toHaveLength(1);

    ScriptedSocket.reset();
    const second = setup({
      refetch: () => new Promise((resolve) => (resolveRefetch = resolve)),
    });
    const s2 = await openLatest();
    s2.receive(serverFrames.permissionDenied(DOC, "permission-denied"));
    s2.serverClose(4401);
    await flush();
    second.access.destroy();
    resolveRefetch({ isSuccess: true, data: { token: FRESH } });
    await advance(5_000);
    expect(sockets()).toHaveLength(1);
  });
});

describe("reopensOnVisible (#810, EXT-4)", () => {
  it("reopens only a visible, disconnected socket that nothing is retrying", () => {
    const retrying = { shouldConnect: true };
    const closed = { shouldConnect: false };
    let calls = 0;
    for (let i = 0; i < 20; i += 1) {
      if (reopensOnVisible("visible", WebSocketStatus.Disconnected, retrying))
        calls += 1;
    }
    expect(calls).toBe(0);
    expect(
      reopensOnVisible("visible", WebSocketStatus.Disconnected, closed),
    ).toBe(true);
    expect(
      reopensOnVisible("hidden", WebSocketStatus.Disconnected, closed),
    ).toBe(false);
    expect(
      reopensOnVisible("visible", WebSocketStatus.Connecting, closed),
    ).toBe(false);
    expect(reopensOnVisible("visible", WebSocketStatus.Connected, closed)).toBe(
      false,
    );
  });
});
