import { Module } from '@nestjs/common';
import { PageRestrictionController } from './page-restriction.controller';
import { PageRestrictionService } from './page-restriction.service';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The page-restriction write feature. Its deps (PageRepo, PagePermissionRepo, SpaceAbilityFactory)
 * are provided by the @Global DatabaseModule + CaslModule, so this module imports nothing and can be
 * mounted from AuthzModule without an upstream edit or an import cycle.
 */
@Module({
  controllers: [PageRestrictionController],
  providers: [PageRestrictionService],
})
export class PageRestrictionModule {}
