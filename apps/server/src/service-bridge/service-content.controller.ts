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
import { SkipTransform } from '../common/decorators/skip-transform.decorator';
import { RemoteOnlyGuard } from '../authz/mode/remote-only.guard';
import { RequireServiceScope, ServiceAuthGuard } from './service-auth.guard';
import { ServiceScope } from './service-scope';
import {
  PublicPageSummary,
  PublicSpaceSummary,
  ServiceContentService,
} from './service-content.service';
import { PublicSearchHit, ServiceSearchService } from './service-search.service';
import { ContentListDto } from './dto/content-read.dto';
import { ContentSearchDto } from './dto/content-search.dto';

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
  constructor(
    private readonly content: ServiceContentService,
    private readonly searchSvc: ServiceSearchService,
  ) {}

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post('pages/list')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.ContentRead)
  async listPages(@Body() dto: ContentListDto): Promise<{ items: PublicPageSummary[] }> {
    return this.content.listPagesByIds(dto);
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post('spaces/list')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.ContentRead)
  async listSpaces(@Body() dto: ContentListDto): Promise<{ items: PublicSpaceSummary[] }> {
    return this.content.listSpacesByIds(dto);
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Get('spaces/:spaceId')
  @RequireServiceScope(ServiceScope.ContentRead)
  async getSpace(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ): Promise<PublicSpaceSummary> {
    return this.content.getSpace(spaceId);
  }

  // Permission-aware search. UNLIKE the list ops above, this is NOT a privileged data plane over a pre-
  // authorized id set — it IS the authorization gate (PdpSearchService, filter-then-retrieve), so it carries
  // its own scope (content:search) and the platform must not post-filter the result.
  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post('search')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.ContentSearch)
  async search(@Body() dto: ContentSearchDto): Promise<{ items: PublicSearchHit[] }> {
    return this.searchSvc.searchContent(dto);
  }
}
