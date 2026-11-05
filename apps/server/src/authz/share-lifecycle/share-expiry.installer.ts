import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { DEFAULT_SHARE_TTL_DAYS } from './share-expiry.sql';

/** Advisory-lock key serializing the DDL across replicas. Distinct from every other CCC installer's. */
export const SHARE_EXPIRY_INSTALL_LOCK_KEY = 335335001;

const sanitizeInt = (raw: string | undefined, def: number, min: number): number => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : def;
};

/**
 * CCC share lifecycle — NOT upstream Docmost code (#335, ADR 0032).
 *
 * Installs the public-share expiry table in Docmost's own database at boot, when (and only when)
 * `AUTHZ_MODE=remote`, in the `PageRestrictionGuardInstaller` / `IdempotencyLedgerInstaller` shape: a boot installer
 * (no Kysely migration, no upstream edit, native installs no CCC DDL), advisory-locked so every replica may run it,
 * bounded retry, and FAIL-CLOSED — a remote boot that cannot establish the table throws, so the app never serves
 * while the read-time expiry gate (`PdpShareRepo`) would have nothing to read.
 *
 *   ccc_share_expiry(share_id → shares(id) on delete cascade, expires_at null = "Never", updated_at)
 *
 * No trigger and no DDL on `shares`. The table is created only when missing, and ONLY the run that created it
 * backfills, in the same transaction: every share that existed before expiry was enforced gets `now() + 90 days`
 * (instead of `created_at + 90 days`, which would kill old shares at first boot). A later boot (the table present)
 * runs no DDL, takes no lock and writes nothing — so a share created afterwards keeps the `created_at + 90 days`
 * default and is never "re-backfilled".
 */
@Injectable()
export class ShareExpiryInstaller implements OnApplicationBootstrap {
  private readonly logger = new Logger(ShareExpiryInstaller.name);
  private readonly maxAttempts = sanitizeInt(process.env.SHARE_EXPIRY_INSTALL_MAX_ATTEMPTS, 15, 1);
  private readonly retryMs = sanitizeInt(process.env.SHARE_EXPIRY_INSTALL_RETRY_MS, 2000, 0);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.mode !== 'remote') {
      this.logger.log('AUTHZ_MODE is not remote — skipping the share expiry install (no CCC DDL in native)');
      return;
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this.install();
        this.logger.log(
          res.created
            ? `ccc_share_expiry installed on Docmost DB (remote mode); backfilled=${res.backfilled}`
            : 'ccc_share_expiry already present (remote mode)',
        );
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === this.maxAttempts) {
          this.logger.error(`SHARE_EXPIRY_INSTALL_FAILED after ${attempt} attempts — refusing to boot: ${msg}`);
          throw new Error(`share expiry install failed in remote mode: ${msg}`);
        }
        this.logger.warn(`share expiry install attempt ${attempt} failed (tables not ready or busy?): ${msg}`);
        await new Promise((r) => {
          const t = setTimeout(r, this.retryMs);
          t.unref?.();
        });
      }
    }
  }

  private async present(db: KyselyDB): Promise<boolean> {
    const res = await sql<{ present: boolean }>`
      select to_regclass('ccc_share_expiry') is not null as present
    `.execute(db);
    return res.rows[0]?.present === true;
  }

  /** Idempotent. `created` is true only for the run that created the table (and backfilled). */
  async install(): Promise<{ created: boolean; backfilled: number }> {
    if (await this.present(this.db)) return { created: false, backfilled: 0 };
    return this.db.transaction().execute(async (trx) => {
      await sql`set local lock_timeout = '3s'`.execute(trx);
      await sql`select pg_advisory_xact_lock(${SHARE_EXPIRY_INSTALL_LOCK_KEY})`.execute(trx);
      // Re-checked under the lock: a concurrent replica may have created (and backfilled) it while we waited.
      if (await this.present(trx as unknown as KyselyDB)) return { created: false, backfilled: 0 };
      await sql`
        create table ccc_share_expiry (
          share_id   uuid        primary key references shares(id) on delete cascade,
          expires_at timestamptz,
          updated_at timestamptz not null default now()
        )
      `.execute(trx);
      const filled = await sql`
        insert into ccc_share_expiry (share_id, expires_at)
        select s.id, now() + make_interval(days => ${sql.lit(DEFAULT_SHARE_TTL_DAYS)}) from shares s
      `.execute(trx);
      return { created: true, backfilled: Number(filled.numAffectedRows ?? 0) };
    });
  }
}
