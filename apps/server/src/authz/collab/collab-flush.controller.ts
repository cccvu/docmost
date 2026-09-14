import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { IsUUID } from 'class-validator';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { CollabServiceSecretGuard } from './service-secret.guard';

export class FlushPageContentDto {
  @IsUUID() pageId!: string;
}

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The inbound seam for CONTENT SETTLE (issue 282). Docmost persists collaborative edits through a
 * DEBOUNCED `onStoreDocument` (10s idle / 45s max), so the `pages` row trails the live Y.Doc while anyone
 * is editing. The platform's `/v1` optimistic-concurrency anchor is computed from that row, so without a
 * settle its `If-Match` compare can (a) wrongly SUCCEED against a stale row and let a content `replace`
 * destroy a human's unsaved edits, or (b) wrongly FAIL once the row catches up. This endpoint forces the
 * pending store to run before the platform reads the anchor.
 *
 * NOT an authorization decision, so no PDP re-check (unlike the sibling force-disconnect route, which
 * DENIES a user and therefore re-checks): it denies nobody, returns only a boolean, and persists only
 * content the collaboration server has already accepted. The platform has already made the page decision
 * before calling. `RemoteOnlyGuard` 404s this route unless AUTHZ_MODE=remote (the surface is meaningless
 * without the platform); `CollabServiceSecretGuard` verifies the shared service secret.
 */
@UseGuards(RemoteOnlyGuard, CollabServiceSecretGuard)
@Controller('collab')
export class CollabFlushController {
  constructor(private readonly gateway: CollaborationGateway) {}

  @HttpCode(HttpStatus.OK)
  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)
  @Post('flush-page-content')
  async flushPageContent(
    @Body() dto: FlushPageContentDto,
  ): Promise<{ flushed: boolean }> {
    // `handleYjsEvent` resolves to undefined when RedisSync is disabled; treat that as "not flushed"
    // rather than failing the caller — the platform's settle is best-effort by design.
    const result = (await this.gateway.flushPageContent(dto.pageId)) as
      | { flushed?: boolean }
      | undefined;
    return { flushed: result?.flushed === true };
  }
}
