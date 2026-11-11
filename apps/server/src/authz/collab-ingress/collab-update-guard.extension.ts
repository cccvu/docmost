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
 * Its one other hook, `afterLoadDocument`, is not on any frame's path: it runs the load repair of legacy values
 * (legacy-repair.ts) once per document lifetime. Hocuspocus 4.7.1 awaits it inside `loadDocument` (after attaching
 * `onUpdate`, before `createDocument` resolves), and a connection, and so every frame, exists only after that; so the
 * guard's shadow and its first-build audit (built on the first frame) see the repaired document. It runs one macrotask
 * turn after the load's `applyUpdate`, never in the same event-loop block. It runs only while the guard enforces: the
 * repair exists so stored values the guard would refuse stop blocking honest edits, and it deletes them, so
 * `COLLAB_UPDATE_GUARD=report` (the ADR 0036 kill switch) turns it off along with the refusals.
 */
import { Logger } from '@nestjs/common';
import type { afterLoadDocumentPayload, beforeHandleMessagePayload } from '@hocuspocus/server';
import { repairLegacyValues } from './legacy-repair';
import { RateLimitedWarn, type SocketLimitLogger } from './socket-limit-log';
import { CollabUpdateGuard, type GuardFrame } from './update-guard';

/** Load-repair lines per token a minute. A read-only page repairs (and logs) on every load until a writer stores it. */
const REPAIR_LOGS_PER_MINUTE = 30;

export class CollabUpdateGuardExtension {
  /** Hocuspocus sorts extensions by priority, highest first (RedisSync is 1000; the rest default to 100). */
  readonly priority = 10_000;
  readonly extensionName = 'CollabUpdateGuard';
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
   * The load repair (legacy-repair.ts). NEVER rejects: a rejection here fails the document's load (every connection to
   * the page). On any failure it logs and carries on; the guard still enforces on every frame. A failure while
   * planning (every read) leaves the document as loaded; a throw inside the one repair transaction would keep the
   * deletes made before it (none of the calls there is known to throw). Logged with counts and rule names only, never a
   * value.
   *
   * Skipped entirely (no yield, no walk, no log) unless the guard is in enforce mode.
   *
   * It first yields one macrotask turn. Hocuspocus chains `onLoadDocument` (the page-sized `applyUpdate`) and this hook
   * with `.then`, so without the yield the repair's page-sized walk would extend that same event-loop block, on every
   * load, readers' and direct connections' included (#731 keeps page-sized work in separate turns). The yield cannot
   * let a frame in first: 4.7.1 awaits this hook inside `loadDocument`, the document is in `documents` only after that
   * resolves (a concurrent open awaits the same loading promise), and a connection is created only after that.
   */
  async afterLoadDocument({ document, documentName }: afterLoadDocumentPayload): Promise<void> {
    if (this.guard.mode !== 'enforce') return;
    const pageId = String(documentName ?? '').replace(/^page\./, '');
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const r = this.repair(document);
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
