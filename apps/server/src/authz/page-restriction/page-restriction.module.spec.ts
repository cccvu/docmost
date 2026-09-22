import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AUTHZ_MODE } from '../mode/authz-mode';
import { HttpAuthzClient } from '../http-authz.client';
import { PageRestrictionModule } from './page-restriction.module';
import { PageRestrictionService } from './page-restriction.service';

/**
 * #486 wiring: PageRestrictionService now also needs Kysely, AUTHZ_MODE and the PDP client. In the app the
 * first three come from @Global modules and the client is provided by PageRestrictionModule itself (importing
 * AuthzModule would be a cycle — AuthzModule imports this module). Compile the module against @Global stand-ins
 * for exactly what the app provides globally, so a dependency that is NOT resolvable that way fails here rather
 * than at boot.
 */
@Global()
@Module({
  providers: [
    { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: {} },
    { provide: PageRepo, useValue: {} },
    { provide: PagePermissionRepo, useValue: {} },
    { provide: SpaceAbilityFactory, useValue: {} },
    { provide: AUTHZ_MODE, useValue: 'remote' },
  ],
  exports: [KYSELY_MODULE_CONNECTION_TOKEN(), PageRepo, PagePermissionRepo, SpaceAbilityFactory, AUTHZ_MODE],
})
class AppGlobalsStub {}

describe('PageRestrictionModule DI wiring (#486)', () => {
  it('resolves PageRestrictionService from the app globals plus its own PDP client', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppGlobalsStub, PageRestrictionModule] })
      .overrideGuard(JwtAuthGuard) // its own deps (EnvironmentService) are not under test here
      .useValue({ canActivate: () => true })
      .compile();
    expect(moduleRef.get(PageRestrictionService)).toBeInstanceOf(PageRestrictionService);
    expect(moduleRef.get(HttpAuthzClient)).toBeInstanceOf(HttpAuthzClient);
    await moduleRef.close();
  });
});
