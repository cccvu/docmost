import { Module } from '@nestjs/common';
import { HttpAuthzClient } from '../http-authz.client';
import { PageRestrictionController } from './page-restriction.controller';
import { PageRestrictionService } from './page-restriction.service';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The page-restriction write feature. Its deps (Kysely, PageRepo, PagePermissionRepo, SpaceAbilityFactory,
 * AUTHZ_MODE) are provided by the @Global KyselyModule, DatabaseModule, CaslModule + AuthzModeModule, so this
 * module imports nothing and can be mounted from AuthzModule without an upstream edit or an import cycle. The
 * PDP client is provided locally rather than imported from AuthzModule (which imports THIS module — a cycle):
 * HttpAuthzClient is stateless and configured from env, so a second instance is equivalent.
 */
@Module({
  controllers: [PageRestrictionController],
  providers: [PageRestrictionService, HttpAuthzClient],
})
export class PageRestrictionModule {}
