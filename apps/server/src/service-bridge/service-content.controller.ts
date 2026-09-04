import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RemoteOnlyGuard } from '../authz/mode/remote-only.guard';
import { RequireServiceScope, ServiceAuthGuard } from './service-auth.guard';
import { ServiceScope } from './service-scope';
import {
  PublicPageSummary,
  PublicSpaceSummary,
  ServiceContentService,
} from './service-content.service';
import { ContentListDto } from './dto/content-read.dto';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * The `/v1` filter-then-retrieve read model, moved into the fork. A PRIVILEGED DATA PLANE, NOT an
 * authorization gate: the `ids` are the platform's PDP-authorized set (the belt); these endpoints return
 * metadata for exactly those ids and do NOT re-authorize. `RemoteOnlyGuard` 404s the surface unless remote;
 * the scoped ServiceAuthGuard enforces the read scope. Cursor encode/decode stays on the platform.
 */
@Controller('service/content')
@UseGuards(RemoteOnlyGuard, ServiceAuthGuard)
export class ServiceContentController {
  constructor(private readonly content: ServiceContentService) {}

  @Post('pages/list')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.ContentRead)
  async listPages(@Body() dto: ContentListDto): Promise<{ items: PublicPageSummary[] }> {
    return this.content.listPagesByIds(dto);
  }

  @Post('spaces/list')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.ContentRead)
  async listSpaces(@Body() dto: ContentListDto): Promise<{ items: PublicSpaceSummary[] }> {
    return this.content.listSpacesByIds(dto);
  }

  @Get('spaces/:spaceId')
  @RequireServiceScope(ServiceScope.ContentRead)
  async getSpace(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ): Promise<PublicSpaceSummary> {
    return this.content.getSpace(spaceId);
  }
}
