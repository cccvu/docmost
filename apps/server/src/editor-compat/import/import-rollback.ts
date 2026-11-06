/**
 * CCC integration — NOT upstream Docmost code (#716 I2, seam #176).
 *
 * `ImportAttachmentService` writes attachment rows and objects OUTSIDE the zip import's transaction, so a rolled-back
 * import leaves both behind. This queues their deletion (the same job, id and retry as `forceDelete`) ONLY when the
 * rollback is certain, and otherwise deletes nothing. Deleting a committed page's attachments cannot be undone; leaking
 * a rolled-back page's files only costs storage (what upstream always did).
 *
 * The caller says how far the transaction got (`bodyFinished`):
 * - `false`: the transaction callback threw, so Kysely rolled it back and COMMIT was never sent. No attempted page
 *   can exist (their ids are fresh v7s minted by this import), so every attempted page's attachments are queued.
 * - `true`: the callback finished, so the failure came from COMMIT or after it was sent. The server may have
 *   committed (a reset or timeout after COMMIT), so the outcome is unknown: nothing is queued, and one
 *   `IMPORT_ROLLBACK_CLEANUP outcome=unknown cleanup=skipped` line is logged. A "do the pages exist?" read cannot
 *   settle it: it can run before the commit becomes visible.
 */
import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { queuePageAttachmentDeletion } from '../../authz/page-delete/page-attachment-jobs';

export async function queueRolledBackImportAttachmentDeletion(
  queue: Queue,
  attemptedPageIds: readonly string[],
  tx: { bodyFinished: boolean },
  logger: Pick<Logger, 'error' | 'warn' | 'log'>,
): Promise<void> {
  if (attemptedPageIds.length === 0) return;
  if (tx.bodyFinished) {
    logger.warn(
      `IMPORT_ROLLBACK_CLEANUP outcome=unknown cleanup=skipped pages=${attemptedPageIds.length}: the import failed at or after COMMIT, so it may have committed; none of the attachments it uploaded were queued for deletion (a rolled-back page's files are left in storage)`,
    );
    return;
  }
  logger.log(
    `IMPORT_ROLLBACK_CLEANUP outcome=rolled_back cleanup=queued pages=${attemptedPageIds.length}: the import's transaction rolled back before COMMIT; the attachments it uploaded are queued for deletion`,
  );
  await queuePageAttachmentDeletion(queue, attemptedPageIds, logger as Logger);
}
