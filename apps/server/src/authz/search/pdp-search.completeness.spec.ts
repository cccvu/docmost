import { PdpSearchService } from './pdp-search.service';

/**
 * CCC authorization integration test (fork compatibility suite) — the CORE filter-then-retrieve
 * COMPLETENESS property (invariant **I5**, "authorized-k-under-truncation"; architecture D9 / §8 /
 * §9 + docs/adr/0005-permission-aware-retrieval.md). GitHub Task #16.
 *
 * WHY this file exists alongside pdp-search.service.spec.ts: the sibling's "returns a FULL page …
 * even when the top-ranked candidates are all denied" test keeps its whole candidate stream (30
 * denied + 40 authorized = 70 rows) INSIDE ONE 128-row CANDIDATE_WINDOW. So it proves post-window
 * ordering, but it never forces the gate to WALK PAST a window that a naive SQL `LIMIT` would have
 * spent entirely on inaccessible rows. That is the exact scenario upstream retrieve-then-filter gets
 * wrong (it returns EMPTY), and the scenario the windowed gate must get right.
 *
 * These specs put the accessible match(es) BEYOND the first candidate window:
 *   - the SOLE authorized page is candidate #300 — every row in windows 1–2 is denied — and
 *     searchPage must STILL return that full page, not empty (the truncation guarantee, structural);
 *   - offset/limit must paginate over the AUTHORIZED set with no skip/dup even when accessible
 *     matches are SPARSE and interleaved across multiple windows.
 *
 * PASS iff the windowed gate is correct (invariant I5). No DB, no containers — the FTS query is a
 * chainable db mock windowing a fixed rank-ordered candidate stream; the authorization decision is
 * the `filterAccessiblePageIds` gate (the PDP-rebound repo) stubbed to deny a known set. Mirrors the
 * mock harness in pdp-search.service.spec.ts (CANDIDATE_WINDOW=128).
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
 * `candidatesFor(table).slice(offset, offset+limit)` — i.e. it models a rank-ordered candidate stream
 * that the gate walks in bounded windows.
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
 * so a test can model explicit windows — e.g. windows 1–2 wholly denied, the authorized rows only in
 * window 3. windowsByTable[table][callIndex] is returned for the Nth execute on that table.
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

describe('PdpSearchService — filter-then-retrieve COMPLETENESS beyond the first window (I5)', () => {
  const WS = 'ws-1';
  const USER = 'u1';

  it('returns the sole authorized page when it sits BEYOND the first candidate window (candidate #300; windows 1–2 fully denied)', async () => {
    // I5 (authorized-k-under-truncation): 299 denied pages rank ABOVE the ONLY accessible match, which
    // is candidate #300 (index 299) — past two full 128-row windows. Upstream retrieve-then-filter
    // fetches LIMIT 25 = candidates 1..25 (all denied) → post-filters to 0 → returns EMPTY. The
    // windowed gate MUST walk past windows 1 & 2 and return the accessible page. Task #16.
    const AUTH = 'a-only';
    const ids = Array.from({ length: 300 }, (_, i) =>
      i === 299 ? AUTH : `d${i}`,
    );
    const denied = new Set(ids.filter((id) => id !== AUTH));
    const { service, filterAccessiblePageIds } = build({
      pageCandidates: mkRows(ids),
      denied,
    });

    const { items } = await service.searchPage(
      { query: 'foo', limit: 25 } as any,
      { userId: USER, workspaceId: WS },
    );

    // The accessible page is returned — NOT an empty result set spent on inaccessible rows.
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(AUTH);
    // …and it is the FULL page record (title + newline-normalized highlight), not a stripped stub.
    expect(items[0].title).toBe(`title-${AUTH}`);
    expect(items[0].highlight).toBe(`hi ${AUTH}`);
    // Load-bearing: the gate had to scan all three windows (128 + 128 + 44) to reach candidate #300.
    // A single-window (naive-LIMIT) gate would have called the PDP once and returned empty.
    expect(filterAccessiblePageIds).toHaveBeenCalledTimes(3);
  });

  it('walks PAST two wholly-denied windows to fill a full authorized page from window 3 (explicit windows)', async () => {
    // Same I5 property with explicit non-slicing windows: windows 1 & 2 are full (128 rows) and every
    // row is denied; window 3 carries the accessible matches. The gate must not stop at the spent
    // windows — it must keep walking and return a FULL page (== limit) of authorized rows. Task #16.
    const w1 = mkRows(Array.from({ length: 128 }, (_, i) => `d${i}`));
    const w2 = mkRows(Array.from({ length: 128 }, (_, i) => `d${128 + i}`));
    const w3 = mkRows(['a0', 'a1', 'a2', 'a3', 'a4']); // partial window → loop breaks after it
    const denied = new Set(
      Array.from({ length: 256 }, (_, i) => `d${i}`),
    );
    const filterAccessiblePageIds = jest.fn(
      async ({ pageIds }: { pageIds: string[] }) =>
        pageIds.filter((id) => !denied.has(id)),
    );
    const service = new PdpSearchService(
      makeSeqDb({ pages: [w1, w2, w3] }) as any,
      { withSpace: () => ({}) } as any,
      {} as any,
      { getUserSpaceIdsQuery: () => ({}), getUserSpaceIds: async () => ['s1'] } as any,
      { filterAccessiblePageIds } as any,
    );

    const { items } = await service.searchPage(
      { query: 'foo', limit: 3 } as any,
      { userId: USER, workspaceId: WS },
    );

    // A FULL page of 3 authorized rows (rank order), none denied — despite two spent windows first.
    expect(items.map((i: any) => i.id)).toEqual(['a0', 'a1', 'a2']);
    expect(items.every((i: any) => !denied.has(i.id))).toBe(true);
    // Proof it walked past both denied windows before reaching the accessible one.
    expect(filterAccessiblePageIds).toHaveBeenCalledTimes(3);
  });

  it('paginates over the AUTHORIZED set with no skip/dup when accessible matches are sparse and interleaved across windows', async () => {
    // I5 pagination completeness: 50 accessible matches are sprinkled 1-in-6 through a 300-candidate
    // stream (a0 at 0, a1 at 6, …), so they straddle windows 1/2/3. offset/limit must slice the
    // AUTHORIZED set — page 3 forces a cross into window 2 — with pages contiguous, no gap, no overlap.
    // Upstream OFFSET-over-raw-candidates would skip and duplicate here. Task #16.
    const ids: string[] = [];
    let ai = 0;
    let di = 0;
    for (let i = 0; i < 300; i++) {
      ids.push(i % 6 === 0 ? `a${ai++}` : `d${di++}`);
    }
    const denied = new Set(ids.filter((id) => id.startsWith('d')));
    const { service } = build({ pageCandidates: mkRows(ids), denied });

    const pageAt = async (offset: number) =>
      (
        await service.searchPage({ query: 'foo', limit: 10, offset } as any, {
          userId: USER,
          workspaceId: WS,
        })
      ).items.map((i: any) => i.id);

    const page1 = await pageAt(0);
    const page2 = await pageAt(10);
    const page3 = await pageAt(20);

    // Each page is exactly the next 10 of the authorized stream — contiguous, no skip.
    expect(page1).toEqual(Array.from({ length: 10 }, (_, i) => `a${i}`));
    expect(page2).toEqual(Array.from({ length: 10 }, (_, i) => `a${10 + i}`));
    // page 3 (a20..a29) can only be produced by walking into window 2 — proves cross-window paging.
    expect(page3).toEqual(Array.from({ length: 10 }, (_, i) => `a${20 + i}`));
    // No duplication across page boundaries, and every returned id is authorized.
    const all = [...page1, ...page2, ...page3];
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((id) => !denied.has(id))).toBe(true);
  });
});
