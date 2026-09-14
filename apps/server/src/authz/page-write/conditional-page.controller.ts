import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  PreconditionFailedException,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../../core/page/services/page.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import {
  ContentOperation,
  UpdatePageDto,
} from '../../core/page/dto/update-page.dto';
import { ContentFormat } from '../../core/page/dto/create-page.dto';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';

export class ConditionalUpdatePageDto {
  @IsString() pageId!: string;

  /**
   * The digest of the live document this write expects to be replacing, as issued by the settle
   * (`POST /api/collab/flush-page-content`). Optional: the settle omits it when no document was resident,
   * and its absence means there was nothing live to race with, so the write applies unconditionally.
   * It must NEVER be derived from stored content — see the note in stable-hash.ts.
   */
  @IsOptional() @IsString() expectedContentHash?: string;

  @IsOptional() content?: string | object;

  @ValidateIf((o) => o.content !== undefined)
  @Transform(({ value }) => value?.toLowerCase())
  @IsIn(['append', 'prepend', 'replace'])
  operation?: ContentOperation;

  @ValidateIf((o) => o.content !== undefined)
  @Transform(({ value }) => value?.toLowerCase() ?? 'json')
  @IsIn(['json', 'markdown', 'html'])
  format?: ContentFormat;

  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsString() parentPageId?: string;
}

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * A COMPARE-AND-SWAP page write (#282, ADR 0017). `POST /api/pages/update` applies content
 * unconditionally, so a caller that verified a version a moment earlier can still overwrite a keystroke
 * that landed in between — and because pages are edited live over the collab websocket, "in between"
 * is a real interval, not a theoretical one. Here the version check happens INSIDE the Yjs transaction
 * that performs the mutation, so a concurrent edit cannot slip between the check and the replace.
 *
 * Deliberately a NORMAL relayed route, not an `/api/service/*` one: it runs under `JwtAuthGuard` as the
 * caller's own (shadow) user and re-runs `PageAccessService.validateCanEdit` exactly as
 * `PageController.update` does, so the fork's independent re-enforcement — the "suspenders" half of the
 * platform/fork defense-in-depth — still applies to every content write. A service-secret side door would
 * have skipped it.
 *
 * Metadata is applied through `PageService.update` (with content omitted) so the row bump,
 * `lastUpdatedById`, `contributorIds` and the watcher enqueue stay byte-identical to the ordinary update
 * path. Content is applied FIRST so a refused precondition changes nothing at all.
 *
 * Returns the same shape as `POST /api/pages/update` — canonical JSON content, no markdown/HTML echo — and
 * keeps the upstream `{ data, success }` envelope (no `@SkipTransform`), because the platform reaches it
 * through the ordinary relay, which unwraps that envelope.
 */
@UseGuards(JwtAuthGuard)
@Controller('pages')
export class ConditionalPageController {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly pageAccessService: PageAccessService,
    private readonly gateway: CollaborationGateway,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('conditional-update')
  async conditionalUpdate(
    @Body() dto: ConditionalUpdatePageDto,
    @AuthUser() user: User,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    // The suspenders: the platform already decided, and we decide again, independently.
    const { hasRestriction } = await this.pageAccessService.validateCanEdit(
      page,
      user,
    );

    if (dto.content !== undefined) {
      const prosemirrorJson = await this.pageService.parseProsemirrorContent(
        dto.content,
        dto.format ?? 'json',
      );
      const result = (await this.gateway.conditionalUpdatePageContent(
        dto.pageId,
        {
          prosemirrorJson,
          operation: dto.operation ?? 'replace',
          user,
          expectedContentHash: dto.expectedContentHash,
        },
      )) as { applied?: boolean; reason?: string } | undefined;

      if (result?.applied !== true) {
        if (result?.reason === 'precondition') {
          throw new PreconditionFailedException('page content changed');
        }
        // Anything else — a collab node that errored, or RedisSync disabled (which resolves to undefined) —
        // means we could NOT establish the precondition. Refuse rather than fall back to an unconditional
        // write: silently downgrading an atomicity guarantee is invisible to the caller.
        throw new ServiceUnavailableException(
          'could not apply the conditional content write',
        );
      }
    }

    // Metadata only — `content`/`operation`/`format` are deliberately omitted, so PageService.update's
    // content branch (guarded on all three being present) cannot run a second time, while its row bump,
    // lastUpdatedById, contributorIds and watcher enqueue stay identical to the ordinary update path.
    const metadataOnly: UpdatePageDto = {
      pageId: dto.pageId,
      title: dto.title,
      icon: dto.icon,
      parentPageId: dto.parentPageId,
    };
    const updatedPage = await this.pageService.update(page, metadataOnly, user);

    return { ...updatedPage, permissions: { canEdit: true, hasRestriction } };
  }
}
