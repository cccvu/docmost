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
  SpaceView,
} from './service-space.service';
import {
  AddSpaceMemberDto,
  CreateSpaceDto,
  UpdateSpaceDto,
  UpdateSpaceMemberDto,
} from './dto/space-admin.dto';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * The space + membership control plane the platform calls (it authorizes `space#administer` first; these
 * carry no policy). `RemoteOnlyGuard` 404s the surface unless AUTHZ_MODE=remote; the scoped ServiceAuthGuard
 * enforces least privilege (read vs write scopes). The fork owns the schema + the transactional create.
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
  async getDetail(@Param('spaceId', ParseUUIDPipe) spaceId: string): Promise<SpaceView> {
    return this.service.getDetail(spaceId);
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Get(':spaceId/members')
  @RequireServiceScope(ServiceScope.SpacesRead)
  async listMembers(@Param('spaceId', ParseUUIDPipe) spaceId: string): Promise<RawSpaceMember[]> {
    return this.service.listMembers(spaceId);
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
  ): Promise<{ ok: true }> {
    await this.service.update(spaceId, dto);
    return { ok: true };
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post(':spaceId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SpacesWrite)
  async archive(@Param('spaceId', ParseUUIDPipe) spaceId: string): Promise<{ ok: true }> {
    await this.service.archive(spaceId);
    return { ok: true };
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
  ): Promise<{ memberId: string; userId: string }> {
    return this.service.addMember(spaceId, dto);
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Patch(':spaceId/members/:memberId')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SpacesWrite)
  async changeMemberRole(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateSpaceMemberDto,
  ): Promise<{ ok: true }> {
    await this.service.changeMemberRole(spaceId, memberId, dto.role);
    return { ok: true };
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Delete(':spaceId/members/:memberId')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SpacesWrite)
  async removeMember(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ): Promise<{ ok: true }> {
    await this.service.removeMember(spaceId, memberId);
    return { ok: true };
  }
}
