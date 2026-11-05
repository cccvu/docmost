import { Provider } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { TrashCleanupService } from '../../core/page/services/trash-cleanup.service';
import { PageService } from '../../core/page/services/page.service';
import { QueueName } from '../../integrations/queue/constants';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { RemoteTrashRetentionService } from './remote-trash-retention.service';

/**
 * CCC authorization integration — NOT upstream Docmost code (#589, #661).
 *
 * The trash retention, mode-selected under upstream's `TrashCleanupService` token (the `repo-providers.ts` pattern):
 * `native` → the stock upstream class, unchanged; `remote` → `RemoteTrashRetentionService`, which purges only an
 * expired trash subtree that is ALL expired trash, in live spaces, under locks. One provider, one instance, so
 * exactly ONE `'trash-cleanup'` interval is registered in either mode (`trash-retention.di.spec.ts`). Registered in
 * core/page/page.module.ts (seam #183) in place of the bare class; nothing injects the token.
 */
export const trashCleanupProvider: Provider = {
  provide: TrashCleanupService,
  inject: [AUTHZ_MODE, KYSELY_MODULE_CONNECTION_TOKEN(), getQueueToken(QueueName.ATTACHMENT_QUEUE), PageService],
  useFactory: (
    mode: AuthzMode,
    db: KyselyDB,
    attachmentQueue: Queue,
    pageService: PageService,
  ): TrashCleanupService | RemoteTrashRetentionService =>
    mode === 'remote'
      ? new RemoteTrashRetentionService(db, pageService, attachmentQueue)
      : new TrashCleanupService(db, attachmentQueue),
};
