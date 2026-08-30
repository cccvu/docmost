import { Module } from '@nestjs/common';
import { PublicDiscoveryController } from './public-discovery.controller';
import { PublicDiscoveryService } from './public-discovery.service';
import { PublicDiscoveryRepo } from './public-discovery.repo';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The anonymous public-content discovery feature. Its only dep is the @Global Kysely connection, so
 * this module imports nothing and can be mounted from AuthzModule without an upstream edit or an
 * import cycle (mirrors PageRestrictionModule).
 */
@Module({
  controllers: [PublicDiscoveryController],
  providers: [PublicDiscoveryService, PublicDiscoveryRepo],
})
export class PublicDiscoveryModule {}
