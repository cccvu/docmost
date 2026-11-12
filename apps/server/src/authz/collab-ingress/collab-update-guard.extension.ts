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
 * #827 adds three hooks, each doing its #827 work synchronously (a throw, never a rejection after an await) and first
 * in its chain:
 *   - `connected`: a join to a resident document that is compacting, draining or superseded closes the socket 1013 with
 *     the compacting reason (the editor waits read-only and retries; the next load is the new lineage), so a socket that
 *     joined during a drain and never sends a frame cannot keep the document resident. Deliberately AFTER
 *     authentication: 4.7.1 runs `onAuthenticate` hooks by priority and this extension outranks the auth extension, so a
 *     join gate there would tell a client holding nothing but a page id that the page exists and is compacting. The
 *     frames a socket queued before it was authenticated reach the frame hook first (4.7.1 drains the queue, then runs
 *     `connected`), which closes it the same way. Never throws: 4.7.1 awaits `connected` inside the auth path's try, and
 *     a throw there would answer permission-denied to a socket already authenticated.
 *   - `onLoadDocument`: a SOCKET's load is refused try-later while its user is in collab CPU debt. Thrown before any
 *     await in the load chain, so no co-loader can share the rejection (4.7.1 reaches this hook through microtasks only,
 *     and no extension defines `onCreateDocument`). A DirectConnection (the API, no `sec-websocket-key`) is never gated.
 *     It then times the load's Yjs transactions (`beforeAllTransactions` to `afterAllTransactions`), never the row read.
 *   - `afterLoadDocument`: charges that time to the socket that caused the load, first, before it yields. Total: a
 *     throw would leak a loaded document. A load that failed (its meter or deadline tripped; a deadline skips Yjs's
 *     cleanup, so `afterAllTransactions` never fires) is charged when Hocuspocus destroys the document.
 *
 * `afterLoadDocument` is not on any frame's path; after the charge it runs the load repair of legacy values
 * (legacy-repair.ts) once per document lifetime. Hocuspocus 4.7.1 awaits it inside `loadDocument` (after attaching
 * `onUpdate`, before `createDocument` resolves), and a connection, and so every frame, exists only after that; so the
 * guard's shadow and its first-build audit (built on the first frame) see the repaired document. It runs one macrotask
 * turn after the load's `applyUpdate`, never in the same event-loop block. It runs only while the guard enforces: the
 * repair exists so stored values the guard would refuse stop blocking honest edits, and it deletes them, so
 * `COLLAB_UPDATE_GUARD=report` (the ADR 0036 kill switch) turns it off along with the refusals.
 */
import { Logger } from '@nestjs/common';
import type {
  afterLoadDocumentPayload,
  beforeHandleMessagePayload,
  connectedPayload,
  onLoadDocumentPayload,
} from '@hocuspocus/server';
import type * as Y from 'yjs';
import { COLLAB_LOAD_TRY_LATER_REASON, COLLAB_PAGE_COMPACTING_REASON } from './collab-reasons';
import { noteLoadRepaired } from '../page-write/compaction';
import { storeGenerationOf } from '../page-write/store-failure-registry';
import { repairLegacyValues } from './legacy-repair';
import { RateLimitedWarn, type SocketLimitLogger } from './socket-limit-log';
import { COLLAB_TRY_LATER_CODE, CollabUpdateGuard, type GuardFrame } from './update-guard';

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

/** Load-repair lines per token a minute. A read-only page repairs (and logs) on every load until a writer stores it. */
const REPAIR_LOGS_PER_MINUTE = 30;

export class CollabUpdateGuardExtension {
  /** Hocuspocus sorts extensions by priority, highest first (RedisSync is 1000; the rest default to 100). */
  readonly priority = 10_000;
  readonly extensionName = 'CollabUpdateGuard';
  private readonly loads = new WeakMap<object, LoadTiming>();
  private readonly repair: typeof repairLegacyValues;
  private readonly repairLog: RateLimitedWarn<'COLLAB_LEGACY_REPAIRED' | 'COLLAB_LEGACY_REPAIR_FAILED'>;

  constructor(
    readonly guard: CollabUpdateGuard = new CollabUpdateGuard(),
    opts: { logger?: SocketLimitLogger; repair?: typeof repairLegacyValues; now?: () => number } = {},
  ) {
    this.repair = opts.repair ?? repairLegacyValues;
    this.repairLog = new RateLimitedWarn({
      logger: opts.logger ?? new Logger('CollabUpdateGuard'),
      perKey: REPAIR_LOGS_PER_MINUTE,
      summary: (of, count) => `COLLAB_GUARD_LOG_SUPPRESSED ${JSON.stringify({ of, count })}`,
      now: opts.now,
    });
  }

  /**
   * Returns undefined (apply) or throws `{ code: 4422, reason }` (Hocuspocus closes that document session with the
   * reason), synchronously. NEVER async and never a promise: typed as Hocuspocus's promise-returning hook only so the
   * extension is assignable to its `Extension` type.
   */
  beforeHandleMessage(payload: beforeHandleMessagePayload): Promise<void> {
    this.guard.check(payload as unknown as GuardFrame);
    return undefined as unknown as Promise<void>;
  }

  /**
   * #827: a socket that joined a resident document closed for compaction (its auth passed after the drain started) is
   * closed 1013 with the compacting reason. Post-authentication only (see the header). Synchronous, never throws.
   */
  connected(payload: connectedPayload): Promise<void> {
    try {
      const { connection } = payload;
      const socket = connection?.webSocket as { readyState?: number; close(code: number, reason: string): void } | undefined;
      // A socket its queued frames already closed (the frame hook) is not refused or logged twice.
      if (socket && (socket.readyState ?? 1) <= 1 && !this.guard.admitJoin(connection.document, userOf(payload.context))) {
        socket.close(COLLAB_TRY_LATER_CODE, COLLAB_PAGE_COMPACTING_REASON);
      }
    } catch {
      // never out of this hook
    }
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

  /**
   * The load repair (legacy-repair.ts). NEVER rejects: a rejection here fails the document's load (every connection to
   * the page). On any failure it logs and carries on; the guard still enforces on every frame. A failure while
   * planning (every read) leaves the document as loaded; a throw inside the one repair transaction would keep the
   * deletes made before it (none of the calls there is known to throw). Logged with counts and rule names only, never a
   * value.
   *
   * #827 first: the load's charge (`finishLoad`), before any yield and in every mode. The repair is then skipped
   * entirely (no yield, no walk, no log) unless the guard is in enforce mode.
   *
   * It first yields one macrotask turn. Hocuspocus chains `onLoadDocument` (the page-sized `applyUpdate`) and this hook
   * with `.then`, so without the yield the repair's page-sized walk would extend that same event-loop block, on every
   * load, readers' and direct connections' included (#731 keeps page-sized work in separate turns). The yield cannot
   * let a frame in first: 4.7.1 awaits this hook inside `loadDocument`, the document is in `documents` only after that
   * resolves (a concurrent open awaits the same loading promise), and a connection is created only after that.
   */
  async afterLoadDocument({ document, documentName }: afterLoadDocumentPayload): Promise<void> {
    try {
      this.finishLoad(document as unknown as Y.Doc); // #827: charge the load first, never out of this hook
    } catch {
      // never out of this hook
    }
    if (this.guard.mode !== 'enforce') return;
    const pageId = String(documentName ?? '').replace(/^page\./, '');
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const before = storeGenerationOf(document);
      const r = this.repair(document);
      // #827: a repaired document still holds its row for compaction (a drain requested at load must still compact)
      if (storeGenerationOf(document) !== before) noteLoadRepaired(document, before);
      if (r.attrs || r.marks || r.skipped) {
        this.repairLog.warn('COLLAB_LEGACY_REPAIRED', () =>
          `COLLAB_LEGACY_REPAIRED ${JSON.stringify({ pageId, attrs: r.attrs, marks: r.marks, spills: r.spills, skipped: r.skipped, rules: r.rules })}`,
        );
      }
    } catch {
      this.repairLog.warn('COLLAB_LEGACY_REPAIR_FAILED', () => `COLLAB_LEGACY_REPAIR_FAILED ${JSON.stringify({ pageId })}`);
    }
  }
}
