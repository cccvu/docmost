/**
 * CCC fork test kit (cccvu/wiki-v2#810) — a scripted WebSocket for driving the REAL @hocuspocus/provider 4.7.1 under
 * fake timers, and the server frames it needs. Test-only: imported by `*.test.ts` files, never by the app.
 *
 * The test plays the server: it opens a socket, answers it (Authenticated, PermissionDenied, sync), closes it with a
 * code, or fails it before it opens (an upgrade refused 503). Frames are built with the same encoders Hocuspocus uses
 * (`@hocuspocus/common`, `y-protocols/sync`), so the wire format cannot drift from the provider under test.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { writeAuthenticated, writePermissionDenied } from "@hocuspocus/common";
import { MessageType } from "@hocuspocus/provider";

type Listener = (event: any) => void;

export class ScriptedSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket the provider constructed, in order. */
  static instances: ScriptedSocket[] = [];
  /** Called for every new socket (e.g. to refuse every upgrade). */
  static onConstruct: ((socket: ScriptedSocket) => void) | null = null;

  static reset(): void {
    ScriptedSocket.instances = [];
    ScriptedSocket.onConstruct = null;
  }

  readyState = ScriptedSocket.CONNECTING;
  binaryType = "blob";
  identifier: unknown;
  /** Frames the client sent on this socket. */
  readonly sent: Uint8Array[] = [];
  closedByClient = false;
  private readonly listeners: Record<string, Set<Listener>> = {};

  constructor(readonly url: string) {
    ScriptedSocket.instances.push(this);
    ScriptedSocket.onConstruct?.(this);
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= new Set()).add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners[type]?.delete(fn);
  }

  send(data: ArrayBufferLike | Uint8Array): void {
    if (this.readyState !== ScriptedSocket.OPEN) {
      throw new Error("send on a socket that is not open");
    }
    this.sent.push(new Uint8Array(data as ArrayBuffer).slice());
  }

  /** The client's close: like a browser, the close event arrives later (code 1005, no status). */
  close(): void {
    if (this.readyState >= ScriptedSocket.CLOSING) return;
    this.closedByClient = true;
    this.readyState = ScriptedSocket.CLOSING;
    setTimeout(() => this.finishClose(1005, ""), 0);
  }

  // ── the server side ──
  open(): void {
    this.readyState = ScriptedSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  receive(frame: Uint8Array): void {
    const data = frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength,
    );
    this.emit("message", { data });
  }

  /** The server closes the socket (or the connection drops: 1006). */
  serverClose(code: number, reason = ""): void {
    this.finishClose(code, reason);
  }

  /** The upgrade is refused before the socket opens (e.g. 503): error, then close 1006. */
  failBeforeOpen(): void {
    this.emit("error", { type: "error" });
    this.finishClose(1006, "");
  }

  get isClosed(): boolean {
    return this.readyState === ScriptedSocket.CLOSED;
  }

  private finishClose(code: number, reason: string): void {
    if (this.readyState === ScriptedSocket.CLOSED) return;
    this.readyState = ScriptedSocket.CLOSED;
    this.emit("close", { code, reason, wasClean: code !== 1006 });
  }

  private emit(type: string, event: any): void {
    for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
  }
}

const frame = (
  documentName: string,
  type: MessageType,
  write: (e: encoding.Encoder) => void,
) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentName);
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
};

export const serverFrames = {
  authenticated: (
    documentName: string,
    scope: "read-write" | "readonly" = "read-write",
  ) =>
    frame(documentName, MessageType.Auth, (e) => writeAuthenticated(e, scope)),
  permissionDenied: (documentName: string, reason: string) =>
    frame(documentName, MessageType.Auth, (e) =>
      writePermissionDenied(e, reason),
    ),
  syncStep1: (documentName: string, doc: Y.Doc) =>
    frame(documentName, MessageType.Sync, (e) =>
      syncProtocol.writeSyncStep1(e, doc),
    ),
  syncStep2: (documentName: string, doc: Y.Doc) =>
    frame(documentName, MessageType.Sync, (e) =>
      syncProtocol.writeSyncStep2(e, doc),
    ),
};

/** One frame the client sent: its document name, message type and the decoder positioned after them. */
export function readClientFrame(bytes: Uint8Array) {
  const decoder = decoding.createDecoder(bytes);
  const documentName = decoding.readVarString(decoder);
  const type = decoding.readVarUint(decoder) as MessageType;
  return { documentName, type, decoder };
}

/** The token of the client's Auth frame on this socket (undefined if it sent none). */
export function sentToken(socket: ScriptedSocket): string | undefined {
  for (const bytes of socket.sent) {
    const { type, decoder } = readClientFrame(bytes);
    if (type !== MessageType.Auth) continue;
    decoding.readVarUint(decoder); // AuthMessageType.Token
    return decoding.readVarString(decoder);
  }
  return undefined;
}

/** Apply every sync frame the client sent on this socket to the server's copy of the document. */
export function applyClientSync(
  socket: ScriptedSocket,
  serverDoc: Y.Doc,
): void {
  for (const bytes of socket.sent) {
    const { type, decoder } = readClientFrame(bytes);
    if (type !== MessageType.Sync) continue;
    syncProtocol.readSyncMessage(
      decoder,
      encoding.createEncoder(),
      serverDoc,
      "client",
    );
  }
}

/** The installed @hocuspocus/provider version (the tests pin 4.7.1 so a stale install cannot pass them). */
export function installedProviderVersion(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@hocuspocus/provider");
  let dir = dirname(entry);
  for (let i = 0; i < 4; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === "@hocuspocus/provider") return pkg.version;
    } catch {
      // not here: walk up
    }
    dir = dirname(dir);
  }
  throw new Error("could not find @hocuspocus/provider's package.json");
}
