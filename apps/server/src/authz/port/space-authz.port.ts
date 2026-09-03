import { UserSpaceRole } from '@docmost/db/repos/space/types';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Implementation-neutral port for space-scoped authorization decisions. Both the stock upstream
 * `SpaceMemberRepo` (native mode — Docmost's own `space_members` + CASL) and the fork's
 * `PdpSpaceMemberRepo` (remote mode — the external authorization service) satisfy this shape. The DI
 * seam in `database.module.ts` selects the implementation by `AUTHZ_MODE` (see UPSTREAM_MODIFICATIONS.md
 * seam #1 and `authz/mode/`). The port formalizes the contract; a type-level test locks that both
 * adapters conform (no edit to the upstream repo is made — `implements` would be an upstream change).
 */
export interface SpaceAuthzPort {
  /** The user's effective space roles (highest first); upstream returns `undefined` for no access. */
  getUserSpaceRoles(userId: string, spaceId: string): Promise<UserSpaceRole[]>;
  /** Reverse index: the space ids this user may view. */
  getUserSpaceIds(userId: string): Promise<string[]>;
  /** Recipient filter: of `userIds`, which may view the space (notification/digest fan-out). */
  getUserIdsWithSpaceAccess(userIds: string[], spaceId: string): Promise<Set<string>>;
}
