import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { SkipTransform } from '../common/decorators/skip-transform.decorator';
import { RemoteOnlyGuard } from '../authz/mode/remote-only.guard';
import { RequireServiceScope, ServiceAuthGuard } from './service-auth.guard';
import { ServiceScope } from './service-scope';
import {
  PublicAttachmentSummary,
  ServiceAttachmentService,
} from './service-attachment.service';
import { parseSubCollectionQuery } from './dto/sub-collection-page.dto';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Read-only attachment lookups backing the platform's `/v1` attachments surface (Option A: resolve→page, then
 * the platform authorizes page#view/#edit — no attachment tuple in the PDP). A PRIVILEGED DATA PLANE, not a
 * gate: the platform performs the page decision BEFORE calling. The bytes themselves are NOT served here — the
 * platform streams them through Docmost's existing native `GET /api/files/:id/:name` (the fork owns storage).
 * `RemoteOnlyGuard` 404s the surface unless remote; the scoped ServiceAuthGuard enforces attachments:read.
 */
@Controller('service/attachments')
@UseGuards(RemoteOnlyGuard, ServiceAuthGuard)
export class ServiceAttachmentController {
  constructor(private readonly attachments: ServiceAttachmentService) {}

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Get(':attachmentId/page')
  @RequireServiceScope(ServiceScope.AttachmentsRead)
  async resolvePage(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<{ attachmentId: string; pageId: string | null; spaceId: string | null }> {
    return this.attachments.resolvePage(attachmentId);
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Get('by-page/:pageId')
  @RequireServiceScope(ServiceScope.AttachmentsRead)
  async listByPage(
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Query('limit') limit?: string,
    @Query('beforeCreatedAt') beforeCreatedAt?: string,
    @Query('beforeId') beforeId?: string,
  ): Promise<{ items: PublicAttachmentSummary[] }> {
    // Opt-in keyset paging (no params → all file attachments, the backward-compatible default).
    return this.attachments.listByPage(pageId, parseSubCollectionQuery(limit, beforeCreatedAt, beforeId));
  }
}
