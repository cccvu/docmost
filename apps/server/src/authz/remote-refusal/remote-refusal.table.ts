/**
 * CCC authorization integration — NOT upstream Docmost code (#502, #542, #598, #636).
 *
 * The engine's native routes that `AUTHZ_MODE=remote` refuses with a 404, as DATA. `RemoteNativeRefusalInterceptor`
 * looks each request up here by `<ControllerClass>.<handler>` and does nothing else per family, so a new refused route
 * is one entry, never new code. Each family is one audit event; its `reason` says where the action lives instead:
 *  - `archive_only`: removal is the platform's archive; there is no remote purge (#502).
 *  - `platform_only`: the platform's governed path owns it — `/api/service/*` through the platform (acting human,
 *    audited, idempotent, connector-posture aware). The engine's own gate on these routes is workspace CASL on
 *    `users.role` (not PDP-backed) or space CASL with no self-dealing check, and a native-phase owner session survives
 *    the switch to remote (#598, #636).
 *  - `identity_platform_owned`: in remote mode a user's email is identity, and the platform owns identity. A session
 *    holder that moves its own email into the reserved shadow namespace could be adopted by a later provisioning
 *    upsert (#636).
 *  - `directory_platform_owned` (#797): the workspace directory — who is in the workspace, who is invited, which groups
 *    exist and who is in them, who is in a space — is not shown to wiki users in remote mode. Upstream lets any
 *    member read it (workspace CASL `Read` on Member/Group, space CASL `Read` on Member for any space reader); the
 *    console, through the platform, is the governed view. The SPA's Settings > Members / Groups pages and the space
 *    settings Members tab stop loading; nothing else in the SPA reads these routes (@mentions use `search/suggest`,
 *    whose group results `PdpSearchService` gives only to a caller who administers the workspace or a space).
 * `invites/info` (public, the invitation-acceptance page) stays reachable.
 *
 * Every key is pinned to a real route whose path equals `route`, families are disjoint, and each family's key set is
 * pinned both ways against the code that reaches its sink (`remote-refusal.fitness.spec.ts` and the family specs
 * beside it). Native (standalone) mode refuses nothing here.
 */

export type RefusalFamilyId =
  | 'spaceHardDelete'
  | 'spaceNativeCreate'
  | 'workspaceAdmin'
  | 'groupAdmin'
  | 'spaceMember'
  | 'userEmail'
  | 'directoryRead';

export interface RefusedRoute {
  /** The audit row's `metadata.route`: `POST <path>`, equal to the scanned route's path (the fitness spec pins it). */
  readonly route: string;
  /**
   * A body field whose value is recorded as the row's `resourceId`, only when it is a UUID. Otherwise the row carries
   * `metadata.invalid<Field>: true` (the #502 shape). The attempted id never goes in a `spaceId` column: the caller
   * may have no access to it.
   */
  readonly resourceIdField?: 'spaceId' | 'groupId';
  /**
   * A body field naming the target user(s), a string or an array of strings. When it names the caller's own user id
   * the row carries `metadata.targetsActor: true`, the #542 self-grant shape. A comparison only: nothing is echoed.
   */
  readonly targetUserField?: 'userId' | 'userIds';
  /** Pass through only when this returns `false` for the raw body. Absent means always refuse; a throw refuses. */
  readonly when?: (body: unknown) => boolean;
}

export interface RefusalFamily {
  readonly id: RefusalFamilyId;
  readonly event: string;
  readonly resourceType: 'space' | 'workspace' | 'group' | 'user';
  readonly reason: 'archive_only' | 'platform_only' | 'identity_platform_owned' | 'directory_platform_owned';
  /** Keyed `<ControllerClass>.<handler>`. */
  readonly routes: ReadonlyMap<string, RefusedRoute>;
}

/**
 * `POST /api/users/update` is refused only when the body names `email` at all (`{email: null}` too): the name and
 * preference forms never send it, and a change to the same address is still a write of the identity field. JSON
 * cannot express `undefined`, so an own `email` key is the whole test.
 */
export const changesEmail = (body: unknown): boolean =>
  body !== null &&
  typeof body === 'object' &&
  !Array.isArray(body) &&
  // `Object.hasOwn` (ES2022) is outside this tsconfig's lib; this is its definition.
  Object.prototype.hasOwnProperty.call(body, 'email');

export const REMOTE_REFUSAL_FAMILIES: readonly RefusalFamily[] = [
  {
    id: 'spaceHardDelete',
    event: 'space.hard_delete_refused',
    resourceType: 'space',
    reason: 'archive_only',
    routes: new Map([['SpaceController.deleteSpace', { route: 'POST /api/spaces/delete', resourceIdField: 'spaceId' }]]),
  },
  {
    id: 'spaceNativeCreate',
    event: 'space.native_create_refused',
    resourceType: 'space',
    reason: 'platform_only',
    routes: new Map([['SpaceController.createSpace', { route: 'POST /api/spaces/create' }]]),
  },
  {
    id: 'workspaceAdmin',
    event: 'workspace.native_admin_refused',
    resourceType: 'workspace',
    reason: 'platform_only',
    routes: new Map([
      ['WorkspaceController.updateWorkspace', { route: 'POST /api/workspace/update' }],
      ['WorkspaceController.deactivateWorkspaceMember', { route: 'POST /api/workspace/members/deactivate' }],
      ['WorkspaceController.activateWorkspaceMember', { route: 'POST /api/workspace/members/activate' }],
      ['WorkspaceController.deleteWorkspaceMember', { route: 'POST /api/workspace/members/delete' }],
      ['WorkspaceController.updateWorkspaceMemberRole', { route: 'POST /api/workspace/members/change-role' }],
      ['WorkspaceController.inviteUser', { route: 'POST /api/workspace/invites/create' }],
      ['WorkspaceController.resendInvite', { route: 'POST /api/workspace/invites/resend' }],
      ['WorkspaceController.revokeInvite', { route: 'POST /api/workspace/invites/revoke' }],
      ['WorkspaceController.getInviteLink', { route: 'POST /api/workspace/invites/link' }],
    ]),
  },
  {
    id: 'groupAdmin',
    event: 'group.native_admin_refused',
    resourceType: 'group',
    reason: 'platform_only',
    routes: new Map<string, RefusedRoute>([
      ['GroupController.createGroup', { route: 'POST /api/groups/create' }],
      ['GroupController.updateGroup', { route: 'POST /api/groups/update', resourceIdField: 'groupId' }],
      ['GroupController.addGroupMember', { route: 'POST /api/groups/members/add', resourceIdField: 'groupId' }],
      ['GroupController.removeGroupMember', { route: 'POST /api/groups/members/remove', resourceIdField: 'groupId' }],
      ['GroupController.deleteGroup', { route: 'POST /api/groups/delete', resourceIdField: 'groupId' }],
    ]),
  },
  {
    id: 'spaceMember',
    event: 'space.native_member_refused',
    resourceType: 'space',
    reason: 'platform_only',
    routes: new Map([
      [
        'SpaceController.addSpaceMember',
        { route: 'POST /api/spaces/members/add', resourceIdField: 'spaceId', targetUserField: 'userIds' },
      ],
      [
        'SpaceController.removeSpaceMember',
        { route: 'POST /api/spaces/members/remove', resourceIdField: 'spaceId', targetUserField: 'userId' },
      ],
      [
        'SpaceController.updateSpaceMemberRole',
        { route: 'POST /api/spaces/members/change-role', resourceIdField: 'spaceId', targetUserField: 'userId' },
      ],
    ]),
  },
  {
    id: 'userEmail',
    event: 'user.native_email_change_refused',
    resourceType: 'user',
    reason: 'identity_platform_owned',
    routes: new Map([['UserController.updateUser', { route: 'POST /api/users/update', when: changesEmail }]]),
  },
  {
    // #797: no `resourceIdField`: the rows' resource is the workspace directory, and a space or group id the caller
    // named is not recorded against a `workspace` resource type.
    id: 'directoryRead',
    event: 'directory.native_read_refused',
    resourceType: 'workspace',
    reason: 'directory_platform_owned',
    routes: new Map<string, RefusedRoute>([
      ['WorkspaceController.getWorkspaceMembers', { route: 'POST /api/workspace/members' }],
      ['WorkspaceController.getInvitations', { route: 'POST /api/workspace/invites' }],
      ['GroupController.getWorkspaceGroups', { route: 'POST /api/groups' }],
      ['GroupController.getGroup', { route: 'POST /api/groups/info' }],
      ['GroupController.getGroupMembers', { route: 'POST /api/groups/members' }],
      ['SpaceController.getSpaceMembers', { route: 'POST /api/spaces/members' }],
    ]),
  },
];

export interface RefusalHit {
  readonly family: RefusalFamily;
  readonly entry: RefusedRoute;
}

/** One lookup map over every family. Throws on a key in two families: the interceptor could only honour one. */
export function buildRefusalIndex(families: readonly RefusalFamily[]): ReadonlyMap<string, RefusalHit> {
  const index = new Map<string, RefusalHit>();
  for (const family of families) {
    for (const [key, entry] of family.routes) {
      if (index.has(key)) throw new Error(`remote refusal table: ${key} is in two families`);
      index.set(key, { family, entry });
    }
  }
  return index;
}

export const REMOTE_REFUSED_ROUTES: ReadonlyMap<string, RefusalHit> = buildRefusalIndex(REMOTE_REFUSAL_FAMILIES);

/** The `Controller.handler` keys of one family. Throws on an unknown id, so a typo cannot read as an empty family. */
export function routesOf(id: RefusalFamilyId): ReadonlySet<string> {
  const family = REMOTE_REFUSAL_FAMILIES.find((f) => f.id === id);
  if (!family) throw new Error(`remote refusal table: unknown family ${id}`);
  return new Set(family.routes.keys());
}
