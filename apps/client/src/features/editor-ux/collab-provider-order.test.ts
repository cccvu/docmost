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
  installedProviderDependencyVersion,
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

/** #845: one client frame with what the binding reads: each awareness entry, and the client ids of each struct. */
type Frame =
  | { kind: "Awareness"; entries: { id: number; clock: number; state: unknown }[] }
  | { kind: "Step2" | "Update"; structClients: number[] }
  | { kind: string };

function frames(socket: ScriptedSocket): Frame[] {
  return socket.sent.map((bytes) => {
    const { type, decoder } = readClientFrame(bytes);
    if (type === MessageType.Auth) return { kind: "Auth" };
    if (type === MessageType.Sync) {
      const sub = decoding.readVarUint(decoder);
      if (sub !== STEP2 && sub !== UPDATE) return { kind: sub === STEP1 ? "Step1" : `Sync${sub}` };
      const update = decoding.readVarUint8Array(decoder);
      return {
        kind: sub === STEP2 ? "Step2" : "Update",
        structClients: Y.decodeUpdate(update).structs.map((s) => s.id.client),
      };
    }
    if (type === MessageType.Awareness) {
      const inner = decoding.createDecoder(decoding.readVarUint8Array(decoder));
      const entries: { id: number; clock: number; state: unknown }[] = [];
      const n = decoding.readVarUint(inner);
      for (let i = 0; i < n; i++) {
        const id = decoding.readVarUint(inner);
        const clock = decoding.readVarUint(inner);
        entries.push({ id, clock, state: JSON.parse(decoding.readVarString(inner)) });
      }
      return { kind: "Awareness", entries };
    }
    return { kind: `type${type}` };
  });
}

/** Index of the first frame announcing `id` the way every receiver applies it: a state, at clock ≥ 1 (y-protocols drops clock 0 for an id it has never seen). */
const announceOf = (fs: Frame[], id: number) =>
  fs.findIndex(
    (f) =>
      f.kind === "Awareness" &&
      "entries" in f &&
      f.entries.some((e) => e.id === id && e.clock >= 1 && e.state !== null),
  );
/** Index of the first frame carrying a struct at `id`. */
const firstStructAt = (fs: Frame[], id: number) =>
  fs.findIndex((f) => "structClients" in f && f.structClients.includes(id));

/**
 * #845: make Yjs regenerate the client's id: the server delivers a struct written under the client's own id (a copy of
 * the client's document with one more insert at its id), so the remote transaction changes the client's own state.
 */
function serverWritesAtClientId(socket: ScriptedSocket, ydoc: Y.Doc) {
  const twin = new Y.Doc();
  Y.applyUpdate(twin, Y.encodeStateAsUpdate(ydoc));
  twin.clientID = ydoc.clientID; // set after the apply: applying under the same id would regenerate the twin's own
  twin.getText("server").insert(0, "written under the client's id");
  socket.receive(serverFrames.syncStep2(DOC, twin));
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

  it("runs y-protocols 1.0.6 and yjs 13.6.30 (#845: the client-id follow reads their Awareness and regeneration)", () => {
    expect(installedProviderDependencyVersion("y-protocols")).toBe("1.0.6");
    expect(installedProviderDependencyVersion("yjs")).toBe("13.6.30");
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

// cccvu/wiki-v2 #845 — Yjs regenerates `doc.clientID` when a remote update writes at it, but y-protocols' Awareness keeps
// the id it was built with. Without a follow the new id is never announced (the server binds it by its first struct, as
// a relay: applied unbound and forgeable), the provider's onClose then removes the local state (it keeps only
// `document.clientID`), and every reconnect sends no awareness at all.
describe("a regenerated client id is announced before any struct at it (#845)", () => {
  it("after the regeneration, no struct at the new id goes on the wire before Awareness(new id) at clock ≥ 1 with the state, even when an awareness `change` listener writes (the cursor plugin then ySync)", async () => {
    const { ydoc, remote } = setup();
    const awareness = remote.awareness!;
    awareness.setLocalStateField("user", { name: "Ada" });
    let armed = false;
    awareness.on("change", (_change: unknown, origin: unknown) => {
      if (armed && origin === "local") ydoc.getText("cursor").insert(0, "|");
    });
    const socket = last();
    socket.open();
    await flush();
    serverOpens(socket, new Y.Doc());
    await flush();
    const before = ydoc.clientID;
    const clock = awareness.meta.get(before)!.clock;
    armed = true;
    serverWritesAtClientId(socket, ydoc);
    armed = false;
    ydoc.getText("t").insert(0, "typed after the regeneration ");
    await flush();
    const after = ydoc.clientID;
    expect(after).not.toBe(before); // anti-vacuity: Yjs did regenerate
    const fs = frames(socket);
    const firstZ = firstStructAt(fs, after);
    expect(firstZ).toBeGreaterThanOrEqual(0); // anti-vacuity: structs at the new id were sent
    const announce = announceOf(fs, after);
    expect(announce).toBeGreaterThanOrEqual(0);
    expect(announce).toBeLessThan(firstZ);
    // The exact sequence the server's binding sees (the guard spec mirrors it): the old id removed at its next clock,
    // then the new id with the state one clock later, back to back.
    expect(fs.slice(announce - 1, announce + 1)).toEqual([
      { kind: "Awareness", entries: [{ id: before, clock: clock + 1, state: null }] },
      { kind: "Awareness", entries: [{ id: after, clock: clock + 2, state: { user: { name: "Ada" } } }] },
    ]);
  });

  it("a reconnect after the regeneration announces the new id (today's provider onClose removed the local state, so it sent no awareness)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    const { ydoc, remote } = setup();
    remote.awareness!.setLocalStateField("user", { name: "Ada" });
    const first = last();
    first.open();
    await flush();
    serverOpens(first, new Y.Doc());
    await flush();
    const before = ydoc.clientID;
    serverWritesAtClientId(first, ydoc);
    await flush();
    expect(ydoc.clientID).not.toBe(before); // anti-vacuity
    first.serverClose(1006);
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = last();
    expect(second).not.toBe(first);
    second.open();
    await flush();
    serverOpens(second, new Y.Doc());
    await flush();
    const fs = frames(second);
    expect(fs.slice(0, 2).map((f) => f.kind)).toEqual(["Auth", "Step1"]);
    expect(fs[2]).toEqual({
      kind: "Awareness",
      entries: [{ id: ydoc.clientID, clock: expect.any(Number), state: { user: { name: "Ada" } } }],
    });
    expect((fs[2] as { entries: { clock: number }[] }).entries[0].clock).toBeGreaterThanOrEqual(1);
  });
});
