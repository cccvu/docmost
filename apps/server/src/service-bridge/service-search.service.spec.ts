import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ServiceSearchService, PublicSearchHit } from './service-search.service';
import { PdpSearchService } from '../authz/search/pdp-search.service';
import { SearchService } from '../core/search/search.service';

const workspaces = () => ({ resolveDefaultWorkspaceId: jest.fn(async () => 'ws-1') }) as any;

// A raw SearchResponseDto row as PdpSearchService returns it — it CARRIES creatorId + rank (+ slugId from the
// SELECT) that the projection must strip before the wire.
const rawHit = () => ({
  id: 'p1',
  slugId: 'slug-p1',
  title: 'Hello',
  icon: '📄',
  parentPageId: null,
  creatorId: 'docmost-user-1',
  rank: 0.87,
  highlight: 'already normalized',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  space: { id: 'sp1', name: 'Space', slug: 'space' },
});

/** A PdpSearchService (the class the SearchService token resolves to in remote mode) with a stubbed gate. */
const pdpSearch = (searchAuthorized: jest.Mock): PdpSearchService =>
  Object.assign(Object.create(PdpSearchService.prototype), { searchAuthorized });

describe('ServiceSearchService — PDP-gated search projection', () => {
  it('threads the caller userId + resolved workspaceId into searchAuthorized, never a shareId', async () => {
    const searchAuthorized = jest.fn(async (_p: any, _f: any, _o: any) => ({ items: [] as any[], hasMore: false }));
    const svc = new ServiceSearchService(pdpSearch(searchAuthorized), workspaces());
    await svc.searchContent({
      userId: 'u-9',
      query: 'foo',
      spaceId: 'sp-2',
      creatorId: 'c-3',
      limit: 10,
      offset: 5,
    } as any);
    expect(searchAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'foo', spaceId: 'sp-2', limit: 10, offset: 5 }),
      expect.objectContaining({ creatorId: 'c-3' }),
      { userId: 'u-9', workspaceId: 'ws-1', serviceSubjectId: undefined },
    );
    expect((searchAuthorized.mock.calls[0][0] as any).shareId).toBeUndefined();
  });

  it('#615: passes every filter as a CANDIDATE filter and the service principal as the second leg', async () => {
    const searchAuthorized = jest.fn(async (_p: any, _f: any, _o: any) => ({ items: [] as any[], hasMore: false }));
    const svc = new ServiceSearchService(pdpSearch(searchAuthorized), workspaces());
    await svc.searchContent({
      userId: 'u-1',
      query: 'foo',
      creatorId: 'c-1',
      lastUpdatedById: 'e-1',
      parentPageId: 'pp-1',
      labelName: 'road-map',
      updatedSince: '2026-01-01T00:00:00.000Z',
      updatedUntil: '2026-02-01T00:00:00.000Z',
      serviceSubjectId: 'sa-1',
    } as any);
    const [params, filters, opts] = searchAuthorized.mock.calls[0];
    expect(filters).toEqual({
      creatorId: 'c-1',
      lastUpdatedById: 'e-1',
      parentPageId: 'pp-1',
      labelName: 'road-map',
      updatedSince: '2026-01-01T00:00:00.000Z',
      updatedUntil: '2026-02-01T00:00:00.000Z',
    });
    // The filters travel ONLY as candidate filters (the search params carry query/space/paging alone).
    expect(Object.keys(params).sort()).toEqual(['limit', 'offset', 'query', 'spaceId']);
    expect(opts).toEqual({ userId: 'u-1', workspaceId: 'ws-1', serviceSubjectId: 'sa-1' });
  });

  it('returns {items, hasMore} with hasMore from the gate (a strict boolean)', async () => {
    const svc = new ServiceSearchService(
      pdpSearch(jest.fn(async () => ({ items: [rawHit()], hasMore: true }))),
      workspaces(),
    );
    const out = await svc.searchContent({ userId: 'u-1', query: 'hello' } as any);
    expect(Object.keys(out).sort()).toEqual(['hasMore', 'items']);
    expect(out.hasMore).toBe(true);

    const none = new ServiceSearchService(
      pdpSearch(jest.fn(async () => ({ items: [], hasMore: 'yes' as any }))),
      workspaces(),
    );
    expect((await none.searchContent({ userId: 'u-1', query: 'hello' } as any)).hasMore).toBe(false);
  });

  it('projects a PII-free hit: drops creatorId + rank + slugId, keeps space{id,name,slug}, ISO dates', async () => {
    const svc = new ServiceSearchService(
      pdpSearch(jest.fn(async () => ({ items: [rawHit()], hasMore: false }))),
      workspaces(),
    );
    const { items } = await svc.searchContent({ userId: 'u-1', query: 'hello' } as any);
    expect(items).toHaveLength(1);
    const hit = items[0];
    expect(hit).toEqual({
      id: 'p1',
      title: 'Hello',
      icon: '📄',
      parentPageId: null,
      space: { id: 'sp1', name: 'Space', slug: 'space' },
      highlight: 'already normalized',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    } satisfies PublicSearchHit);
    // The leak-prone fields are ABSENT from the wire shape (a regression here re-exposes a Docmost user id).
    expect(Object.keys(hit)).not.toContain('creatorId');
    expect(Object.keys(hit)).not.toContain('rank');
    expect(Object.keys(hit)).not.toContain('slugId');
  });

  it('maps a null space through without throwing (defensive)', async () => {
    const svc = new ServiceSearchService(
      pdpSearch(jest.fn(async () => ({ items: [{ ...rawHit(), space: null }], hasMore: false }))),
      workspaces(),
    );
    const { items } = await svc.searchContent({ userId: 'u-1', query: 'x' } as any);
    expect(items[0].space).toBeNull();
  });

  it('#615: 503s when the SearchService token is not the PDP subclass (never a search without the gate)', async () => {
    // The stock upstream SearchService (native mode), and a look-alike carrying a searchAuthorized of its own.
    const stock = Object.assign(Object.create(SearchService.prototype), { searchPage: jest.fn() });
    const lookalike = { searchPage: jest.fn(), searchAuthorized: jest.fn() };
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    for (const search of [stock, lookalike]) {
      const ws = workspaces();
      const svc = new ServiceSearchService(search as any, ws);
      await expect(svc.searchContent({ userId: 'u-1', query: 'x' } as any)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(search.searchPage).not.toHaveBeenCalled();
      expect(ws.resolveDefaultWorkspaceId).not.toHaveBeenCalled();
    }
    expect(lookalike.searchAuthorized).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledTimes(2); // an operator-visible misconfiguration, never silent
    logged.mockRestore();
  });
});
