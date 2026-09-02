import { BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { PdpSearchService } from './pdp-search.service';
import {
  MAX_SEARCH_QUERY_LENGTH,
  SearchDTO,
  SearchShareDTO,
  SearchSuggestionDTO,
} from '../../core/search/dto/search.dto';

/**
 * CCC authorization integration test (fork compatibility suite) — permission-aware search is
 * **filter-then-retrieve** (architecture D9 / §8 search row / §9 "authorized-k-under-truncation, no
 * count/score side-channel"). These prove the subclass:
 *   - returns a FULL page of authorized results even when higher-ranked candidates are all denied
 *     (the truncation fix — upstream retrieve-then-filter would under-return here);
 *   - never surfaces a denied/restricted page (the §8 absence guarantee, now structural);
 *   - fails CLOSED when the PDP gate denies everything (platform down → empty);
 *   - paginates stably over the AUTHORIZED set (no skip/dup across pages);
 *   - never silently truncates — a hit on the candidate scan ceiling is logged.
 *
 * The FTS query itself is stubbed (a chainable db mock that windows a fixed candidate stream); the
 * authorization decision is the `filterAccessiblePageIds` gate (the PDP-rebound repo), stubbed to deny
 * a known set. No DB, no containers — pure unit specs, mirroring authz/leakage/primitives.spec.ts.
 */

type Row = { id: string; rank: number; title: string; highlight: string };

const mkRows = (ids: string[]): Row[] =>
  ids.map((id, i) => ({
    id,
    rank: 1 - i / 1000,
    title: `title-${id}`,
    highlight: `hi\n${id}`,
  }));

/**
 * A chainable Kysely-like mock. Every builder method returns the same proxy; `selectFrom` resets the
 * active table + window, `limit`/`offset` capture the window, and `execute` returns
 * `candidatesFor(table).slice(offset, offset+limit)` — i.e. it models a rank-ordered candidate stream.
 */
function makeDb(candidatesFor: (table: string) => Row[]) {
  let table = '';
  let _limit = Number.MAX_SAFE_INTEGER;
  let _offset = 0;
  const proxy: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'selectFrom')
          return (t: string) => {
            table = t;
            _limit = Number.MAX_SAFE_INTEGER;
            _offset = 0;
            return proxy;
          };
        if (prop === 'limit')
          return (n: number) => {
            _limit = n;
            return proxy;
          };
        if (prop === 'offset')
          return (n: number) => {
            _offset = n;
            return proxy;
          };
        if (prop === 'execute')
          return async () =>
            candidatesFor(table).slice(_offset, _offset + _limit);
        // select / where / $if / orderBy / ... → keep chaining (callback args are never invoked).
        return (..._args: any[]) => proxy;
      },
    },
  );
  return proxy;
}

/**
 * A chainable mock that returns PRE-DEFINED successive windows per `execute()` (ignoring limit/offset),
 * so a test can model non-snapshot windows — e.g. a row shifting into a later window under a concurrent
 * insert. windowsByTable[table][callIndex] is returned for the Nth execute on that table.
 */
function makeSeqDb(windowsByTable: Record<string, Row[][]>) {
  let table = '';
  const counters: Record<string, number> = {};
  const proxy: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'selectFrom')
          return (t: string) => {
            table = t;
            return proxy;
          };
        if (prop === 'execute')
          return async () => {
            const list = windowsByTable[table] || [];
            const i = counters[table] ?? 0;
            counters[table] = i + 1;
            return list[i] ?? [];
          };
        return (..._args: any[]) => proxy;
      },
    },
  );
  return proxy;
}

const build = (opts: {
  pageCandidates: Row[];
  denied: Set<string>;
  userSpaceIds?: string[];
}) => {
  const filterAccessiblePageIds = jest.fn(
    async ({ pageIds }: { pageIds: string[] }) =>
      pageIds.filter((id) => !opts.denied.has(id)),
  );
  const db = makeDb((table) => (table === 'pages' ? opts.pageCandidates : []));
  const pageRepo = { withSpace: () => ({}) };
  const shareRepo = {};
  const spaceMemberRepo = {
    getUserSpaceIdsQuery: () => ({}),
    getUserSpaceIds: jest.fn(async () => opts.userSpaceIds ?? ['space-1']),
  };
  const pagePermissionRepo = { filterAccessiblePageIds };
  const service = new PdpSearchService(
    db as any,
    pageRepo as any,
    shareRepo as any,
    spaceMemberRepo as any,
    pagePermissionRepo as any,
  );
  return { service, filterAccessiblePageIds, spaceMemberRepo };
};

describe('PdpSearchService — filter-then-retrieve (searchPage)', () => {
  const WS = 'ws-1';
  const USER = 'u1';

  it('returns a FULL page of authorized results even when the top-ranked candidates are all denied (authorized-k-under-truncation)', async () => {
    // 30 denied pages rank ABOVE 40 authorized ones. Upstream (limit-before-filter) would return 0 for
    // limit=25; we must return 25 authorized rows.
    const denied = new Set(Array.from({ length: 30 }, (_, i) => `d${i}`));
    const pageCandidates = mkRows([
      ...Array.from({ length: 30 }, (_, i) => `d${i}`),
      ...Array.from({ length: 40 }, (_, i) => `a${i}`),
    ]);
    const { service } = build({ pageCandidates, denied });

    const { items } = await service.searchPage(
      { query: 'foo', limit: 25 } as any,
      { userId: USER, workspaceId: WS },
    );

    expect(items).toHaveLength(25);
    expect(items.map((i: any) => i.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => `a${i}`),
    );
    expect(items.every((i: any) => !denied.has(i.id))).toBe(true);
  });

  it('never surfaces a denied/restricted page in results (§8 absence)', async () => {
    const CONF = 'conf-page';
    const denied = new Set([CONF]);
    const pageCandidates = mkRows(['a', CONF, 'b', 'c']);
    const { service } = build({ pageCandidates, denied });

    const { items } = await service.searchPage(
      { query: 'foo', limit: 25 } as any,
      { userId: USER, workspaceId: WS },
    );

    expect(items.map((i: any) => i.id)).toEqual(['a', 'b', 'c']);
    expect(items.map((i: any) => i.id)).not.toContain(CONF);
  });

  it('fails CLOSED — the PDP gate denying everything (platform down) yields empty results, not the raw candidates', async () => {
    const pageCandidates = mkRows(['a', 'b', 'c']);
    const { service, filterAccessiblePageIds } = build({
      pageCandidates,
      denied: new Set(),
    });
    // Simulate the fail-closed client: filterAccessiblePageIds returns [] on outage.
    filterAccessiblePageIds.mockResolvedValue([]);

    const { items } = await service.searchPage(
      { query: 'foo', limit: 25 } as any,
      { userId: USER, workspaceId: WS },
    );

    expect(items).toEqual([]);
  });

  it('paginates stably over the AUTHORIZED set (offset applies to authorized results — no skip/dup)', async () => {
    const denied = new Set(Array.from({ length: 30 }, (_, i) => `d${i}`));
    const pageCandidates = mkRows([
      ...Array.from({ length: 30 }, (_, i) => `d${i}`),
      ...Array.from({ length: 40 }, (_, i) => `a${i}`),
    ]);
    const { service } = build({ pageCandidates, denied });

    const page1 = (
      await service.searchPage({ query: 'foo', limit: 25, offset: 0 } as any, {
        userId: USER,
        workspaceId: WS,
      })
    ).items.map((i: any) => i.id);
    const page2 = (
      await service.searchPage({ query: 'foo', limit: 25, offset: 25 } as any, {
        userId: USER,
        workspaceId: WS,
      })
    ).items.map((i: any) => i.id);

    expect(page1).toEqual(Array.from({ length: 25 }, (_, i) => `a${i}`));
    // 40 authorized total → page 2 is a25..a39 (15 rows), contiguous with page 1, no overlap.
    expect(page2).toEqual(Array.from({ length: 15 }, (_, i) => `a${25 + i}`));
    expect(page1.filter((id) => page2.includes(id))).toEqual([]);
  });

  it('never silently truncates — hitting the candidate scan ceiling logs a warning', async () => {
    // 1200 candidates, ALL denied → the loop scans up to MAX_CANDIDATES (1024) then stops empty + warns.
    const ids = Array.from({ length: 1200 }, (_, i) => `d${i}`);
    const denied = new Set(ids);
    const { service } = build({ pageCandidates: mkRows(ids), denied });
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();

    const { items } = await service.searchPage(
      { query: 'foo', limit: 25 } as any,
      { userId: USER, workspaceId: WS },
    );

    expect(items).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/scan budget/i);
  });

  it('clamps a huge caller limit to MAX_LIMIT (a large limit cannot force an unbounded scan)', async () => {
    // 150 authorized candidates; a limit of 1000 must return at most 100 (MAX_LIMIT).
    const pageCandidates = mkRows(
      Array.from({ length: 150 }, (_, i) => `a${i}`),
    );
    const { service } = build({ pageCandidates, denied: new Set() });

    const { items } = await service.searchPage(
      { query: 'foo', limit: 1000 } as any,
      { userId: USER, workspaceId: WS },
    );

    expect(items).toHaveLength(100);
  });

  it('clamps a negative offset to 0 (no slice-from-end over the authorized set)', async () => {
    const pageCandidates = mkRows(['a', 'b', 'c', 'd', 'e']);
    const { service } = build({ pageCandidates, denied: new Set() });

    const { items } = await service.searchPage(
      { query: 'foo', limit: 3, offset: -10 } as any,
      { userId: USER, workspaceId: WS },
    );

    // offset clamped to 0 -> the first page, NOT the tail that Array.slice(-10) would return.
    expect(items.map((i: any) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates rows that appear in more than one window (concurrent-write shift)', async () => {
    // Window 1 is a FULL window (128 rows) so the loop continues; window 2 re-includes a27 (as if an
    // insert shifted the stream by one between fetches). The result must contain a27 exactly once.
    const w1 = mkRows([
      ...Array.from({ length: 100 }, (_, i) => `d${i}`),
      ...Array.from({ length: 28 }, (_, i) => `a${i}`),
    ]);
    const w2 = mkRows(['a27', 'a28', 'a29']); // a27 overlaps w1
    const denied = new Set(Array.from({ length: 100 }, (_, i) => `d${i}`));
    const filterAccessiblePageIds = jest.fn(
      async ({ pageIds }: { pageIds: string[] }) =>
        pageIds.filter((id) => !denied.has(id)),
    );
    const service = new PdpSearchService(
      makeSeqDb({ pages: [w1, w2] }) as any,
      { withSpace: () => ({}) } as any,
      {} as any,
      { getUserSpaceIdsQuery: () => ({}), getUserSpaceIds: async () => ['s1'] } as any,
      { filterAccessiblePageIds } as any,
    );

    const { items } = await service.searchPage(
      { query: 'foo', limit: 50 } as any,
      { userId: USER, workspaceId: WS },
    );

    const ids = items.map((i: any) => i.id);
    expect(ids.filter((id) => id === 'a27')).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toEqual(Array.from({ length: 30 }, (_, i) => `a${i}`));
  });

  it('short-circuits an empty query without touching the PDP', async () => {
    const { service, filterAccessiblePageIds } = build({
      pageCandidates: mkRows(['a']),
      denied: new Set(),
    });
    const { items } = await service.searchPage({ query: '' } as any, {
      userId: USER,
      workspaceId: WS,
    });
    expect(items).toEqual([]);
    expect(filterAccessiblePageIds).not.toHaveBeenCalled();
  });

  it('the anonymous / public-share path (no userId) does not run the per-principal PDP loop', async () => {
    // No userId, no shareId, no spaceId → the inherited upstream path returns empty and the loop
    // (filterAccessiblePageIds) is never invoked.
    const { service, filterAccessiblePageIds } = build({
      pageCandidates: mkRows(['a', 'b']),
      denied: new Set(),
    });

    const { items } = await service.searchPage({ query: 'foo' } as any, {
      workspaceId: WS,
    });

    expect(items).toEqual([]);
    expect(filterAccessiblePageIds).not.toHaveBeenCalled();
  });
});

describe('PdpSearchService — filter-then-retrieve (searchSuggestions)', () => {
  const WS = 'ws-1';
  const USER = 'u1';

  it('page suggestions exclude denied pages and stay complete up to the limit', async () => {
    const denied = new Set(['d0', 'd1', 'd2']);
    const pageCandidates = mkRows(['d0', 'd1', 'd2', 'p0', 'p1', 'p2', 'p3']);
    const { service } = build({ pageCandidates, denied });

    const { pages } = await service.searchSuggestions(
      { query: 'p', includePages: true, limit: 3 } as any,
      USER,
      WS,
    );

    expect(pages.map((p: any) => p.id)).toEqual(['p0', 'p1', 'p2']);
    expect(pages.map((p: any) => p.id)).not.toContain('d0');
  });

  it('returns no page suggestions when the user has no accessible spaces', async () => {
    const { service, filterAccessiblePageIds } = build({
      pageCandidates: mkRows(['p0']),
      denied: new Set(),
      userSpaceIds: [],
    });

    const { pages } = await service.searchSuggestions(
      { query: 'p', includePages: true } as any,
      USER,
      WS,
    );

    expect(pages).toEqual([]);
    expect(filterAccessiblePageIds).not.toHaveBeenCalled();
  });
});

/**
 * Sweep F6: pg-tsquery 8.4.2 backtracks O(N²) on a crafted query, so an unbounded search string blocks the
 * event loop for seconds before any DB call. The clamp sits at the TOP of searchPage — ahead of the
 * `if (!opts.userId) super.searchPage(...)` delegation — so it covers BOTH the authenticated path and the
 * unauthenticated @Public /search/share-search path (which reaches the upstream tsquery via super).
 */
describe('PdpSearchService — search-query length guard (sweep F6)', () => {
  const WS = 'ws-1';
  const USER = 'u1';
  const overLong = 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1);

  it('rejects an over-length query on the AUTHENTICATED path before touching the PDP or tsquery', async () => {
    const { service, filterAccessiblePageIds } = build({ pageCandidates: mkRows(['a']), denied: new Set() });
    await expect(
      service.searchPage({ query: overLong, limit: 25 } as any, { userId: USER, workspaceId: WS }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(filterAccessiblePageIds).not.toHaveBeenCalled(); // rejected before any retrieval work
  });

  it('rejects an over-length query on the UNAUTHENTICATED public-share path (guard precedes super.searchPage)', async () => {
    // No userId → without the guard this would delegate to the upstream tsquery via super.searchPage. The
    // clamp is ahead of that delegation, so the anonymous path is protected by this one fork choke point.
    const { service } = build({ pageCandidates: mkRows(['a']), denied: new Set() });
    await expect(
      service.searchPage({ query: overLong, shareId: 's1' } as any, { workspaceId: WS }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a query exactly at the limit and returns results (bound is inclusive, not off-by-one)', async () => {
    const { service } = build({ pageCandidates: mkRows(['a']), denied: new Set() });
    const { items } = await service.searchPage(
      { query: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH), limit: 25 } as any,
      { userId: USER, workspaceId: WS },
    );
    expect(items.map((i: any) => i.id)).toEqual(['a']);
  });

  it('adversarial: a max-length run of tsquery backtracking chars parses FAST (no event-loop block)', async () => {
    // The pre-fix attack was ~50KB of `&` then `>`. Bounded to MAX_SEARCH_QUERY_LENGTH, the same shape is
    // parsed in well under the ReDoS timescale — this completes rather than hanging.
    const { service } = build({ pageCandidates: mkRows(['a']), denied: new Set() });
    const start = Date.now();
    await service.searchPage(
      { query: '&'.repeat(MAX_SEARCH_QUERY_LENGTH - 1) + '>', limit: 25 } as any,
      { userId: USER, workspaceId: WS },
    );
    expect(Date.now() - start).toBeLessThan(1000); // negligible vs the seconds-long unbounded ReDoS
  });
});

/**
 * Edge validation twin (sweep F6): the global ValidationPipe enforces @MaxLength on the DTO, so an
 * over-length query is a 400 for EVERY search route before the service runs. Asserted directly against
 * class-validator, mirroring public-discovery.service.spec.ts.
 */
describe('search DTO @MaxLength (sweep F6)', () => {
  const hasMaxLength = (errors: Awaited<ReturnType<typeof validate>>) =>
    errors.some((e) => e.property === 'query' && e.constraints && 'maxLength' in e.constraints);

  it('SearchDTO rejects an over-length query and accepts one at the bound', async () => {
    const over = Object.assign(new SearchDTO(), { query: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) });
    const ok = Object.assign(new SearchDTO(), { query: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH) });
    expect(hasMaxLength(await validate(over))).toBe(true);
    expect(hasMaxLength(await validate(ok))).toBe(false);
  });

  it('SearchShareDTO inherits the query bound (the @Public share route DTO)', async () => {
    const over = Object.assign(new SearchShareDTO(), {
      query: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1),
      shareId: 's1',
    });
    expect(hasMaxLength(await validate(over))).toBe(true);
  });

  it('SearchSuggestionDTO rejects an over-length query', async () => {
    const over = Object.assign(new SearchSuggestionDTO(), { query: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) });
    expect(hasMaxLength(await validate(over))).toBe(true);
  });
});
