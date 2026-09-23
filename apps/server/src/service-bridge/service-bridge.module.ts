import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ServiceBridgeController } from './service-bridge.controller';
import { ServiceBridgeService } from './service-bridge.service';
import { ServiceAuthGuard } from './service-auth.guard';
import { WorkspaceResolver } from './workspace-resolver';
import { ServiceWorkspaceController } from './service-workspace.controller';
import { ServiceWorkspaceService } from './service-workspace.service';
import { ServiceSpaceController } from './service-space.controller';
import { ServiceSpaceService } from './service-space.service';
import { ServicePageController } from './service-page.controller';
import { ServiceContentController } from './service-content.controller';
import { ServiceContentService } from './service-content.service';
import { ServiceSearchService } from './service-search.service';
import { ServiceAttachmentController } from './service-attachment.controller';
import { ServiceAttachmentService } from './service-attachment.service';
import { AuthzChangeController } from './authz-change.controller';
import { AuthzChangeFeedService } from './authz-change-feed.service';
import { AuthzSnapshotService } from './authz-snapshot.service';
import { ServicePageLifecycleService } from './service-page-lifecycle.service';
import { PageCycleGuardInstaller } from './page-cycle-guard.installer';
import { AuthzOutboxInstaller } from './authz-outbox.installer';
import { PageAuthzStateService } from './page-authz-state.service';
import { PageRestrictionGuardInstaller } from './page-restriction-guard.installer';
import { PageGuardConflictInterceptor } from './page-guard-conflict.interceptor';
// Seam #5 (see UPSTREAM_MODIFICATIONS.md): SearchModule binds the SearchService token to PdpSearchService in
// AUTHZ_MODE=remote. Importing it here lets ServiceSearchService inject that PDP-gated search — the binding
// is module-local, so the token must be resolved through the module that exports it (a @Global rebind can't
// win). No cycle: SearchModule imports no modules (its provider deps are all @Global).
import { SearchModule } from '../core/search/search.module';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Mounts the east-west `/api/service/*` endpoints (session brokerage + provisioning + the Phase C
 * reverse-coupling surface: workspace settings, the space/membership control plane, and the `/v1`
 * content read model). Its deps — SessionService (@Global SessionModule), UserRepo + Kysely (@Global
 * DatabaseModule), EnvironmentService (@Global), the @Global AUTHZ_MODE token + RemoteOnlyGuard, and
 * Reflector — are all globally available, so this module is registered via AuthzModule (already in the
 * graph) with NO app.module edit. Every route is gated by RemoteOnlyGuard (404 unless AUTHZ_MODE=remote)
 * then the scoped ServiceAuthGuard (which fails closed without a service secret), so the surface is off by
 * ENFORCEMENT in native mode, not by the accident of a missing secret.
 */
@Module({
  imports: [SearchModule],
  controllers: [
    ServiceBridgeController,
    ServiceWorkspaceController,
    ServiceSpaceController,
    ServicePageController,
    ServiceContentController,
    ServiceAttachmentController,
    AuthzChangeController,
  ],
  providers: [
    ServiceBridgeService,
    ServiceWorkspaceService,
    ServiceSpaceService,
    ServiceContentService,
    ServiceSearchService,
    ServiceAttachmentService,
    AuthzChangeFeedService,
    AuthzSnapshotService,
    AuthzOutboxInstaller,
    WorkspaceResolver,
    ServiceAuthGuard,
    ServicePageLifecycleService, // #485 (appended)
    PageCycleGuardInstaller, // #485 (appended)
    PageAuthzStateService, // #545 (appended)
    PageRestrictionGuardInstaller, // #493/#545 (appended)
    // #493/#545: the page guards' DB refusals → 409 (inner to AppModule's audit interceptor; see the class).
    { provide: APP_INTERCEPTOR, useClass: PageGuardConflictInterceptor },
  ],
})
export class ServiceBridgeModule {}
