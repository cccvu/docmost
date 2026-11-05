import { PdpSpaceMemberRepo } from './pdp-space-member.repo';
import SpaceAbilityFactory from '../core/casl/abilities/space-ability.factory';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SpaceCaslAction, SpaceCaslSubject } from '../core/casl/interfaces/space-ability.type';

/**
 * CCC authorization unit test — NOT upstream Docmost code.
 *
 * #542: the native space role is synthesized from the PDP's space administer/edit/view STRICTLY, so the native
 * engine (CASL and the collab connect) never grants more than the PDP does. No view → no role; view without edit →
 * reader; admin needs all three. Every one of the eight combinations is pinned, plus the fail-closed PDP error
 * (#696: a 503, never a role and never the deny-shaped "no role").
 */
const USER = 'u1';
const SPACE = 's1';

function repoAnswering(answer: (checks: Array<{ permission: string }>) => boolean[] | null) {
  const authz = { tryCheckBulk: jest.fn(async (_s: unknown, checks: Array<{ permission: string }>) => answer(checks)) };
  const repo = new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, authz as any);
  return { repo, authz };
}

const grantsRepo = (g: { administer: boolean; edit: boolean; view: boolean }) =>
  repoAnswering((checks) => checks.map((c) => g[c.permission as keyof typeof g] === true));

describe('PdpSpaceMemberRepo.getUserSpaceRoles — the native role is the PDP bits, strictly (#542)', () => {
  const combos: Array<[boolean, boolean, boolean, 'admin' | 'writer' | 'reader' | undefined]> = [
    // administer, edit, view → role
    [false, false, false, undefined],
    [true, false, false, undefined], // manage_members only: no view, no role (was admin)
    [false, true, false, undefined], // edit only: no view, no role (was writer)
    [true, true, false, undefined], // no view, no role (was admin)
    [false, false, true, 'reader'],
    [true, false, true, 'reader'], // administer + view without edit: reader (was admin) — ADR 0025 amendment
    [false, true, true, 'writer'],
    [true, true, true, 'admin'],
  ];

  it.each(combos)('administer=%s edit=%s view=%s → %s', async (administer, edit, view, expected) => {
    const { repo, authz } = grantsRepo({ administer, edit, view });
    const roles = await repo.getUserSpaceRoles(USER, SPACE);
    if (expected === undefined) {
      // The upstream contract: undefined (not []) when the user has no role in the space.
      expect(roles).toBeUndefined();
    } else {
      expect(roles).toEqual([{ userId: USER, role: expected }]);
    }
    expect(authz.tryCheckBulk).toHaveBeenCalledTimes(1);
    expect(authz.tryCheckBulk).toHaveBeenCalledWith({ provider: 'docmost', externalId: USER }, [
      { permission: 'administer', resourceType: 'space', resourceId: SPACE },
      { permission: 'edit', resourceType: 'space', resourceId: SPACE },
      { permission: 'view', resourceType: 'space', resourceId: SPACE },
    ]);
  });

  it('#696: a PDP that could not answer (tryCheckBulk → null) is a 503 — never a role, never "no role"', async () => {
    // HttpAuthzClient.tryCheckBulk reports a transport error, timeout, non-2xx or malformed answer as null.
    const { repo } = repoAnswering(() => null);
    const err = await repo.getUserSpaceRoles(USER, SPACE).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getStatus()).toBe(503);
    expect(err.message).toBe('authorization is temporarily unavailable; retry shortly');
  });

  it('a thrown PDP error propagates (never read as a role)', async () => {
    const authz = { tryCheckBulk: jest.fn(async () => Promise.reject(new Error('pdp down'))) };
    const repo = new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, authz as any);
    await expect(repo.getUserSpaceRoles(USER, SPACE)).rejects.toThrow('pdp down');
  });

  describe('through the REAL SpaceAbilityFactory (what every native CASL path sees)', () => {
    it('a view-less space admin gets no ability at all: 404, so no page read/write, no permanent delete', async () => {
      const { repo } = grantsRepo({ administer: true, edit: false, view: false });
      await expect(new SpaceAbilityFactory(repo).createForUser({ id: USER } as any, SPACE)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('administer + view without edit reads pages but cannot manage them or the settings', async () => {
      const { repo } = grantsRepo({ administer: true, edit: false, view: true });
      const ability = await new SpaceAbilityFactory(repo).createForUser({ id: USER } as any, SPACE);
      expect(ability.can(SpaceCaslAction.Read, SpaceCaslSubject.Page)).toBe(true);
      expect(ability.can(SpaceCaslAction.Manage, SpaceCaslSubject.Page)).toBe(false);
      expect(ability.can(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)).toBe(false);
    });

    it('#696: a PDP that could not answer is a 503 there too — not the 404 "Space permissions not found"', async () => {
      const { repo } = repoAnswering(() => null);
      await expect(new SpaceAbilityFactory(repo).createForUser({ id: USER } as any, SPACE)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('control: administer + edit + view is a full space admin (the test is not vacuous)', async () => {
      const { repo } = grantsRepo({ administer: true, edit: true, view: true });
      const ability = await new SpaceAbilityFactory(repo).createForUser({ id: USER } as any, SPACE);
      expect(ability.can(SpaceCaslAction.Manage, SpaceCaslSubject.Page)).toBe(true);
      expect(ability.can(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)).toBe(true);
    });
  });
});
