import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../../core/page/services/page.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../core/casl/interfaces/space-ability.type';
import { CreatePageDto } from '../../core/page/dto/create-page.dto';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';
import { getPageTitle } from '../../common/helpers';
import { jsonToHtml, jsonToMarkdown } from '../../collaboration/collaboration.util';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { OpSemaphore } from '../page-write/op-semaphore';
import { toEngineBusy } from '../page-write/conditional-page-ops.controller';
import {
  boundLedgerTx,
  IdempotencyLedgerService,
  idempotencyKeyReused,
  userPrincipal,
} from './idempotency-ledger.service';
import { IsIdempotencyKey, IsIdempotencyNamespace, IsRequestFingerprint } from './idempotency-dto';

/** Keyed creates in flight per fork process, and how long a request waits for a slot before a retryable 503. */
export const IDEMPOTENT_CREATE_MAX_CONCURRENT = 2;
export const IDEMPOTENT_CREATE_SLOT_WAIT_MS = 2000;

/**
 * EXTENDS the native `CreatePageDto` (the fork's ValidationPipe strips an undeclared property silently, so a
 * hand-copied field set would drift from the native route at the next bump) plus the three keyed-create fields.
 */
export class IdempotentCreatePageDto extends CreatePageDto {
  @IsIdempotencyKey() idempotencyKey: string;
  @IsIdempotencyNamespace() idempotencyNamespace: string;
  @IsRequestFingerprint() fingerprint: string;
}

/**
 * CCC authorization integration — NOT upstream Docmost code (#616).
 *
 * `POST /api/pages/idempotent-create` — the native `POST /api/pages/create`, keyed so that a retry after a relay
 * failure that followed the commit returns the page it already created instead of creating a duplicate. The
 * platform's Redis claim cannot know the outcome in that window; the ledger row (`IdempotencyLedgerService`)
 * commits in the SAME transaction as the page:
 *
 *   native preamble (REPLICATED, pinned by conditional-page-ops.tripwire.spec.ts) → parse the content → slot (≤2 per
 *   process, ≤2s wait) → BEGIN → SET LOCAL lock/statement timeouts → reserve the key
 *     fresh    → PageService.create(…, trx) → complete(slot, page.id) → COMMIT → view check → PAGE_CREATED audit
 *     replay   → read the page it created → COMMIT → view check (no create, no audit, no watcher, no event)
 *     mismatch → 409 `idempotency_key_reused`, nothing written
 *
 * - The native preamble runs on a replay too: returning the page requires the same authority a fresh create would
 *   (a replay after the caller lost the parent/space is refused like the create, never answered from the ledger).
 * - The content is parsed BEFORE the transaction (an HTML/Markdown import can take a while and must not hold a
 *   pooled connection or row lock), then handed to `PageService.create` as canonical JSON, which it only re-validates.
 * - `PageService.create` reads the parent and the next position through its own `this.db` (a second pooled
 *   connection, outside our snapshot). That matches the native route's reads; the per-process slot cap bounds the
 *   extra connections.
 * - The view check and the audit run after the commit, exactly as the native route orders them (the PDP's #524 lineage
 *   read needs the committed page). The replayed page is the page's CURRENT state, re-authorized for this caller.
 *
 * A NORMAL relayed route under `JwtAuthGuard` as the caller's own (shadow) user, like `conditional-update`; 404 unless
 * `AUTHZ_MODE=remote` (the ledger exists only there). Keeps the upstream `{ data, success }` envelope; the body is the
 * native create's plus `replayed`. Busy SQLSTATEs and a full slot → 503 `engine_busy`.
 */
@UseGuards(RemoteOnlyGuard, JwtAuthGuard)
@Controller('pages')
export class IdempotentPageCreateController {
  private readonly logger = new Logger(IdempotentPageCreateController.name);
  private readonly slots = new OpSemaphore(IDEMPOTENT_CREATE_MAX_CONCURRENT, IDEMPOTENT_CREATE_SLOT_WAIT_MS);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly pageAccessService: PageAccessService,
    private readonly spaceAbility: SpaceAbilityFactory,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly ledger: IdempotencyLedgerService,
  ) {}

  /** Replicates `PageController.create`, keyed. */
  @HttpCode(HttpStatus.OK)
  @Post('idempotent-create')
  async create(
    @Body() dto: IdempotentCreatePageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    // Transport fields never reach PageService.create.
    const { idempotencyKey, idempotencyNamespace, fingerprint, ...createPageDto } = dto;

    if (createPageDto.parentPageId) {
      // Creating under a parent page - check edit permission on parent
      const parentPage = await this.pageRepo.findById(createPageDto.parentPageId);
      if (!parentPage || parentPage.deletedAt || parentPage.spaceId !== createPageDto.spaceId) {
        throw new NotFoundException('Parent page not found');
      }
      await this.pageAccessService.validateCanEdit(parentPage, user);
    } else {
      // Creating at root level - require space-level permission
      const ability = await this.spaceAbility.createForUser(user, createPageDto.spaceId);
      if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    const toCreate = await this.parsedBeforeTx(createPageDto);

    const { page, replayed } = await this.guarded(async (trx) => {
      const reservation = await this.ledger.reserve(trx, {
        workspaceId: workspace.id,
        principal: userPrincipal(user.id),
        namespace: idempotencyNamespace,
        op: 'page.create',
        key: idempotencyKey,
        fingerprint,
      });
      if (reservation.outcome === 'mismatch') throw idempotencyKeyReused();
      if (reservation.outcome === 'replay') {
        const existing = await this.pageRepo.findById(reservation.resourceId, { trx });
        if (!existing || existing.workspaceId !== workspace.id) {
          throw new NotFoundException({
            message: 'the page created under this idempotency key no longer exists',
            code: 'idempotency_resource_gone',
          });
        }
        return { page: existing, replayed: true };
      }
      const created = await this.pageService.create(user.id, workspace.id, toCreate, trx);
      await this.ledger.complete(trx, reservation.slot, created.id);
      return { page: created, replayed: false };
    });

    const { canEdit, hasRestriction } = await this.pageAccessService.validateCanViewWithPermissions(page, user);

    const permissions = { canEdit, hasRestriction };

    if (replayed) {
      this.logger.log(`IDEMPOTENT_CREATE_REPLAYED page=${page.id}: returned the page this key created; nothing re-run`);
    } else {
      this.auditService.log({
        event: AuditEvent.PAGE_CREATED,
        resourceType: AuditResource.PAGE,
        resourceId: page.id,
        spaceId: page.spaceId,
        changes: {
          after: {
            title: getPageTitle(page.title),
            spaceId: page.spaceId,
          },
        },
      });
    }

    if (createPageDto.format && createPageDto.format !== 'json' && page.content) {
      const contentOutput =
        createPageDto.format === 'markdown' ? jsonToMarkdown(page.content) : jsonToHtml(page.content);
      return { ...page, content: contentOutput, permissions, replayed };
    }

    return { ...page, permissions, replayed };
  }

  /**
   * The content parsed to canonical JSON before any transaction, under the SAME condition `PageService.create` parses
   * it (`content && format`, tripwire-pinned): `create` then only re-validates JSON, and stores exactly what the
   * native route would. Anything else passes through untouched (an empty content creates a page without content, as
   * native).
   */
  private async parsedBeforeTx(dto: CreatePageDto): Promise<CreatePageDto> {
    if (!(dto?.content && dto?.format)) return dto;
    const content = await this.pageService.parseProsemirrorContent(dto.content, dto.format);
    return { ...dto, content, format: 'json' };
  }

  /**
   * One slot, one bounded transaction; busy SQLSTATEs and a full slot become a retryable 503. Every other error passes
   * through unchanged and the transaction rolls back — so a failed create leaves neither a page nor a ledger row.
   */
  private async guarded<T>(fn: (trx: KyselyTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.slots.run(() =>
        executeTx(this.db, async (trx) => {
          await boundLedgerTx(trx);
          return fn(trx);
        }),
      );
    } catch (err) {
      const busy = toEngineBusy(err);
      if (busy) {
        this.logger.warn(
          `IDEMPOTENT_CREATE_BUSY code=${(err as { code?: string }).code ?? (err as Error).name}: answered 503 engine_busy`,
        );
        throw busy;
      }
      throw err;
    }
  }
}
