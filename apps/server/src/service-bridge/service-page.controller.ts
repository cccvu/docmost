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
import { RawPagePermission, ServiceContentService } from './service-content.service';
import { ResolvePageSpaceDto } from './dto/content-read.dto';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Bounded page lookups the platform calls: resolve a page's owning space (for `@AuthzDerived` route checks)
 * and list a page's ACL grants (for the `/v1` ACL read). `RemoteOnlyGuard` 404s the surface unless remote;
 * the scoped ServiceAuthGuard enforces least privilege. The ACL listing is a privileged data plane; the
 * platform maps the returned Docmost user ids back to its own identities.
 */
@Controller('service/pages')
@UseGuards(RemoteOnlyGuard, ServiceAuthGuard)
export class ServicePageController {
  constructor(private readonly content: ServiceContentService) {}

  @Post('resolve-space')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.PagesRead)
  async resolveSpace(@Body() dto: ResolvePageSpaceDto): Promise<{ pageId: string; spaceId: string }> {
    return this.content.resolvePageSpace(dto);
  }

  @Get(':pageId/permissions')
  @RequireServiceScope(ServiceScope.ContentRead)
  async listPermissions(
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ): Promise<{ items: RawPagePermission[] }> {
    return this.content.listPagePermissions(pageId);
  }
}
