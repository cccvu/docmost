import { ServiceUnavailableException } from '@nestjs/common';
import { PdpSearchService } from './pdp-search.service';
import { searchDb } from './search-db.testkit';

/**
 * wiki-v2 #797 — group names in `search/suggest` are part of the workspace directory, which remote mode does not show
 * to wiki users. `PdpSearchService.searchSuggestions` returns groups only to a caller with `workspace#admin_cascade`
 * or `space#administer` on at least one space (who may grant a space to a group); user suggestions (@mentions) are
 * unchanged. A PDP that cannot answer is a 503, never a silent "no groups"; the group statement never runs for a caller
 * who may not see it.
 */
const WS = 'ws-1';
const USER = 'u1';
const GROUP_ROW = { id: 'g1', name: 'Team', description: null };

const build = (decide: (permission: string, type: string, ids: string[]) => string[] | null) => {
  const sdb = searchDb({
    candidates: [],
    answer: (q) => {
      if (/from "groups"/.test(q.sql)) return [GROUP_ROW];
      if (/from "spaces"/.test(q.sql)) return [{ id: 'sp1' }, { id: 'sp2' }];
      if (/from "users"/.test(q.sql)) return [{ id: 'u2', name: 'Pat', email: 'pat@example.edu', avatarUrl: null }];
      return undefined;
    },
  });
  const pdp = {
    tryFilterResources: jest.fn(async (_s: unknown, permission: string, type: string, ids: string[]) =>
      decide(permission, type, ids),
    ),
  };
  const service = new PdpSearchService(
    sdb.db as any,
    { withSpace: (eb: any) => eb.lit(null).as('space') } as any,
    {} as any,
    { getUserSpaceIds: jest.fn(async () => []) } as any,
    {} as any,
    pdp,
  );
  return { service, pdp, sdb };
};

const suggest = (service: PdpSearchService) =>
  service.searchSuggestions({ query: 'te', includeUsers: true, includeGroups: true } as any, USER, WS);

describe('PdpSearchService group suggestions are for workspace or space admins only (#797)', () => {
  it('a workspace admin (admin_cascade) gets groups; the check names the caller as a Docmost user', async () => {
    const { service, pdp } = build((p, _t, ids) => (p === 'admin_cascade' ? ids : []));
    const res = await suggest(service);
    expect(res.groups).toEqual([GROUP_ROW]);
    expect(pdp.tryFilterResources).toHaveBeenCalledWith({ provider: 'docmost', externalId: USER }, 'admin_cascade', 'workspace', [WS]);
  });

  it('a space admin gets groups (administer on one space of the workspace)', async () => {
    const { service, pdp } = build((p, _t, ids) => (p === 'administer' ? ids.filter((id) => id === 'sp2') : []));
    expect((await suggest(service)).groups).toEqual([GROUP_ROW]);
    expect(pdp.tryFilterResources).toHaveBeenCalledWith(expect.anything(), 'administer', 'space', ['sp1', 'sp2']);
  });

  it('anyone else gets users but no groups, and the group statement never runs', async () => {
    const { service, sdb } = build(() => []);
    const res = await suggest(service);
    expect(res.groups).toEqual([]);
    expect(res.users).toHaveLength(1); // @mentions unchanged
    expect(sdb.queries.some((q) => /from "groups"/.test(q.sql))).toBe(false);
  });

  it.each([
    ['the cascade check', (p: string) => (p === 'admin_cascade' ? null : [])],
    ['the space check', (p: string) => (p === 'administer' ? null : [])],
  ])('a PDP that cannot answer %s is a 503, never "no groups"', async (_l, decide) => {
    const { service } = build(decide as any);
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    await expect(suggest(service)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('a suggest that does not ask for groups asks the PDP nothing about them', async () => {
    const { service, pdp } = build(() => []);
    await service.searchSuggestions({ query: 'te', includeUsers: true } as any, USER, WS);
    expect(pdp.tryFilterResources).not.toHaveBeenCalled();
  });
});
