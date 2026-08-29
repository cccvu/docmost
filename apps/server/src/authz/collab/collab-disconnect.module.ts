import { Module } from '@nestjs/common';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { CollabDisconnectController } from './collab-disconnect.controller';
import { CollabServiceSecretGuard } from './service-secret.guard';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Mounts the inbound force-disconnect endpoint. Imports CollaborationModule for the gateway (to route
 * the disconnect cross-node); PagePermissionRepo comes from the @Global DatabaseModule. Mounted at the
 * app root (app.module.ts — a documented composition seam) rather than via AuthzModule, to avoid
 * pulling CollaborationModule's heavy graph into the database-module init chain.
 */
@Module({
  imports: [CollaborationModule],
  controllers: [CollabDisconnectController],
  providers: [CollabServiceSecretGuard],
})
export class CollabDisconnectModule {}
