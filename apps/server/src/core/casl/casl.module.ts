import { Global, Module } from '@nestjs/common';
import SpaceAbilityFactory from './abilities/space-ability.factory';
import WorkspaceAbilityFactory from './abilities/workspace-ability.factory';
// --- CCC authorization integration seam (see /UPSTREAM_MODIFICATIONS.md #177).
// Selects WorkspaceAbilityFactory by AUTHZ_MODE: native → the stock factory; remote → the fork subclass that
// gives every role the member ability (users.role confers no workspace authority). This module is the token's
// only registration, so the selection must be bound here. All policy lives in the fork-owned provider.
import { workspaceAbilityFactoryProvider } from '../../authz/mode/workspace-ability';

@Global()
@Module({
  providers: [workspaceAbilityFactoryProvider, SpaceAbilityFactory],
  exports: [WorkspaceAbilityFactory, SpaceAbilityFactory],
})
export class CaslModule {}
