import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

// A factory mock keeps SpaceAbilityFactory's dependency off kysely/the database; it is only resolved, never called.
jest.mock('@docmost/db/repos/space/space-member.repo', () => ({
  __esModule: true,
  SpaceMemberRepo: class SpaceMemberRepo {},
}));

import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { CaslModule } from '../../core/casl/casl.module';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { AuthzMode } from './authz-mode';
import { AuthzModeModule } from './authz-mode.module';
import { RemoteWorkspaceAbilityFactory } from './workspace-ability';

/**
 * CCC authorization integration — NOT upstream Docmost code (#636).
 *
 * Proves the seam end to end through Nest DI: the REAL upstream `CaslModule` (with its #177 provider line) and
 * the REAL `AuthzModeModule` resolving AUTHZ_MODE from config, as both the API process (CoreModule) and the
 * collab process (CollabAppModule → DatabaseModule → AuthzModule → AuthzModeModule) wire them. The probe module
 * does NOT import CaslModule, so the factory it receives comes over the @Global path the upstream controllers use.
 */
@Injectable()
class Probe {
  constructor(readonly factory: WorkspaceAbilityFactory) {}
}

@Module({ providers: [Probe], exports: [Probe] })
class ProbeModule {}

async function boot(mode: AuthzMode) {
  @Global()
  @Module({
    providers: [
      { provide: ConfigService, useValue: { get: (k: string) => (k === 'AUTHZ_MODE' ? mode : undefined) } },
      { provide: SpaceMemberRepo, useValue: {} },
    ],
    exports: [ConfigService, SpaceMemberRepo],
  })
  class StubGlobal {}

  return Test.createTestingModule({
    imports: [StubGlobal, AuthzModeModule, CaslModule, ProbeModule],
  }).compile();
}

const OWNER = { id: 'u-1', role: 'owner' } as any;
const WORKSPACE = { id: 'ws-1' } as any;

describe('CaslModule resolves WorkspaceAbilityFactory by AUTHZ_MODE (#636, seam #177)', () => {
  it('remote: the globally injected factory is the remote subclass, and an owner cannot manage settings', async () => {
    const ref = await boot('remote');
    const { factory } = ref.get(Probe);
    expect(factory).toBeInstanceOf(RemoteWorkspaceAbilityFactory);
    expect(
      factory.createForUser(OWNER, WORKSPACE).can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings),
    ).toBe(false);
    // The token is the one the module exports, and the space factory still resolves beside it.
    expect(ref.get(WorkspaceAbilityFactory)).toBe(factory);
    expect(ref.get(SpaceAbilityFactory)).toBeInstanceOf(SpaceAbilityFactory);
    await ref.close();
  });

  it('native: the globally injected factory is the stock class, and an owner manages settings', async () => {
    const ref = await boot('native');
    const { factory } = ref.get(Probe);
    expect(factory).toBeInstanceOf(WorkspaceAbilityFactory);
    expect(factory).not.toBeInstanceOf(RemoteWorkspaceAbilityFactory);
    expect(
      factory.createForUser(OWNER, WORKSPACE).can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings),
    ).toBe(true);
    await ref.close();
  });
});
