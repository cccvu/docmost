import { FactoryProvider, NotFoundException } from '@nestjs/common';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction as A,
  WorkspaceCaslSubject as S,
} from '../../core/casl/interfaces/workspace-ability.type';
import { AUTHZ_MODE, AuthzMode } from './authz-mode';
import {
  RemoteWorkspaceAbilityFactory,
  workspaceAbilityFactoryProvider,
} from './workspace-ability';

/**
 * CCC authorization integration — NOT upstream Docmost code (#636).
 *
 * In remote mode `users.role` confers no workspace authority: every known role gets the stock MEMBER ability,
 * an unknown role fails closed, and the caller's user object is never changed. Native is upstream unchanged.
 * The expected rules are taken from the STOCK factory itself, so an upstream change to what a member may do
 * moves both sides together and this spec keeps pinning the demotion, not a copy of today's rule list.
 */
const WORKSPACE = { id: 'ws-1' } as Workspace;
const ROLES = ['owner', 'admin', 'member'] as const;
const userWith = (role: unknown) => ({ id: 'u-1', role }) as unknown as User;

const stock = new WorkspaceAbilityFactory();
const stockRules = (role: string) => stock.createForUser(userWith(role), WORKSPACE).rules;
const factoryFor = (mode: AuthzMode): WorkspaceAbilityFactory =>
  (workspaceAbilityFactoryProvider as FactoryProvider).useFactory(mode);

describe('workspace CASL by AUTHZ_MODE — roles × modes (#636)', () => {
  describe('native: the stock upstream rules for every role', () => {
    const f = factoryFor('native');
    it.each(ROLES)('%s → the stock rules for that role', (role) => {
      expect(f.createForUser(userWith(role), WORKSPACE).rules).toEqual(stockRules(role));
    });
    it('owner manages settings and audit; admin settings but not audit; member only reads settings', () => {
      const owner = f.createForUser(userWith('owner'), WORKSPACE);
      const admin = f.createForUser(userWith('admin'), WORKSPACE);
      const member = f.createForUser(userWith('member'), WORKSPACE);
      expect(owner.can(A.Manage, S.Settings)).toBe(true);
      expect(owner.can(A.Manage, S.Audit)).toBe(true);
      expect(admin.can(A.Manage, S.Settings)).toBe(true);
      expect(admin.can(A.Manage, S.Audit)).toBe(false);
      expect(member.can(A.Manage, S.Settings)).toBe(false);
      expect(member.can(A.Read, S.Settings)).toBe(true);
    });
  });

  describe('remote: the stock MEMBER rules for every role', () => {
    const f = factoryFor('remote');
    it.each(ROLES)('%s → exactly the member rules', (role) => {
      expect(f.createForUser(userWith(role), WORKSPACE).rules).toEqual(stockRules('member'));
    });
    it.each(ROLES)('%s cannot manage settings, members, groups, spaces, API or audit', (role) => {
      const ability = f.createForUser(userWith(role), WORKSPACE);
      for (const subject of [S.Settings, S.Member, S.Group, S.Space, S.API, S.Audit]) {
        expect(ability.can(A.Manage, subject)).toBe(false);
      }
      // Member-level authority is kept (shadow members have it today).
      expect(ability.can(A.Read, S.Settings)).toBe(true);
      expect(ability.can(A.Manage, S.Attachment)).toBe(true);
    });
  });
});

describe('remote: an unknown role fails closed (#636)', () => {
  const f = factoryFor('remote');
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an unknown role', 'guest'],
    ['a wrong-case role', 'OWNER'],
    ['a non-string', 1],
  ])('%s → NotFoundException, never member', (_label, role) => {
    expect(() => f.createForUser(userWith(role), WORKSPACE)).toThrow(NotFoundException);
  });
  it('a missing user → NotFoundException', () => {
    expect(() => f.createForUser(undefined as unknown as User, WORKSPACE)).toThrow(NotFoundException);
  });
  it('native refuses the same unknown roles (upstream parity)', () => {
    for (const role of [null, undefined, 'guest', 'OWNER']) {
      expect(() => factoryFor('native').createForUser(userWith(role), WORKSPACE)).toThrow(NotFoundException);
    }
  });
});

describe("remote: the caller's user is never mutated (#636)", () => {
  it('the owner stays an owner on the object the request carries', () => {
    const user = userWith('owner');
    factoryFor('remote').createForUser(user, WORKSPACE);
    expect(user.role).toBe('owner');
  });
  it('a frozen user is accepted (the demotion is a copy, not a write)', () => {
    const user = Object.freeze(userWith('admin'));
    expect(() => factoryFor('remote').createForUser(user, WORKSPACE)).not.toThrow();
    expect(user.role).toBe('admin');
  });
});

describe('workspaceAbilityFactoryProvider (#636)', () => {
  const p = workspaceAbilityFactoryProvider as FactoryProvider;
  it('binds the upstream token, injecting AUTHZ_MODE only', () => {
    expect(p.provide).toBe(WorkspaceAbilityFactory);
    expect(p.inject).toEqual([AUTHZ_MODE]);
  });
  it('native → the stock factory, never the remote subclass', () => {
    const inst = p.useFactory('native');
    expect(inst).toBeInstanceOf(WorkspaceAbilityFactory);
    expect(inst).not.toBeInstanceOf(RemoteWorkspaceAbilityFactory);
  });
  it('remote → RemoteWorkspaceAbilityFactory', () => {
    expect(p.useFactory('remote')).toBeInstanceOf(RemoteWorkspaceAbilityFactory);
  });
});
