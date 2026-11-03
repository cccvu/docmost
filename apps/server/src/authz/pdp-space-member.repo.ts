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
import { HttpAuthzClient } from './http-authz.client';

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
    private readonly authz: HttpAuthzClient,
  ) {
    super(db, groupRepo, spaceRepo, cacheManager);
  }

  private subject(userId: string) {
    return { provider: 'docmost', externalId: userId } as const;
  }

  /**
   * Synthesize the space role from the PDP's space administer/edit/view — STRICTLY, so the native engine never
   * grants more than the PDP does (#542):
   *
   *   no view                        → no role
   *   view, no edit                  → reader   (administer or not)
   *   view + edit, no administer     → writer
   *   view + edit + administer       → admin
   *
   * Why: every native content path takes its decision from this role — CASL (`SpaceAbilityFactory`) and the collab
   * connect (`AuthenticationExtension`) both read it. CASL `admin` holds `Manage` on Page, i.e. full read/write on
   * every unrestricted page, so it must need edit AND view; `writer` needs both too. A binding that grants
   * administer without view (a `manage_members`-only role, ADR 0025) or edit without view used to map to admin or
   * writer and so reached content the PDP refuses. With no view there is now no role at all: `SpaceAbilityFactory`
   * answers 404 and the collab connect Unauthorized. That one rule closes page info (by id or slug), update, trash,
   * restore, move, create, import, the sidebar, comments, shares, uploads and permanent delete (CASL Manage
   * Settings) for a view-less space admin. Space administration itself (members, settings, page ACLs) does not
   * depend on this role: the console and `/v1` decide it on `space#administer` (and the ACL write service in remote
   * mode, see `PageRestrictionService.authorize`).
   *
   * Accepted loss (ADR 0025 amendment): an administer + view holder without edit becomes a native READER, so the
   * native-only space settings (space update, icon, comment moderation, native space export) are gone for them.
   *
   * `checkBulk` denies the whole batch on a PDP error (all false), which reads as no view → no role: fail closed.
   * `live-access/collab-access.decision.ts` applies the same mapping to open collab connections (pinned by
   * `collab-access-parity.spec.ts`).
   */
  override async getUserSpaceRoles(userId: string, spaceId: string): Promise<UserSpaceRole[]> {
    const [admin, edit, view] = await this.authz.checkBulk(this.subject(userId), [
      { permission: 'administer', resourceType: 'space', resourceId: spaceId },
      { permission: 'edit', resourceType: 'space', resourceId: spaceId },
      { permission: 'view', resourceType: 'space', resourceId: spaceId },
    ]);
    const role = view ? (edit ? (admin ? SpaceRole.ADMIN : SpaceRole.WRITER) : SpaceRole.READER) : null;
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
