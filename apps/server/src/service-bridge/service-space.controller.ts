import {
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
  RawSpaceMember,
  ServiceSpaceService,
  SpaceDetailView,
  SpaceMemberPreview,
  SpaceView,
} from './service-space.service';
import {
  AddSpaceMemberDto,
  CreateSpaceDto,
  ExpectedVersionDto,
  SpaceMemberPreviewDto,
  UpdateSpaceDto,
  UpdateSpaceMemberDto,
} from './dto/space-admin.dto';
import { parseSubCollectionQuery } from './dto/sub-collection-page.dto';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * The space + membership control plane the platform calls (it authorizes `space#administer` first; these
 * carry no authorization policy — the service enforces the last-admin DATA invariant (409) and refuses a
 * self-raising membership write (403 `self_grant`), both under the space row lock).
 * `RemoteOnlyGuard` 404s the surface unless AUTHZ_MODE=remote; the scoped ServiceAuthGuard
 * enforces least privilege (read vs write scopes). The fork owns the schema + the transactional create.
 *
 * #616: the detail and every membership carry a `version`; rename / archive / role change / removal take an optional
 * `expectedVersion` compared atomically (412 `precondition_failed`) and answer the new version (a removal has none).
 * `members/preview` answers what a member write would do without writing (same scope as the write; not a narrowing
 * route — it narrows nothing).
 */
@Controller('service/spaces')
@UseGuards(RemoteOnlyGuard, ServiceAuthGuard)
export class ServiceSpaceController {
  constructor(private readonly service: ServiceSpaceService) {}

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Get()
  @RequireServiceScope(ServiceScope.SpacesRead)
  async list(@Query('includeArchived') includeArchived?: string): Promise<SpaceView[]> {
    return this.service.list(includeArchived === 'true');
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Get(':spaceId')
  @RequireServiceScope(ServiceScope.SpacesRead)
  async getDetail(@Param('spaceId', ParseUUIDPipe) spaceId: string): Promise<SpaceDetailView> {
    return this.service.getDetail(spaceId);
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Get(':spaceId/members')
  @RequireServiceScope(ServiceScope.SpacesRead)
  async listMembers(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('limit') limit?: string,
    @Query('beforeCreatedAt') beforeCreatedAt?: string,
    @Query('beforeId') beforeId?: string,
  ): Promise<RawSpaceMember[]> {
    // Opt-in keyset paging (no params → all members, the backward-compatible default).
    return this.service.listMembers(spaceId, parseSubCollectionQuery(limit, beforeCreatedAt, beforeId));
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SpacesWrite)
  async create(@Body() dto: CreateSpaceDto): Promise<{ id: string; slug: string; name: string | null }> {
    return this.service.create(dto);
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Patch(':spaceId')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SpacesWrite)
  async update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: UpdateSpaceDto,
  ): Promise<{ ok: true; version: string }> {
    const { expectedVersion, ...input } = dto;
    return { ok: true, ...(await this.service.update(spaceId, input, expectedVersion)) };
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post(':spaceId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SpacesWrite)
  async archive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto?: ExpectedVersionDto,
  ): Promise<{ ok: true; version: string }> {
    return { ok: true, ...(await this.service.archive(spaceId, dto?.expectedVersion)) };
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post(':spaceId/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SpacesWrite)
  async unarchive(@Param('spaceId', ParseUUIDPipe) spaceId: string): Promise<{ ok: true }> {
    await this.service.unarchive(spaceId);
    return { ok: true };
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post(':spaceId/members')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SpacesWrite)
  async addMember(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: AddSpaceMemberDto,
  ): Promise<{ memberId: string; userId: string; version: string }> {
    return this.service.addMember(spaceId, dto);
  }

  /**
   * #616: what an add / role change / removal would do — decided like the real write, under its locks, rolled back;
   * shadow users are only looked up, never provisioned. Declared before `:memberId` routes (a distinct POST path).
   */
  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post(':spaceId/members/preview')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SpacesWrite)
  async previewMember(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: SpaceMemberPreviewDto,
  ): Promise<SpaceMemberPreview> {
    return this.service.previewMember(spaceId, dto);
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Patch(':spaceId/members/:memberId')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SpacesWrite)
  async changeMemberRole(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateSpaceMemberDto,
  ): Promise<{ ok: true; version: string }> {
    return {
      ok: true,
      ...(await this.service.changeMemberRole(spaceId, memberId, dto.role, dto.actorExternalId, dto.expectedVersion)),
    };
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Delete(':spaceId/members/:memberId')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SpacesWrite)
  async removeMember(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto?: ExpectedVersionDto,
  ): Promise<{ ok: true }> {
    await this.service.removeMember(spaceId, memberId, dto?.expectedVersion);
    return { ok: true };
  }
}
