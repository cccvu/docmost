import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { CollabServiceSecretGuard } from './service-secret.guard';
import { FlushPageContentOutcome } from '../page-write/collab-outcomes';

export class FlushPageContentDto {
  @IsUUID() pageId!: string;

  /**
   * Ask for the settled document's digest. Off by default: producing it serializes and hashes the whole
   * document on the event loop every live editor on this node shares, and a read settle
   * (`GET /v1/pages/:id?settle=true`) only ever wants the store.
   */
  @IsOptional() @IsBoolean() withDigest?: boolean;
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
 * before calling. Responds 503 when the settle could not be established — the caller cannot be allowed to
 * read that as "nothing was live". `RemoteOnlyGuard` 404s this route unless AUTHZ_MODE=remote (the surface is meaningless
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
  ): Promise<{ flushed: boolean; contentDigest?: string }> {
    // Typed from the handler's own return shape, so the `reason: 'error'` discriminator below cannot
    // drift apart from the producer: renaming it there fails to compile HERE rather than silently
    // turning every failed settle back into an indistinguishable `{flushed:false}`.
    const result = (await this.gateway.flushPageContent(dto.pageId, {
      withDigest: dto.withDigest === true,
    })) as FlushPageContentOutcome | undefined;

    // "We could not settle" MUST be distinguishable from "there was nothing to settle". A resident
    // document whose flush threw may still hold unpersisted edits; answering `{flushed:false}` — the
    // very same answer a page nobody has open gives — would tell the platform it is safe to write
    // unconditionally against a stale row, which is precisely the lost update this endpoint exists to
    // prevent. `undefined` (RedisSync disabled) is the same "we don't know". Fail loudly; the platform
    // fails the guarded write closed and still lets reads through.
    if (!result || result.reason === 'error') {
      throw new ServiceUnavailableException(
        'could not settle the page content',
      );
    }
    if (result.flushed !== true) return { flushed: false };
    // The live document's digest, for a follow-up conditional write. Present only when a document was
    // actually resident — its absence is the caller's signal that nothing was live to race with.
    return typeof result.contentDigest === 'string'
      ? { flushed: true, contentDigest: result.contentDigest }
      : { flushed: true };
  }
}
