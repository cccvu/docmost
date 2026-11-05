import { Module } from '@nestjs/common';
import { PageModule } from '../../core/page/page.module';
import { PageAccessModule } from '../../core/page/page-access/page-access.module';
import { HttpAuthzClient } from '../http-authz.client';
import { RemotePurgeService } from './remote-purge.service';
import { RemoteTrashService } from './remote-trash.service';

/**
 * CCC authorization integration — NOT upstream Docmost code (#636 W6, #661).
 *
 * Provides the remote-mode page-removal routines — the permanent delete (`RemotePurgeService`) and the trash
 * (`RemoteTrashService`) — to their two entry points: `RemotePurgeInterceptor` (registered as an APP_INTERCEPTOR in
 * app.module.ts, seam #4, which imports this module) and `ConditionalPageOpsController` (ConditionalPageModule imports
 * it). PageModule gives `PageService`; PageAccessModule gives `PageAccessService` (the trash's root fast refusal);
 * PageRepo (DatabaseModule), SpaceAbilityFactory (CaslModule), AUTHZ_MODE, AUDIT_SERVICE and the attachment queue are
 * global. HttpAuthzClient is stateless and configured from env, so a module-local instance is equivalent (as in
 * PageRestrictionModule). Not registered through AuthzModule: the collab app imports that, and has no audit module.
 * The trash RETENTION is not here: it replaces upstream's `TrashCleanupService` inside PageModule (seam #183,
 * `trash-retention.provider.ts`).
 */
@Module({
  imports: [PageModule, PageAccessModule],
  providers: [RemotePurgeService, RemoteTrashService, HttpAuthzClient],
  exports: [RemotePurgeService, RemoteTrashService],
})
export class PageDeleteModule {}
