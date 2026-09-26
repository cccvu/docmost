import { Global, Module } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { PlatformAuditClient } from './platform-audit.client';
import { PlatformAuditService } from './platform-audit.service';
import { ActivityAuditWriter, StandaloneAuditService } from './activity-audit.writer';

/**
 * The `AUDIT_SERVICE` for a mode. remote → the platform-forwarding implementation; native → upstream's no-op
 * (standalone deployments have no central audit sink — a value-add, not a security control; documented).
 * BOTH also keep the #615 activity copy of the allowlisted page/comment lifecycle events in Docmost's `audit`
 * table (activity-audit.writer.ts), so that table means the same thing in either mode. Exported so
 * platform-audit.service.spec.ts can pin that each mode gets the writer.
 */
export function createAuditService(
  mode: AuthzMode,
  cls: ClsService,
  client: PlatformAuditClient,
  activity: ActivityAuditWriter,
): IAuditService {
  return mode === 'remote'
    ? new PlatformAuditService(cls, client, activity)
    : new StandaloneAuditService(cls, activity);
}

/**
 * CCC audit integration — NOT upstream Docmost code.
 *
 * Binds `AUDIT_SERVICE` by AUTHZ_MODE via `createAuditService`. Same `@Global` + `exports: [AUDIT_SERVICE]`
 * shape as upstream's `NoopAuditModule`, so the ~45 upstream call sites that inject the token are a drop-in
 * swap and the app.module.ts import line is unchanged (the mode selection lives here, not upstream).
 * `ActivityAuditWriter` is a provider (not constructed in the factory) so Nest runs its lifecycle hooks — the
 * hourly retention prune starts on init and stops on shutdown. It needs only the global Kysely connection.
 */
@Global()
@Module({
  providers: [
    PlatformAuditClient,
    ActivityAuditWriter,
    {
      provide: AUDIT_SERVICE,
      inject: [AUTHZ_MODE, ClsService, PlatformAuditClient, ActivityAuditWriter],
      useFactory: createAuditService,
    },
  ],
  // PlatformAuditClient is exported (#467) so the per-request `/api` access-audit path (ApiAccessAuditService)
  // can reuse the same fire-and-forget forwarder without re-wiring the base URL / service secret.
  exports: [AUDIT_SERVICE, PlatformAuditClient],
})
export class PlatformAuditModule {}
