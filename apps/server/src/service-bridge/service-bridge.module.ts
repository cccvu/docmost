import { Module } from '@nestjs/common';
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
  controllers: [
    ServiceBridgeController,
    ServiceWorkspaceController,
    ServiceSpaceController,
    ServicePageController,
    ServiceContentController,
  ],
  providers: [
    ServiceBridgeService,
    ServiceWorkspaceService,
    ServiceSpaceService,
    ServiceContentService,
    WorkspaceResolver,
    ServiceAuthGuard,
  ],
})
export class ServiceBridgeModule {}
