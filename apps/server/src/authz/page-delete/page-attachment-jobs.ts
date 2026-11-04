import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QueueJob } from '../../integrations/queue/constants';

/**
 * CCC authorization integration — NOT upstream Docmost code (#616, #636).
 *
 * The attachment-deletion jobs `PageService.forceDelete` queues on its own path — same job name, id and retry policy
 * (pinned against the upstream source by `conditional-page-ops.tripwire.spec.ts`). A caller that runs `forceDelete`
 * inside its own transaction (the conditional delete, the remote purge) gets NO jobs from it, and queues them here
 * AFTER its commit: a job queued before a delete that then rolled back would delete the files of a page that survives.
 * A failure cannot undo the committed delete, so it is logged (files left in storage), never turned into an error.
 */
export async function queuePageAttachmentDeletion(queue: Queue, pageIds: readonly string[], logger: Logger): Promise<void> {
  for (const id of pageIds) {
    try {
      await queue.add(
        QueueJob.DELETE_PAGE_ATTACHMENTS,
        { pageId: id },
        {
          jobId: `delete-page-attachments-${id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    } catch (err) {
      logger.error(
        `PAGE_ATTACHMENT_CLEANUP_ENQUEUE_FAILED page=${id}: the page is deleted but its attachment files were not queued for deletion: ${(err as Error).message}`,
      );
    }
  }
}
