/**
 * CCC collab integration — NOT upstream Docmost code (#840, ADR 0036).
 *
 * The exact shadow source. The guard validates a frame on a shadow replica, so the shadow must hold live's exact order;
 * a reload of live does not (order-parity.ts: Yjs integrates some frames into one order incrementally and another after
 * `applyUpdate(new Y.Doc(), encodeStateAsUpdate(live))`, and a reload is not even idempotent). What does reproduce live
 * is replaying live's own inputs, in live's order, from bytes that rebuild live exactly: the load bytes, or an encode
 * of live taken while a reload of it strict-equals live (`tryAdvance`). The inputs are each accepted client frame's RAW
 * bytes (live's 'update' re-encoding of a frame is not exact: it drops pending structs and re-cuts the structs a frame
 * only partly adds) and, for server-local transactions, live's 'update' payload. Each entry replays in its own
 * transaction, as live applied it, so Yjs's per-transaction cleanup (GC, merges) runs at the same points. Never
 * `mergeUpdates`: it is not live's order and costs far more than the replay.
 *
 * The log is one packed append-only buffer, each entry behind a 4-byte length (an array of Uint8Arrays costs ~236 B
 * of heap per entry). It is native memory (#679), so the caps count what the log RETAINS (the buffer's capacity), and
 * growth is clamped to the cap: a log that fits its cap never holds more, and an empty log holds nothing. The caps also bound the replay a rebuild pays. Recording never drops an entry (that would break exactness),
 * so a caller asks `wouldRetain` first and, when the entry does not fit, stops trusting the log instead of recording
 * (exact-replica-registry.ts does). The process-wide total is the registry's.
 */
import * as Y from 'yjs';
import { strictOrderDiff } from './order-parity';

export type ExactReplicaCaps = { maxBytes: number; maxSteps: number };
/** Per document: 8 MiB retained (the buffer's capacity) and 5M replay steps (ADR 0036 #840 amendment). */
export const EXACT_REPLICA_CAPS: ExactReplicaCaps = { maxBytes: 8 * 1024 * 1024, maxSteps: 5_000_000 };
const INITIAL_BYTES = 4096;
/** Each entry's length, before its bytes. */
const PREFIX = 4;
const NO_BYTES = new Uint8Array(0);

/** `have` grown to hold `need`: doubled from `initial`, but never past `limit` unless `need` itself is. */
function grownSize(have: number, need: number, initial: number, limit: number): number {
  if (need <= have) return have;
  let size = Math.max(initial, have * 2);
  while (size < need) size *= 2;
  return Math.max(need, Math.min(size, limit));
}

export class ExactReplicaLog {
  private checkpoint: Uint8Array;
  /** Entry i is a little-endian uint32 length, then that many bytes; `used` bytes of it are written. */
  private buf: Uint8Array = NO_BYTES;
  private used = 0;
  private count = 0;
  private logged = 0;
  private replaySteps = 0;

  /** `checkpoint` must rebuild live exactly when applied to an empty doc. Kept, not copied: never mutate it. */
  constructor(
    checkpoint: Uint8Array,
    private readonly caps: ExactReplicaCaps = EXACT_REPLICA_CAPS,
  ) {
    this.checkpoint = checkpoint;
  }

  /** An accepted client frame's raw update, in live's apply order; `steps` is what its integrate walked. */
  recordFrame(raw: Uint8Array, steps: number): void {
    this.append(raw, steps);
  }

  /** Live's 'update' payload for a server-local transaction; `structs` is its replay cost. */
  recordServerUpdate(update: Uint8Array, structs: number): void {
    this.append(update, structs);
  }

  /**
   * A fresh replica of live: the checkpoint, then every entry in order, each in its own transaction. `into` (an empty
   * document made with live's gc options) lets a caller meter the replay on a document it holds (the guard's rebuild).
   */
  rebuild(opts: { gc?: boolean; gcFilter?: (item: Y.Item) => boolean } = {}, into?: Y.Doc): Y.Doc {
    const doc = into ?? new Y.Doc(opts);
    Y.applyUpdate(doc, this.checkpoint);
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    for (let i = 0, at = 0; i < this.count; i++) {
      const length = view.getUint32(at, true);
      Y.applyUpdate(doc, this.buf.subarray(at + PREFIX, at + PREFIX + length));
      at += PREFIX + length;
    }
    return doc;
  }

  /** A new checkpoint that rebuilds live as it is now; the log empties and frees its buffer. */
  advance(checkpoint: Uint8Array): void {
    this.checkpoint = checkpoint;
    this.buf = NO_BYTES;
    this.used = 0;
    this.count = 0;
    this.logged = 0;
    this.replaySteps = 0;
  }

  /** Fails closed: a non-finite step count (a caller's NaN) reads as over, never as under forever. */
  overCap(): boolean {
    return !(this.retained <= this.caps.maxBytes && this.replaySteps <= this.caps.maxSteps);
  }

  /** What the log would retain with one more entry of `length` bytes and `steps`; Infinity when that is over a cap. */
  wouldRetain(length: number, steps: number): number {
    if (!(this.replaySteps + steps <= this.caps.maxSteps)) return Infinity;
    const retained = this.sizeFor(length);
    return retained <= this.caps.maxBytes ? retained : Infinity;
  }

  /** Logged input, in bytes (the length prefixes not counted). */
  get bytes(): number {
    return this.logged;
  }

  /** Native memory held: the buffer's capacity (what the caps and the process total count). */
  get retained(): number {
    return this.buf.byteLength;
  }

  get steps(): number {
    return this.replaySteps;
  }

  get entries(): number {
    return this.count;
  }

  /** The buffer's size after one more entry of `length`: doubled from INITIAL_BYTES, clamped to the cap. */
  private sizeFor(length: number): number {
    return grownSize(this.buf.length, this.used + PREFIX + length, INITIAL_BYTES, this.caps.maxBytes);
  }

  private append(update: Uint8Array, steps: number): void {
    const size = this.sizeFor(update.length);
    if (size > this.buf.length) {
      const grown = new Uint8Array(size);
      grown.set(this.buf.subarray(0, this.used));
      this.buf = grown;
    }
    new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength).setUint32(this.used, update.length, true);
    this.buf.set(update, this.used + PREFIX);
    this.used += PREFIX + update.length;
    this.count++;
    this.logged += update.length;
    this.replaySteps += steps;
  }
}

/**
 * Advances `log` to an encode of `live` only when a reload of that encode strict-equals live (so the checkpoint
 * rebuilds live exactly); otherwise, a reload that throws included, leaves it as it is. Returns whether it advanced.
 */
export function tryAdvance(log: ExactReplicaLog, live: Y.Doc): boolean {
  let bytes: Uint8Array;
  try {
    bytes = Y.encodeStateAsUpdate(live);
    const reload = new Y.Doc({ gc: live.gc, gcFilter: live.gcFilter });
    Y.applyUpdate(reload, bytes);
    if (strictOrderDiff(live, reload) !== null) return false;
  } catch {
    return false; // a crafted state Yjs cannot encode or reload
  }
  log.advance(bytes);
  return true;
}
