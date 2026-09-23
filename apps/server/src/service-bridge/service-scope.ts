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
  // #455 fork-side instant revocation. `session:revoke` deactivates the shadow user (sets `deactivatedAt`
  // + revokes its live `user_sessions` + force-disconnects its live collab sockets) so a disabled platform
  // identity cannot keep reading/writing wiki content through an already-issued fork credential; the paired
  // `session:restore` clears `deactivatedAt` on re-enable. Distinct scopes so a future least-privilege
  // credential can be granted revoke without restore (or vice-versa).
  SessionRevoke = 'session:revoke',
  SessionRestore = 'session:restore',
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
  // The /v1 permission-aware search (PdpSearchService — filter-then-retrieve). A DISTINCT read scope from
  // content:read so a future least-privilege credential can be granted list-retrieval without search (or
  // search without bulk list); search is a different capability class (it walks the FTS candidate stream).
  ContentSearch = 'content:search',
  // Read-only attachment lookups (resolve attachment→page + list a page's file attachments) backing the
  // platform's /v1 attachment surface. Option A: the platform authorizes page#view/#edit off the resolved
  // page — this scope guards the metadata lookups only; the bytes ride Docmost's native file endpoint.
  AttachmentsRead = 'attachments:read',
  // Group D (issue #171): the authz change-feed + snapshot the platform drains to project membership/page/
  // restriction changes into SpiceDB. Read-only; replaces the platform's direct Docmost-DB outbox access.
  ChangesRead = 'changes:read',
  // #545: the CURRENT authorization structure of pages (placement, restriction, lineage) the platform's page
  // projector re-reads on every page event. Read-only, and distinct from changes:read because it is called once per
  // page event (plus fan-out and reconcile) and so gets its own, larger rate bucket (ServiceAuthGuard).
  PagesAuthzRead = 'pages:authz:read',
}
