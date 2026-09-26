import {
  applyDecorators,
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Post,
  PreconditionFailedException,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { sql } from 'kysely';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateBy,
} from 'class-validator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Page, User, Workspace } from '@docmost/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../../core/page/services/page.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../core/casl/interfaces/space-ability.type';
import { DeletePageDto } from '../../core/page/dto/page.dto';
import { MovePageDto, MovePageToSpaceDto } from '../../core/page/dto/move-page.dto';
import { UpdatePageDto } from '../../core/page/dto/update-page.dto';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { getPageTitle } from '../../common/helpers';
import { pageEtagOpaque } from './page-etag';
import { OpSemaphore, OpSemaphoreTimeout } from './op-semaphore';

/** `If-Match: *` — the page exists (it has not been permanently deleted). Accepted only as the sole item. */
export const ETAG_ANY = '*';
export const MAX_EXPECTED_ETAGS = 8;
export const MAX_ETAG_LENGTH = 128;
/** Conditional page operations in flight per fork process, and how long a request waits for a slot. */
export const CONDITIONAL_OPS_MAX_CONCURRENT = 2;
export const CONDITIONAL_OPS_SLOT_WAIT_MS = 2000;
/** Bounds on the transaction: a lock we cannot get quickly, or a statement that runs long, is a retryable 503. */
export const CONDITIONAL_OPS_LOCK_TIMEOUT = '2s';
export const CONDITIONAL_OPS_STATEMENT_TIMEOUT = '15s';
/** SQLSTATEs that mean "busy, retry": lock_not_available, deadlock_detected, query_canceled (statement timeout). */
export const ENGINE_BUSY_SQLSTATES: ReadonlySet<string> = new Set(['55P03', '40P01', '57014']);

export type ConditionalOutcome = 'applied' | 'noop';
export interface ConditionalOpResult {
  outcome: ConditionalOutcome;
  pageId: string;
}

/** The expected-version list every conditional route carries (the platform already stripped `W/`, quotes, spaces). */
function IsExpectedEtags(): PropertyDecorator {
  return applyDecorators(
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(MAX_EXPECTED_ETAGS),
    IsString({ each: true }),
    MinLength(1, { each: true }),
    MaxLength(MAX_ETAG_LENGTH, { each: true }),
    ValidateBy({
      name: 'etagWildcardAlone',
      validator: {
        validate: (v: unknown) => !Array.isArray(v) || !v.includes(ETAG_ANY) || v.length === 1,
        defaultMessage: () => `expectedEtags: "${ETAG_ANY}" must be the only item`,
      },
    }),
  );
}

// Each DTO EXTENDS the native route's DTO (the conditional-update argument): the fork's ValidationPipe strips an
// undeclared property silently, so a hand-copied field set would drift from the native route at the next bump.

export class ConditionalDeletePageDto extends DeletePageDto {
  @IsExpectedEtags() expectedEtags: string[];
}

export class ConditionalMovePageDto extends MovePageDto {
  @IsExpectedEtags() expectedEtags: string[];
}

export class ConditionalMovePageToSpaceDto extends MovePageToSpaceDto {
  /**
   * Only for convergence ("already there"). The engine's move-to-space always lands at the target space's root, so a
   * named parent could not be honoured — it is refused rather than silently dropped.
   */
  @IsOptional()
  @Equals(null, { message: 'parentPageId: a move to another space lands at its root; send null or omit it' })
  parentPageId?: string | null;

  @IsExpectedEtags() expectedEtags: string[];
}

export class ConditionalUpdatePageMetaDto extends UpdatePageDto {
  @IsExpectedEtags() expectedEtags: string[];
}

/** The fields `PageService.update` writes from the request; convergence is decided on these alone (tripwire-pinned). */
export const META_FIELDS = ['title', 'icon'] as const;
/** Declared on UpdatePageDto but ignored by `PageService.update` (as on the native route): never block a no-op. */
const META_IGNORED = new Set(['pageId', 'expectedEtags', 'parentPageId', 'spaceId']);
/** Content belongs to the content write (`conditional-update`), never to a metadata write. */
const CONTENT_FIELDS = ['content', 'operation', 'format'] as const;

/** Exactly `PageRepo`'s base fields plus `content` (the ETag input) — never `ydoc`/`tsv`/`text_content`. */
const LOCKED_FIELDS = [
  'id',
  'slugId',
  'title',
  'icon',
  'coverPhoto',
  'position',
  'parentPageId',
  'creatorId',
  'lastUpdatedById',
  'spaceId',
  'workspaceId',
  'isLocked',
  'isBase',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'contributorIds',
  'content',
] as const;

/** A retryable 503 for a busy engine (a lock not got in time, a deadlock, a statement timeout, no free slot). */
export function engineBusy(): ServiceUnavailableException {
  return new ServiceUnavailableException({ message: 'the page is busy; retry shortly', code: 'engine_busy' });
}

/** The 503 for a driver error that means "busy, retry", or null for any other error (which passes through). */
export function toEngineBusy(err: unknown): ServiceUnavailableException | null {
  if (err instanceof OpSemaphoreTimeout) return engineBusy();
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ENGINE_BUSY_SQLSTATES.has(code) ? engineBusy() : null;
}

/**
 * CCC authorization integration — NOT upstream Docmost code (#616).
 *
 * ATOMIC compare-and-write for page trash / permanent delete / move / move-to-space / metadata update. The platform
 * used to check a page's `If-Match` and then call the native route — a window in which another write could land and
 * be overwritten or deleted. Here the version is compared INSIDE the write's own transaction, under the row lock:
 *
 *   slot (≤2 per process, ≤2s wait) → BEGIN → SET LOCAL lock_timeout/statement_timeout → the page row
 *   `FOR NO KEY UPDATE` → 404 → the native route's authorization, REPLICATED → convergence (already done ⇒ `noop`)
 *   → compare → the upstream service call WITH the transaction → COMMIT → the native audit event.
 *
 * `FOR NO KEY UPDATE`, never `FOR UPDATE`: the #545 guard triggers (g0 on `page_access`) take the per-workspace
 * advisory lock and THEN a `FOR KEY SHARE` on the page (the foreign-key check); `FOR UPDATE` would block that while
 * our move waits on the same advisory lock inside g1/g2 — a deadlock. `FOR NO KEY UPDATE` still excludes every other
 * writer of the row (a native write, the collab store's `FOR UPDATE`, a second conditional op).
 *
 * Convergence is decided on the locked row BEFORE the compare (RFC 9110 §13.1.1), so a retry of a write that already
 * committed answers 200 `noop` instead of 412-ing on its own change. A permanent delete never converges.
 *
 * Like `conditional-update`, a NORMAL relayed route under `JwtAuthGuard` as the caller's own (shadow) user — the fork
 * re-decides authorization itself (CASL + `validateCanEdit`, exactly the native preambles, pinned against the native
 * controller by `conditional-page-ops.tripwire.spec.ts`). The two move handlers are narrowing routes
 * (`live-access/narrowing-routes.ts`), so they answer only once the PDP enforces them, like the native moves. The
 * #545 guard refusals map to 409 through the global `PageGuardConflictInterceptor`; busy SQLSTATEs map to 503
 * `engine_busy` here. Keeps the upstream `{ data, success }` envelope.
 */
@UseGuards(JwtAuthGuard)
@Controller('pages')
export class ConditionalPageOpsController {
  private readonly logger = new Logger(ConditionalPageOpsController.name);
  private readonly slots = new OpSemaphore(CONDITIONAL_OPS_MAX_CONCURRENT, CONDITIONAL_OPS_SLOT_WAIT_MS);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly pageAccessService: PageAccessService,
    private readonly spaceAbility: SpaceAbilityFactory,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE) private readonly attachmentQueue: Queue,
  ) {}

  /** Replicates `PageController.delete`. Trash converges on an already-trashed page; a permanent delete never does. */
  @HttpCode(HttpStatus.OK)
  @Post('conditional-delete')
  async conditionalDelete(
    @Body() dto: ConditionalDeletePageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<ConditionalOpResult> {
    const done = await this.guarded(async (trx) => {
      const page = await this.lockPage(trx, dto.pageId, workspace.id, { allowTrashed: true });
      const ability = await this.spaceAbility.createForUser(user, page.spaceId);

      if (dto.permanentlyDelete) {
        // Permanent deletion requires space admin permissions
        if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
          throw new ForbiddenException('Only space admins can permanently delete pages');
        }
        this.assertExpected(dto.expectedEtags, page);
        const deletedIds = await this.pageService.forceDelete(page.id, workspace.id, trx);
        return { outcome: 'applied' as const, page, deletedIds };
      }

      // User with edit permission can delete
      await this.pageAccessService.validateCanEdit(page, user);
      if (page.deletedAt) return { outcome: 'noop' as const, page, deletedIds: [] as string[] };
      this.assertExpected(dto.expectedEtags, page);
      await this.pageService.removePage(page.id, user.id, workspace.id, trx);
      return { outcome: 'applied' as const, page, deletedIds: [] as string[] };
    });

    const { page } = done;
    if (done.outcome === 'applied') {
      const before = {
        pageId: page.id,
        slugId: page.slugId,
        title: getPageTitle(page.title),
        spaceId: page.spaceId,
      };
      if (dto.permanentlyDelete) {
        // AFTER the commit (PageService.forceDelete skips these under a caller transaction): a job queued before a
        // delete that then rolled back would delete the files of a page that survives.
        await this.queueAttachmentDeletion(done.deletedIds);
        this.auditService.log({
          event: AuditEvent.PAGE_DELETED,
          resourceType: AuditResource.PAGE,
          resourceId: page.id,
          spaceId: page.spaceId,
          changes: { before },
        });
      } else {
        this.auditService.log({
          event: AuditEvent.PAGE_TRASHED,
          resourceType: AuditResource.PAGE,
          resourceId: page.id,
          spaceId: page.spaceId,
          changes: { before },
        });
      }
    }
    return { outcome: done.outcome, pageId: page.id };
  }

  /** Replicates `PageController.movePage` (same-space reorder / re-parent). A narrowing route. */
  @HttpCode(HttpStatus.OK)
  @Post('conditional-move')
  async conditionalMove(
    @Body() dto: ConditionalMovePageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<ConditionalOpResult> {
    const done = await this.guarded(async (trx) => {
      const movedPage = await this.lockPage(trx, dto.pageId, workspace.id, { notFound: 'Moved page not found' });

      const ability = await this.spaceAbility.createForUser(user, movedPage.spaceId);
      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
      // Check page-level edit permission
      await this.pageAccessService.validateCanEdit(movedPage, user);

      // Convergence: already under that parent (omitted = the root, as upstream reads it) at that position.
      if (
        (dto.parentPageId ?? null) === (movedPage.parentPageId ?? null) &&
        dto.position === movedPage.position
      ) {
        return { outcome: 'noop' as const, page: movedPage };
      }

      // If moving to a new parent, check permission on the target parent
      if (dto.parentPageId && dto.parentPageId !== movedPage.parentPageId) {
        const targetParent = await this.pageRepo.findById(dto.parentPageId, { trx });
        if (!targetParent || targetParent.deletedAt) {
          throw new NotFoundException('Target parent page not found');
        }
        await this.pageAccessService.validateCanEdit(targetParent, user);
      }

      this.assertExpected(dto.expectedEtags, movedPage);
      await this.pageService.movePage(
        { pageId: movedPage.id, parentPageId: dto.parentPageId, position: dto.position },
        movedPage,
        trx,
      );
      return { outcome: 'applied' as const, page: movedPage };
    });
    return { outcome: done.outcome, pageId: done.page.id };
  }

  /** Replicates `PageController.movePageToSpace`. Lands at the target space's root. A narrowing route. */
  @HttpCode(HttpStatus.OK)
  @Post('conditional-move-to-space')
  async conditionalMoveToSpace(
    @Body() dto: ConditionalMovePageToSpaceDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<ConditionalOpResult> {
    const done = await this.guarded(async (trx) => {
      const movedPage = await this.lockPage(trx, dto.pageId, workspace.id, { notFound: 'Page to move not found' });

      const abilities = await Promise.all([
        this.spaceAbility.createForUser(user, movedPage.spaceId),
        this.spaceAbility.createForUser(user, dto.spaceId),
      ]);
      if (abilities.some((ability) => ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page))) {
        throw new ForbiddenException();
      }
      // Check page-level edit permission on the source page
      await this.pageAccessService.validateCanEdit(movedPage, user);

      // Convergence, decided before the native "already in this space" refusal so a retry answers `noop`, not 400.
      if (
        movedPage.spaceId === dto.spaceId &&
        (dto.parentPageId === undefined || (movedPage.parentPageId ?? null) === null)
      ) {
        return { outcome: 'noop' as const, page: movedPage, childPageIds: [] as string[] };
      }
      if (movedPage.spaceId === dto.spaceId) {
        throw new BadRequestException('Page is already in this space');
      }

      this.assertExpected(dto.expectedEtags, movedPage);
      // Moves only accessible pages; inaccessible child pages become root pages in original space
      const { childPageIds } = await this.pageService.movePageToSpace(movedPage, dto.spaceId, user.id, trx);
      return { outcome: 'applied' as const, page: movedPage, childPageIds };
    });

    const { page } = done;
    if (done.outcome === 'applied') {
      this.auditService.log({
        event: AuditEvent.PAGE_MOVED_TO_SPACE,
        resourceType: AuditResource.PAGE,
        resourceId: page.id,
        spaceId: page.spaceId,
        changes: {
          before: { spaceId: page.spaceId },
          after: { spaceId: dto.spaceId },
        },
        metadata: {
          title: getPageTitle(page.title),
          ...(done.childPageIds.length > 0 && { childPageIds: done.childPageIds }),
        },
      });
    }
    return { outcome: done.outcome, pageId: page.id };
  }

  /** Replicates `PageController.update` for METADATA only (title/icon); content goes to `conditional-update`. */
  @HttpCode(HttpStatus.OK)
  @Post('conditional-update-meta')
  async conditionalUpdateMeta(
    @Body() dto: ConditionalUpdatePageMetaDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<ConditionalOpResult> {
    const sent = CONTENT_FIELDS.filter((k) => dto[k] !== undefined);
    if (sent.length > 0) {
      throw new BadRequestException(
        `${sent.join(', ')}: not accepted on a metadata write — send content through conditional-update`,
      );
    }
    const { expectedEtags, ...metadata } = dto;

    const done = await this.guarded(async (trx) => {
      const page = await this.lockPage(trx, dto.pageId, workspace.id);

      await this.pageAccessService.validateCanEdit(page, user);

      if (metadataConverged(metadata as Record<string, unknown>, page)) return { outcome: 'noop' as const, page };

      this.assertExpected(expectedEtags, page);
      await this.pageService.update(page, { ...metadata, pageId: page.id }, user, trx);
      return { outcome: 'applied' as const, page };
    });
    return { outcome: done.outcome, pageId: done.page.id };
  }

  /**
   * One slot, one transaction, bounded waits; busy SQLSTATEs become a retryable 503. Every other error — a 403/404/
   * 409/412 — passes through unchanged, and the transaction rolls back, so a refused operation changes nothing.
   */
  private async guarded<T>(fn: (trx: KyselyTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.slots.run(() =>
        executeTx(this.db, async (trx) => {
          await sql`SET LOCAL lock_timeout = ${sql.lit(CONDITIONAL_OPS_LOCK_TIMEOUT)}`.execute(trx);
          await sql`SET LOCAL statement_timeout = ${sql.lit(CONDITIONAL_OPS_STATEMENT_TIMEOUT)}`.execute(trx);
          return fn(trx);
        }),
      );
    } catch (err) {
      const busy = toEngineBusy(err);
      if (busy) {
        this.logger.warn(
          `CONDITIONAL_PAGE_OP_BUSY code=${(err as { code?: string }).code ?? (err as Error).name}: answered 503 engine_busy`,
        );
        throw busy;
      }
      throw err;
    }
  }

  /**
   * Resolve a slug to the page's id (an id never changes), then lock the row `FOR NO KEY UPDATE`, workspace-scoped. A
   * missing page is 404; a TRASHED page is 404 for everything but a delete (a retry of a trash converges instead).
   */
  private async lockPage(
    trx: KyselyTransaction,
    ref: string,
    workspaceId: string,
    opts: { allowTrashed?: boolean; notFound?: string } = {},
  ): Promise<Page> {
    const notFound = opts.notFound ?? 'Page not found';
    const resolved = await this.pageRepo.findById(ref, { trx });
    if (!resolved || resolved.workspaceId !== workspaceId) throw new NotFoundException(notFound);
    const page = (await trx
      .selectFrom('pages')
      .select([...LOCKED_FIELDS])
      .where('id', '=', resolved.id)
      .where('workspaceId', '=', workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirst()) as Page | undefined;
    if (!page) throw new NotFoundException(notFound);
    if (page.deletedAt && !opts.allowTrashed) throw new NotFoundException(notFound);
    return page;
  }

  /** `["*"]` passes on any live row; otherwise one of the tags must equal the locked row's version. */
  private assertExpected(expectedEtags: string[], page: Page): void {
    if (expectedEtags.length === 1 && expectedEtags[0] === ETAG_ANY) return;
    const current = pageEtagOpaque(page);
    if (!expectedEtags.includes(current)) {
      throw new PreconditionFailedException({ message: 'page changed', code: 'precondition_failed' });
    }
  }

  /**
   * The attachment-deletion jobs `PageService.forceDelete` queues on its own path — same job name, id and retry
   * policy (pinned against the upstream source by the tripwire spec). Run after the commit; a failure here cannot
   * undo the committed delete, so it is logged (files left in storage), never turned into an error.
   */
  private async queueAttachmentDeletion(pageIds: string[]): Promise<void> {
    for (const id of pageIds) {
      try {
        await this.attachmentQueue.add(
          QueueJob.DELETE_PAGE_ATTACHMENTS,
          { pageId: id },
          {
            jobId: `delete-page-attachments-${id}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
          },
        );
      } catch (err) {
        this.logger.error(
          `PAGE_ATTACHMENT_CLEANUP_ENQUEUE_FAILED page=${id}: the page is deleted but its attachment files were not queued for deletion: ${(err as Error).message}`,
        );
      }
    }
  }
}

/**
 * A metadata write is a no-op when every field it would write is already the row's value. Only the fields
 * `PageService.update` writes (title, icon) can converge; any OTHER provided field (a future upstream one) means
 * "apply", so a convergence check can never drop a change it does not understand.
 */
export function metadataConverged(metadata: Record<string, unknown>, page: Page): boolean {
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || META_IGNORED.has(key)) continue;
    if (!(META_FIELDS as readonly string[]).includes(key)) return false;
    if (value !== (page as unknown as Record<string, unknown>)[key]) return false;
  }
  return true;
}
