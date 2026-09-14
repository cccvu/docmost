import { Module } from '@nestjs/common';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { CollabDisconnectController } from './collab-disconnect.controller';
import { CollabFlushController } from './collab-flush.controller';
import { CollabServiceSecretGuard } from './service-secret.guard';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Mounts the inbound collab-mediated endpoints the platform calls: force-disconnect (mid-session
 * revocation) and flush-page-content (content settle, issue 282). Imports CollaborationModule for the
 * gateway (to route each event to the doc-owning node); PagePermissionRepo comes from the @Global
 * DatabaseModule. Mounted at the app root (app.module.ts — a documented composition seam) rather than via
 * AuthzModule, to avoid pulling CollaborationModule's heavy graph into the database-module init chain.
 */
@Module({
  imports: [CollaborationModule],
  controllers: [CollabDisconnectController, CollabFlushController],
  providers: [CollabServiceSecretGuard],
})
export class CollabDisconnectModule {}
