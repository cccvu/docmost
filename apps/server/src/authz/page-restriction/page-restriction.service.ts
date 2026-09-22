import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { InsertablePagePermission, Page, User } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../core/casl/interfaces/space-ability.type';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { HttpAuthzClient } from '../http-authz.client';
import {
  AddPagePermissionDto,
  PageGrantRole,
  RemovePagePermissionDto,
  UpdatePagePermissionDto,
} from './dto';

/** A1 (#486): the 403 body carries a machine-readable `code`, the same one rule M uses on the bridge. */
const selfGrant = () =>
  new ForbiddenException({
    code: 'self_grant',
    message:
      'you cannot grant yourself, or a group you belong to, access to a page; another administrator must do this',
  });

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The page-restriction WRITE feature (Docmost gates this behind EE and does not vendor the server
 * half here). It only writes Docmost's own `page_access` / `page_permissions` tables via the existing
 * repo methods; the platform's DB-trigger outbox then projects the change to SpiceDB (`#restricted` /
 * `#viewer` / `#editor`) — so NO SpiceDB/policy logic lives here. Managing restrictions is gated on
 * space-admin (`Manage` on space Settings); refine per product later.
 *
 * Self-dealing (#486) — restriction management must never become a way to reach content the actor could not
 * already see, on ANY path (native UI and the platform relay both land here):
 *   - A1: a grant or re-role that names the actor, or a group the actor is in, is refused (403 `self_grant`);
 *     revoking your own grant stays allowed.
 *   - A2: restrict keeps only the access the actor already had — the auto-grant role is decided from a STRICT
 *     PDP read before anything is written (remote mode; native keeps upstream's writer self-grant).
 *   - A3: an unrestrict carrying `requireActorCoverage` (the platform relay always sends it) is refused unless
 *     the actor can edit the page and no direct sub-page is unrestricted (it would be exposed). Without the
 *     flag — the native UI — unrestrict is unchanged: the human break-glass for an orphaned page.
 * The PDP is only ever asked space view/edit and page edit here — never `locked` (issue 499).
 */
@Injectable()
export class PageRestrictionService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly authz: HttpAuthzClient,
  ) {}

  private subject(user: User) {
    return { provider: 'docmost', externalId: user.id } as const;
  }

  /** A1: refuse a grant whose grantees include the actor (any case) or a group the actor belongs to. */
  private async refuseSelfGrant(user: User, userIds: string[], groupIds: string[]): Promise<void> {
    const me = user.id.toLowerCase();
    if (userIds.some((id) => id.toLowerCase() === me)) throw selfGrant();
    if (groupIds.length === 0) return;
    const mine = await this.db
      .selectFrom('groupUsers')
      .select('groupId')
      .where('userId', '=', user.id)
      .where('groupId', 'in', groupIds)
      .executeTakeFirst();
    if (mine) throw selfGrant();
  }

  /**
   * A2: the role the actor keeps on a page they are about to restrict — exactly the access they have now.
   * The page has no `page_access` row yet (restrict returns early otherwise), and an unrestricted page cannot
   * hold grants, so inside an unrestricted section the actor's page access IS their space access: space
   * view+edit → writer, view only → reader, neither → none. Under a restricted ancestor nobody but that
   * section's own grantees can see the page, so the actor keeps nothing. `hasRestrictedAncestor` reads the
   * local tables (read-only upstream repo use), so a freshly created page has no projection lag. A PDP error
   * refuses the restrict (503) before anything is written.
   */
  private async retainedRole(page: Page, user: User): Promise<PageGrantRole | null> {
    if (this.mode !== 'remote') return 'writer'; // native standalone: upstream behaviour, unchanged
    if (await this.pagePermissionRepo.hasRestrictedAncestor(page.id)) return null;
    const res = await this.authz.tryCheckBulk(this.subject(user), [
      { permission: 'view', resourceType: 'space', resourceId: page.spaceId },
      { permission: 'edit', resourceType: 'space', resourceId: page.spaceId },
    ]);
    if (!res) {
      throw new ServiceUnavailableException('authorization is unavailable; the page was not restricted — retry');
    }
    const [view, edit] = res;
    return view ? (edit ? 'writer' : 'reader') : null;
  }

  /**
   * A3 (a): may the actor edit the page right now? Remote: a STRICT PDP `page#edit` (no answer → 503, never a
   * guess). Native (no PDP; the platform never sends the flag there, but a caller may): upstream's own rule —
   * the actor already passed `authorize` (space admin ⊇ space edit), so it reduces to the page-level grant
   * when the page or an ancestor is restricted.
   */
  private async actorCanEdit(page: Page, user: User): Promise<boolean> {
    if (this.mode !== 'remote') {
      const r = await this.pagePermissionRepo.canUserEditPage(user.id, page.id);
      return !r.hasAnyRestriction || r.canEdit;
    }
    const res = await this.authz.tryCheckBulk(this.subject(user), [
      { permission: 'edit', resourceType: 'page', resourceId: page.id },
    ]);
    if (!res) {
      throw new ServiceUnavailableException('authorization is unavailable; the restriction was not removed — retry');
    }
    return res[0];
  }

  /** Load the page and enforce that `user` may manage its restrictions (space admin). */
  private async authorize(pageId: string, user: User): Promise<Page> {
    const page = await this.pageRepo.findById(pageId);
    if (!page) throw new NotFoundException('page not found');
    const ability = await this.spaceAbility.createForUser(user, page.spaceId);
    if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
      throw new ForbiddenException('only a space admin may manage page restrictions');
    }
    return page;
  }

  private async requireAccessId(pageId: string): Promise<string> {
    const access = await this.pagePermissionRepo.findPageAccessByPageId(pageId);
    if (!access) throw new BadRequestException('page is not restricted');
    return access.id;
  }

  /**
   * Make a page restricted, granting the actor the access they already had (A2) so they don't lock themselves
   * out — and nothing more. The role is decided BEFORE any write.
   */
  async restrict(pageId: string, user: User): Promise<void> {
    const page = await this.authorize(pageId, user);
    if (await this.pagePermissionRepo.findPageAccessByPageId(pageId)) return; // already restricted
    const retained = await this.retainedRole(page, user);
    await this.pagePermissionRepo.insertPageAccess({
      pageId: page.id,
      workspaceId: page.workspaceId,
      spaceId: page.spaceId,
      accessLevel: 'members',
      creatorId: user.id,
    });
    if (!retained) return;
    const access = await this.pagePermissionRepo.findPageAccessByPageId(pageId);
    if (access) {
      await this.pagePermissionRepo.insertPagePermissions([
        { pageAccessId: access.id, userId: user.id, role: retained, addedById: user.id },
      ]);
    }
  }

  /**
   * Remove restriction — page_access delete cascades all grants (and the platform clears the tuples). With
   * `requireActorCoverage` (A3) it is refused unless the actor can edit the page (403) and every DIRECT
   * sub-page carries its own restriction (409): an unrestricted child of a restricted page is locked through
   * its parent and cannot hold grants of its own, so nobody can see it — lifting the parent would expose it.
   * Direct children suffice: a deeper page is unlocked only via an unrestricted chain, whose top is a direct
   * child. Trashed children count (they can be restored).
   */
  async unrestrict(pageId: string, user: User, opts: { requireActorCoverage?: boolean } = {}): Promise<void> {
    const page = await this.authorize(pageId, user);
    if (opts.requireActorCoverage) {
      if (!(await this.actorCanEdit(page, user))) {
        throw new ForbiddenException('you can only remove the restriction from a page you can edit');
      }
      const exposed = await this.db
        .selectFrom('pages as c')
        .select('c.id')
        .where('c.parentPageId', '=', page.id)
        .where((eb) =>
          eb.not(eb.exists(eb.selectFrom('pageAccess as pa').select('pa.id').whereRef('pa.pageId', '=', 'c.id'))),
        )
        .limit(1)
        .executeTakeFirst();
      if (exposed) {
        throw new ConflictException(
          'the page has sub-pages that are not restricted; unrestricting it would expose them — restrict them first or use the wiki UI',
        );
      }
    }
    await this.pagePermissionRepo.deletePageAccess(pageId);
  }

  /** Grant users/groups access to a restricted page (idempotent: replaces any existing grant). */
  async addPermission(dto: AddPagePermissionDto, user: User): Promise<void> {
    await this.authorize(dto.pageId, user);
    const accessId = await this.requireAccessId(dto.pageId);
    const userIds = dto.userIds ?? [];
    const groupIds = dto.groupIds ?? [];
    if (userIds.length === 0 && groupIds.length === 0) {
      throw new BadRequestException('userIds or groupIds required');
    }
    await this.refuseSelfGrant(user, userIds, groupIds);
    // Replace any existing grant for these subjects so add is idempotent / doubles as a role change.
    await this.pagePermissionRepo.deletePagePermissionsByUserIds(accessId, userIds);
    await this.pagePermissionRepo.deletePagePermissionsByGroupIds(accessId, groupIds);
    const perms: InsertablePagePermission[] = [
      ...userIds.map((userId) => ({ pageAccessId: accessId, userId, role: dto.role, addedById: user.id })),
      ...groupIds.map((groupId) => ({ pageAccessId: accessId, groupId, role: dto.role, addedById: user.id })),
    ];
    await this.pagePermissionRepo.insertPagePermissions(perms);
  }

  /** Revoke users'/groups' access to a restricted page (revoking your own grant is always allowed). */
  async removePermission(dto: RemovePagePermissionDto, user: User): Promise<void> {
    await this.authorize(dto.pageId, user);
    const accessId = await this.requireAccessId(dto.pageId);
    if (dto.userIds?.length) await this.pagePermissionRepo.deletePagePermissionsByUserIds(accessId, dto.userIds);
    if (dto.groupIds?.length) await this.pagePermissionRepo.deletePagePermissionsByGroupIds(accessId, dto.groupIds);
  }

  /**
   * Change a subject's role (reader ↔ writer) on a restricted page. #486: 404 when the subject holds no grant
   * here — upstream's `updatePagePermissionRole` returns void and cannot tell, so a PATCH for a non-grantee used
   * to answer success. The grant row is found and locked in this transaction, then updated by its id.
   */
  async updatePermission(dto: UpdatePagePermissionDto, user: User): Promise<void> {
    if (!dto.userId === !dto.groupId) {
      throw new BadRequestException('exactly one of userId or groupId is required');
    }
    await this.authorize(dto.pageId, user);
    await this.refuseSelfGrant(user, dto.userId ? [dto.userId] : [], dto.groupId ? [dto.groupId] : []);
    await executeTx(this.db, async (trx) => {
      const access = await this.pagePermissionRepo.findPageAccessByPageId(dto.pageId, trx);
      if (!access) throw new BadRequestException('page is not restricted');
      const grant = await trx
        .selectFrom('pagePermissions')
        .select('id')
        .where('pageAccessId', '=', access.id)
        .$if(!!dto.userId, (q) => q.where('userId', '=', dto.userId!))
        .$if(!!dto.groupId, (q) => q.where('groupId', '=', dto.groupId!))
        .forUpdate()
        .executeTakeFirst();
      if (!grant) throw new NotFoundException('no permission for this user or group on the page');
      await trx
        .updateTable('pagePermissions')
        .set({ role: dto.role, updatedAt: new Date() })
        .where('id', '=', grant.id)
        .execute();
    });
  }
}
