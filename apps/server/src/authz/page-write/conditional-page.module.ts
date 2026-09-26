import { Module } from '@nestjs/common';
import { PageModule } from '../../core/page/page.module';
import { PageAccessModule } from '../../core/page/page-access/page-access.module';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { ConditionalPageController } from './conditional-page.controller';
import { ConditionalPageOpsController } from './conditional-page-ops.controller';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Mounts the compare-and-swap page write (#282, ADR 0019). Imports PageModule for `PageService` (the
 * shared content parser + the metadata update, so this path keeps the ordinary update's side effects),
 * PageAccessModule for the `validateCanEdit` re-check, and CollaborationModule for the gateway that routes
 * the conditional apply to the doc-owning node. PageRepo comes from the @Global DatabaseModule.
 *
 * Also mounts the #616 atomic compare-and-write page operations (`ConditionalPageOpsController`: conditional trash /
 * permanent delete / move / move-to-space / metadata update), which need the same PageService + PageAccessService;
 * SpaceAbilityFactory (CaslModule), AUDIT_SERVICE and the attachment queue (QueueModule) are global.
 *
 * Mounted at the app root (app.module.ts — a documented composition seam) rather than via AuthzModule, for
 * the same reason as CollabDisconnectModule: to keep CollaborationModule's heavy graph out of the
 * database-module init chain.
 */
@Module({
  imports: [PageModule, PageAccessModule, CollaborationModule],
  controllers: [ConditionalPageController, ConditionalPageOpsController],
})
export class ConditionalPageModule {}
