import { ServiceSearchService, PublicSearchHit } from './service-search.service';

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

describe('ServiceSearchService — PDP-gated search projection', () => {
  it('threads the caller userId + resolved workspaceId into searchPage, never a shareId', async () => {
    const searchPage = jest.fn(async (_params: any, _opts: any) => ({ items: [] as any[] }));
    const svc = new ServiceSearchService({ searchPage } as any, workspaces());
    await svc.searchContent({
      userId: 'u-9',
      query: 'foo',
      spaceId: 'sp-2',
      creatorId: 'c-3',
      limit: 10,
      offset: 5,
    } as any);
    expect(searchPage).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'foo', spaceId: 'sp-2', creatorId: 'c-3', limit: 10, offset: 5 }),
      { userId: 'u-9', workspaceId: 'ws-1' },
    );
    expect((searchPage.mock.calls[0][0] as any).shareId).toBeUndefined();
  });

  it('projects a PII-free hit: drops creatorId + rank + slugId, keeps space{id,name,slug}, ISO dates', async () => {
    const searchPage = jest.fn(async () => ({ items: [rawHit()] }));
    const svc = new ServiceSearchService({ searchPage } as any, workspaces());
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
    const searchPage = jest.fn(async () => ({ items: [{ ...rawHit(), space: null }] }));
    const svc = new ServiceSearchService({ searchPage } as any, workspaces());
    const { items } = await svc.searchContent({ userId: 'u-1', query: 'x' } as any);
    expect(items[0].space).toBeNull();
  });
});
