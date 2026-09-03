import { Global, Module } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  AUDIT_SERVICE,
  NoopAuditService,
} from '../../integrations/audit/audit.service';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { PlatformAuditClient } from './platform-audit.client';
import { PlatformAuditService } from './platform-audit.service';

/**
 * CCC audit integration — NOT upstream Docmost code.
 *
 * Binds `AUDIT_SERVICE` by AUTHZ_MODE: native → the stock `NoopAuditService` (standalone deployments
 * have no central audit sink — a value-add, not a security control; documented); remote → the
 * platform-forwarding implementation. Same `@Global` + `exports: [AUDIT_SERVICE]` shape as upstream's
 * `NoopAuditModule`, so the ~45 upstream call sites that inject the token are a drop-in swap and the
 * app.module.ts import line is unchanged (the mode selection lives here, not upstream).
 */
@Global()
@Module({
  providers: [
    PlatformAuditClient,
    {
      provide: AUDIT_SERVICE,
      inject: [AUTHZ_MODE, ClsService, PlatformAuditClient],
      useFactory: (
        mode: AuthzMode,
        cls: ClsService,
        client: PlatformAuditClient,
      ) =>
        mode === 'remote'
          ? new PlatformAuditService(cls, client)
          : new NoopAuditService(),
    },
  ],
  exports: [AUDIT_SERVICE],
})
export class PlatformAuditModule {}
