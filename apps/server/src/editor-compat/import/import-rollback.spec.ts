import { QueueJob } from '../../integrations/queue/constants';
import { queueRolledBackImportAttachmentDeletion } from './import-rollback';

/**
 * CCC #716 I2 (review): a failed zip import's attachments are deleted only when the rollback is certain. A failure at
 * or after COMMIT may have committed, so it deletes nothing: a leak is recoverable, a committed page's lost
 * attachments are not.
 */
describe('queueRolledBackImportAttachmentDeletion (#716 I2)', () => {
  const setup = () => {
    const queue = { add: jest.fn(async () => undefined) };
    const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    return { queue, logger };
  };
  const ids = ['p-1', 'p-2', 'p-3'];

  it('a certain rollback (the callback threw before COMMIT) queues the deletion of every attempted page', async () => {
    const { queue, logger } = setup();
    await queueRolledBackImportAttachmentDeletion(
      queue as never,
      ids,
      { bodyFinished: false },
      logger,
    );
    expect(queue.add.mock.calls).toEqual(
      ids.map((id) => [
        QueueJob.DELETE_PAGE_ATTACHMENTS,
        { pageId: id },
        expect.objectContaining({ jobId: `delete-page-attachments-${id}` }),
      ]),
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'IMPORT_ROLLBACK_CLEANUP outcome=rolled_back cleanup=queued pages=3',
      ),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('an unknown outcome (the failure came at or after COMMIT) queues nothing and says so', async () => {
    const { queue, logger } = setup();
    await queueRolledBackImportAttachmentDeletion(
      queue as never,
      ids,
      { bodyFinished: true },
      logger,
    );
    expect(queue.add).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'IMPORT_ROLLBACK_CLEANUP outcome=unknown cleanup=skipped pages=3',
      ),
    );
  });

  it('nothing attempted: nothing queued, nothing logged', async () => {
    const { queue, logger } = setup();
    await queueRolledBackImportAttachmentDeletion(
      queue as never,
      [],
      { bodyFinished: false },
      logger,
    );
    expect(queue.add).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
