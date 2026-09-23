import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { CollabDisconnectController } from './collab-disconnect.controller';
import { CollabFlushController } from './collab-flush.controller';
import { CollabServiceSecretGuard } from './service-secret.guard';
import { HttpAuthzClient } from '../http-authz.client';
import { LiveAccessRevalidator } from '../live-access/live-access.revalidator';
import { NarrowingSettleInterceptor } from '../live-access/narrowing-settle.interceptor';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Mounts the inbound collab-mediated endpoints the platform calls: live-connection revalidation (#501) and
 * account-disable force-disconnect (#455), and flush-page-content (content settle, issue 282). Imports
 * CollaborationModule for the gateway; UserRepo/PageRepo come from the @Global DatabaseModule and WsGateway
 * from the @Global WsModule. The revalidator (and its periodic sweep) lives here because it needs the collab
 * gateway; the PDP client is provided locally (stateless, env-configured — the same pattern as
 * PageRestrictionModule). Mounted at the app root (app.module.ts — a documented composition seam) rather than via
 * AuthzModule, to avoid pulling CollaborationModule's heavy graph into the database-module init chain.
 *
 * It also registers the narrowing-route settle interceptor (#501 Part B) as an APP_INTERCEPTOR, here rather than in
 * app.module.ts so no upstream file changes: it needs the revalidator, and it acts only on the routes listed in
 * `live-access/narrowing-routes.ts`.
 */
@Module({
  imports: [CollaborationModule],
  controllers: [CollabDisconnectController, CollabFlushController],
  providers: [
    CollabServiceSecretGuard,
    HttpAuthzClient,
    LiveAccessRevalidator,
    { provide: APP_INTERCEPTOR, useClass: NarrowingSettleInterceptor },
  ],
})
export class CollabDisconnectModule {}
