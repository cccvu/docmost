import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipTransform } from '../common/decorators/skip-transform.decorator';
import { RemoteOnlyGuard } from '../authz/mode/remote-only.guard';
import { RequireServiceScope, ServiceAuthGuard } from './service-auth.guard';
import { ServiceScope } from './service-scope';
import {
  AddedGroupMembers,
  EnsuredDefaultGroup,
  GroupMembershipSummary,
  GroupUsage,
  GroupView,
  RawGroupMember,
  ServiceGroupService,
} from './service-group.service';
import {
  AddGroupMembersDto,
  CreateGroupDto,
  EnsureDefaultGroupDto,
  GroupMembershipLookupDto,
  UpdateGroupDto,
} from './dto/group-admin.dto';
import { parseSubCollectionQuery, SUB_COLLECTION_MAX_LIMIT } from './dto/sub-collection-page.dto';

/**
 * CCC service-bridge — NOT upstream Docmost code (wiki-v2 #797).
 *
 * The group control plane the platform calls (it authorizes a workspace admin, applies its self-grant rules and audits
 * first; these carry no authorization policy — the service enforces the data invariants: the default group is changed
 * only by `default/ensure`, case-insensitive name uniqueness, no delete of a group that still grants access, members
 * are users named by externalId). `RemoteOnlyGuard` 404s the surface unless AUTHZ_MODE=remote; the scoped
 * ServiceAuthGuard enforces least privilege (`groups:read` vs `groups:write`).
 *
 * `DELETE :groupId/members/:externalId` is a narrowing route (`authz/live-access/narrowing-routes.ts`): it answers with
 * `Authz-Propagation`. `memberships/lookup` and `:groupId/usage` are reads (`groups:read`). `default/ensure` and
 * `memberships/lookup` are declared before the `:groupId` routes.
 */
@Controller('service/groups')
@UseGuards(RemoteOnlyGuard, ServiceAuthGuard)
export class ServiceGroupController {
  constructor(private readonly service: ServiceGroupService) {}

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)
  @Get()
  @RequireServiceScope(ServiceScope.GroupsRead)
  async list(@Query('q') q?: string, @Query('limit') limit?: string): Promise<GroupView[]> {
    if (q !== undefined && q.length > GROUP_QUERY_MAX_LENGTH) {
      throw new BadRequestException(`q must be at most ${GROUP_QUERY_MAX_LENGTH} characters`);
    }
    return this.service.list({ q, limit: parseLimit(limit) });
  }

  /** A READ (POST only to carry the body): the live groups one identity is in. */
  @SkipTransform()
  @Post('memberships/lookup')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.GroupsRead)
  async lookupMemberships(@Body() dto: GroupMembershipLookupDto): Promise<{ groups: GroupMembershipSummary[] }> {
    return this.service.lookupMemberships(dto.externalId);
  }

  @SkipTransform()
  @Post('default/ensure')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.GroupsWrite)
  async ensureDefault(@Body() dto: EnsureDefaultGroupDto): Promise<EnsuredDefaultGroup> {
    return this.service.ensureDefault(dto);
  }

  @SkipTransform()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireServiceScope(ServiceScope.GroupsWrite)
  async create(@Body() dto: CreateGroupDto): Promise<GroupView> {
    return this.service.create(dto);
  }

  @SkipTransform()
  @Get(':groupId')
  @RequireServiceScope(ServiceScope.GroupsRead)
  async get(@Param('groupId', ParseUUIDPipe) groupId: string): Promise<GroupView> {
    return this.service.get(groupId);
  }

  @SkipTransform()
  @Patch(':groupId')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.GroupsWrite)
  async update(@Param('groupId', ParseUUIDPipe) groupId: string, @Body() dto: UpdateGroupDto): Promise<GroupView> {
    return this.service.update(groupId, dto);
  }

  @SkipTransform()
  @Delete(':groupId')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.GroupsWrite)
  async delete(@Param('groupId', ParseUUIDPipe) groupId: string): Promise<{ ok: true }> {
    await this.service.delete(groupId);
    return { ok: true };
  }

  @SkipTransform()
  @Get(':groupId/usage')
  @RequireServiceScope(ServiceScope.GroupsRead)
  async usage(@Param('groupId', ParseUUIDPipe) groupId: string): Promise<GroupUsage> {
    return this.service.usage(groupId);
  }

  @SkipTransform()
  @Get(':groupId/members')
  @RequireServiceScope(ServiceScope.GroupsRead)
  async listMembers(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Query('limit') limit?: string,
    @Query('beforeCreatedAt') beforeCreatedAt?: string,
    @Query('beforeId') beforeId?: string,
  ): Promise<RawGroupMember[]> {
    return this.service.listMembers(groupId, parseSubCollectionQuery(limit, beforeCreatedAt, beforeId));
  }

  @SkipTransform()
  @Post(':groupId/members')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.GroupsWrite)
  async addMembers(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: AddGroupMembersDto,
  ): Promise<AddedGroupMembers> {
    return this.service.addMembers(groupId, dto);
  }

  @SkipTransform()
  @Delete(':groupId/members/:externalId')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.GroupsWrite)
  async removeMember(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('externalId') externalId: string,
  ): Promise<{ removed: boolean }> {
    return this.service.removeMember(groupId, externalId);
  }
}

const GROUP_QUERY_MAX_LENGTH = 100;

/** `limit` (optional): an integer in [1, 200], else 400. */
function parseLimit(raw?: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > SUB_COLLECTION_MAX_LIMIT) {
    throw new BadRequestException(`limit must be an integer in [1, ${SUB_COLLECTION_MAX_LIMIT}]`);
  }
  return n;
}
