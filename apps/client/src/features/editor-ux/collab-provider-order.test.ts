// cccvu/wiki-v2 #781 lineage (ADR 0036 §4) — the outbound frame ORDER the server's client-id binding relies on, driven
// through the REAL @hocuspocus/provider 4.7.1 over a scripted WebSocket. The collab update guard binds a never-seen
// client id by its first struct only when the sender's connection announced that id in its own awareness (or announced
// nothing), so every honest provider must put its own awareness on the wire before any document update it sends: its
// Step2, a queued offline edit, or a y-indexeddb remount echo. A provider bump that reorders these frames would
// silently drop the server back to the old rule (a relay of a co-editor's lost structs would take the co-editor's id);
// this file turns that into a red test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  MessageType,
} from "@hocuspocus/provider";
import { createCollabAccessController } from "./collab-access-controller";
import {
  installedProviderVersion,
  readClientFrame,
  ScriptedSocket,
  serverFrames,
} from "./collab-scripted-socket.testkit";

const DOC = "page.p1";
const jwt = (exp: number) =>
  `e30.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.sig`;
const TOKEN = jwt(4_000_000_000);
/** y-protocols sync subtypes. */
const STEP1 = 0;
const STEP2 = 1;
const UPDATE = 2;

const live: {
  socket: HocuspocusProviderWebsocket;
  remote: HocuspocusProvider;
}[] = [];

/** The provider exactly as page-editor.tsx builds it (a string token, the access controller bound). */
function setup() {
  const socket = new HocuspocusProviderWebsocket({
    url: "ws://collab.test/collab",
    WebSocketPolyfill: ScriptedSocket,
  });
  const ydoc = new Y.Doc();
  const access = createCollabAccessController({
    socket,
    initialToken: TOKEN,
    refetchToken: async () => ({ isSuccess: true, data: { token: TOKEN } }),
    onState: () => {},
    markDisconnected: () => {},
    random: () => 1,
    network: null,
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
  return { ydoc, remote };
}

/** Each frame the client sent, named: Auth, Step1, Step2, Update, Awareness(<ids>), or the raw type. */
function wire(socket: ScriptedSocket): string[] {
  return socket.sent.map((bytes) => {
    const { type, decoder } = readClientFrame(bytes);
    if (type === MessageType.Auth) return "Auth";
    if (type === MessageType.Sync) {
      const sub = decoding.readVarUint(decoder);
      return sub === STEP1
        ? "Step1"
        : sub === STEP2
          ? "Step2"
          : sub === UPDATE
            ? "Update"
            : `Sync${sub}`;
    }
    if (type === MessageType.Awareness) {
      const inner = decoding.createDecoder(decoding.readVarUint8Array(decoder));
      const ids: number[] = [];
      const n = decoding.readVarUint(inner);
      for (let i = 0; i < n; i++) {
        ids.push(decoding.readVarUint(inner));
        decoding.readVarUint(inner); // clock
        decoding.readVarString(inner); // state
      }
      return `Awareness(${ids.join(",")})`;
    }
    return `type${type}`;
  });
}

/** The server's side of a 4.7.1 open: Authenticated, then its Step1 (the client answers it with its Step2). */
function serverOpens(socket: ScriptedSocket, serverDoc: Y.Doc) {
  socket.receive(serverFrames.authenticated(DOC));
  socket.receive(serverFrames.syncStep1(DOC, serverDoc));
}

/** Its own awareness is on the wire before any frame that carries document structs. */
function expectAnnouncedFirst(frames: string[], clientID: number) {
  const own = frames.indexOf(`Awareness(${clientID})`);
  const firstStructs = frames.findIndex((f) => f === "Step2" || f === "Update");
  expect(own).toBeGreaterThanOrEqual(0);
  expect(firstStructs).toBeGreaterThan(own);
  expect(frames.slice(0, 3)).toEqual([
    "Auth",
    "Step1",
    `Awareness(${clientID})`,
  ]);
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const last = () =>
  ScriptedSocket.instances[ScriptedSocket.instances.length - 1];

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

describe("the provider and page-editor under test", () => {
  it("is @hocuspocus/provider 4.7.1", () => {
    expect(installedProviderVersion()).toBe("4.7.1");
  });

  it("page-editor passes a string token (an async token function would put frames made during `await getToken()` before Auth)", () => {
    const source = readFileSync(
      join(__dirname, "..", "editor", "page-editor.tsx"),
      "utf8",
    );
    const provider = source.slice(source.indexOf("new HocuspocusProvider({"));
    expect(provider).toMatch(
      /^new HocuspocusProvider\(\{[^}]*\btoken: collabQuery\?\.token,/,
    );
  });
});

describe("own awareness precedes every document update (ADR 0036 §4 binding evidence)", () => {
  it("an update queued while the socket is Connecting (a y-indexeddb echo, an offline edit) goes out after it", async () => {
    const { ydoc } = setup();
    const local = new Y.Doc();
    local.getText("t").insert(0, "stored in IndexedDB");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(local), "idb"); // y-indexeddb's load: a remote origin, so it is sent
    ydoc.getText("t").insert(0, "typed offline ");
    const socket = last();
    socket.open();
    await flush();
    serverOpens(socket, new Y.Doc());
    await flush();
    const frames = wire(socket);
    expect(frames).toContain("Update"); // anti-vacuity: the queued updates were sent
    expect(frames).toContain("Step2");
    expectAnnouncedFirst(frames, ydoc.clientID);
  });

  it("an update made in a later task than the open goes out after it", async () => {
    const { ydoc } = setup();
    const socket = last();
    socket.open();
    await flush();
    ydoc.getText("t").insert(0, "typed right after open ");
    serverOpens(socket, new Y.Doc());
    await flush();
    const frames = wire(socket);
    expect(frames).toContain("Update");
    expectAnnouncedFirst(frames, ydoc.clientID);
  });

  it("after a dropped connection, the reconnect announces its own id again before its Step2 and queued edits", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    const { ydoc } = setup();
    const first = last();
    first.open();
    await flush();
    serverOpens(first, new Y.Doc());
    await flush();
    first.serverClose(1006);
    await flush();
    ydoc.getText("t").insert(0, "typed during the outage ");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = last();
    expect(second).not.toBe(first);
    second.open();
    await flush();
    serverOpens(second, new Y.Doc());
    await flush();
    const frames = wire(second);
    expect(frames.some((f) => f === "Update" || f === "Step2")).toBe(true);
    expectAnnouncedFirst(frames, ydoc.clientID);
  });
});
