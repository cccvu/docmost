import { Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { PageService } from '../../core/page/services/page.service';
import { boundWaits } from '../../service-bridge/resource-version';
import { queuePageAttachmentDeletion } from './page-attachment-jobs';
import { lockSpacesShared, lockSubtree, spacesOf } from './page-subtree';

/** Upstream's default (`trash-cleanup.service.ts`, pinned by `remote-trash-retention.tripwire.spec.ts`). */
export const DEFAULT_RETENTION_DAYS = 30;
/** Upstream's period, and its interval NAME: the two classes are alternatives under one token, never both. */
export const TRASH_CLEANUP_INTERVAL = 'trash-cleanup';
export const TRASH_CLEANUP_PERIOD_MS = 24 * 60 * 60 * 1000;

export type RetentionSkipReason =
  | 'live_descendant'
  | 'not_expired'
  | 'other_workspace'
  | 'space_archived'
  | 'space_recently_changed'
  | 'subtree_changed';

/** Thrown inside a candidate's transaction to roll it back; logged as a failure, never rethrown. */
class RetentionMismatch extends Error {
  constructor(readonly locked: number, readonly deleted: number) {
    super('retention: the deleted set is not the locked set');
    this.name = 'RetentionMismatch';
  }
}

const sameSet = (a: readonly string[], b: ReadonlySet<string>) => a.length === b.size && a.every((id) => b.has(id));

/**
 * CCC authorization integration — NOT upstream Docmost code (#589, #661).
 *
 * The trash retention in `AUTHZ_MODE=remote`, bound under upstream's `TrashCleanupService` token by
 * `trash-retention.provider.ts` (seam #183) — an alternative, not a subclass, so exactly ONE `'trash-cleanup'`
 * interval exists in either mode. Upstream purges every page trashed longer ago than the workspace's retention, plus
 * EVERY descendant of it through the parent foreign key's cascade, with no lock and no check: a page restored since
 * (live, under a parent still in the trash), a sub-page trashed later (not yet expired), and the pages of an archived
 * space a workspace admin may still restore (#193) all went with it.
 *
 * Here retention purges a trash ROOT (trashed, expired, no trashed parent) in a live space of a live workspace only
 * when, under locks, its WHOLE subtree is trash this job may remove:
 *
 *   per candidate, its own bounded transaction → 1. lock the subtree `FOR UPDATE` (the purge's lock: a restore, a
 *   child insert, a move into it all wait); root gone → skip silently → 2. every locked row trashed, expired, in this
 *   workspace — else skip → 3. hold every space `FOR SHARE`; any archived, or changed since the cutoff, → skip →
 *   4. `forceDelete(trx)`, and the deleted set must BE the locked set → COMMIT → attachment jobs.
 *
 * 3. An unarchive stamps `spaces.updated_at` (`service-space.service.ts`), so the retention clock restarts when a space
 *    is restored: a workspace admin who restores a space has the full retention period to restore its pages. A rename
 *    also stamps it and only postpones retention — the safe direction.
 * Every skip logs `TRASH_RETENTION_SKIPPED page=<id> reason=<reason>`. A lock timeout or any other error logs
 * `TRASH_RETENTION_FAILED` and the run moves on to the next candidate. No decision is asked of the PDP: nobody acts.
 */
export class RemoteTrashRetentionService {
  private readonly logger = new Logger(RemoteTrashRetentionService.name);

  constructor(
    private readonly db: KyselyDB,
    private readonly pageService: PageService,
    private readonly attachmentQueue: Queue,
  ) {}

  @Interval(TRASH_CLEANUP_INTERVAL, TRASH_CLEANUP_PERIOD_MS)
  async cleanupOldTrash(): Promise<void> {
    let workspaces: { id: string; trashRetentionDays: number | null }[];
    try {
      workspaces = await this.db
        .selectFrom('workspaces')
        .select(['id', 'trashRetentionDays'])
        .where('deletedAt', 'is', null)
        .execute();
    } catch (err) {
      this.logger.error(`TRASH_RETENTION_FAILED stage=workspaces: ${(err as Error).message}`);
      return;
    }
    for (const workspace of workspaces) {
      const retentionDays = workspace.trashRetentionDays ?? DEFAULT_RETENTION_DAYS;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - retentionDays);
      let candidates: string[];
      try {
        candidates = await this.candidates(workspace.id, cutoff);
      } catch (err) {
        this.logger.error(`TRASH_RETENTION_FAILED stage=candidates workspace=${workspace.id}: ${(err as Error).message}`);
        continue;
      }
      for (const pageId of candidates) await this.retire(pageId, workspace.id, cutoff);
    }
  }

  /** Expired trash ROOTS (no trashed parent) in live spaces of `workspaceId`, in id order. Re-checked under locks. */
  async candidates(workspaceId: string, cutoff: Date): Promise<string[]> {
    const rows = await this.db
      .selectFrom('pages as p')
      .innerJoin('spaces as s', 's.id', 'p.spaceId')
      .select(['p.id'])
      .where('p.workspaceId', '=', workspaceId)
      .where('p.deletedAt', '<', cutoff)
      .where('s.deletedAt', 'is', null)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('pages as q')
              .select(['q.id'])
              .whereRef('q.id', '=', 'p.parentPageId')
              .where('q.deletedAt', 'is not', null),
          ),
        ),
      )
      .orderBy('p.id')
      .execute();
    return rows.map((r) => r.id);
  }

  /** One candidate in its own transaction: purge it with its subtree, skip it, or log a failure. Never throws. */
  async retire(pageId: string, workspaceId: string, cutoff: Date): Promise<'purged' | 'skipped' | 'failed'> {
    let deleted: string[] | null;
    try {
      deleted = await executeTx(this.db, async (trx) => {
        await boundWaits(trx);
        const rows = await lockSubtree(trx, pageId, workspaceId, 'update');
        if (rows === null) return this.skip(pageId, 'subtree_changed');
        if (rows.length === 0) return null; // already gone (another node, a manual purge): nothing to do
        if (rows.some((r) => r.workspaceId !== workspaceId)) return this.skip(pageId, 'other_workspace');
        if (rows.some((r) => r.deletedAt == null)) return this.skip(pageId, 'live_descendant');
        if (rows.some((r) => !(r.deletedAt! < cutoff))) return this.skip(pageId, 'not_expired');

        const spaces = await lockSpacesShared(trx, spacesOf(rows), workspaceId);
        if (spaces === null || spaces.some((s) => s.deletedAt != null)) return this.skip(pageId, 'space_archived');
        if (spaces.some((s) => !(s.updatedAt < cutoff))) return this.skip(pageId, 'space_recently_changed');

        const ids = new Set(rows.map((r) => r.id));
        const deletedIds = await this.pageService.forceDelete(pageId, workspaceId, trx);
        if (!sameSet(deletedIds, ids)) throw new RetentionMismatch(ids.size, deletedIds.length);
        return deletedIds;
      });
    } catch (err) {
      const detail =
        err instanceof RetentionMismatch
          ? `reason=set_mismatch locked=${err.locked} deleted=${err.deleted}`
          : `code=${(err as { code?: string }).code ?? (err as Error).name}`;
      this.logger.error(`TRASH_RETENTION_FAILED page=${pageId} ${detail}: rolled back, continuing`);
      return 'failed';
    }
    if (deleted === null) return 'skipped';
    // AFTER the commit: a job queued before a rollback would delete the files of a page that survives.
    await queuePageAttachmentDeletion(this.attachmentQueue, deleted, this.logger);
    return 'purged';
  }

  private skip(pageId: string, reason: RetentionSkipReason): null {
    this.logger.log(`TRASH_RETENTION_SKIPPED page=${pageId} reason=${reason}`);
    return null;
  }
}
