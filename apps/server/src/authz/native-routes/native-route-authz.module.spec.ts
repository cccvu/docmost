import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AUTHZ_MODE } from '../mode/authz-mode';
import { HttpAuthzClient } from '../http-authz.client';
import { PlatformAuditClient } from '../audit/platform-audit.client';
import { NativeRouteAuthzModule } from './native-route-authz.module';

/**
 * #542/#574 wiring: the two interceptors need AUTHZ_MODE (@Global AuthzModeModule), PlatformAuditClient (@Global
 * PlatformAuditModule) and the PDP client, which NativeRouteAuthzModule provides itself (importing AuthzModule would be
 * a cycle — AuthzModule imports this module). Compile the module against @Global stand-ins for exactly what the app
 * provides globally, so a dependency that is NOT resolvable that way fails here rather than at boot.
 */
@Global()
@Module({
  providers: [
    { provide: AUTHZ_MODE, useValue: 'remote' },
    { provide: PlatformAuditClient, useValue: { forward: async () => undefined } },
  ],
  exports: [AUTHZ_MODE, PlatformAuditClient],
})
class AppGlobalsStub {}

describe('NativeRouteAuthzModule DI wiring (#542, #574)', () => {
  it('resolves both APP_INTERCEPTORs from the app globals plus its own PDP client', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppGlobalsStub, NativeRouteAuthzModule] }).compile();
    expect(moduleRef.get(HttpAuthzClient)).toBeInstanceOf(HttpAuthzClient);
    await moduleRef.close();
  });

  it('is not vacuous: without the audit client the module does not resolve', async () => {
    @Global()
    @Module({ providers: [{ provide: AUTHZ_MODE, useValue: 'remote' }], exports: [AUTHZ_MODE] })
    class ModeOnly {}
    await expect(Test.createTestingModule({ imports: [ModeOnly, NativeRouteAuthzModule] }).compile()).rejects.toThrow(
      /PlatformAuditClient/,
    );
  });
});
