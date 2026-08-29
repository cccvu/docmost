import { Module } from '@nestjs/common';
import { PlatformAuthzClient } from './platform-authz.client';
import { PageRestrictionModule } from './page-restriction/page-restriction.module';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Provides the platform PDP client. The PDP-backed repo subclasses are bound to the SpaceMemberRepo /
 * PagePermissionRepo tokens in database.module.ts (the single upstream DI seam — see
 * UPSTREAM_MODIFICATIONS.md); they resolve this client + the global repo deps.
 *
 * Also mounts the page-restriction write feature (its deps are all @Global, so no upstream edit is
 * needed to register the routes — AuthzModule is already in the graph via database.module).
 */
@Module({
  imports: [PageRestrictionModule],
  providers: [PlatformAuthzClient],
  exports: [PlatformAuthzClient],
})
export class AuthzModule {}
