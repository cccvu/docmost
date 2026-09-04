import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { HttpAuthzClient } from './http-authz.client';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * PDP-backed PagePermissionRepo: page view/edit DECISIONS come from the platform (SpiceDB). Page
 * restrictions ARE mirrored now (platform projects page_access → `page:#restricted` and
 * page_permissions → `#viewer`/`#editor`), so `hasAnyRestriction` reflects the schema's `locked`
 * permission (page or an ancestor is restricted). Non-overridden methods delegate to upstream.
 */
@Injectable()
export class PdpPagePermissionRepo extends PagePermissionRepo {
  constructor(
    @InjectKysely() db: KyselyDB,
    groupRepo: GroupRepo,
    @Inject(CACHE_MANAGER) cacheManager: Cache,
    private readonly authz: HttpAuthzClient,
  ) {
    super(db, groupRepo, cacheManager);
  }

  private subject(userId: string) {
    return { provider: 'docmost', externalId: userId } as const;
  }

  override async canUserAccessPage(userId: string, pageId: string): Promise<boolean> {
    return this.authz.check(this.subject(userId), 'view', 'page', pageId);
  }

  override async canUserEditPage(
    userId: string,
    pageId: string,
  ): Promise<{ hasAnyRestriction: boolean; canAccess: boolean; canEdit: boolean }> {
    // `locked` (schema: restricted + parent->locked) tells upstream whether to trust the PDP's page
    // decision (restricted page) or fall back to space CASL (unrestricted). The PDP's view/edit
    // already fold restriction in, so canAccess/canEdit are correct either way.
    const [canAccess, canEdit, locked] = await this.authz.checkBulk(this.subject(userId), [
      { permission: 'view', resourceType: 'page', resourceId: pageId },
      { permission: 'edit', resourceType: 'page', resourceId: pageId },
      { permission: 'locked', resourceType: 'page', resourceId: pageId },
    ]);
    return { hasAnyRestriction: locked, canAccess, canEdit };
  }

  override async filterAccessiblePageIds(opts: {
    pageIds: string[];
    userId: string;
    spaceId?: string;
  }): Promise<string[]> {
    if (opts.pageIds.length === 0) return [];
    return this.authz.filterResources(this.subject(opts.userId), 'view', 'page', opts.pageIds);
  }

  /**
   * Sidebar / tree listing: the viewable subset of `pageIds` WITH their edit capability — from the
   * PDP, not the local mirror (closes the sidebar leakage vector). Two checks per page (view, edit),
   * chunked under the platform's 256-check bulk cap; a page is included only if view passes.
   */
  override async filterAccessiblePageIdsWithPermissions(
    pageIds: string[],
    userId: string,
  ): Promise<Array<{ id: string; canEdit: boolean }>> {
    if (pageIds.length === 0) return [];
    const subject = this.subject(userId);
    const out: Array<{ id: string; canEdit: boolean }> = [];
    const CHUNK = 128; // 2 checks/page ≤ the platform's 256-item bulk cap
    for (let i = 0; i < pageIds.length; i += CHUNK) {
      const batch = pageIds.slice(i, i + CHUNK);
      const checks = batch.flatMap((id) => [
        { permission: 'view', resourceType: 'page', resourceId: id },
        { permission: 'edit', resourceType: 'page', resourceId: id },
      ]);
      const results = await this.authz.checkBulk(subject, checks);
      batch.forEach((id, j) => {
        if (results[j * 2]) out.push({ id, canEdit: !!results[j * 2 + 1] });
      });
    }
    return out;
  }

  /**
   * Reverse index (recipient filter): of `userIds`, which may VIEW the page — from the PDP, not the
   * local mirror. Powers comment/mention/update/verification notification fan-out.
   */
  override async getUserIdsWithPageAccess(pageId: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    return this.authz.filterSubjects('view', 'page', pageId, userIds);
  }
}
