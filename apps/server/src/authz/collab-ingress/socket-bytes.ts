/**
 * CCC collab integration — NOT upstream Docmost code (#810, ADR 0036).
 *
 * The process-wide byte budget across every collab socket (COLLAB_SOCKET_TOTAL_BYTES): what all of them together hold
 * in ws's send buffers and, once authenticated, in the frames ws is still assembling from them. The per-socket bounds
 * (bounded-socket.ts outbound, `maxPayload` inbound) times the per-user connection cap still let one account hold more
 * than the heap, and any number of accounts more again; this bounds the sum. It keys on nothing a client sends, so it
 * behaves the same behind the front door and at the load balancer.
 *
 * - **Outbound**: every frame the bounded socket sends goes through `send`, which queues it with ws's send callback, so
 *   each socket knows its frames still queued (`pending`, oldest first: ws calls each write's callback exactly once,
 *   in order). A socket's charge is its `bufferedAmount` at its last sample plus COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES
 *   per pending frame (the heap `bufferedAmount` does not show: limits.ts).
 * - **A shared payload is counted once.** Hocuspocus 4.7.1 encodes a broadcast once and hands the SAME Uint8Array to
 *   every peer's socket, and ws queues a view of it, not a copy; yet each peer's `bufferedAmount` counts it. So each
 *   queued payload is refcounted by that Uint8Array (`shared`), and the total subtracts every copy past the first
 *   (`dup`): a peer adds only its frame overhead. Keyed by the view Hocuspocus passed, not its ArrayBuffer: Node's
 *   Buffer pool and RedisSync's decoded messages put distinct payloads in one ArrayBuffer, which would count once
 *   what is held twice. Without this, one editor writing a 4.2 MB update to a page with 32 paused viewers passes the
 *   budget with bytes held once, and the cut kicks the viewers (ADR 0036). A frame the kernel took at once (the
 *   socket's buffer did not grow by it) is not refcounted: its bytes are not in any sample.
 * - **Inbound** (from `track`, given the upgraded TCP socket): every read adds its bytes plus
 *   COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES; each complete message ws emits clears it. ws's own 'data' listener runs first
 *   and emits the messages a read completes before this one counts the read, so the count over-estimates by at most
 *   the part of one read that finished a message, never under. Ping, pong and close frames do not clear it (one can
 *   sit between the fragments of a message). It joins the total only once the socket is authenticated
 *   (`authenticated`, from the bounded socket's first Authenticated reply, next to the pre-auth release): before that
 *   the same bytes are the pre-auth budget's (preauth-slots.ts), so a partial frame straddling auth is counted in
 *   exactly one of them.
 * - **Fast path**: every charge updates cached totals in O(1). A sample (`bufferedAmount`) is taken at each send and
 *   at each keepalive tick; between samples a drained socket's sample is stale, high. Past the budget, `enforce`
 *   re-samples EVERY socket first, so a socket that has drained is never cut on a stale sample, and only if the
 *   total is still over cuts the sockets holding the most (each one's payloads shared with others counted at its
 *   share), logged `socket_total_bytes`, until the total is back to COLLAB_SOCKET_TOTAL_LOW_WATER_BYTES. A pass that
 *   finds only stale samples over cuts no one and moves the next pass 1/16 of the gap to the low water (1 MiB) past the
 *   total it found, so the total can pass the budget by at most that, and a holder parked just under the budget cannot
 *   make every send re-sample every socket.
 * - **Release**: a cut or a close releases everything the socket holds, exactly once; a send callback after that is
 *   ignored.
 *
 * The pings ws answers are not counted (socket-pong.ts keeps one in flight); the kernel's and a proxy's socket buffers
 * hold no Node memory. One instance per process, owned by `CollabSocketBounds` (socket-bounds.ts): the adapter tracks a
 * socket on it and the bounded socket sends through it, so two instances would each see half.
 */
import {
  COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES,
  COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES,
  COLLAB_SOCKET_TOTAL_BYTES,
  COLLAB_SOCKET_TOTAL_LOW_WATER_BYTES,
} from './limits';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

/** The ws socket surface used here. */
export interface BytesSocket {
  readonly bufferedAmount: number;
  send(data: Uint8Array, cb: (err?: Error) => void): void;
  terminate(): void;
  on?(event: 'message', listener: () => void): unknown;
  off?(event: 'message', listener: () => void): unknown;
  once?(event: 'close', listener: () => void): unknown;
}

/** The upgraded TCP socket surface used here (a `net.Socket`). */
export interface BytesTransport {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

type Entry = {
  socket: BytesSocket;
  /** `bufferedAmount` at the last sample. */
  sampled: number;
  /** Frames queued and not yet written, oldest first from `head`: the payload refcounted in `shared`, or null. */
  pending: Array<Uint8Array | null>;
  head: number;
  /** Bytes (plus per-read overhead) since the last complete message. */
  inbound: number;
  /** Authenticated: `inbound` is in the total. */
  counted: boolean;
  released: boolean;
  detach: () => void;
  /** ws's send callback for every frame of this socket (one closure per socket). */
  written: () => void;
};

type Shared = { bytes: number; refs: number };

export interface CollabSocketBytesOptions {
  /** COLLAB_SOCKET_TOTAL_BYTES. */
  budget?: number;
  /** COLLAB_SOCKET_TOTAL_LOW_WATER_BYTES (never more than `budget`). */
  lowWater?: number;
  /** COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES. */
  frameOverhead?: number;
  /** COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES. */
  chunkOverhead?: number;
  limitLog?: SocketLimitLog;
}

export class CollabSocketBytes {
  private readonly entries = new Map<object, Entry>();
  private readonly shared = new Map<Uint8Array, Shared>();
  /** Σ every entry's charge (sample + pending x overhead + counted inbound). */
  private held = 0;
  /** Σ bytes x (refs - 1) over `shared`: the copies of shared payloads the samples count more than once. */
  private dup = 0;
  private enforcing = false;
  /** The cached total past which `enforce` runs: the budget, or a little above it after a pass that cut no one. */
  private threshold: number;
  private passCount = 0;
  private readonly budget: number;
  /** How far past the post-pass total the next pass waits after a pass that cut no one: (budget - lowWater) / 16. */
  private readonly recheck: number;
  private readonly lowWater: number;
  private readonly frameOverhead: number;
  private readonly chunkOverhead: number;
  private readonly limitLog: SocketLimitLog;

  constructor({
    budget = COLLAB_SOCKET_TOTAL_BYTES,
    lowWater = COLLAB_SOCKET_TOTAL_LOW_WATER_BYTES,
    frameOverhead = COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES,
    chunkOverhead = COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES,
    limitLog = collabSocketLimitLog,
  }: CollabSocketBytesOptions = {}) {
    this.budget = budget;
    this.lowWater = Math.min(lowWater, budget);
    this.recheck = (this.budget - this.lowWater) / 16;
    this.threshold = budget;
    this.frameOverhead = frameOverhead;
    this.chunkOverhead = chunkOverhead;
    this.limitLog = limitLog;
  }

  /**
   * At the upgrade (`CollabSocketBounds.holdUpgraded`, seam §226): track `socket`, counting what its TCP socket
   * delivers since its last message (in the total once it is authenticated). Released when it closes. Idempotent.
   */
  track(socket: BytesSocket, transport?: BytesTransport): void {
    if (this.entries.has(socket)) return;
    const entry: Entry = {
      socket,
      sampled: 0,
      pending: [],
      head: 0,
      inbound: 0,
      counted: false,
      released: false,
      detach: () => undefined,
      written: () => this.written(entry),
    };
    const onData = (chunk: Buffer) => {
      if (entry.released) return;
      const bytes = chunk.length + this.chunkOverhead;
      entry.inbound += bytes;
      if (!entry.counted) return;
      this.held += bytes;
      if (this.total > this.threshold) this.enforce();
    };
    const onMessage = () => {
      if (entry.counted) this.held -= entry.inbound;
      entry.inbound = 0;
    };
    if (transport) {
      transport.on('data', onData);
      socket.on?.('message', onMessage);
      entry.detach = () => {
        transport.off('data', onData);
        socket.off?.('message', onMessage);
      };
    }
    this.entries.set(socket, entry);
    socket.once?.('close', () => this.release(socket));
  }

  /** The socket's first Authenticated reply was sent: its inbound partial frame joins the total from now on. */
  authenticated(socket: object): void {
    const entry = this.entries.get(socket);
    if (!entry || entry.counted) return;
    entry.counted = true;
    this.held += entry.inbound;
    if (this.total > this.threshold) this.enforce();
  }

  /**
   * What `socket` has queued now, for the per-socket bound (bounded-socket.ts): `bufferedAmount` plus the overhead of
   * each frame still pending. Fresh, never a cached sample.
   */
  queued(socket: BytesSocket): number {
    const entry = this.entries.get(socket);
    return socket.bufferedAmount + (entry ? this.pendingOf(entry) * this.frameOverhead : 0);
  }

  /** Frames `socket` has queued that ws has not written yet. */
  pendingFrames(socket: object): number {
    const entry = this.entries.get(socket);
    return entry ? this.pendingOf(entry) : 0;
  }

  /**
   * Queue `message` on `socket` with ws's send callback, count it, and enforce the budget (which may cut this very
   * socket: the frame then goes with it). A socket nothing tracked yet is tracked now (outbound only), so no frame
   * escapes the count. False when nothing was queued (the socket was already released or ws refused it).
   */
  send(socket: BytesSocket, message: Uint8Array): boolean {
    if (!this.entries.has(socket)) this.track(socket);
    const entry = this.entries.get(socket)!;
    if (entry.released) return false;
    if (entry.head > 1024 && entry.head * 2 > entry.pending.length) {
      // drop the written frames' slots (only here, so `index` below stays valid whatever ws calls back)
      entry.pending = entry.pending.slice(entry.head);
      entry.head = 0;
    }
    const before = socket.bufferedAmount;
    // pending before ws sees it, so a callback however early finds its frame
    const index = entry.pending.push(null) - 1;
    this.held += this.frameOverhead;
    try {
      socket.send(message, entry.written);
    } catch {
      // the socket is gone: ws queued nothing (and called nothing)
      entry.pending.pop();
      this.held -= this.frameOverhead;
      return false;
    }
    const after = socket.bufferedAmount;
    if (index >= entry.head && message.byteLength > 0 && after - before >= message.byteLength) {
      entry.pending[index] = message;
      const shared = this.shared.get(message);
      if (shared) {
        shared.refs++;
        this.dup += shared.bytes;
      } else {
        this.shared.set(message, { bytes: message.byteLength, refs: 1 });
      }
    }
    this.sample(entry, after);
    if (this.total > this.threshold) this.enforce();
    return true;
  }

  /** Re-sample one socket (the keepalive tick): bounds how stale its cached charge gets to one tick. */
  resample(socket: object): void {
    const entry = this.entries.get(socket);
    if (entry && !entry.released) this.sample(entry, entry.socket.bufferedAmount);
  }

  /** It closed (or was cut): release everything it holds. Idempotent; a send callback after this is ignored. */
  release(socket: object): void {
    const entry = this.entries.get(socket);
    if (!entry || entry.released) return;
    entry.released = true;
    entry.detach();
    this.held -= this.chargeOf(entry);
    for (let i = entry.head; i < entry.pending.length; i++) this.unref(entry.pending[i]);
    entry.pending = [];
    entry.head = 0;
    this.entries.delete(socket);
  }

  /** Bytes counted across every socket, each shared payload once. */
  get total(): number {
    return this.held - this.dup;
  }

  /** Sockets tracked, and distinct payloads queued (specs and diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  get sharedPayloads(): number {
    return this.shared.size;
  }

  /** Enforcement passes run so far (specs and diagnostics). */
  get passes(): number {
    return this.passCount;
  }

  /**
   * Past the budget: re-sample every socket, and if the total is still over, cut the sockets holding the most until
   * it is back to the low water. O(sockets + queued frames), which the budget itself bounds (each queued frame counts
   * its overhead), and the low water buys at least budget - lowWater of growth before the next pass; a pass that finds
   * the total under the budget (only stale samples were over) buys `recheck` (1 MiB in production), so the total can
   * pass the budget by at most that before the next pass cuts.
   */
  private enforce(): void {
    if (this.enforcing) return;
    this.enforcing = true;
    this.passCount++;
    try {
      for (const entry of this.entries.values()) this.sample(entry, entry.socket.bufferedAmount);
      if (this.total <= this.budget) {
        // the cached total was stale: nobody is cut. The next pass waits until the total has grown `recheck` past this
        // one (never more than `recheck` past the budget), so a holder parked just under the budget cannot make every
        // send re-sample every socket.
        this.threshold = Math.max(this.budget, this.total + this.recheck);
        return;
      }
      this.threshold = this.budget;
      const ranked = [...this.entries.values()].map((entry) => ({ entry, holding: this.holdingOf(entry) }));
      ranked.sort((a, b) => b.holding - a.holding);
      for (const { entry, holding } of ranked) {
        if (this.total <= this.lowWater) break;
        if (entry.released) continue;
        this.limitLog.log('socket_total_bytes', { heldBytes: Math.round(holding), totalBytes: this.total, budgetBytes: this.budget });
        this.release(entry.socket);
        try {
          entry.socket.terminate();
        } catch {
          // already gone
        }
      }
    } finally {
      this.enforcing = false;
    }
  }

  private written(entry: Entry): void {
    if (entry.released || entry.head >= entry.pending.length) return;
    const key = entry.pending[entry.head];
    entry.pending[entry.head++] = null;
    this.held -= this.frameOverhead;
    this.unref(key);
  }

  private unref(key: Uint8Array | null): void {
    if (key === null) return;
    const shared = this.shared.get(key);
    if (!shared) return;
    if (shared.refs > 1) {
      shared.refs--;
      this.dup -= shared.bytes;
    } else {
      this.shared.delete(key);
    }
  }

  private sample(entry: Entry, buffered: number): void {
    this.held += buffered - entry.sampled;
    entry.sampled = buffered;
  }

  private pendingOf(entry: Entry): number {
    return entry.pending.length - entry.head;
  }

  private chargeOf(entry: Entry): number {
    return entry.sampled + this.pendingOf(entry) * this.frameOverhead + (entry.counted ? entry.inbound : 0);
  }

  /** Its charge, with each payload it shares with other sockets counted at its share (bytes / refs). */
  private holdingOf(entry: Entry): number {
    let discount = 0;
    for (let i = entry.head; i < entry.pending.length; i++) {
      const key = entry.pending[i];
      const shared = key && this.shared.get(key);
      if (shared && shared.refs > 1) discount += shared.bytes - shared.bytes / shared.refs;
    }
    return Math.max(0, this.chargeOf(entry) - discount);
  }
}
