/**
 * CCC authorization integration — NOT upstream Docmost code (#781, ADR 0036).
 *
 * The Hocuspocus extension that puts the collab update guard (update-guard.ts) in front of every client frame. Its frame
 * hook, `beforeHandleMessage`, is the first Hocuspocus 4.7.1 hook a frame meets and the only one every frame meets
 * before it applies (4.7.1 then awaits `beforeSync` for a Sync frame and `beforeHandleAwareness` for an awareness frame;
 * `onChange` runs after the apply). Registered FIRST by the gateway (seam #3) and outranking every other extension, and
 * deliberately synchronous: Hocuspocus chains the hooks of each frame as promises, and frames of different connections
 * apply in the order they were checked only while every frame's path from check to apply has the same length. It is
 * the only `beforeHandleMessage` in the server, and no `beforeSync` or `beforeHandleAwareness` hook exists
 * (collab-update-guard.wiring.spec.ts).
 *
 * #827 adds three hooks, each synchronous (a throw, never a rejection after an await) and first in its chain:
 *   - `onAuthenticate`: a join to a resident document that is compacting, draining or superseded is refused with the
 *     compacting try-later reason (the editor waits read-only and retries; the next load is the new lineage).
 *   - `onLoadDocument`: a SOCKET's load is refused try-later while its user is in collab CPU debt. Thrown before any
 *     await in the load chain, so no co-loader can share the rejection (4.7.1 reaches this hook through microtasks only,
 *     and no extension defines `onCreateDocument`). A DirectConnection (the API, no `sec-websocket-key`) is never gated.
 *     It then times the load's Yjs transactions (`beforeAllTransactions` to `afterAllTransactions`), never the row read.
 *   - `afterLoadDocument`: charges that time to the socket that caused the load. Total: 4.7.1 awaits it outside its
 *     try, so a throw would leak a loaded document. A load that failed (its meter or deadline tripped; a deadline skips
 *     Yjs's cleanup, so `afterAllTransactions` never fires) is charged when Hocuspocus destroys the document.
 */
import type {
  afterLoadDocumentPayload,
  beforeHandleMessagePayload,
  onAuthenticatePayload,
  onLoadDocumentPayload,
} from '@hocuspocus/server';
import type * as Y from 'yjs';
import { COLLAB_LOAD_TRY_LATER_REASON, pageCompactingRefusal } from './collab-reasons';
import { CollabUpdateGuard, type GuardFrame } from './update-guard';

/** One load being timed: CPU ms of its Yjs transactions so far, and the transaction open now. */
type LoadTiming = { user: string | null; ms: number; openedAt: number | null; wallStarted: number; detach: () => void };

const userOf = (context: unknown): string => String((context as { user?: { id?: unknown } } | undefined)?.user?.id ?? '');

/**
 * A websocket's request carries `sec-websocket-key` (the gateway's server-made UUID on the RedisSync path, the
 * client's own otherwise); `openDirectConnection` builds `new Request('http://localhost')`, which has none.
 */
function isSocketLoad(headers: unknown): boolean {
  if (!headers || typeof headers !== 'object') return false;
  const h = headers as { has?: (name: string) => boolean } & Record<string, unknown>;
  if (typeof h.has === 'function') return h.has('sec-websocket-key');
  return h['sec-websocket-key'] !== undefined;
}

export class CollabUpdateGuardExtension {
  /** Hocuspocus sorts extensions by priority, highest first (RedisSync is 1000; the rest default to 100). */
  readonly priority = 10_000;
  readonly extensionName = 'CollabUpdateGuard';
  private readonly loads = new WeakMap<object, LoadTiming>();

  constructor(readonly guard: CollabUpdateGuard = new CollabUpdateGuard()) {}

  /**
   * Returns undefined (apply) or throws `{ code: 4422, reason }` (Hocuspocus closes that document session with the
   * reason), synchronously. NEVER async and never a promise: typed as Hocuspocus's promise-returning hook only so the
   * extension is assignable to its `Extension` type.
   */
  beforeHandleMessage(payload: beforeHandleMessagePayload): Promise<void> {
    this.guard.check(payload as unknown as GuardFrame);
    return undefined as unknown as Promise<void>;
  }

  /** #827: refuses (throws `{ reason }`) a join to a resident document closed for compaction. Synchronous. */
  onAuthenticate(payload: onAuthenticatePayload): Promise<void> {
    const resident = (payload.instance as unknown as { documents?: Map<string, object> } | undefined)?.documents?.get(payload.documentName);
    if (!this.guard.admitJoin(resident, userOf(payload.context))) throw pageCompactingRefusal();
    return undefined as unknown as Promise<void>;
  }

  /** #827: the CPU-debt gate for a socket's load, then the load's timing. Synchronous; throws `{ reason }`. */
  onLoadDocument(payload: onLoadDocumentPayload): Promise<void> {
    const socket = isSocketLoad(payload.requestHeaders);
    const user = userOf(payload.context);
    if (socket && !this.guard.admitLoad(user)) throw { reason: COLLAB_LOAD_TRY_LATER_REASON };
    this.timeLoad(payload.document as unknown as Y.Doc, socket ? user : null);
    return undefined as unknown as Promise<void>;
  }

  /** #827: charges the load. Never throws and never rejects. */
  afterLoadDocument(payload: afterLoadDocumentPayload): Promise<void> {
    try {
      this.finishLoad(payload.document as unknown as Y.Doc);
    } catch {
      // never out of this hook
    }
    return undefined as unknown as Promise<void>;
  }

  private timeLoad(doc: Y.Doc, user: string | null): void {
    this.finishLoad(doc); // a hook re-run on the same document: settle the earlier timing first
    const timing: LoadTiming = { user, ms: 0, openedAt: null, wallStarted: this.guard.wallClock(), detach: () => undefined };
    const opened = () => {
      if (timing.openedAt === null) timing.openedAt = this.guard.cpuClock();
    };
    const closed = () => {
      if (timing.openedAt === null) return;
      timing.ms += this.guard.cpuClock() - timing.openedAt;
      timing.openedAt = null;
    };
    const destroyed = () => {
      try {
        this.finishLoad(doc);
      } catch {
        // never out of a Yjs listener
      }
    };
    doc.on('beforeAllTransactions', opened);
    doc.on('afterAllTransactions', closed);
    doc.on('destroy', destroyed);
    timing.detach = () => {
      doc.off('beforeAllTransactions', opened);
      doc.off('afterAllTransactions', closed);
      doc.off('destroy', destroyed);
    };
    this.loads.set(doc, timing);
  }

  /** Detach the load's listeners and charge its transactions' time (a transaction a deadline cut counts until now). */
  private finishLoad(doc: Y.Doc): void {
    const timing = this.loads.get(doc);
    if (!timing) return;
    this.loads.delete(doc);
    timing.detach();
    if (timing.openedAt !== null) timing.ms += this.guard.cpuClock() - timing.openedAt;
    timing.openedAt = null;
    if (timing.user !== null && timing.ms > 0) this.guard.chargeLoad(timing.user, timing.ms, timing.wallStarted);
  }
}
