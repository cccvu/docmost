import { Global, Module } from '@nestjs/common';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import { PlatformAuditClient } from './platform-audit.client';
import { PlatformAuditService } from './platform-audit.service';

/**
 * CCC audit integration — NOT upstream Docmost code.
 *
 * Binds `AUDIT_SERVICE` to the platform-forwarding implementation, replacing `NoopAuditModule`. Same
 * `@Global` + `exports: [AUDIT_SERVICE]` shape, so the ~45 upstream call sites that inject the token are
 * a drop-in swap (the only upstream edit is the one import line in `app.module.ts`).
 */
@Global()
@Module({
  providers: [
    PlatformAuditClient,
    {
      provide: AUDIT_SERVICE,
      useClass: PlatformAuditService,
    },
  ],
  exports: [AUDIT_SERVICE],
})
export class PlatformAuditModule {}
