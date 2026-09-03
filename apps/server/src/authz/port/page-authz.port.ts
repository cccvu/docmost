/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Implementation-neutral port for page-scoped authorization decisions. Both the stock upstream
 * `PagePermissionRepo` (native mode) and the fork's `PdpPagePermissionRepo` (remote mode) satisfy this
 * shape; the DI seam in `database.module.ts` selects by `AUTHZ_MODE`. See `space-authz.port.ts` for the
 * "no upstream `implements`" rationale.
 */

/** Result of an edit-capability check: whether the page (or an ancestor) is restricted, plus access. */
export interface PageEditDecision {
  hasAnyRestriction: boolean;
  canAccess: boolean;
  canEdit: boolean;
}

export interface PageAuthzPort {
  canUserAccessPage(userId: string, pageId: string): Promise<boolean>;
  canUserEditPage(userId: string, pageId: string): Promise<PageEditDecision>;
  filterAccessiblePageIds(opts: {
    pageIds: string[];
    userId: string;
    spaceId?: string;
  }): Promise<string[]>;
  filterAccessiblePageIdsWithPermissions(
    pageIds: string[],
    userId: string,
  ): Promise<Array<{ id: string; canEdit: boolean }>>;
  getUserIdsWithPageAccess(pageId: string, userIds: string[]): Promise<string[]>;
}
