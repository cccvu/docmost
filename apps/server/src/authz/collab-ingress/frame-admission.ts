/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * The gateway's check on every inbound collab frame, on both paths (RedisSync and standalone), before RedisSync or
 * Hocuspocus sees it. Both are synchronous, so a burst of frames in one TCP read is checked frame by frame.
 *
 * ## The address
 * Every Hocuspocus frame starts with its document name (a lib0 varString). RedisSync turns that name into a Redis
 * key (`collabLock:<name>`, a SET NX per frame for a document this node has not loaded) before anything
 * authenticates the socket, and Hocuspocus allocates a queue per name. Docmost only ever opens `page.<uuid>`
 * (`collaboration.util.ts` getPageId; session awareness is off, so there is never a `\0sessionId` suffix), so the
 * gateway admits a frame only when its name is exactly that, and terminates the socket otherwise.
 *
 * The UUID must be lower case: Postgres compares uuids case-blind, so `page.<UPPER>` would load a second live
 * document (a second shadow, store and lock) for the same page. Docmost names documents from `page.id` as Postgres
 * prints it, always lower case (page-editor.tsx, `page.${pageId}`).
 *
 * The length prefix is checked before any byte of the name is read: a client-chosen 8 MiB name is refused without
 * decoding it. A non-minimal varint (one no lib0 encoder writes) is refused too, so the name checked here is exactly
 * the name lib0's `readVarString` returns downstream.
 *
 * ## Per-socket budgets (past either, the socket is terminated and the frame dropped)
 * - at most COLLAB_DOCUMENTS_PER_SOCKET distinct names ever. RedisSync claims a Redis lock (a SET NX, a 5 s timer) for
 *   every name this node has not loaded BEFORE Hocuspocus counts its `maxPendingDocuments`, so without this one
 *   unauthenticated socket could make Redis (shared with the platform) take a SET per frame;
 * - at most COLLAB_AUTH_FRAMES_PER_SOCKET Auth frames ever. Hocuspocus 4.7.1 clears a document's state when it
 *   refuses its Auth, so the next Auth re-runs `onAuthenticate`; a token that does not verify never reaches the per-user
 *   auth rate (auth-rate.ts), which needs the verified user id.
 *
 * ## The first Auth frame (#810 N1)
 * The socket's first complete Auth frame tells the pre-auth slots (`authArrived`, preauth-slots.ts) that the socket is
 * authenticating, which moves its deadline from the short first-Auth one to the overall one. Here, on the origin node,
 * it holds on both paths, also for an Auth RedisSync relays to the node that owns the document. A partial frame never
 * reaches this check, so a socket trickling one is still cut at the first-Auth deadline.
 *
 * ## The awareness rate (a drop, not a refusal)
 * Awareness and QueryAwareness frames past a burst of COLLAB_AWARENESS_BURST, then COLLAB_AWARENESS_REFILL_PER_SECOND,
 * are DROPPED and the socket stays up (limits.ts says why a drop, not a refusal). Here, before RedisSync and
 * Hocuspocus, a dropped frame is never proxied, queued or relayed, and the update guard never sees it. Nothing else is
 * ever dropped: a dropped Sync frame would lose an edit.
 *
 * Message types are Hocuspocus's own `MessageType` (the wire values are pinned in frame-admission.spec.ts).
 */
import * as decoding from 'lib0/decoding';
import { MessageType } from '@hocuspocus/server';
import { WsReadyStates } from '@hocuspocus/common';
import {
  COLLAB_AUTH_FRAMES_PER_SOCKET,
  COLLAB_AWARENESS_BURST,
  COLLAB_AWARENESS_REFILL_PER_SECOND,
  COLLAB_DOCUMENTS_PER_SOCKET,
} from './limits';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

const NAME = /^page\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `page.` + a 36-character UUID; below 128, so its varint is the single byte 41. */
const NAME_BYTES = 41;
const AWARENESS_REFILL_MS = 1000 / COLLAB_AWARENESS_REFILL_PER_SECOND;

const asBytes = (data: Uint8Array | ArrayBuffer): Uint8Array => (data instanceof Uint8Array ? data : new Uint8Array(data));

/** The frame's document name when it is `page.<uuid>` (any UUID version, lower case), else null. Never throws. */
function frameAddress(frame: Uint8Array): string | null {
  if (frame.byteLength < 1 + NAME_BYTES || frame[0] !== NAME_BYTES) return null;
  const name = Buffer.from(frame.buffer, frame.byteOffset + 1, NAME_BYTES).toString('latin1');
  return NAME.test(name) ? name : null;
}

/** True when the frame's document name is `page.<uuid>` (any UUID version, lower case). Never throws. */
export function isCollabFrameAddress(data: Uint8Array | ArrayBuffer): boolean {
  return frameAddress(asBytes(data)) !== null;
}

/** The message type after the name, read as lib0 reads it (a varint); null when there is none. */
function messageType(frame: Uint8Array): number | null {
  try {
    const d = decoding.createDecoder(frame.subarray(1 + NAME_BYTES));
    return decoding.readVarUint(d);
  } catch {
    return null;
  }
}

/** What one socket has addressed so far. */
interface SocketFrames {
  readonly names: Set<string>;
  auths: number;
  /** The awareness bucket: tokens left, and when they were last counted. */
  awarenessTokens: number;
  awarenessAt: number;
}
const perSocket = new WeakMap<object, SocketFrames>();

/** The pre-auth slots' hook for a socket's first Auth frame (CollabPreAuthSlots.authArrived). */
export interface FirstAuthListener {
  authArrived(socket: object): void;
}

/** The `ws` WebSocket surface used here. */
export interface AddressedSocket {
  readonly readyState: number;
  terminate(): void;
}

/**
 * The gateway's check on every inbound frame, on both paths: false (drop it) when the socket is no longer open; false
 * after terminating the socket when the frame does not name `page.<uuid>`, names one document more than
 * COLLAB_DOCUMENTS_PER_SOCKET, or is one Auth frame more than COLLAB_AUTH_FRAMES_PER_SOCKET; and false, with the socket
 * left up, for an awareness frame over the socket's awareness rate. The first admitted Auth frame is reported to
 * `preAuth` (`CollabSocketBounds.open` passes the process's pre-auth slots).
 */
export function admitCollabFrame(
  ws: AddressedSocket,
  data: Uint8Array | ArrayBuffer,
  limitLog: SocketLimitLog = collabSocketLimitLog,
  now: () => number = Date.now,
  preAuth?: FirstAuthListener,
): boolean {
  if (ws.readyState !== WsReadyStates.Open) return false;
  const frame = asBytes(data);
  const name = frameAddress(frame);
  if (name === null) return refuse(ws, limitLog, 'frame_address', { frameBytes: frame.byteLength });
  let seen = perSocket.get(ws);
  if (!seen) perSocket.set(ws, (seen = { names: new Set(), auths: 0, awarenessTokens: COLLAB_AWARENESS_BURST, awarenessAt: now() }));
  if (!seen.names.has(name)) {
    if (seen.names.size >= COLLAB_DOCUMENTS_PER_SOCKET) return refuse(ws, limitLog, 'socket_documents', { documents: seen.names.size + 1 });
    seen.names.add(name);
  }
  const type = messageType(frame);
  if (type === MessageType.Auth) {
    if (++seen.auths > COLLAB_AUTH_FRAMES_PER_SOCKET) return refuse(ws, limitLog, 'socket_auth_frames', { authFrames: seen.auths });
    if (seen.auths === 1) preAuth?.authArrived(ws);
  }
  if (type === MessageType.Awareness || type === MessageType.QueryAwareness) return chargeAwareness(seen, now());
  return true;
}

/** One token from the socket's awareness bucket; false (drop the frame, unlogged: a drop costs nothing) when empty. */
function chargeAwareness(seen: SocketFrames, at: number): boolean {
  const tokens = Math.min(COLLAB_AWARENESS_BURST, seen.awarenessTokens + Math.max(0, at - seen.awarenessAt) / AWARENESS_REFILL_MS);
  seen.awarenessAt = at;
  if (tokens < 1) {
    seen.awarenessTokens = tokens;
    return false;
  }
  seen.awarenessTokens = tokens - 1;
  return true;
}

function refuse(ws: AddressedSocket, limitLog: SocketLimitLog, limit: string, fields: Record<string, number>): false {
  limitLog.log(limit, fields);
  ws.terminate();
  return false;
}
