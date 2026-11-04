import { Module } from '@nestjs/common';
import { PageModule } from '../../core/page/page.module';
import { HttpAuthzClient } from '../http-authz.client';
import { RemotePurgeService } from './remote-purge.service';

/**
 * CCC authorization integration — NOT upstream Docmost code (#636 W6).
 *
 * Provides the remote-mode permanent delete (`RemotePurgeService`) to its two entry points: `RemotePurgeInterceptor`
 * (registered as an APP_INTERCEPTOR in app.module.ts, seam #4, which imports this module) and
 * `ConditionalPageOpsController` (ConditionalPageModule imports it). PageModule gives `PageService`; PageRepo
 * (DatabaseModule), SpaceAbilityFactory (CaslModule), AUTHZ_MODE, AUDIT_SERVICE and the attachment queue are global.
 * HttpAuthzClient is stateless and configured from env, so a module-local instance is equivalent (as in
 * PageRestrictionModule). Not registered through AuthzModule: the collab app imports that, and has no audit module.
 */
@Module({
  imports: [PageModule],
  providers: [RemotePurgeService, HttpAuthzClient],
  exports: [RemotePurgeService],
})
export class PageDeleteModule {}
