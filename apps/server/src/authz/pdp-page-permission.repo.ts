import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PlatformAuthzClient } from './platform-authz.client';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * PDP-backed PagePermissionRepo: page view/edit DECISIONS come from the platform (SpiceDB). Page
 * restrictions are not yet mirrored (creating them is EE-gated / a future feature), so
 * `hasAnyRestriction` is false and access derives from the space role via the PDP `page` permissions.
 * Non-overridden methods delegate to upstream.
 */
@Injectable()
export class PdpPagePermissionRepo extends PagePermissionRepo {
  constructor(
    @InjectKysely() db: KyselyDB,
    groupRepo: GroupRepo,
    @Inject(CACHE_MANAGER) cacheManager: Cache,
    private readonly authz: PlatformAuthzClient,
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
    const [canAccess, canEdit] = await this.authz.checkBulk(this.subject(userId), [
      { permission: 'view', resourceType: 'page', resourceId: pageId },
      { permission: 'edit', resourceType: 'page', resourceId: pageId },
    ]);
    return { hasAnyRestriction: false, canAccess, canEdit };
  }

  override async filterAccessiblePageIds(opts: {
    pageIds: string[];
    userId: string;
    spaceId?: string;
  }): Promise<string[]> {
    if (opts.pageIds.length === 0) return [];
    return this.authz.filterResources(this.subject(opts.userId), 'view', 'page', opts.pageIds);
  }
}
