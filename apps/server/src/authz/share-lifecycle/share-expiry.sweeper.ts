import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { AuditEvent, AuditLogPayload, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';
import { shareEffectiveExpirySql, shareIsLiveSql } from './share-expiry.sql';

export const SHARE_SWEEP_INTERVAL_MS = 60 * 1000;
/** ≤ the platform audit ingest's 500-event batch cap, so one batch is at most one forward per workspace. */
export const SHARE_SWEEP_BATCH_SIZE = 500;
export const SHARE_SWEEP_MAX_BATCHES = 20;

/** One removed share, as the sweeper audits it. */
export interface SweptShare {
  id: string;
  pageId: string;
  spaceId: string;
  workspaceId: string;
  includeSubPages: boolean | null;
  searchIndexing: boolean | null;
  expiresAt: Date;
}

/**
 * CCC share lifecycle — NOT upstream Docmost code (#335, ADR 0032).
 *
 * CLEANUP and AUDIT only, never the control: every remote read already refuses an expired share at read time
 * (`PdpShareRepo` + `shareIsLiveSql`), so if this sweeper stops, expired rows only pile up — none becomes readable.
 *
 * Every 60 s (unref'd timers; remote mode only; never throws; one run at a time per process) it deletes expired
 * shares in bounded batches (≤ SHARE_SWEEP_BATCH_SIZE × SHARE_SWEEP_MAX_BATCHES per run). Each batch is ONE short
 * transaction, in the same lock order as the expiry API's write (the `shares` row, then its `ccc_share_expiry` row
 * through the cascade):
 *   1. lock up to N expired shares `FOR UPDATE OF s SKIP LOCKED`, oldest effective expiry first — replicas take
 *      disjoint rows and never wait on each other, a move/trash/renewal holding a row is simply skipped;
 *   2. delete exactly the locked rows that are STILL expired, re-read in a fresh statement snapshot. Step 1 reads
 *      the expiry table in a snapshot taken before it locked, so a renewal that committed in between (it locks the
 *      row, writes the expiry row, commits) is invisible to it — and `FOR UPDATE` re-checks only a row that was
 *      UPDATED, never one that was only locked, and never the expiry table. Step 2 sees the renewal and keeps the
 *      share. A renewal that starts after step 1 waits on our lock, then finds the share gone (404).
 * The cascade removes the expiry row. After the commit, each removed share is audited as `share.deleted` with
 * `reason: 'expired'`, its before-state and actor type `system`, one batch per workspace.
 *
 * Logs `SHARE_EXPIRY_SWEEP removed=N` only when N > 0, and `SHARE_EXPIRY_SWEEP_FAILED` (warn) on a failure — a
 * hygiene signal (LOG_TOKENS.fork), not a security one.
 */
@Injectable()
export class ShareExpirySweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ShareExpirySweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.mode !== 'remote') return;
    this.timer = setInterval(() => void this.sweep(), SHARE_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep run. Returns the number of shares removed (never throws). */
  async sweep(): Promise<number> {
    if (this.mode !== 'remote' || this.running) return 0;
    this.running = true;
    let removed = 0;
    try {
      for (let batch = 0; batch < SHARE_SWEEP_MAX_BATCHES; batch++) {
        const { locked, gone } = await this.db.transaction().execute((trx) => this.sweepBatch(trx));
        removed += gone.length;
        this.audit(gone);
        if (locked < SHARE_SWEEP_BATCH_SIZE) break;
      }
      if (removed > 0) this.logger.log(`SHARE_EXPIRY_SWEEP removed=${removed}`);
    } catch (e) {
      this.logger.warn(`SHARE_EXPIRY_SWEEP_FAILED removed=${removed} (will retry next run): ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
    return removed;
  }

  /** One batch: lock (step 1), then delete what is still expired (step 2). See the class comment. */
  async sweepBatch(trx: KyselyTransaction): Promise<{ locked: number; gone: SweptShare[] }> {
    await sql`set local lock_timeout = '3s'`.execute(trx);
    await sql`set local statement_timeout = '15s'`.execute(trx);
    const ids = await this.lockExpired(trx);
    if (ids.length === 0) return { locked: 0, gone: [] };
    const res = await sql<SweptShare>`
      with victims as (
        select s.id, ${shareEffectiveExpirySql('s')} as expires_at
        from shares s
        where s.id = any(${ids}::uuid[]) and not ${shareIsLiveSql('s')}
      )
      delete from shares d using victims v
      where d.id = v.id
      returning d.id, d.page_id, d.space_id, d.workspace_id, d.include_sub_pages, d.search_indexing, v.expires_at
    `.execute(trx);
    return { locked: ids.length, gone: res.rows };
  }

  /** Step 1: up to a batch of expired shares, locked, oldest effective expiry first. */
  protected async lockExpired(trx: KyselyTransaction): Promise<string[]> {
    const res = await sql<{ id: string }>`
      select s.id from shares s
      where not ${shareIsLiveSql('s')}
      order by ${shareEffectiveExpirySql('s')}, s.id
      limit ${sql.lit(SHARE_SWEEP_BATCH_SIZE)}
      for update of s skip locked
    `.execute(trx);
    return res.rows.map((r) => r.id);
  }

  /** After the commit: one `share.deleted` batch per workspace (≤ SHARE_SWEEP_BATCH_SIZE events). Never throws. */
  private audit(gone: SweptShare[]): void {
    const byWorkspace = new Map<string, AuditLogPayload[]>();
    for (const s of gone) {
      const payloads = byWorkspace.get(s.workspaceId) ?? [];
      payloads.push({
        event: AuditEvent.SHARE_DELETED,
        resourceType: AuditResource.SHARE,
        resourceId: s.id,
        spaceId: s.spaceId,
        changes: {
          before: {
            pageId: s.pageId,
            spaceId: s.spaceId,
            includeSubPages: s.includeSubPages,
            searchIndexing: s.searchIndexing,
            expiresAt: toIso(s.expiresAt),
          },
        },
        metadata: { reason: 'expired' },
      });
      byWorkspace.set(s.workspaceId, payloads);
    }
    for (const [workspaceId, payloads] of byWorkspace) {
      try {
        void Promise.resolve(
          this.auditService.logBatchWithContext(payloads, { workspaceId, actorType: 'system' }),
        ).catch((e) => this.logger.warn(`SHARE_EXPIRY_SWEEP audit forward failed: ${(e as Error).message}`));
      } catch (e) {
        this.logger.warn(`SHARE_EXPIRY_SWEEP audit forward failed: ${(e as Error).message}`);
      }
    }
  }
}

const toIso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
