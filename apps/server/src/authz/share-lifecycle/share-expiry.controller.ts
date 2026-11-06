import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Page, Share, User, Workspace } from '@docmost/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { AuditEventType, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { asEngineBusy, boundWaits } from '../../service-bridge/resource-version';
import { SetShareExpiryDto, ShareExpiryInfoDto } from './share-expiry.dto';
import { shareIsLiveSql, shareReportedExpirySql } from './share-expiry.sql';
import { SharePublishGate } from './share-publish.gate';

/**
 * Upstream's `AuditEvent` has no share-update event (it has only `share.created` / `share.deleted`), and adding one
 * would edit an upstream file. The platform sink stores the event name verbatim, so the CCC event is its own name.
 */
export const SHARE_EXPIRY_UPDATED = 'share.expiry_updated' as AuditEventType;

export interface ShareExpiryView {
  /** ISO-8601 instant the share stops being public, or `null` for "Never". */
  expiresAt: string | null;
}

/**
 * CCC share lifecycle — NOT upstream Docmost code (#335, ADR 0032).
 *
 *   POST /api/shares/expiry/info {shareId}                       → { expiresAt }   (page view)
 *   POST /api/shares/expiry      {shareId, expiresInDays|null}   → { expiresAt }   (page edit)
 *
 * Both resolve the share through the injected `ShareRepo` token (remote = `PdpShareRepo`, so an expired share is
 * "Share not found"), require it to be in the caller's workspace (else the same 404), and authorize on the shared
 * page exactly as upstream's share routes do: `validateCanView` to read, `validateCanEdit` to change — the gate
 * share update and delete use. Changing the expiry changes the publish state (Never, or a later date, keeps a page
 * public longer), so `set` also needs `page#share` (#704): it calls `SharePublishGate` — the check the upstream share
 * create and update get from `SharePublishInterceptor` — after resolving the share and before its transaction, so no
 * row lock is ever held across the PDP call.
 *
 * The write is ONE bounded transaction, in the sweeper's lock order: the `shares` row `FOR UPDATE`, then — in a
 * fresh statement, so a concurrent renewal or sweep that committed before the lock is seen — the liveness re-check
 * (an expired share is dead: 404, re-share instead), then the `ccc_share_expiry` upsert (`null` = "Never"; a renewal
 * counts from now). A lock/statement timeout is a retryable 503 `engine_busy`. Audited after the commit with the
 * before/after expiry.
 *
 * A NORMAL relayed route under `JwtAuthGuard`; 404 unless `AUTHZ_MODE=remote` (the table exists only there).
 */
@UseGuards(RemoteOnlyGuard, JwtAuthGuard)
@Controller('shares/expiry')
export class ShareExpiryController {
  private readonly logger = new Logger(ShareExpiryController.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly shareRepo: ShareRepo,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly publishGate: SharePublishGate,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(
    @Body() dto: ShareExpiryInfoDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<ShareExpiryView> {
    const { share, page } = await this.resolve(dto.shareId, workspace);
    await this.pageAccessService.validateCanView(page, user);
    const current = await this.readExpiry(this.db, share.id);
    if (!current || !current.live) throw shareNotFound();
    return { expiresAt: toIso(current.expiresAt) };
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async set(
    @Body() dto: SetShareExpiryDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<ShareExpiryView> {
    const { share, page } = await this.resolve(dto.shareId, workspace);
    // #704: publish authority, decided before any transaction (and before the edit check, as the interceptor's is).
    await this.publishGate.requirePublish(user.id, page);
    await this.pageAccessService.validateCanEdit(page, user);

    const { before, after } = await this.bounded(async (trx) => {
      const locked = await sql<{ id: string }>`
        select s.id from shares s where s.id = ${share.id} for update of s
      `.execute(trx);
      if (locked.rows.length === 0) throw shareNotFound();
      const current = await this.readExpiry(trx, share.id);
      if (!current || !current.live) throw shareNotFound();
      const written = await sql<{ expiresAt: Date | null }>`
        insert into ccc_share_expiry (share_id, expires_at, updated_at)
        values (
          ${share.id},
          ${dto.expiresInDays === null ? sql`null` : sql`now() + make_interval(days => ${dto.expiresInDays}::int)`},
          now()
        )
        on conflict (share_id) do update set expires_at = excluded.expires_at, updated_at = excluded.updated_at
        returning expires_at
      `.execute(trx);
      return { before: toIso(current.expiresAt), after: toIso(written.rows[0].expiresAt) };
    });

    this.auditService.log({
      event: SHARE_EXPIRY_UPDATED,
      resourceType: AuditResource.SHARE,
      resourceId: share.id,
      spaceId: share.spaceId,
      changes: { before: { expiresAt: before }, after: { expiresAt: after } },
      metadata: { pageId: share.pageId, expiresInDays: dto.expiresInDays },
    });

    return { expiresAt: after };
  }

  /** The live share in the caller's workspace and its page; anything else is the same 404. */
  private async resolve(shareId: string, workspace: Workspace): Promise<{ share: Share; page: Page }> {
    const share = await this.shareRepo.findById(shareId);
    if (!share || share.workspaceId !== workspace.id || !share.pageId) throw shareNotFound();
    const page = await this.pageRepo.findById(share.pageId);
    if (!page || page.deletedAt || page.workspaceId !== workspace.id) throw shareNotFound();
    return { share, page };
  }

  private async readExpiry(
    db: KyselyDB | KyselyTransaction,
    shareId: string,
  ): Promise<{ live: boolean; expiresAt: Date | null } | undefined> {
    const res = await sql<{ live: boolean; expiresAt: Date | null }>`
      select ${shareIsLiveSql('s')} as live, ${shareReportedExpirySql('s')} as expires_at
      from shares s where s.id = ${shareId}
    `.execute(db);
    return res.rows[0];
  }

  private async bounded<T>(fn: (trx: KyselyTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await boundWaits(trx);
        return fn(trx);
      });
    } catch (err) {
      const busy = asEngineBusy(err);
      if (busy) {
        this.logger.warn(
          `SHARE_EXPIRY_WRITE_BUSY code=${(err as { code?: string }).code}: answered 503 engine_busy`,
        );
        throw busy;
      }
      throw err;
    }
  }
}

const shareNotFound = () => new NotFoundException('Share not found');

const toIso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
