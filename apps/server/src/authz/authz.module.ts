import { Module } from '@nestjs/common';
import { HttpAuthzClient } from './http-authz.client';
import { AuthzModeModule } from './mode/authz-mode.module';
import { NativeRouteAuthzModule } from './native-routes/native-route-authz.module';
import { PageRestrictionModule } from './page-restriction/page-restriction.module';
import { PublicDiscoveryModule } from './public-discovery/public-discovery.module';
import { ServiceBridgeModule } from '../service-bridge/service-bridge.module';
import { ShareLifecycleModule } from './share-lifecycle/share-lifecycle.module';
import { ExportAdmissionModule } from './request-controls/export-admission.module';
import { RetryAfterModule } from './request-controls/retry-after.module';
import { NativeFormatModule } from './native-format/native-format.module';

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
 * (NativeRouteAuthzModule, #574), and the public-share expiry feature (ShareLifecycleModule, #335), and the native
 * export admission (ExportAdmissionModule, #699: a resource bound, in both modes), and the engine-wide `Retry-After` on
 * every 503 (RetryAfterModule, #696), and the remote-mode refusal of a non-json `format` on the native page routes
 * (NativeFormatModule, #716: their echo converts a whole page on the event loop).
 */
@Module({
  imports: [
    AuthzModeModule,
    NativeRouteAuthzModule, // #574: remote-mode breadcrumb redaction on a native route
    PageRestrictionModule,
    PublicDiscoveryModule,
    ServiceBridgeModule,
    ShareLifecycleModule, // #335: public-share expiry (installer, sweeper, API) — remote only
    ExportAdmissionModule, // #699: at most 1 heavy export per principal, 8 per process — both modes
    RetryAfterModule, // #696: every 503 carries Retry-After (kept when already set) — both modes
    NativeFormatModule, // #716: remote mode refuses a non-json `format` on native /api/pages/info|create|update
  ],
  providers: [HttpAuthzClient],
  exports: [AuthzModeModule, HttpAuthzClient],
})
export class AuthzModule {}
