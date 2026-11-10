/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * Every Hocuspocus frame starts with its document name (a lib0 varString). RedisSync turns that name into a Redis
 * key (`collabLock:<name>`, a SET NX per frame for a document this node has not loaded) before anything
 * authenticates the socket, and Hocuspocus allocates a queue per name. Docmost only ever opens `page.<uuid>`
 * (`collaboration.util.ts` getPageId; session awareness is off, so there is never a `\0sessionId` suffix), so the
 * gateway admits a frame only when its name is exactly that, and terminates the socket otherwise.
 *
 * The length prefix is checked before any byte of the name is read: a client-chosen 8 MiB name is refused without
 * decoding it. A non-minimal varint (one no lib0 encoder writes) is refused too, so the name checked here is exactly
 * the name lib0's `readVarString` returns downstream.
 */
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

const NAME = /^page\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `page.` + a 36-character UUID; below 128, so its varint is the single byte 41. */
const NAME_BYTES = 41;
const OPEN = 1;

/** True when the frame's document name is `page.<uuid>` (any UUID version, any case). Never throws. */
export function isCollabFrameAddress(data: Uint8Array | ArrayBuffer): boolean {
  const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (frame.byteLength < 1 + NAME_BYTES || frame[0] !== NAME_BYTES) return false;
  return NAME.test(Buffer.from(frame.buffer, frame.byteOffset + 1, NAME_BYTES).toString('latin1'));
}

/** The `ws` WebSocket surface used here. */
export interface AddressedSocket {
  readonly readyState: number;
  terminate(): void;
}

/**
 * The gateway's check on every inbound frame, on both paths: false (drop it) when the socket is no longer open, and
 * false after terminating the socket when the frame does not name `page.<uuid>`.
 */
export function admitCollabFrame(ws: AddressedSocket, data: Uint8Array | ArrayBuffer, limitLog: SocketLimitLog = collabSocketLimitLog): boolean {
  if (ws.readyState !== OPEN) return false;
  if (isCollabFrameAddress(data)) return true;
  limitLog.log('frame_address', { frameBytes: data.byteLength });
  ws.terminate();
  return false;
}
