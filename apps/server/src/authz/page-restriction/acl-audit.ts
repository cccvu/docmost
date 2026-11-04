import { AuditEvent, AuditEventType, AuditLogPayload, AuditResource } from '../../common/events/audit-events';
import { Page } from '@docmost/db/types/entity.types';
import { AclChange, AclEffect, AclGrant } from './acl-state';
import { MAX_PAGE_GRANTEES } from './dto';

/**
 * CCC authorization integration — NOT upstream Docmost code (#503).
 *
 * The domain-audit row for one APPLIED page-ACL write (restrict / unrestrict / add / remove / update). Pure: the
 * service builds it from the committed write's `effect` and hands it to `AUDIT_SERVICE` after the commit.
 *
 *   - Upstream's event names only (no edit to `audit-events.ts`); there is no "permission updated" event, so a role
 *     change is `page.permission_added` with `metadata.operation: 'role_changed'` — the same vocabulary as the
 *     platform's `/v1` `admin_change` rows. Count ACL changes by `source` / `event_category` too: a `/v1` change
 *     writes both rows.
 *   - `metadata.surface: 'engine'` marks this as the ENGINE's record of the write. A `/v1` or MCP change reaches here
 *     through the platform relay as the relayed human, with no service account or on-behalf-of: the platform's own
 *     `admin_change` row (`source: 'platform'`) is the authoritative agent attribution, this row is not. The fork
 *     cannot tell a relayed request from a native one, and no client-settable marker is added (it could be forged).
 *   - Ids and roles only. Never the page title, a name or an email: a restricted page's title is itself confidential.
 *   - Each grantee list is capped at `MAX_PAGE_GRANTEES`; a capped list's full length is in `metadata.truncated`.
 *     Only unrestrict's `removed` (the `page_access` delete cascades every grant) is unbounded in practice.
 */
export type AclAuditAction = 'restrict' | 'unrestrict' | 'add' | 'remove' | 'update';

export const ACL_AUDIT_EVENT: Readonly<Record<AclAuditAction, { event: AuditEventType; operation: string }>> =
  Object.freeze({
    restrict: { event: AuditEvent.PAGE_RESTRICTED, operation: 'restricted' },
    unrestrict: { event: AuditEvent.PAGE_RESTRICTION_REMOVED, operation: 'unrestricted' },
    add: { event: AuditEvent.PAGE_PERMISSION_ADDED, operation: 'granted' },
    update: { event: AuditEvent.PAGE_PERMISSION_ADDED, operation: 'role_changed' },
    remove: { event: AuditEvent.PAGE_PERMISSION_REMOVED, operation: 'revoked' },
  });

/** Upper bound on each grantee list in a row (the native write's own per-list batch cap). */
export const ACL_AUDIT_LIST_CAP = MAX_PAGE_GRANTEES;

/** `{ userId }` or `{ groupId }` — the null side is dropped, so a reader never sees `userId: null`. */
const subjectOf = (g: { userId: string | null; groupId: string | null }) =>
  g.userId ? { userId: g.userId } : { groupId: g.groupId as string };

const grantEntry = (g: AclGrant) => ({ ...subjectOf(g), role: g.role });
const changeEntry = (c: AclChange) => ({ ...subjectOf(c), fromRole: c.fromRole, toRole: c.toRole });

export function aclAuditPayload(
  action: AclAuditAction,
  page: Pick<Page, 'id' | 'spaceId'>,
  effect: AclEffect,
): AuditLogPayload {
  const { event, operation } = ACL_AUDIT_EVENT[action];
  const truncated: Record<string, number> = {};
  const capped = <T, R>(name: string, list: T[], map: (x: T) => R): R[] => {
    if (list.length > ACL_AUDIT_LIST_CAP) truncated[name] = list.length;
    return list.slice(0, ACL_AUDIT_LIST_CAP).map(map);
  };
  const metadata: Record<string, unknown> = {
    surface: 'engine',
    operation,
    added: capped('added', effect.added, grantEntry),
    changed: capped('changed', effect.changed, changeEntry),
    removed: capped('removed', effect.removed, grantEntry),
  };
  // Restrict only: the role the actor kept (A2); `null` (kept nothing) is a fact worth recording.
  if ('retainedRole' in effect) metadata.retainedRole = effect.retainedRole ?? null;
  if (Object.keys(truncated).length > 0) metadata.truncated = truncated;
  return {
    event,
    resourceType: AuditResource.PAGE,
    resourceId: page.id,
    spaceId: page.spaceId,
    changes: { before: { restricted: effect.restrictedBefore }, after: { restricted: effect.restrictedAfter } },
    metadata,
  };
}
