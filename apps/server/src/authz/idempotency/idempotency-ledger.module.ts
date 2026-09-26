import { Module } from '@nestjs/common';
import { IdempotencyLedgerInstaller } from './idempotency-ledger.installer';
import { IdempotencyLedgerService } from './idempotency-ledger.service';
import { IdempotencyLedgerSweeper } from './idempotency-ledger.sweeper';

/**
 * CCC authorization integration — NOT upstream Docmost code (#616).
 *
 * The create-idempotency ledger: its boot installer, the hourly retention sweep, and `IdempotencyLedgerService`
 * (exported) for any create that must survive a relay failure after commit. Imported by the CCC modules that serve
 * such creates (ConditionalPageModule for `POST /api/pages/idempotent-create`) — never by an upstream file. Nest
 * instantiates it once however many modules import it, so the installer and the sweep run once per process.
 * KyselyDB (DatabaseModule) and AUTHZ_MODE (AuthzModeModule) are global.
 */
@Module({
  providers: [IdempotencyLedgerInstaller, IdempotencyLedgerService, IdempotencyLedgerSweeper],
  exports: [IdempotencyLedgerService],
})
export class IdempotencyLedgerModule {}
