/**
 * CCC authorization integration — NOT upstream Docmost code (#501 Part B).
 *
 * The fork routes that can TAKE ACCESS AWAY, keyed `<ControllerClass>.<handler>` (what the settle interceptor sees
 * at runtime, and what the static route scan sees at build time — `narrowing-routes.spec.ts` fails if an entry no
 * longer names a real route). A successful request on one of these answers only after the PDP enforces it (or says
 * `Authz-Propagation: pending`). Every surface lands here: the native UI calls these routes directly; the console,
 * `/v1` and MCP reach the page and space-member ones through the platform's relay, and archive and service-member
 * changes through the service bridge.
 *
 * Deliberately NOT here (ADR 0026 §4, "eventual, bounded"): trash / permanent delete, space and group delete,
 * workspace-member delete and deactivate, and every widening route (unrestrict, add member, add grant). Those still
 * reach live sessions through the relay signal and the sweep.
 */
export const NARROWING_ROUTES: ReadonlySet<string> = new Set([
  // page restriction + grants (fork-owned controller)
  'PageRestrictionController.restrict',
  'PageRestrictionController.addPermission', // an existing grantee's role is replaced (can demote)
  'PageRestrictionController.removePermission',
  'PageRestrictionController.updatePermission',
  // page structure: moving under a restricted parent, or to another space, narrows the subtree
  'PageController.movePage',
  'PageController.movePageToSpace',
  // native space + group membership
  'SpaceController.removeSpaceMember',
  'SpaceController.updateSpaceMemberRole',
  'GroupController.removeGroupMember',
  // service bridge (console + /v1 + MCP space admin)
  'ServiceSpaceController.archive',
  'ServiceSpaceController.addMember', // an upsert: an existing member's role is replaced (can demote)
  'ServiceSpaceController.changeMemberRole',
  'ServiceSpaceController.removeMember',
]);
