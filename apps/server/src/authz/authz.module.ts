import { Module } from '@nestjs/common';
import { PlatformAuthzClient } from './platform-authz.client';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Provides the platform PDP client. The PDP-backed repo subclasses are bound to the SpaceMemberRepo /
 * PagePermissionRepo tokens in database.module.ts (the single upstream DI seam — see
 * UPSTREAM_MODIFICATIONS.md); they resolve this client + the global repo deps.
 */
@Module({
  providers: [PlatformAuthzClient],
  exports: [PlatformAuthzClient],
})
export class AuthzModule {}
