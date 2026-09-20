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
import { IsOptional, IsString } from 'class-validator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../../core/page/services/page.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { UpdatePageDto } from '../../core/page/dto/update-page.dto';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { ConditionalUpdateOutcome } from './collab-outcomes';

/**
 * EXTENDS `UpdatePageDto` deliberately, rather than restating its fields. The fork's global
 * ValidationPipe runs `whitelist: true` WITHOUT `forbidNonWhitelisted`, so an undeclared property is
 * silently stripped, not rejected: a hand-copied field set would mean that the moment a field is added
 * upstream (or to our own `/v1` mapper), the same PATCH applies it when nobody has the page open and
 * silently drops it when someone does — a difference in behaviour decided by whether a colleague has a
 * tab open, with no error anywhere. Inheriting is the same argument that justifies widening
 * `parseProsemirrorContent` in seam #121: one definition of what this route accepts.
 */
export class ConditionalUpdatePageDto extends UpdatePageDto {
  /**
   * The digest of the live document this write expects to be replacing, as issued by the settle
   * (`POST /api/collab/flush-page-content`). Optional: the settle omits it when no document was resident,
   * and its absence means there was nothing live to race with, so the write applies unconditionally.
   * It must NEVER be derived from stored content — see the note in stable-hash.ts.
   */
  @IsOptional() @IsString() expectedContentHash?: string;

  /**
   * Optional idempotency key for a CONTENT write (#429). When present, the fork records it on the live
   * document atomically with the content and treats a repeat within the retention window (~1h) as a no-op
   * that returns the current page — so a client/agent retry of a non-idempotent `append`/`prepend` after a
   * timeout cannot double-apply. Bounded, not unconditional exactly-once (see authz/page-write/write-idem.ts).
   * Must be unique per logical operation; the platform forwards its `Idempotency-Key` header here.
   */
  @IsOptional() @IsString() idempotencyKey?: string;
}

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * A COMPARE-AND-SWAP page write (#282, ADR 0019). `POST /api/pages/update` applies content
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

    // TRUTHINESS, matching upstream `PageService.update` (`updatePageDto.content && …`). A falsy
    // `content` ("" / null) is "no content supplied" there, so treating it as supplied here would make
    // the same request wipe the page on this route while no-opping on the ordinary one — a difference
    // decided by whether anyone has the page open.
    if (dto.content) {
      const prosemirrorJson = await this.pageService.parseProsemirrorContent(
        dto.content,
        dto.format ?? 'json',
      );
      // `page.id`, NEVER `dto.pageId`. `PageRepo.findById` resolves a non-UUID as a slugId, and live
      // documents are keyed `page.<uuid>` — so a slug-shaped id would name a DIFFERENT document: the
      // precondition would find nothing resident and silently apply unconditionally, and the direct
      // connection would fork a second RedisSync-owned Y.Doc over the same row, whose store races the
      // real one. Upstream normalizes the same way (`PageService.update` → `updatePageContent(page.id)`).
      const result = (await this.gateway.conditionalUpdatePageContent(page.id, {
        prosemirrorJson,
        operation: dto.operation ?? 'replace',
        user,
        expectedContentHash: dto.expectedContentHash,
        idempotencyKey: dto.idempotencyKey,
        // Typed from the handler's own return shape: `reason` is a literal union there, so renaming a
        // discriminator fails to compile at BOTH ends instead of silently changing what this branches on.
      })) as ConditionalUpdateOutcome | undefined;

      // #429: a keyed write already applied within the idempotency window → a SUCCESSFUL retry, not a
      // conflict. Return the CURRENT page as a 2xx no-op WITHOUT re-applying content OR metadata (the first
      // request applied both). This is the bounded-idempotency guarantee: the non-idempotent append/prepend
      // is not double-applied on a timeout retry.
      if (result?.reason === 'duplicate') {
        const current = await this.pageRepo.findById(page.id, {
          includeContent: true,
        });
        return {
          ...current,
          permissions: { canEdit: true, hasRestriction },
        };
      }

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

    // Metadata only. `content`/`operation`/`format` are removed ON PURPOSE, so PageService.update's
    // content branch (guarded on all three) cannot run a second time, while its row bump,
    // lastUpdatedById, contributorIds and watcher enqueue stay identical to the ordinary update path.
    // Everything else is forwarded by SUBTRACTION rather than re-listed, so a field added to
    // UpdatePageDto keeps working here instead of being silently dropped on this route alone.
    const {
      content: _content,
      operation: _operation,
      format: _format,
      expectedContentHash: _expectedContentHash,
      ...rest
    } = dto;
    const metadataOnly: UpdatePageDto = { ...rest, pageId: page.id };
    const updatedPage = await this.pageService.update(page, metadataOnly, user);

    return { ...updatedPage, permissions: { canEdit: true, hasRestriction } };
  }
}
