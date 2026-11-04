import { Module } from '@nestjs/common';
import { HttpAuthzClient } from './http-authz.client';
import { AuthzModeModule } from './mode/authz-mode.module';
import { NativeRouteAuthzModule } from './native-routes/native-route-authz.module';
import { PageRestrictionModule } from './page-restriction/page-restriction.module';
import { PublicDiscoveryModule } from './public-discovery/public-discovery.module';
import { ServiceBridgeModule } from '../service-bridge/service-bridge.module';
import { ShareLifecycleModule } from './share-lifecycle/share-lifecycle.module';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Provides the platform PDP client. The PDP-backed repo subclasses are bound to the SpaceMemberRepo /
 * PagePermissionRepo tokens in database.module.ts (the single upstream DI seam — see
 * UPSTREAM_MODIFICATIONS.md); they resolve this client + the global repo deps.
 *
 * Also mounts the page-restriction write feature and the anonymous public-content discovery feature
 * (their deps are all @Global, so no upstream edit is needed to register the routes — AuthzModule is
 * already in the graph via database.module), and the remote-mode breadcrumb redaction on a native upstream route
 * (NativeRouteAuthzModule, #574), and the public-share expiry feature (ShareLifecycleModule, #335).
 */
@Module({
  imports: [
    AuthzModeModule,
    NativeRouteAuthzModule, // #574: remote-mode breadcrumb redaction on a native route
    PageRestrictionModule,
    PublicDiscoveryModule,
    ServiceBridgeModule,
    ShareLifecycleModule, // #335: public-share expiry (installer, sweeper, API) — remote only
  ],
  providers: [HttpAuthzClient],
  exports: [AuthzModeModule, HttpAuthzClient],
})
export class AuthzModule {}
