/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * The canonical typed change-event contract the fork emits over the east-west authz change feed (Group D,
 * issue #171). The platform consumes THESE events and maps them to SpiceDB tuples; it no longer parses
 * Docmost's raw table rows. All Docmost-schema knowledge (column names, the `page_access` restriction idiom,
 * the `page_permissions.page_access_id` indirection, the soft-vs-hard-delete divergence) lives HERE, in the
 * fork that owns the schema — so a Docmost upgrade that renames a column is fixed in this one place, never on
 * the platform.
 *
 * Ids are Docmost ids (user/group/space/page): the platform translates Docmost user ids to its own principals
 * via SubjectResolverService, and that mapping never leaves the platform. `seq` is the outbox row id (a
 * monotonic bigserial) and is DIAGNOSTIC ONLY (logging/tracing) — the change-feed's ordering + checkpoint
 * primitive is the opaque `(xact_id, id)` cursor the feed returns (see AuthzChangeFeedService), never `seq`.
 * Snapshot events (the reconciler's full desired set) reuse the same shapes with `seq = 0` since they carry
 * no outbox position.
 */
export type AuthzChangeEvent =
  | {
      seq: number;
      type: 'SpaceChanged';
      spaceId: string;
      workspaceId: string | null;
      deleted: boolean;
    }
  | {
      seq: number;
      type: 'SpaceMemberChanged';
      spaceId: string;
      userId: string | null;
      groupId: string | null;
      role: string | null;
      removed: boolean;
    }
  | {
      seq: number;
      type: 'GroupMemberChanged';
      groupId: string;
      userId: string;
      removed: boolean;
    }
  | {
      seq: number;
      type: 'PageStructureChanged';
      pageId: string;
      spaceId: string;
      parentPageId: string | null;
      deleted: boolean;
    }
  | {
      seq: number;
      type: 'PageRestrictionChanged';
      pageId: string;
      restricted: boolean;
    }
  | {
      seq: number;
      type: 'PagePermissionChanged';
      pageId: string;
      userId: string | null;
      groupId: string | null;
      role: string | null;
      removed: boolean;
    };

export type AuthzChangeEventType = AuthzChangeEvent['type'];

/** A raw `authz_outbox` row after the feed has parsed its `payload` to an object (see
 *  AuthzChangeFeedService.parsePayload). The trigger stores the payload via `jsonb_build_object('space_id',
 *  ...)` with SNAKE_CASE keys and the feed reads it as TEXT (`payload::text`), so the parsed object carries the
 *  ORIGINAL snake_case keys (space_id, deleted_at, page_id, ...) and this mapper reads them snake_cased.
 *  History (incident #181): the R1 note that CamelCasePlugin recurses into the payload was RIGHT for the
 *  production read path (postgres.js parses jsonb to an object in the built image; the plugin camelCases
 *  nested keys); R2 observed a string under jest and switched the mapper to snake_case, which left every live
 *  event unmapped in production. Reading the column as text makes the key case independent of the driver,
 *  the environment and any result-key plugin; pinned by authz-change-feed.service.spec.ts (SQL mechanism) and
 *  authz-outbox-commit-safety.pg.spec.ts (real rows through the app-shaped Kysely). */
export interface OutboxRow {
  id: number;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  tableName: string;
  payload: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Map ONE raw outbox row to a typed change event (or `null` to skip). `null` is a deliberate no-op for the
 * one case that carries no actionable state: a `page_permissions` cascade-delete whose `page_id` could not be
 * resolved at trigger time (the parent `page_access` was already gone) — it is covered by the paired
 * `PageRestrictionChanged{restricted:false}` event, which clears every grant on the page by filter, exactly
 * as the platform's legacy `forPageAccess` DELETE did.
 *
 * `removed` normalizes BOTH a hard DELETE and an UPDATE that set `deleted_at` (the `space_members`/`spaces`
 * hard-vs-soft divergence); `group_users`/`page_access`/`page_permissions` are hard-delete only.
 */
/** Tables `mapOutboxRow` knows. A row from one of these that still maps to `null` is a payload-shape or mapper
 *  defect (incident #181: every live event was dropped this way for a whole release), EXCEPT the one documented
 *  no-op above (a `page_permissions` cascade DELETE whose `page_id` could not be resolved). */
const AUTHZ_TABLES = new Set(['spaces', 'space_members', 'group_users', 'pages', 'page_access', 'page_permissions']);

/** True when a `null` mapping for this row is EXPECTED (unknown table, or the documented page_permissions cascade
 *  no-op); false means the feed must flag it (`AUTHZ_CHANGE_EVENT_DROPPED`). */
export function isExpectedSkip(row: OutboxRow): boolean {
  if (!AUTHZ_TABLES.has(row.tableName)) return true;
  return row.tableName === 'page_permissions' && row.op === 'DELETE';
}

export function mapOutboxRow(row: OutboxRow): AuthzChangeEvent | null {
  const p = row.payload; // SNAKE_CASE keys (the stored jsonb, parsed off the wire) — see OutboxRow.
  const isDelete = row.op === 'DELETE';
  const softDeleted = (p['deleted_at'] ?? null) != null;

  switch (row.tableName) {
    case 'spaces': {
      const spaceId = str(p['id']);
      if (!spaceId) return null;
      return {
        seq: row.id,
        type: 'SpaceChanged',
        spaceId,
        workspaceId: str(p['workspace_id']),
        deleted: isDelete || softDeleted,
      };
    }
    case 'space_members': {
      const spaceId = str(p['space_id']);
      if (!spaceId) return null;
      return {
        seq: row.id,
        type: 'SpaceMemberChanged',
        spaceId,
        userId: str(p['user_id']),
        groupId: str(p['group_id']),
        role: str(p['role']),
        removed: isDelete || softDeleted,
      };
    }
    case 'group_users': {
      const groupId = str(p['group_id']);
      const userId = str(p['user_id']);
      if (!groupId || !userId) return null;
      return { seq: row.id, type: 'GroupMemberChanged', groupId, userId, removed: isDelete };
    }
    case 'pages': {
      const pageId = str(p['id']);
      const spaceId = str(p['space_id']);
      if (!pageId || !spaceId) return null;
      return {
        seq: row.id,
        type: 'PageStructureChanged',
        pageId,
        spaceId,
        parentPageId: str(p['parent_page_id']),
        deleted: isDelete || softDeleted,
      };
    }
    case 'page_access': {
      const pageId = str(p['page_id']);
      if (!pageId) return null;
      // A row exists => the page is restricted; a DELETE => unrestricted.
      return { seq: row.id, type: 'PageRestrictionChanged', pageId, restricted: !isDelete };
    }
    case 'page_permissions': {
      // page_id is enriched into the payload by the trigger (resolved from page_access while it still exists).
      // A cascade-delete that could not resolve it => skip; the PageRestrictionChanged{false} covers the page.
      const pageId = str(p['page_id']);
      if (!pageId) return null;
      return {
        seq: row.id,
        type: 'PagePermissionChanged',
        pageId,
        userId: str(p['user_id']),
        groupId: str(p['group_id']),
        role: str(p['role']),
        removed: isDelete,
      };
    }
    default:
      return null;
  }
}
