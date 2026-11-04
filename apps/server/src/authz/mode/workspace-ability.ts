import { NotFoundException, Provider } from '@nestjs/common';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRole } from '../../common/helpers/types/permission';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import { AUTHZ_MODE, AuthzMode } from './authz-mode';

/**
 * CCC authorization integration — NOT upstream Docmost code (#636).
 *
 * Mode-selected DI provider for upstream's `WorkspaceAbilityFactory` (workspace CASL). Upstream's factory is a
 * plain switch on `users.role`, so an engine OWNER/ADMIN row can update the workspace, change member roles,
 * invite, edit groups (`group_users` feeds SpiceDB) and set the workspace icon. In `remote` mode authority comes
 * from the PDP alone, and the service-bridge only ever mints `member` sessions, so `users.role` must confer
 * nothing: a native-phase owner session that survives the switch to remote would otherwise keep all of it.
 *
 *   - native → the STOCK upstream factory (Docmost's own authorization), byte-for-byte unchanged.
 *   - remote → `RemoteWorkspaceAbilityFactory`: every known role gets the stock MEMBER ability. This covers
 *              every route gated on workspace CASL, including any route a later upstream version adds.
 *
 * Space CASL is not touched: it is already PDP-backed through the mode-selected `SpaceMemberRepo` (seam #1).
 * Wired by the one-line composition seam in `core/casl/casl.module.ts` (#177), beside the repo providers here.
 */

/**
 * The roles this fork has decided to demote to member in remote mode. Deliberately a literal list, not
 * `Object.values(UserRole)`: a role upstream adds later (a "guest", say) must be a decision here, so until then
 * it fails closed instead of being silently widened (or narrowed) to member.
 */
export const REMOTE_DEMOTED_ROLES: ReadonlySet<string> = new Set<string>([
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.MEMBER,
]);

export class RemoteWorkspaceAbilityFactory extends WorkspaceAbilityFactory {
  createForUser(user: User, workspace: Workspace) {
    if (!REMOTE_DEMOTED_ROLES.has(user?.role as string)) {
      // Same answer as upstream's unknown-role branch.
      throw new NotFoundException('Workspace permissions not found');
    }
    // A COPY: services read `authUser.role` after the CASL check and `/api/users/me` returns it. This changes
    // the authorization decision only, never the identity data.
    return super.createForUser({ ...user, role: UserRole.MEMBER }, workspace);
  }
}

export const workspaceAbilityFactoryProvider: Provider = {
  provide: WorkspaceAbilityFactory,
  inject: [AUTHZ_MODE],
  useFactory: (mode: AuthzMode): WorkspaceAbilityFactory =>
    mode === 'remote'
      ? new RemoteWorkspaceAbilityFactory()
      : new WorkspaceAbilityFactory(),
};
