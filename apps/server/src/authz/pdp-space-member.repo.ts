import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { UserSpaceRole } from '@docmost/db/repos/space/types';
import { SpaceRole } from '../common/helpers/types/permission';
import { PlatformAuthzClient } from './platform-authz.client';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * PDP-backed SpaceMemberRepo: the space-access DECISIONS come from the platform (SpiceDB), not the
 * local space_members table. Everything not overridden delegates to the upstream repo (the table is
 * a transitional mirror kept in sync by the platform relay/reconciler). Docmost user ids are passed
 * as an external subject ref; the platform translates them to canonical principal ids.
 */
@Injectable()
export class PdpSpaceMemberRepo extends SpaceMemberRepo {
  constructor(
    @InjectKysely() db: KyselyDB,
    groupRepo: GroupRepo,
    spaceRepo: SpaceRepo,
    @Inject(CACHE_MANAGER) cacheManager: Cache,
    private readonly authz: PlatformAuthzClient,
  ) {
    super(db, groupRepo, spaceRepo, cacheManager);
  }

  private subject(userId: string) {
    return { provider: 'docmost', externalId: userId } as const;
  }

  /** Synthesize the highest space role from the PDP (administer→admin, edit→writer, view→reader). */
  override async getUserSpaceRoles(userId: string, spaceId: string): Promise<UserSpaceRole[]> {
    const [admin, edit, view] = await this.authz.checkBulk(this.subject(userId), [
      { permission: 'administer', resourceType: 'space', resourceId: spaceId },
      { permission: 'edit', resourceType: 'space', resourceId: spaceId },
      { permission: 'view', resourceType: 'space', resourceId: spaceId },
    ]);
    const role = admin ? SpaceRole.ADMIN : edit ? SpaceRole.WRITER : view ? SpaceRole.READER : null;
    // Mirror the upstream contract: undefined (not []) when the user has no role in the space.
    return role ? [{ userId, role }] : (undefined as unknown as UserSpaceRole[]);
  }

  /** Reverse index: the space ids this user may view, straight from the PDP. */
  override async getUserSpaceIds(userId: string): Promise<string[]> {
    return this.authz.lookupResources(this.subject(userId), 'view', 'space');
  }

  /**
   * Reverse index (recipient filter): of `userIds`, which may VIEW the space — from the PDP, not the
   * local mirror. Powers notification/digest fan-out. Bounded candidate list → subject-side filter.
   */
  override async getUserIdsWithSpaceAccess(userIds: string[], spaceId: string): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    return new Set(await this.authz.filterSubjects('view', 'space', spaceId, userIds));
  }
}
