import { SPACE_ROLES, SpaceMemberRole } from './dto/space-admin.dto';
import { pdpChecksFor, ROLE_RANK } from './space-grant-ceiling';
import { ceilingPermission, roleCovers } from '../authz/page-restriction/grant-ceiling';
import { PageGrantRole } from '../authz/page-restriction/dto';

/**
 * CCC — NOT upstream Docmost code (wiki-v2 #797, INV-2 / INV-4).
 *
 * Both grant ceilings let the actor's OWN local rows allow a grant without asking the PDP (the space ceiling's
 * `localRank`, the page ceiling's `localRoleOf` + `space#view`). That is a fork-local input that can ALLOW, so it must
 * never be wider than what the schema derives from the same rows. ADR 0037 records the exception; this spec pins it:
 *
 *   SCHEMA_FACTS below is what pdp/schema.zed grants a live, un-banned member for each local row. The super repo's
 *   `make pdp-test` asserts exactly these facts (pdp/tests/authz.assertions.yaml, block "#797 ceiling parity"), so a
 *   schema change that drops one reds there, and a change to the ranks / checks here reds below. Change both together.
 */

/** Space: a live direct membership of this role (own row or a group's) holds these space permissions. */
const SPACE_SCHEMA_FACTS: Readonly<Record<SpaceMemberRole, readonly string[]>> = {
  reader: ['view'],
  writer: ['view', 'edit', 'share'],
  admin: ['view', 'edit', 'share', 'administer'],
};

/** Page: a live grant of this role on a restricted page, held with `space#view`, gives these page permissions. */
const PAGE_SCHEMA_FACTS: Readonly<Record<PageGrantRole, readonly string[]>> = {
  reader: ['view'],
  writer: ['view', 'edit'],
};

const pairs = <R extends string>(roles: readonly R[]) => roles.flatMap((held) => roles.map((need) => [held, need] as const));

describe('#797 grant ceilings: a local-row allow is never wider than the schema', () => {
  it('the space roles are exactly reader < writer < admin', () => {
    expect([...SPACE_ROLES].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b])).toEqual(['reader', 'writer', 'admin']);
    expect(Object.keys(SPACE_SCHEMA_FACTS).sort()).toEqual([...SPACE_ROLES].sort());
  });

  it.each(pairs(SPACE_ROLES))('space: a local %s row allowing %s holds every permission the PDP path would ask', (held, need) => {
    const allowsLocally = ROLE_RANK[held] >= ROLE_RANK[need];
    if (!allowsLocally) return;
    if (need === 'admin') {
      // The one documented divergence: granting admin needs a live DIRECT admin row locally (not `space#administer`,
      // which a `manage_members` binding confers), while the PDP leg asks `workspace#admin_cascade`.
      expect(held).toBe('admin');
      expect(pdpChecksFor(need, 's', 'w')).toEqual([{ permission: 'admin_cascade', resourceType: 'workspace', resourceId: 'w' }]);
      return;
    }
    for (const c of pdpChecksFor(need, 's', 'w')) {
      expect(c.resourceType).toBe('space');
      expect(SPACE_SCHEMA_FACTS[held]).toContain(c.permission);
    }
  });

  it('anti-vacuity: the local allows cover exactly the six upward-closed pairs', () => {
    expect(pairs(SPACE_ROLES).filter(([h, n]) => ROLE_RANK[h] >= ROLE_RANK[n])).toHaveLength(6);
  });

  it.each(pairs<PageGrantRole>(['reader', 'writer']))(
    'page: a local %s grant (with space#view) allowing %s holds the permission the ceiling asks',
    (held, need) => {
      if (!roleCovers(held, need)) return;
      expect(PAGE_SCHEMA_FACTS[held]).toContain(ceilingPermission(need));
    },
  );

  it('page anti-vacuity: reader covers reader only, writer covers both; nothing covers from no grant', () => {
    expect(roleCovers('reader', 'reader')).toBe(true);
    expect(roleCovers('reader', 'writer')).toBe(false);
    expect(roleCovers('writer', 'writer')).toBe(true);
    expect(roleCovers(null, 'reader')).toBe(false);
  });
});
