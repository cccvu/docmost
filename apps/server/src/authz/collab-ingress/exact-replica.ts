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
 * The log is one packed append-only buffer with an offsets table (an array of Uint8Arrays costs ~236 B of heap per
 * entry). The caps bound the replay a rebuild pays; recording never drops an entry (that would break exactness), so a
 * caller that sees `overCap()` advances the checkpoint or stops trusting the log.
 */
import * as Y from 'yjs';
import { strictOrderDiff } from './order-parity';

export type ExactReplicaCaps = { maxBytes: number; maxSteps: number };
/** Per document: 8 MiB of logged input and 5M replay steps (ADR 0036 #840 amendment). */
export const EXACT_REPLICA_CAPS: ExactReplicaCaps = { maxBytes: 8 * 1024 * 1024, maxSteps: 5_000_000 };
const INITIAL_BYTES = 4096;
const INITIAL_ENTRIES = 64;

export class ExactReplicaLog {
  private checkpoint: Uint8Array;
  private buf = new Uint8Array(INITIAL_BYTES);
  /** ends[i] is entry i's end offset in `buf`; entry i starts at ends[i - 1] (or 0). */
  private ends = new Uint32Array(INITIAL_ENTRIES);
  private count = 0;
  private used = 0;
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

  /** A fresh replica of live: the checkpoint, then every entry in order, each in its own transaction. */
  rebuild(opts: { gc?: boolean; gcFilter?: (item: Y.Item) => boolean } = {}): Y.Doc {
    const doc = new Y.Doc(opts);
    Y.applyUpdate(doc, this.checkpoint);
    for (let i = 0, start = 0; i < this.count; start = this.ends[i++]) Y.applyUpdate(doc, this.buf.subarray(start, this.ends[i]));
    return doc;
  }

  /** A new checkpoint that rebuilds live as it is now; the log empties. */
  advance(checkpoint: Uint8Array): void {
    this.checkpoint = checkpoint;
    if (this.buf.length > INITIAL_BYTES) this.buf = new Uint8Array(INITIAL_BYTES);
    if (this.ends.length > INITIAL_ENTRIES) this.ends = new Uint32Array(INITIAL_ENTRIES);
    this.count = 0;
    this.used = 0;
    this.replaySteps = 0;
  }

  /** Fails closed: a non-finite step count (a caller's NaN) reads as over, never as under forever. */
  overCap(): boolean {
    return !(this.used <= this.caps.maxBytes && this.replaySteps <= this.caps.maxSteps);
  }

  get bytes(): number {
    return this.used;
  }

  get steps(): number {
    return this.replaySteps;
  }

  get entries(): number {
    return this.count;
  }

  private append(update: Uint8Array, steps: number): void {
    const end = this.used + update.length;
    if (end > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < end) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.buf.subarray(0, this.used));
      this.buf = grown;
    }
    if (this.count === this.ends.length) {
      const grown = new Uint32Array(this.ends.length * 2);
      grown.set(this.ends);
      this.ends = grown;
    }
    this.buf.set(update, this.used);
    this.ends[this.count++] = end;
    this.used = end;
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
