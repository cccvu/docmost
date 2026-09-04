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
 * monotonic bigserial) and is the change-feed cursor; snapshot events (the reconciler's full desired set)
 * reuse the same shapes with `seq = 0` since they carry no outbox position.
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

/** A raw `authz_outbox` row as delivered by the fork's Kysely. The trigger STORES `to_jsonb(NEW/OLD)` with
 *  snake_case column keys, but the fork's `CamelCasePlugin` recurses into the jsonb on read (verified: it does
 *  NOT stop at the top-level column), so `payload` arrives with CAMELCASE keys (spaceId, deletedAt, pageId,
 *  pageAccessId, ...). This mapper reads them camelCased accordingly. */
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
export function mapOutboxRow(row: OutboxRow): AuthzChangeEvent | null {
  const p = row.payload; // CAMELCASE keys (CamelCasePlugin recurses into the jsonb) — see OutboxRow.
  const isDelete = row.op === 'DELETE';
  const softDeleted = (p['deletedAt'] ?? null) != null;

  switch (row.tableName) {
    case 'spaces': {
      const spaceId = str(p['id']);
      if (!spaceId) return null;
      return {
        seq: row.id,
        type: 'SpaceChanged',
        spaceId,
        workspaceId: str(p['workspaceId']),
        deleted: isDelete || softDeleted,
      };
    }
    case 'space_members': {
      const spaceId = str(p['spaceId']);
      if (!spaceId) return null;
      return {
        seq: row.id,
        type: 'SpaceMemberChanged',
        spaceId,
        userId: str(p['userId']),
        groupId: str(p['groupId']),
        role: str(p['role']),
        removed: isDelete || softDeleted,
      };
    }
    case 'group_users': {
      const groupId = str(p['groupId']);
      const userId = str(p['userId']);
      if (!groupId || !userId) return null;
      return { seq: row.id, type: 'GroupMemberChanged', groupId, userId, removed: isDelete };
    }
    case 'pages': {
      const pageId = str(p['id']);
      const spaceId = str(p['spaceId']);
      if (!pageId || !spaceId) return null;
      return {
        seq: row.id,
        type: 'PageStructureChanged',
        pageId,
        spaceId,
        parentPageId: str(p['parentPageId']),
        deleted: isDelete || softDeleted,
      };
    }
    case 'page_access': {
      const pageId = str(p['pageId']);
      if (!pageId) return null;
      // A row exists => the page is restricted; a DELETE => unrestricted.
      return { seq: row.id, type: 'PageRestrictionChanged', pageId, restricted: !isDelete };
    }
    case 'page_permissions': {
      // page_id is enriched into the payload by the trigger (resolved from page_access while it still exists).
      // A cascade-delete that could not resolve it => skip; the PageRestrictionChanged{false} covers the page.
      const pageId = str(p['pageId']);
      if (!pageId) return null;
      return {
        seq: row.id,
        type: 'PagePermissionChanged',
        pageId,
        userId: str(p['userId']),
        groupId: str(p['groupId']),
        role: str(p['role']),
        removed: isDelete,
      };
    }
    default:
      return null;
  }
}
