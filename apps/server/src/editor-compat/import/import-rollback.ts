/**
 * CCC integration — NOT upstream Docmost code (#716 I2, seam #176).
 *
 * After a zip import failed before its transaction was KNOWN to commit, queue the attachment deletion (objects and
 * rows, which `processAttachments` wrote outside the transaction) of every attempted page that does not exist. Only
 * the absent ones: a COMMIT can fail ambiguously (the connection reset after the server committed), and then pages that
 * did commit must keep their attachments. Page ids are fresh v7s minted by this import, so "the row exists" means "it
 * committed".
 *
 * If the existence check itself fails, nothing is deleted (logged): leaking a rolled-back page's files is recoverable,
 * deleting a committed page's attachments is not.
 */
import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { KyselyDB } from '@docmost/db/types/kysely.types';
import { queuePageAttachmentDeletion } from '../../authz/page-delete/page-attachment-jobs';

const CHUNK = 1000;

export async function queueRolledBackImportAttachmentDeletion(
  db: KyselyDB,
  queue: Queue,
  attemptedPageIds: readonly string[],
  logger: Pick<Logger, 'error'>,
): Promise<void> {
  if (attemptedPageIds.length === 0) return;
  const existing = new Set<string>();
  try {
    for (let i = 0; i < attemptedPageIds.length; i += CHUNK) {
      const rows = await db
        .selectFrom('pages')
        .select('id')
        .where('id', 'in', attemptedPageIds.slice(i, i + CHUNK) as string[])
        .execute();
      for (const r of rows) existing.add(r.id);
    }
  } catch (err) {
    logger.error(
      `PAGE_ATTACHMENT_CLEANUP_ENQUEUE_FAILED import: could not tell which of ${attemptedPageIds.length} attempted pages committed, so none of their attachments were queued for deletion: ${(err as Error).message}`,
    );
    return;
  }
  const absent = attemptedPageIds.filter((id) => !existing.has(id));
  await queuePageAttachmentDeletion(queue, absent, logger as Logger);
}
