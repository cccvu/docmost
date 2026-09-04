/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Scopes for the east-west `/api/service/*` machine-to-machine endpoints. Each route declares the single
 * scope it needs; the ServiceAuthGuard authorizes THAT scope (least privilege), not mere secret
 * possession. Today one shared secret is a transitional credential granted the full set; distinct
 * per-scope credentials can be introduced later with no guard redesign.
 */
export enum ServiceScope {
  SessionMint = 'session:mint',
  UsersProvision = 'users:provision',
  // Phase C reverse-coupling: the platform stops reaching into Docmost's DB and instead calls these
  // scoped, service-secret-guarded endpoints. Reads and writes are distinct scopes so a future
  // per-scope credential can be granted read-only access without any write capability.
  UsersResolve = 'users:resolve',
  WorkspaceRead = 'workspace:read',
  WorkspaceSettingsWrite = 'workspace:settings:write',
  PagesRead = 'pages:read',
  SpacesRead = 'spaces:read',
  SpacesWrite = 'spaces:write',
  ContentRead = 'content:read',
  // Group D (issue #171): the authz change-feed + snapshot the platform drains to project membership/page/
  // restriction changes into SpiceDB. Read-only; replaces the platform's direct Docmost-DB outbox access.
  ChangesRead = 'changes:read',
}
