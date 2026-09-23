import { isUserDisabled } from '../../common/helpers';

/**
 * CCC authorization integration — NOT upstream Docmost code (#501).
 *
 * The collab access decision for an ALREADY-OPEN connection. Upstream decides access only once, in
 * `AuthenticationExtension.onAuthenticate`, when the socket connects; a narrowing change (restrict, member
 * removal or demotion, archive, group-grant removal) never reached a live editor. The revalidator re-runs THIS
 * function for every resident connection and closes the ones that lost access.
 *
 * It MIRRORS `onAuthenticate` step for step, pinned by `collab-access-parity.spec.ts` against the real
 * extension, so a connection is never closed for a reason the connect path would not also refuse (a
 * close → reconnect → close loop). The ONE deliberate difference is a PDP failure: on connect it fails closed
 * (the repos turn an error into "no role" / "restricted, no access"); here it is `unknown`, so a PDP blip
 * does not mass-evict every editor. The revalidator caps consecutive unknowns and then closes. The same holds for
 * the #524 lineage read: on connect a failed read denies, here it is `unknown`.
 */
export type CollabAccess = 'deny' | 'read' | 'write' | 'unknown';

/** Space permissions from the PDP (null = the PDP call failed). */
export interface SpacePermissions {
  administer: boolean;
  edit: boolean;
  view: boolean;
}

/** Page permissions from the PDP (null = the PDP call failed). `locked` = the page or an ancestor is restricted. */
export interface PagePermissions {
  view: boolean;
  edit: boolean;
  locked: boolean;
}

export interface CollabAccessFacts {
  /** The re-read fork user; null/undefined = missing (deleted row). */
  user:
    | { deactivatedAt?: Date | null; deletedAt?: Date | null }
    | null
    | undefined;
  /** The re-read page; null/undefined = missing. */
  page: { deletedAt?: Date | null } | null | undefined;
  space: SpacePermissions | null;
  pagePerms: PagePermissions | null;
  /**
   * #524: for a page the PDP has not placed (no view, not locked), whether the fork's own lineage restricts it
   * (`lineageRestricted`). Read only in that case; null/undefined there = the read failed or was not made.
   */
  lineageRestricted?: boolean | null;
}

export function decideCollabAccess(f: CollabAccessFacts): CollabAccess {
  // onAuthenticate: missing user, or isUserDisabled → Unauthorized.
  if (!f.user || isUserDisabled(f.user)) return 'deny';
  // onAuthenticate: page not found → NotFound.
  if (!f.page) return 'deny';
  if (!f.space || !f.pagePerms) return 'unknown';

  // onAuthenticate: findHighestUserSpaceRole over the PDP's administer/edit/view; no role → Unauthorized.
  const role = f.space.administer
    ? 'admin'
    : f.space.edit
      ? 'writer'
      : f.space.view
        ? 'reader'
        : null;
  if (!role) return 'deny';

  // #524: "no view, not locked" is a page the PDP has not placed (trashed, or not projected yet) — never evidence
  // of "unrestricted". Mirrors PdpPagePermissionRepo.canUserEditPage: only a lineage the fork walked to its root
  // with no restriction on it may fall back to the space role.
  let restricted = f.pagePerms.locked;
  if (!f.pagePerms.view && !f.pagePerms.locked) {
    if (f.lineageRestricted == null) return 'unknown';
    restricted = f.lineageRestricted;
  }

  let readOnly: boolean;
  if (restricted) {
    // Restricted page (or restricted ancestor): the PDP's page decision rules.
    if (!f.pagePerms.view) return 'deny';
    readOnly = !f.pagePerms.edit;
  } else {
    // Unrestricted: the space role rules.
    readOnly = role === 'reader';
  }
  // A trashed page is always read-only.
  if (f.page.deletedAt) readOnly = true;
  return readOnly ? 'read' : 'write';
}
