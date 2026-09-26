import { Module } from '@nestjs/common';
import { PageAccessModule } from '../../core/page/page-access/page-access.module';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { CommentResolutionController } from './comment-resolution.controller';
import { CommentResolutionService } from './comment-resolution.service';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Mounts comment resolve / reopen (#615). Imports PageAccessModule for `validateCanComment` and
 * CollaborationModule for the gateway that updates an inline comment's highlight. Kysely, PageRepo and
 * CommentRepo come from the @Global Kysely/DatabaseModule, WsService from the @Global WsModule, the
 * notification queue from the @Global QueueModule and AUDIT_SERVICE from the @Global PlatformAuditModule.
 *
 * Mounted at the app root (app.module.ts, seam #4) rather than via AuthzModule, for the same reason as
 * ConditionalPageModule: to keep CollaborationModule's heavy graph out of the database-module init chain.
 */
@Module({
  imports: [PageAccessModule, CollaborationModule],
  controllers: [CommentResolutionController],
  providers: [CommentResolutionService],
})
export class CommentResolutionModule {}
