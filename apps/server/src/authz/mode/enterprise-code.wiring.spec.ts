import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

// The boot guard is mocked so each case decides "EE present" without touching the filesystem.
jest.mock('./enterprise-code', () => ({
  __esModule: true,
  assertNoEnterpriseCode: jest.fn(),
}));

import { assertNoEnterpriseCode } from './enterprise-code';
import { AUTHZ_MODE, AuthzMode } from './authz-mode';
import { AuthzModeModule } from './authz-mode.module';

/**
 * CCC authorization integration test — NOT upstream Docmost code (wiki-v2 #133, ADR 0035).
 *
 * Proves the EE boot refusal is wired into the AUTHZ_MODE factory through real Nest DI, and that it applies
 * in EVERY mode: both `native` and `remote` are asserted, so a later "only in remote" scoping reds here.
 */
async function compile(mode: AuthzMode) {
  @Global()
  @Module({
    providers: [
      {
        provide: ConfigService,
        useValue: {
          get: (k: string) => (k === 'AUTHZ_MODE' ? mode : undefined),
        },
      },
    ],
    exports: [ConfigService],
  })
  class StubGlobal {}

  return Test.createTestingModule({
    imports: [StubGlobal, AuthzModeModule],
  }).compile();
}

const guard = assertNoEnterpriseCode as jest.MockedFunction<
  typeof assertNoEnterpriseCode
>;

describe('AuthzModeModule refuses to boot when EE code is present (#133)', () => {
  afterEach(() => guard.mockReset());

  it.each<AuthzMode>(['native', 'remote'])(
    '%s: EE present → the module fails to compile',
    async (mode) => {
      guard.mockImplementation(() => {
        throw new Error('EE present (test)');
      });
      await expect(compile(mode)).rejects.toThrow('EE present (test)');
      expect(guard).toHaveBeenCalled();
    },
  );

  it.each<AuthzMode>(['native', 'remote'])(
    '%s: EE absent → the module compiles and resolves the mode',
    async (mode) => {
      const ref = await compile(mode);
      expect(ref.get(AUTHZ_MODE)).toBe(mode);
      expect(guard).toHaveBeenCalledTimes(1);
      await ref.close();
    },
  );
});
