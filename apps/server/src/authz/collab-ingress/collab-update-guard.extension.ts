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
 * guard's shadow and its first-build audit (built on the first frame) see the repaired document.
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
   * The load repair (legacy-repair.ts). NEVER throws: a throw here fails the document's load (every connection to the
   * page). On any failure it logs and leaves the document as loaded; the guard still enforces on every frame.
   * Logged with counts and rule names only, never a value.
   */
  afterLoadDocument({ document, documentName }: afterLoadDocumentPayload): Promise<void> {
    const pageId = String(documentName ?? '').replace(/^page\./, '');
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
    return undefined as unknown as Promise<void>;
  }
}
