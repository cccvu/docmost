import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PdpSearchService, SearchCandidateFilters, SearchLimits } from './pdp-search.service';
import { pdpStub, searchDb, SearchRow, serviceLegCalls, userLegCalls } from './search-db.testkit';

/**
 * CCC authorization integration test (fork compatibility suite) — `PdpSearchService.searchAuthorized` (#615): the
 * service-bridge search behind `POST /v1/search`.
 *
 *   - FILTERS ARE CANDIDATE SQL: every #615 filter is a predicate of the one candidate statement (#696), so a
 *     filtered page fills from the filtered stream. The DB here is a real Kysely (Postgres compiler + the production
 *     CamelCasePlugin) over a recording driver, so the assertions read the SQL that would reach Postgres.
 *   - `hasMore` is a one-row PEEK past the page (never a count), measured against the CLAMPED limit.
 *   - The on-behalf-of SERVICE leg gates every window: a hit the service account cannot see never takes a slot (the
 *     next authorized hit fills it), and `hasMore` is service ∩ user too. A deny on either leg drops the hit; a leg
 *     that cannot answer aborts the search with a 503 (#696).
 *   - The native `searchPage` keeps its `{ items }` shape.
 *
 * The real-SQL twin (the predicates against real Postgres rows) is pdp-search.pg.spec.ts.
 */

type Row = SearchRow;
const mkRows = (ids: string[]): Row[] => ids.map((id) => ({ id, title: `t-${id}`, highlight: `hi\n${id}` }));

const WS = '00000000-0000-4000-8000-00000000000a';
const USER = '00000000-0000-4000-8000-0000000000b1';
const SA = '00000000-0000-4000-8000-0000000000c1';
const SPACE = '00000000-0000-4000-8000-0000000000d1';

function build(opts: {
  candidates: Row[];
  userDenied?: Set<string>;
  serviceDenied?: Set<string>;
  withPdp?: boolean;
  limits?: Partial<SearchLimits>;
}) {
  const { db, queries, candidateQueries, hydrateQueries } = searchDb({ candidates: opts.candidates });
  const pdp = pdpStub({ userDenied: opts.userDenied, serviceDenied: opts.serviceDenied });
  // The real repos: `withSpace` / `getUserSpaceIdsQuery` only build SQL over `db`.
  const pageRepo = new PageRepo(db as any, {} as any, {} as any);
  const spaceMemberRepo = new SpaceMemberRepo(db as any, {} as any, {} as any, {} as any);
  const service = new PdpSearchService(
    db as any,
    pageRepo,
    {} as any,
    spaceMemberRepo,
    {} as any,
    opts.withPdp === false ? undefined : pdp,
    undefined,
    opts.limits,
  );
  return { service, queries, candidateQueries, hydrateQueries, pdp };
}

const ids = (n: number, p = 'a') => Array.from({ length: n }, (_, i) => `${p}${i}`);
/** Fixed 128-id windows: the cases below that count windows predate #716's page-sized first window. */
const FIXED_128: Partial<SearchLimits> = { pdpWindowMin: 128, pdpWindowMax: 128 };
const run = (service: PdpSearchService, params: any, filters: SearchCandidateFilters = {}, extra: any = {}) =>
  service.searchAuthorized({ query: 'roadmap', ...params }, filters, { userId: USER, workspaceId: WS, ...extra });

describe('PdpSearchService.searchAuthorized — #615 filters are candidate SQL (never a post-filter)', () => {
  const FILTERS: SearchCandidateFilters = {
    creatorId: '00000000-0000-4000-8000-000000000101',
    lastUpdatedById: '00000000-0000-4000-8000-000000000102',
    parentPageId: '00000000-0000-4000-8000-000000000103',
    labelName: '  Road Map ',
    updatedSince: '2026-01-01T00:00:00.000Z',
    updatedUntil: '2026-02-01T00:00:00.000Z',
  };

  it('puts every filter into THE candidate statement, with its value bound (not interpolated)', async () => {
    // 200 authorized candidates, offset 50 + limit 100 (+1 peek) → two 128-id PDP windows, ONE statement (#696).
    const { service, candidateQueries, pdp } = build({ candidates: mkRows(ids(200)), limits: FIXED_128 });
    await run(service, { limit: 100, offset: 50 }, FILTERS);
    const windows = candidateQueries();
    expect(windows).toHaveLength(1);
    expect(userLegCalls(pdp)).toHaveLength(2);
    for (const q of windows) {
      expect(q.sql).toMatch(/"creator_id" = \$\d+/);
      expect(q.sql).toMatch(/"last_updated_by_id" = \$\d+/);
      expect(q.sql).toMatch(/"parent_page_id" = \$\d+/);
      expect(q.sql).toMatch(/"updated_at" >= \$\d+::timestamptz/);
      expect(q.sql).toMatch(/"updated_at" < \$\d+::timestamptz/);
      // The label exists-join: pinned to the page, the WORKSPACE and the page label type.
      expect(q.sql).toMatch(
        /exists \(\s*select 1 from page_labels pl join labels l on l\.id = pl\.label_id\s+where pl\.page_id = pages\.id and l\.workspace_id = \$\d+ and l\.type = 'page'\s+and l\.name = \$\d+\s*\)/,
      );
      // Live pages of this workspace only, rank-ordered with an id tiebreak.
      expect(q.sql).toMatch(/"deleted_at" is null/);
      expect(q.sql).toMatch(/"workspace_id" = \$\d+/);
      expect(q.sql).toMatch(/order by "rank" desc, "id" asc limit \$\d+$/);
      // Bound values: the label is normalized as Docmost stores it; nothing is spliced into the SQL text.
      expect(q.parameters).toEqual(
        expect.arrayContaining([
          FILTERS.creatorId,
          FILTERS.lastUpdatedById,
          FILTERS.parentPageId,
          FILTERS.updatedSince,
          FILTERS.updatedUntil,
          'road-map',
          WS,
        ]),
      );
      expect(q.sql).not.toContain('road-map');
      expect(q.sql).not.toContain(FILTERS.creatorId as string);
    }
  });

  it('the service does not drop rows itself: every authorized window row is kept (the SQL did the narrowing)', async () => {
    // Whatever the SQL returned is, by construction, the filtered stream: with every row authorized, the page is
    // exactly the first `limit` rows the DB answered — no JS-side predicate trims it.
    const { service } = build({ candidates: mkRows(ids(30)) });
    const { items, hasMore } = await run(service, { limit: 25 }, FILTERS);
    expect(items.map((r: any) => r.id)).toEqual(ids(25));
    expect(hasMore).toBe(true);
  });

  it('adds no predicate for an absent filter (the native search SQL is unchanged)', async () => {
    const { service, candidateQueries } = build({ candidates: mkRows(ids(3)) });
    await run(service, { limit: 10, spaceId: SPACE });
    const [q] = candidateQueries();
    for (const col of ['creator_id', 'last_updated_by_id', 'parent_page_id', 'updated_at']) {
      expect(q.sql).not.toMatch(new RegExp(`"${col}" (=|>=|<) `));
    }
    expect(q.sql).not.toContain('page_labels');
    expect(q.sql).toMatch(/"space_id" = \$\d+/);
  });

  it('without a spaceId the stream is pre-filtered to the user\'s member spaces (a subquery, still in SQL)', async () => {
    const { service, candidateQueries } = build({ candidates: mkRows(ids(3)) });
    await run(service, { limit: 10 });
    const [q] = candidateQueries();
    expect(q.sql).toMatch(/"space_id" in \(select/);
    expect(q.parameters).toContain(USER);
  });

  it('refuses a Postgres-invalid updated bound with a 400 before any SQL runs', async () => {
    for (const bad of [{ updatedSince: '2026' }, { updatedUntil: 'yesterday' }]) {
      const { service, queries } = build({ candidates: mkRows(ids(3)) });
      await expect(run(service, { limit: 10 }, bad)).rejects.toBeInstanceOf(BadRequestException);
      expect(queries).toHaveLength(0);
    }
  });
});

describe('PdpSearchService.searchAuthorized — hasMore is a one-row peek past the page', () => {
  it('true when one more authorized hit exists, false when the page ends the authorized set', async () => {
    const more = build({ candidates: mkRows(ids(26)) });
    expect(await run(more.service, { limit: 25 })).toMatchObject({ hasMore: true });
    const exact = build({ candidates: mkRows(ids(25)) });
    const page = await run(exact.service, { limit: 25 });
    expect(page.items).toHaveLength(25);
    expect(page.hasMore).toBe(false);
  });

  it('the peek counts AUTHORIZED hits only: a denied candidate after the page is not "more"', async () => {
    const { service } = build({ candidates: mkRows([...ids(25), 'd0', 'd1']), userDenied: new Set(['d0', 'd1']) });
    const page = await run(service, { limit: 25 });
    expect(page.items).toHaveLength(25);
    expect(page.hasMore).toBe(false);
  });

  it('pages over the authorized set with a correct peek on every page (offset)', async () => {
    const { service } = build({ candidates: mkRows(ids(60)) });
    const p1 = await run(service, { limit: 25, offset: 0 });
    const p2 = await run(service, { limit: 25, offset: 25 });
    const p3 = await run(service, { limit: 25, offset: 50 });
    expect([p1.hasMore, p2.hasMore, p3.hasMore]).toEqual([true, true, false]);
    expect(p3.items.map((r: any) => r.id)).toEqual(ids(60).slice(50));
  });

  it('MAX_LIMIT edge: the peek is measured against the CLAMPED limit (100), not the requested one', async () => {
    // Requested 1000 → clamped to 100. With 101 authorized hits the 101st is the peek (hasMore), never an item.
    const over = build({ candidates: mkRows(ids(101)) });
    const a = await run(over.service, { limit: 1000 });
    expect(a.items).toHaveLength(100);
    expect(a.hasMore).toBe(true);
    // Exactly 100: a full clamped page, and nothing behind it.
    const at = build({ candidates: mkRows(ids(100)) });
    const b = await run(at.service, { limit: 1000 });
    expect(b.items).toHaveLength(100);
    expect(b.hasMore).toBe(false);
  });

  it('the peek walks past a window when the page ends exactly on it (the 129th candidate decides)', async () => {
    // limit 100, offset 28 → need 129: the peek row sits in the SECOND 128-id PDP window (one statement).
    const { service, candidateQueries, pdp } = build({ candidates: mkRows(ids(129)), limits: FIXED_128 });
    const page = await run(service, { limit: 100, offset: 28 });
    expect(page.items).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(userLegCalls(pdp).map((c) => c[3].length)).toEqual([128, 1]);
    expect(candidateQueries()).toHaveLength(1);
  });

  it('a scan-budget stop never turns into hasMore=true (the peek alone decides; the stop is only logged)', async () => {
    // Every candidate denied → the walk stops at the budget with nothing: empty page, hasMore false.
    const denied = ids(1200, 'd');
    const none = build({ candidates: mkRows(denied), userDenied: new Set(denied) });
    const warn = jest.spyOn((none.service as any).logger, 'warn').mockImplementation();
    expect(await run(none.service, { limit: 25 })).toEqual({ items: [], hasMore: false });
    expect(warn).toHaveBeenCalledTimes(1);

    // 25 authorized hits, then only denied rows until the budget runs out: the page is full and the stream was NOT
    // exhausted, but no 26th authorized hit was COLLECTED — so no promise (page 2 would re-scan the same budget).
    const tail = ids(1500, 'd');
    const full = build({ candidates: mkRows([...ids(25), ...tail]), userDenied: new Set(tail) });
    const fullWarn = jest.spyOn((full.service as any).logger, 'warn').mockImplementation();
    const page = await run(full.service, { limit: 25 });
    expect(page.items).toHaveLength(25);
    expect(page.hasMore).toBe(false);
    expect(fullWarn).toHaveBeenCalledTimes(1); // still never a silent cap server-side
  });

  it('end to end: every hasMore=true is honored by a non-empty next page, even behind a budget-length denied tail', async () => {
    // Walk the cursor exactly as a /v1 or MCP client would, over authorized hits interleaved with a long denied run.
    const tail = ids(1500, 'd');
    const hits = ids(26);
    const { service } = build({
      candidates: mkRows([...hits.slice(0, 25), ...tail.slice(0, 700), hits[25], ...tail.slice(700)]),
      userDenied: new Set(tail),
    });
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    const collected: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = await run(service, { limit: 25, offset });
      if (offset > 0) expect(page.items.length).toBeGreaterThan(0); // a promised page is never empty
      collected.push(...page.items.map((r: any) => r.id));
      if (!page.hasMore) break;
      offset += 25;
    }
    expect(collected).toEqual(hits);

    // The exact false-promise shape: 25 visible hits then >=1000 hidden matches. Page 1 must not promise page 2.
    const trap = build({ candidates: mkRows([...ids(25), ...tail]), userDenied: new Set(tail) });
    jest.spyOn((trap.service as any).logger, 'warn').mockImplementation();
    const p1 = await run(trap.service, { limit: 25 });
    const p2 = await run(trap.service, { limit: 25, offset: 25 });
    expect(p1.hasMore).toBe(false);
    expect(p2).toEqual({ items: [], hasMore: false });
  });

  it('no count side-channel: hasMore does not reveal how many matches the caller cannot see (limit 1)', async () => {
    // One visible hit, then either nothing or a budget-exhausting run of hidden matches: the answer is identical.
    const hidden = ids(1500, 'd');
    const quiet = build({ candidates: mkRows(ids(1)) });
    const noisy = build({ candidates: mkRows([...ids(1), ...hidden]), userDenied: new Set(hidden) });
    jest.spyOn((noisy.service as any).logger, 'warn').mockImplementation();
    const a = await run(quiet.service, { limit: 1 });
    const b = await run(noisy.service, { limit: 1 });
    expect(b).toEqual(a);
    expect(b.hasMore).toBe(false);
  });

  it('an empty query answers an empty page without touching the DB or the PDP', async () => {
    const { service, queries, pdp } = build({ candidates: mkRows(ids(3)) });
    expect(await run(service, { query: '' })).toEqual({ items: [], hasMore: false });
    expect(queries).toHaveLength(0);
    expect(pdp.tryFilterResources).not.toHaveBeenCalled();
  });
});

describe('PdpSearchService.searchAuthorized — the on-behalf-of SERVICE leg (service ∩ user)', () => {
  it('a window hit the service account cannot see is skipped and the next authorized hit fills the page', async () => {
    const { service, pdp } = build({
      candidates: mkRows(['a0', 'hidden', 'a1', 'a2', 'a3']),
      serviceDenied: new Set(['hidden']),
    });
    const page = await run(service, { limit: 3 }, {}, { serviceSubjectId: SA });
    expect(page.items.map((r: any) => r.id)).toEqual(['a0', 'a1', 'a2']);
    expect(page.hasMore).toBe(true); // a3: visible to both
    // The service leg names the SERVICE ACCOUNT (never a user subject) and asks for page view; the user leg names
    // the Docmost user exactly as PdpPagePermissionRepo.filterAccessiblePageIds does.
    expect(pdp.tryFilterResources).toHaveBeenCalledWith(
      { provider: 'docmost', externalId: USER },
      'view',
      'page',
      expect.any(Array),
    );
    expect(pdp.tryFilterResources).toHaveBeenCalledWith(
      { principalId: SA, subjectType: 'service' },
      'view',
      'page',
      expect.any(Array),
    );
  });

  it('the service leg only sees ids the USER leg already admitted (never the raw window)', async () => {
    const { service, pdp } = build({
      candidates: mkRows(['a0', 'u-denied', 'a1']),
      userDenied: new Set(['u-denied']),
    });
    await run(service, { limit: 10 }, {}, { serviceSubjectId: SA });
    expect(serviceLegCalls(pdp).map((c) => c[3])).toEqual([['a0', 'a1']]);
  });

  it('a hit only the USER can see is neither an item nor the hasMore peek', async () => {
    const { service } = build({
      candidates: mkRows(['a0', 'a1', 'user-only']),
      serviceDenied: new Set(['user-only']),
    });
    const page = await run(service, { limit: 2 }, {}, { serviceSubjectId: SA });
    expect(page.items.map((r: any) => r.id)).toEqual(['a0', 'a1']);
    expect(page.hasMore).toBe(false);
  });

  it('keeps filling across windows when the service account hides a whole window', async () => {
    const hidden = ids(128, 'h');
    const { service } = build({
      candidates: mkRows([...hidden, ...ids(5)]),
      serviceDenied: new Set(hidden),
    });
    const page = await run(service, { limit: 5 }, {}, { serviceSubjectId: SA });
    expect(page.items.map((r: any) => r.id)).toEqual(ids(5));
    expect(page.hasMore).toBe(false);
  });

  it('a service leg that DENIES everything yields an empty page, not the user-only hits', async () => {
    const { service } = build({ candidates: mkRows(ids(5)), serviceDenied: new Set(ids(5)) });
    expect(await run(service, { limit: 5 }, {}, { serviceSubjectId: SA })).toEqual({ items: [], hasMore: false });
  });

  it('#696: a service leg that CANNOT answer aborts with a 503 — never the user-only hits, never an empty page', async () => {
    const { service, pdp, hydrateQueries } = build({ candidates: mkRows(ids(5)) });
    pdp.tryFilterResources.mockImplementation(async (s: any, _p: string, _t: string, l: string[]) =>
      s.subjectType === 'service' ? null : l,
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    await expect(run(service, { limit: 5 }, {}, { serviceSubjectId: SA })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(hydrateQueries()).toHaveLength(0);
  });

  it('refuses (503) to run any search when no PDP client is wired, before any SQL', async () => {
    for (const extra of [{ serviceSubjectId: SA }, {}]) {
      const { service, queries } = build({ candidates: mkRows(ids(5)), withPdp: false });
      await expect(run(service, { limit: 5 }, {}, extra)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(queries).toHaveLength(0);
    }
  });

  it('no serviceSubjectId → no service-leg call at all (a session / self-acting credential)', async () => {
    const { service, pdp } = build({ candidates: mkRows(ids(5)) });
    await run(service, { limit: 5 });
    expect(serviceLegCalls(pdp)).toHaveLength(0);
  });
});

describe('PdpSearchService.searchPage — the native route keeps its shape', () => {
  it('returns exactly { items } (no hasMore), gated for the user only, with the creator filter in SQL', async () => {
    const { service, candidateQueries, pdp } = build({ candidates: mkRows(ids(30)) });
    const creatorId = '00000000-0000-4000-8000-000000000101';
    const out = await service.searchPage({ query: 'roadmap', limit: 25, creatorId } as any, {
      userId: USER,
      workspaceId: WS,
    });
    expect(Object.keys(out)).toEqual(['items']);
    expect(out.items).toHaveLength(25);
    expect(serviceLegCalls(pdp)).toHaveLength(0);
    expect(candidateQueries()[0].sql).toMatch(/"creator_id" = \$\d+/);
    expect(candidateQueries()[0].parameters).toContain(creatorId);
  });

  it('still normalizes highlights (newlines collapsed) on both entry points', async () => {
    const { service } = build({ candidates: mkRows(['a']) });
    const native = await service.searchPage({ query: 'roadmap' } as any, { userId: USER, workspaceId: WS });
    expect(native.items[0].highlight).toBe('hi a');
    const bridge = build({ candidates: mkRows(['a']) });
    expect((await run(bridge.service, {})).items[0].highlight).toBe('hi a');
  });
});
