import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { InsertablePagePermission, Page, User } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../core/casl/interfaces/space-ability.type';
import {
  AddPagePermissionDto,
  RemovePagePermissionDto,
  UpdatePagePermissionDto,
} from './dto';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The page-restriction WRITE feature (Docmost gates this behind EE and does not vendor the server
 * half here). It only writes Docmost's own `page_access` / `page_permissions` tables via the existing
 * repo methods; the platform's DB-trigger outbox then projects the change to SpiceDB (`#restricted` /
 * `#viewer` / `#editor`) — so NO SpiceDB/policy logic lives here. Managing restrictions is gated on
 * space-admin (`Manage` on space Settings); refine per product later.
 */
@Injectable()
export class PageRestrictionService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
  ) {}

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

  /** Make a page restricted, granting the actor writer access so they don't lock themselves out. */
  async restrict(pageId: string, user: User): Promise<void> {
    const page = await this.authorize(pageId, user);
    if (await this.pagePermissionRepo.findPageAccessByPageId(pageId)) return; // already restricted
    await this.pagePermissionRepo.insertPageAccess({
      pageId: page.id,
      workspaceId: page.workspaceId,
      spaceId: page.spaceId,
      accessLevel: 'members',
      creatorId: user.id,
    });
    const access = await this.pagePermissionRepo.findPageAccessByPageId(pageId);
    if (access) {
      await this.pagePermissionRepo.insertPagePermissions([
        { pageAccessId: access.id, userId: user.id, role: 'writer', addedById: user.id },
      ]);
    }
  }

  /** Remove restriction — page_access delete cascades all grants (and the platform clears the tuples). */
  async unrestrict(pageId: string, user: User): Promise<void> {
    await this.authorize(pageId, user);
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
    // Replace any existing grant for these subjects so add is idempotent / doubles as a role change.
    await this.pagePermissionRepo.deletePagePermissionsByUserIds(accessId, userIds);
    await this.pagePermissionRepo.deletePagePermissionsByGroupIds(accessId, groupIds);
    const perms: InsertablePagePermission[] = [
      ...userIds.map((userId) => ({ pageAccessId: accessId, userId, role: dto.role, addedById: user.id })),
      ...groupIds.map((groupId) => ({ pageAccessId: accessId, groupId, role: dto.role, addedById: user.id })),
    ];
    await this.pagePermissionRepo.insertPagePermissions(perms);
  }

  /** Revoke users'/groups' access to a restricted page. */
  async removePermission(dto: RemovePagePermissionDto, user: User): Promise<void> {
    await this.authorize(dto.pageId, user);
    const accessId = await this.requireAccessId(dto.pageId);
    if (dto.userIds?.length) await this.pagePermissionRepo.deletePagePermissionsByUserIds(accessId, dto.userIds);
    if (dto.groupIds?.length) await this.pagePermissionRepo.deletePagePermissionsByGroupIds(accessId, dto.groupIds);
  }

  /** Change a subject's role (reader ↔ writer) on a restricted page. */
  async updatePermission(dto: UpdatePagePermissionDto, user: User): Promise<void> {
    await this.authorize(dto.pageId, user);
    const accessId = await this.requireAccessId(dto.pageId);
    if (!dto.userId && !dto.groupId) throw new BadRequestException('userId or groupId required');
    await this.pagePermissionRepo.updatePagePermissionRole(accessId, dto.role, {
      userId: dto.userId,
      groupId: dto.groupId,
    });
  }
}
