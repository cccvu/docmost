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
 * Deliberately NOT here (ADR 0026 §4, "eventual, bounded"): trash / permanent delete (native and the #616
 * `conditionalDelete`), the metadata-only update (`conditionalUpdateMeta` — title/icon change no access), space and group delete
 * (the service-bridge group delete refuses a group that still grants anything, #797),
 * workspace-member delete and deactivate, and the purely widening routes (native add member, add group member).
 * Those still reach live sessions through the relay signal and the sweep.
 *
 * The three native membership entries are dead in `AUTHZ_MODE=remote`: the remote refusal table
 * (`authz/remote-refusal/remote-refusal.table.ts`, #636) 404s those routes before the handler, and the settle runs
 * only in remote. They stay on purpose, for native mode and so that lifting a refusal brings the settle back with it.
 * `narrowing-routes.spec.ts` pins the overlap to exactly those three.
 */
export const NARROWING_ROUTES: ReadonlySet<string> = new Set([
  // page restriction + grants (fork-owned controller)
  'PageRestrictionController.restrict',
  'PageRestrictionController.removeRestriction', // drops every grant with the marker: a grantee can lose edit
  'PageRestrictionController.addPermission', // an existing grantee's role is replaced (can demote)
  'PageRestrictionController.removePermission',
  'PageRestrictionController.updatePermission',
  // page structure: moving under a restricted parent, or to another space, narrows the subtree
  'PageController.movePage',
  'PageController.movePageToSpace',
  // …and their #616 atomic compare-and-write twins (the platform relays a move carrying If-Match here)
  'ConditionalPageOpsController.conditionalMove',
  'ConditionalPageOpsController.conditionalMoveToSpace',
  // native space + group membership (refused in remote, #636: see the header)
  'SpaceController.removeSpaceMember',
  'SpaceController.updateSpaceMemberRole',
  'GroupController.removeGroupMember',
  // service bridge (console + /v1 + MCP space admin)
  'ServiceSpaceController.archive',
  'ServiceSpaceController.addMember', // an upsert: an existing member's role is replaced (can demote)
  'ServiceSpaceController.changeMemberRole',
  'ServiceSpaceController.removeMember',
  // wiki-v2 #797: leaving a group drops every grant the group carries (spaces, pages, role bindings naming it)
  'ServiceGroupController.removeMember',
]);
