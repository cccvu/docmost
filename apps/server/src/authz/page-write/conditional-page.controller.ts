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
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { PageService } from '../../core/page/services/page.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { UpdatePageDto } from '../../core/page/dto/update-page.dto';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { ConditionalUpdateOutcome } from './collab-outcomes';
import { stableHash } from './stable-hash';

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
   * Bounded (#429 security review S2): the key is recorded on the live doc and persists in `pages.ydoc`, so
   * an over-long value would bloat the snapshot; 255 chars is generous for a UUID/opaque token. The platform
   * edge also rejects an over-long header, so this is the fork-side half of a two-layer bound.
   */
  @IsOptional() @IsString() @MaxLength(255) idempotencyKey?: string;

  /**
   * #485: before a content `replace`, save the page's CURRENT content as a history version, so the write can be
   * undone in one step (the engine's own history job runs minutes later and would miss it). Skipped when the
   * current content already equals the newest version or the incoming content. The response then carries
   * `snapshot: { status: 'saved' | 'unchanged', historyId }`; the platform treats its ABSENCE as an engine that
   * predates this field and refuses the write.
   */
  @IsOptional() @IsBoolean() snapshotBefore?: boolean;
}

/** What a `snapshotBefore` write reports back (#485). `historyId` is the version that holds the prior content. */
export interface SnapshotOutcome {
  status: 'saved' | 'unchanged';
  historyId: string | null;
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
    private readonly pageHistoryRepo?: PageHistoryRepo, // #485 snapshotBefore (appended)
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

    // The metadata to apply alongside/after the content. `content`/`operation`/`format` are removed ON
    // PURPOSE, so PageService.update's content branch (guarded on all three) cannot run a second time, while
    // its row bump, lastUpdatedById, contributorIds and watcher enqueue stay identical to the ordinary
    // update path. `expectedContentHash`/`idempotencyKey` are transport concerns, not page columns — and the
    // key MUST NOT leak into PageService.update (correctness review). Everything else is forwarded by
    // SUBTRACTION rather than re-listed, so a field added to UpdatePageDto keeps working here instead of
    // being silently dropped on this route alone. Computed BEFORE the content branch so the duplicate path
    // below can tell whether there is metadata still to (re)apply.
    const {
      content: _content,
      operation: _operation,
      format: _format,
      expectedContentHash: _expectedContentHash,
      idempotencyKey: _idempotencyKey,
      snapshotBefore: _snapshotBefore,
      ...rest
    } = dto;
    let snapshot: SnapshotOutcome | undefined;
    const metadataOnly: UpdatePageDto = { ...rest, pageId: page.id };
    // Does this request carry an actual metadata edit (title/icon/parent/…)? `rest` is `dto` minus the
    // content + transport fields; `pageId` only addresses the row, it is not an edit.
    const hasMetadata = Object.keys(rest).some(
      (k) => k !== 'pageId' && (rest as Record<string, unknown>)[k] !== undefined,
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
      // #485: snapshot AFTER the edit check and the parse (a refused or malformed write saves nothing), BEFORE
      // the apply. A replace that then 412s leaves a version equal to the unchanged page — harmless, and the
      // next attempt reports it as `unchanged` rather than saving a duplicate.
      if (dto.snapshotBefore && (dto.operation ?? 'replace') === 'replace') {
        snapshot = await this.snapshotCurrent(page.id, prosemirrorJson, dto.title);
      }
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

      if (result?.reason === 'duplicate') {
        // #429: this exact content already applied within the idempotency window → a SUCCESSFUL retry, not
        // a conflict. Do NOT re-apply the non-idempotent append/prepend. But the SAME request may ALSO carry
        // metadata, applied AFTER the content by PageService.update below; if that second write failed on
        // the first attempt (content committed + key recorded, metadata not), returning here unconditionally
        // would SILENTLY DROP the metadata on every retry (architecture review F1). Metadata is idempotent,
        // so when it is present we fall through and (re)apply it; a content-ONLY retry stays a genuine inert
        // no-op — the current page, no row bump, no reattribution, no broadcast.
        if (!hasMetadata) {
          const current = await this.pageRepo.findById(page.id, {
            includeContent: true,
          });
          return { ...current, permissions: { canEdit: true, hasRestriction }, ...(snapshot ? { snapshot } : {}) };
        }
        // else: fall through to the metadata write (the content was already applied by the first request).
      } else if (result?.applied !== true) {
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

    // Runs for an applied content write (its row bump), a metadata-only write, AND a deduped content write
    // that still carries metadata (the F1 re-apply above). Content was stripped from `metadataOnly`, so
    // PageService.update's content branch cannot run here.
    const updatedPage = await this.pageService.update(page, metadataOnly, user);

    return { ...updatedPage, permissions: { canEdit: true, hasRestriction }, ...(snapshot ? { snapshot } : {}) };
  }

  /**
   * Save the page's current title + content as a history version unless that would add nothing: the write
   * changes neither (its title is omitted or equal, and its content is equal), or the newest saved version
   * already holds exactly this title + content. Content is compared by `stableHash` (key-order-insensitive).
   * The row is current: the platform settles the live document before a guarded write (ADR 0019).
   */
  private async snapshotCurrent(
    pageId: string,
    incoming: unknown,
    incomingTitle: string | undefined,
  ): Promise<SnapshotOutcome> {
    if (!this.pageHistoryRepo) throw new ServiceUnavailableException('page history is unavailable');
    const current = await this.pageRepo.findById(pageId, { includeContent: true });
    if (!current) throw new NotFoundException('Page not found');
    const currentHash = stableHash(current.content ?? null);
    const titleKept = incomingTitle === undefined || incomingTitle === current.title;
    if (titleKept && currentHash === stableHash(incoming ?? null)) return { status: 'unchanged', historyId: null };
    const last = await this.pageHistoryRepo.findPageLastHistory(pageId, { includeContent: true });
    if (last && last.title === current.title && stableHash(last.content ?? null) === currentHash) {
      return { status: 'unchanged', historyId: last.id };
    }
    const saved = await this.pageHistoryRepo.insertPageHistory({
      pageId: current.id,
      slugId: current.slugId,
      title: current.title,
      content: current.content,
      icon: current.icon,
      coverPhoto: current.coverPhoto,
      lastUpdatedById: current.lastUpdatedById ?? current.creatorId,
      contributorIds: current.contributorIds,
      spaceId: current.spaceId,
      workspaceId: current.workspaceId,
    });
    return { status: 'saved', historyId: saved.id };
  }
}
