import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AUTHZ_MODE } from '../mode/authz-mode';
import { HttpAuthzClient } from '../http-authz.client';
import { NativeRouteAuthzModule } from './native-route-authz.module';

/**
 * #574 wiring: the breadcrumb redaction interceptor needs AUTHZ_MODE (@Global AuthzModeModule) and the PDP client,
 * which NativeRouteAuthzModule provides itself (importing AuthzModule would be a cycle — AuthzModule imports this
 * module). Compile the module against a @Global stand-in for exactly what the app provides globally, so a dependency
 * that is NOT resolvable that way fails here rather than at boot.
 */
@Global()
@Module({ providers: [{ provide: AUTHZ_MODE, useValue: 'remote' }], exports: [AUTHZ_MODE] })
class AppGlobalsStub {}

describe('NativeRouteAuthzModule DI wiring (#574)', () => {
  it('resolves its APP_INTERCEPTOR from the app globals plus its own PDP client', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppGlobalsStub, NativeRouteAuthzModule] }).compile();
    expect(moduleRef.get(HttpAuthzClient)).toBeInstanceOf(HttpAuthzClient);
    await moduleRef.close();
  });

  it('is not vacuous: without AUTHZ_MODE the module does not resolve', async () => {
    await expect(Test.createTestingModule({ imports: [NativeRouteAuthzModule] }).compile()).rejects.toThrow(/AUTHZ_MODE/);
  });
});
