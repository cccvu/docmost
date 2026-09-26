import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';

/** Advisory-lock key so concurrent replicas / processes serialize the DDL. Distinct from the other CCC installers'. */
const INSTALL_LOCK_KEY = 774615092616;

const sanitizeInt = (raw: string | undefined, def: number, min: number): number => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : def;
};

/**
 * CCC authorization integration — NOT upstream Docmost code (#616).
 *
 * Installs the create-idempotency ledger (`IdempotencyLedgerService`) in Docmost's own database at boot, when (and
 * only when) `AUTHZ_MODE=remote` — the same pattern as `AuthzOutboxInstaller`: a boot installer rather than a Kysely
 * migration (it runs uniformly in dev and prod, native standalone Docmost installs no CCC DDL, and no upstream file
 * changes), idempotent and advisory-locked so every boot and every replica may run it, and FAIL-CLOSED: if the table
 * cannot be established within the bounded retry the boot fails, rather than serve a keyed create that cannot
 * remember its key.
 *
 *   ccc_idempotency_ledger(namespace_digest, op, key_digest) primary key
 *     namespace_digest  sha256(workspace ‖ the fork-authenticated principal ‖ the caller's namespace)
 *     op                'page.create' | 'space.create'
 *     key_digest        sha256(the raw key) — the key itself is never stored
 *     fingerprint       sha256 hex of the caller's stable request body
 *     resource_id       the created resource, set in the reserving transaction
 *     created_at        drives the retention sweep (index)
 *
 * The index is created only when missing: `create index if not exists` still takes a SHARE lock on the table first,
 * which on every boot would stall live ledger writes behind a rolling deploy.
 */
@Injectable()
export class IdempotencyLedgerInstaller implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdempotencyLedgerInstaller.name);
  private readonly maxAttempts = sanitizeInt(process.env.IDEMPOTENCY_LEDGER_INSTALL_MAX_ATTEMPTS, 15, 1);
  private readonly retryMs = sanitizeInt(process.env.IDEMPOTENCY_LEDGER_INSTALL_RETRY_MS, 2000, 0);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.mode !== 'remote') {
      this.logger.log('AUTHZ_MODE is not remote — skipping the idempotency ledger install (no CCC DDL in native)');
      return;
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.install();
        this.logger.log('ccc_idempotency_ledger ensured on Docmost DB (remote mode)');
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === this.maxAttempts) {
          this.logger.error(`IDEMPOTENCY_LEDGER_INSTALL_FAILED after ${attempt} attempts — refusing to boot: ${msg}`);
          throw new Error(`idempotency ledger install failed in remote mode: ${msg}`);
        }
        this.logger.warn(`idempotency ledger install attempt ${attempt} failed: ${msg}`);
        await new Promise((r) => {
          const t = setTimeout(r, this.retryMs);
          t.unref?.();
        });
      }
    }
  }

  /** The idempotent DDL, serialized across replicas/processes by a transaction-scoped advisory lock. */
  async install(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      await sql`select pg_advisory_xact_lock(${INSTALL_LOCK_KEY})`.execute(trx);
      await sql`
        create table if not exists ccc_idempotency_ledger (
          namespace_digest text        not null,
          op               text        not null,
          key_digest       text        not null,
          fingerprint      text        not null,
          resource_id      uuid,
          created_at       timestamptz not null default now(),
          primary key (namespace_digest, op, key_digest)
        )
      `.execute(trx);
      const idx = await sql<{ present: boolean }>`
        select to_regclass('ccc_idempotency_ledger_created_at_idx') is not null as present
      `.execute(trx);
      if (!idx.rows[0]?.present) {
        await sql`
          create index if not exists ccc_idempotency_ledger_created_at_idx on ccc_idempotency_ledger (created_at)
        `.execute(trx);
      }
    });
  }
}
