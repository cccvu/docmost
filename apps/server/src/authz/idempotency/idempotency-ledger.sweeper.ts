import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { IDEMPOTENCY_RETENTION_HOURS } from './idempotency-ledger.service';

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
/** The first sweep runs soon after boot, so a process that never lives an hour still sweeps. */
export const FIRST_SWEEP_DELAY_MS = 60 * 1000;
export const SWEEP_BATCH_SIZE = 1000;
export const SWEEP_MAX_BATCHES = 20;

/**
 * CCC authorization integration — NOT upstream Docmost code (#616).
 *
 * The retention sweep of `ccc_idempotency_ledger`: rows older than `IDEMPOTENCY_RETENTION_HOURS` are deleted, in
 * bounded batches (≤ SWEEP_BATCH_SIZE × SWEEP_MAX_BATCHES rows per run, each batch its own short autocommit
 * statement), once shortly after boot and then hourly. Safe on every replica at once: a batch takes its rows
 * `FOR UPDATE SKIP LOCKED`, so replicas never wait on each other and a row a replay is reading (`FOR SHARE`) is left
 * for the next run. Remote mode only (the table exists only there). A failure is logged and retried next run.
 */
@Injectable()
export class IdempotencyLedgerSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyLedgerSweeper.name);
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
  ) {}

  onApplicationBootstrap(): void {
    if (this.mode !== 'remote') return;
    this.firstTimer = setTimeout(() => void this.sweep(), FIRST_SWEEP_DELAY_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep run. Returns the number of rows removed (never throws). */
  async sweep(): Promise<number> {
    let removed = 0;
    try {
      for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
        const del = await sql<{ gone: number }>`
          delete from ccc_idempotency_ledger
          where (namespace_digest, op, key_digest) in (
            select namespace_digest, op, key_digest from ccc_idempotency_ledger
            where created_at < now() - make_interval(hours => ${sql.lit(IDEMPOTENCY_RETENTION_HOURS)})
            order by created_at
            limit ${sql.lit(SWEEP_BATCH_SIZE)}
            for update skip locked
          )
          returning 1 as gone
        `.execute(this.db);
        removed += del.rows.length;
        if (del.rows.length < SWEEP_BATCH_SIZE) break;
      }
      this.logger.log(`IDEMPOTENCY_LEDGER_SWEEP removed=${removed} retentionHours=${IDEMPOTENCY_RETENTION_HOURS}`);
    } catch (e) {
      this.logger.warn(`IDEMPOTENCY_LEDGER_SWEEP_FAILED removed=${removed} (will retry next run): ${(e as Error).message}`);
    }
    return removed;
  }
}
