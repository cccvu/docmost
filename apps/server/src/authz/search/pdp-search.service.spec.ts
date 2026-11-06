import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { validate } from 'class-validator';
import {
  PdpSearchService,
  SearchLimits,
  searchMaxConcurrent,
  searchMaxPerPrincipal,
  searchPdpLane,
  searchPdpWindowMax,
} from './pdp-search.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SearchService } from '../../core/search/search.service';
import {
  MAX_SEARCH_QUERY_LENGTH,
  SearchDTO,
  SearchShareDTO,
  SearchSuggestionDTO,
} from '../../core/search/dto/search.dto';
import { isSetTimeout, pdpStub, searchDb, SearchRow, userLegCalls } from './search-db.testkit';

/**
 * CCC authorization integration test (fork compatibility suite) — permission-aware search is
 * **filter-then-retrieve** (architecture D9 / §8 search row / §9 "authorized-k-under-truncation, no
 * count/score side-channel"). These prove the subclass:
 *   - returns a FULL page of authorized results even when higher-ranked candidates are all denied
 *     (the truncation fix — upstream retrieve-then-filter would under-return here);
 *   - never surfaces a denied/restricted page (the §8 absence guarantee, now structural);
 *   - answers empty when the PDP denies everything, and 503 (never empty) when the PDP cannot answer (#696);
 *   - paginates stably over the AUTHORIZED set (no skip/dup across pages);
 *   - never silently truncates — a hit on the candidate scan ceiling is logged;
 *   - #696: one candidate statement, a hydrate of the final slice only, one deadline, statement timeouts in short
 *     transactions never spanning a PDP call, the bulkhead and per-principal cap, the anonymous share lane;
 *   - #716: the process-wide PDP lane (held until a call settles), the adaptive first window, a per-(principal, kind)
 *     place that waits its turn, the shed log, and the share search under statement timeouts.
 *
 * The DB is a real Kysely over a recording driver (search-db.testkit.ts) that models the candidate statement and the
 * hydrate; the authorization decision is a `tryFilterResources` stub denying a known set. No DB, no containers.
 */

const mkRows = (ids: string[]): SearchRow[] =>
  ids.map((id, i) => ({
    id,
    rank: 1 - i / 1000,
    title: `title-${id}`,
    highlight: `hi\n${id}`,
  }));

const build = (opts: {
  pageCandidates: SearchRow[];
  denied: Set<string>;
  userSpaceIds?: string[];
  limits?: Partial<SearchLimits>;
  trashed?: Set<string>;
  delayMs?: Parameters<typeof searchDb>[0]['delayMs'];
  fail?: Parameters<typeof searchDb>[0]['fail'];
}) => {
  const sdb = searchDb({
    candidates: opts.pageCandidates,
    trashed: opts.trashed,
    delayMs: opts.delayMs,
    fail: opts.fail,
  });
  const pdp = pdpStub({ userDenied: opts.denied });
  const pageRepo = { withSpace: (eb: any) => eb.lit(null).as('space') };
  const spaceMemberRepo = {
    getUserSpaceIdsQuery: () => sdb.db.selectFrom('space_members').select('spaceId'),
    getUserSpaceIds: jest.fn(async () => opts.userSpaceIds ?? ['space-1']),
  };
  const service = new PdpSearchService(
    sdb.db as any,
    pageRepo as any,
    {} as any,
    spaceMemberRepo as any,
    {} as any,
    pdp,
    undefined,
    opts.limits,
  );
  return { service, pdp, spaceMemberRepo, ...sdb };
};

const WS = 'ws-1';
const USER = 'u1';
const ids = (n: number, p = 'a') => Array.from({ length: n }, (_, i) => `${p}${i}`);

/** A gate that holds every call until `open()` — to keep searches in flight. */
function heldPdp() {
  const waiting: Array<() => void> = [];
  return {
    tryFilterResources: jest.fn(
      (_s: unknown, _p: string, _t: string, list: string[]) =>
        new Promise<string[]>((resolve) => waiting.push(() => resolve(list))),
    ),
    open: () => waiting.splice(0).forEach((f) => f()),
    get pending() {
      return waiting.length;
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

const busy = { response: { code: 'engine_busy' }, status: 503 };
const expectEngineBusy = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ServiceUnavailableException);
  expect({ response: { code: err.getResponse().code }, status: err.getStatus() }).toEqual(busy);
};

describe('PdpSearchService — filter-then-retrieve (searchPage)', () => {
  it('returns a FULL page of authorized results even when the top-ranked candidates are all denied (authorized-k-under-truncation)', async () => {
    // 30 denied pages rank ABOVE 40 authorized ones. Upstream (limit-before-filter) would return 0 for
    // limit=25; we must return 25 authorized rows.
    const denied = new Set(ids(30, 'd'));
    const { service } = build({ pageCandidates: mkRows([...ids(30, 'd'), ...ids(40)]), denied });

    const { items } = await service.searchPage({ query: 'foo', limit: 25 } as any, { userId: USER, workspaceId: WS });

    expect(items.map((i: any) => i.id)).toEqual(ids(25));
    expect(items.every((i: any) => !denied.has(i.id))).toBe(true);
  });

  it('never surfaces a denied/restricted page in results (§8 absence)', async () => {
    const CONF = 'conf-page';
    const { service } = build({ pageCandidates: mkRows(['a', CONF, 'b', 'c']), denied: new Set([CONF]) });

    const { items } = await service.searchPage({ query: 'foo', limit: 25 } as any, { userId: USER, workspaceId: WS });

    expect(items.map((i: any) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('a PDP that DENIES everything yields empty results, not the raw candidates', async () => {
    const { service, pdp } = build({ pageCandidates: mkRows(['a', 'b', 'c']), denied: new Set() });
    pdp.tryFilterResources.mockResolvedValue([]);

    const { items } = await service.searchPage({ query: 'foo', limit: 25 } as any, { userId: USER, workspaceId: WS });

    expect(items).toEqual([]);
  });

  it('#696: a PDP that CANNOT answer aborts the search with a 503 at the first window — never an empty "no results", never more windows', async () => {
    const { service, pdp, hydrateQueries } = build({ pageCandidates: mkRows(ids(600, 'd')), denied: new Set() });
    pdp.tryFilterResources.mockResolvedValue(null);
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();

    const err = await service
      .searchPage({ query: 'foo', limit: 25 } as any, { userId: USER, workspaceId: WS })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(pdp.tryFilterResources).toHaveBeenCalledTimes(1);
    expect(hydrateQueries()).toHaveLength(0);
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/SEARCH_PDP_UNAVAILABLE/);
  });

  it('paginates stably over the AUTHORIZED set (offset applies to authorized results — no skip/dup)', async () => {
    const denied = new Set(ids(30, 'd'));
    const { service } = build({ pageCandidates: mkRows([...ids(30, 'd'), ...ids(40)]), denied });
    const page = async (offset: number) =>
      (await service.searchPage({ query: 'foo', limit: 25, offset } as any, { userId: USER, workspaceId: WS })).items.map(
        (i: any) => i.id,
      );

    const page1 = await page(0);
    const page2 = await page(25);

    expect(page1).toEqual(ids(25));
    expect(page2).toEqual(ids(40).slice(25));
  });

  it('never silently truncates — hitting the candidate scan ceiling logs a warning', async () => {
    // 1200 candidates, ALL denied → the statement reads the 1024 budget, the gate walks it, stops empty + warns.
    const all = ids(1200, 'd');
    // Fixed 128-id windows (#716 sizes the first one from the page; that is pinned in the PDP-lane describe).
    const { service, pdp } = build({
      pageCandidates: mkRows(all),
      denied: new Set(all),
      limits: { pdpWindowMin: 128, pdpWindowMax: 128 },
    });
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();

    const { items } = await service.searchPage({ query: 'foo', limit: 25 } as any, { userId: USER, workspaceId: WS });

    expect(items).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/scan budget/i);
    expect(pdp.tryFilterResources).toHaveBeenCalledTimes(1024 / 128);
  });

  it('clamps a huge caller limit to MAX_LIMIT (a large limit cannot force an unbounded scan)', async () => {
    const { service } = build({ pageCandidates: mkRows(ids(150)), denied: new Set() });
    const { items } = await service.searchPage({ query: 'foo', limit: 1000 } as any, { userId: USER, workspaceId: WS });
    expect(items).toHaveLength(100);
  });

  it('clamps a negative offset to 0 (no slice-from-end over the authorized set)', async () => {
    const { service } = build({ pageCandidates: mkRows(['a', 'b', 'c', 'd', 'e']), denied: new Set() });
    const { items } = await service.searchPage({ query: 'foo', limit: 3, offset: -10 } as any, {
      userId: USER,
      workspaceId: WS,
    });
    expect(items.map((i: any) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('collects an id once even if the candidate list repeats it', async () => {
    const { service } = build({ pageCandidates: mkRows(['a0', 'a1', 'a1', 'a2']), denied: new Set() });
    const { items } = await service.searchPage({ query: 'foo', limit: 50 } as any, { userId: USER, workspaceId: WS });
    expect(items.map((i: any) => i.id)).toEqual(['a0', 'a1', 'a2']);
  });

  it('short-circuits an empty query without touching the PDP or the DB', async () => {
    const { service, pdp, queries } = build({ pageCandidates: mkRows(['a']), denied: new Set() });
    const { items } = await service.searchPage({ query: '' } as any, { userId: USER, workspaceId: WS });
    expect(items).toEqual([]);
    expect(pdp.tryFilterResources).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
  });

  it('the anonymous / public-share path (no userId) does not run the per-principal PDP loop', async () => {
    // No userId, no shareId → the inherited upstream path returns empty and the gate is never invoked.
    const { service, pdp } = build({ pageCandidates: mkRows(['a', 'b']), denied: new Set() });
    const { items } = await service.searchPage({ query: 'foo' } as any, { workspaceId: WS });
    expect(items).toEqual([]);
    expect(pdp.tryFilterResources).not.toHaveBeenCalled();
  });

  it('refuses (503) any authenticated search when no PDP client is wired, before any SQL', async () => {
    const sdb = searchDb({ candidates: mkRows(['a']) });
    const service = new PdpSearchService(sdb.db as any, {} as any, {} as any, {} as any, {} as any);
    await expect(
      service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sdb.queries).toHaveLength(0);
  });
});

describe('PdpSearchService — #696 one candidate statement, then hydrate only the authorized slice', () => {
  it('reads the candidates in ONE statement (id + rank only, LIMIT budget) however many PDP windows it takes', async () => {
    // The sole authorized hit is candidate #300: three PDP windows, still ONE candidate statement.
    const all = [...ids(299, 'd'), 'a0'];
    const { service, pdp, candidateQueries } = build({
      pageCandidates: mkRows(all),
      denied: new Set(ids(299, 'd')),
      limits: { pdpWindowMin: 128, pdpWindowMax: 128 },
    });

    const { items } = await service.searchPage({ query: 'foo', limit: 25 } as any, { userId: USER, workspaceId: WS });

    expect(items.map((i: any) => i.id)).toEqual(['a0']);
    expect(pdp.tryFilterResources).toHaveBeenCalledTimes(3);
    expect(userLegCalls(pdp).every((c) => c[3].length <= 128)).toBe(true);
    const [q, ...rest] = candidateQueries();
    expect(rest).toHaveLength(0);
    expect(q.sql).toMatch(/^select "id", ts_rank\(tsv, /);
    expect(q.sql).not.toMatch(/ts_headline|text_content|"spaces"|offset/);
    expect(q.sql).toMatch(/order by "rank" desc, "id" asc limit \$\d+$/);
    expect(q.parameters[q.parameters.length - 1]).toBe(1024); // max(BASE_SCAN, need*4) for need 26
  });

  it('the budget scales with need and is capped at HARD_SCAN_CAP (2048)', async () => {
    const deep = build({ pageCandidates: mkRows(ids(5)), denied: new Set() });
    await deep.service.searchPage({ query: 'foo', limit: 100, offset: 400 } as any, { userId: USER, workspaceId: WS });
    const [q1] = deep.candidateQueries();
    expect(q1.parameters[q1.parameters.length - 1]).toBe(2004); // (400 + 100 + 1) * 4
    const huge = build({ pageCandidates: mkRows(ids(5)), denied: new Set() });
    await huge.service.searchPage({ query: 'foo', limit: 100, offset: 1e9 } as any, { userId: USER, workspaceId: WS });
    const [q2] = huge.candidateQueries();
    expect(q2.parameters[q2.parameters.length - 1]).toBe(2048);
  });

  it('hydrates ONLY the final page: the authorized ids of the slice (never a denied id, never the peek), with the headline over left(text_content, 64 KiB)', async () => {
    const denied = new Set(['d0', 'd1']);
    const { service, hydrateQueries } = build({
      pageCandidates: mkRows(['a0', 'd0', 'a1', 'd1', 'a2', 'a3', 'a4']),
      denied,
    });

    const { items } = await service.searchPage({ query: 'foo', limit: 2, offset: 1 } as any, {
      userId: USER,
      workspaceId: WS,
    });

    expect(items.map((i: any) => i.id)).toEqual(['a1', 'a2']);
    const [h, ...rest] = hydrateQueries();
    expect(rest).toHaveLength(0);
    const inIds = /"id" in \(([^)]*)\)/
      .exec(h.sql)![1]
      .split(',')
      .map((p) => h.parameters[Number(p.trim().slice(1)) - 1]);
    expect(inIds).toEqual(['a1', 'a2']);
    expect(h.sql).toContain(
      "ts_headline('english', left(text_content, 65536), to_tsquery('english', f_unaccent($1)),'MinWords=9, MaxWords=10, MaxFragments=3') as \"highlight\"",
    );
    expect(h.sql).toMatch(/"workspace_id" = \$\d+ and "deleted_at" is null$/);
    expect(h.parameters).toContain(WS);
  });

  it('restores the candidate (rank) order and drops a page trashed between the gate and the hydrate (no back-fill)', async () => {
    // The hydrate answers in REVERSE (SQL `in` has no order); a2 was trashed after the gate admitted it.
    const { service } = build({
      pageCandidates: mkRows(ids(6)),
      denied: new Set(),
      trashed: new Set(['a2']),
    });
    const { items } = await service.searchPage({ query: 'foo', limit: 4 } as any, { userId: USER, workspaceId: WS });
    expect(items.map((i: any) => i.id)).toEqual(['a0', 'a1', 'a3']);
    expect(items.map((i: any) => i.rank)).toEqual([1, 0.999, 0.997]);
  });

  it('returns the native response shape (rank from the candidate statement, normalized highlight, space)', async () => {
    const { service } = build({
      pageCandidates: [
        {
          id: 'a0',
          rank: 0.5,
          slugId: 's0',
          title: 't0',
          icon: null,
          parentPageId: null,
          creatorId: 'c0',
          createdAt: 'x',
          updatedAt: 'y',
          highlight: 'one\r\ntwo\n\n three',
          space: { id: 'sp' },
        },
      ],
      denied: new Set(),
    });
    const { items } = await service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS });
    expect(items).toEqual([
      {
        id: 'a0',
        slugId: 's0',
        title: 't0',
        icon: null,
        parentPageId: null,
        creatorId: 'c0',
        createdAt: 'x',
        updatedAt: 'y',
        rank: 0.5,
        highlight: 'one two three',
        space: { id: 'sp' },
      },
    ]);
  });

  it('no hydrate at all when nothing is authorized', async () => {
    const { service, hydrateQueries } = build({ pageCandidates: mkRows(['d0']), denied: new Set(['d0']) });
    await service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS });
    expect(hydrateQueries()).toHaveLength(0);
  });
});

describe('PdpSearchService — #696 statements: short transactions, statement_timeout, one deadline', () => {
  it('every statement runs in its own transaction under SET LOCAL statement_timeout ≤ 3 s, and no transaction is open during a PDP call', async () => {
    const sdb = searchDb({ candidates: mkRows(ids(5)) });
    const openAtPdp: number[] = [];
    const pdp = {
      tryFilterResources: jest.fn(async (_s: unknown, _p: string, _t: string, list: string[]) => {
        openAtPdp.push(sdb.tx.filter((t) => t === 'begin').length - sdb.tx.filter((t) => t !== 'begin').length);
        return list;
      }),
    };
    const service = new PdpSearchService(
      sdb.db as any,
      { withSpace: (eb: any) => eb.lit(null).as('space') } as any,
      {} as any,
      { getUserSpaceIdsQuery: () => sdb.db.selectFrom('space_members').select('spaceId') } as any,
      {} as any,
      pdp,
    );
    await service.searchPage({ query: 'foo', limit: 3 } as any, { userId: USER, workspaceId: WS });

    // candidates + hydrate: two transactions, each opened by its timeout, then exactly one statement.
    expect(sdb.tx).toEqual(['begin', 'commit', 'begin', 'commit']);
    const kinds = sdb.queries.map((q) => (/^set local/i.test(q.sql) ? 'set' : /"id" in \(/.test(q.sql) ? 'hydrate' : 'cand'));
    expect(kinds).toEqual(['set', 'cand', 'set', 'hydrate']);
    for (const t of sdb.timeouts()) {
      const ms = Number(/= (\d+)$/.exec(t.sql)![1]);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(3000);
    }
    expect(openAtPdp).toEqual([0]);
  });

  it('the statement timeout is what is LEFT of the deadline when that is under 3 s', async () => {
    const { service, timeouts } = build({
      pageCandidates: mkRows(ids(3)),
      denied: new Set(),
      limits: { deadlineMs: 1000 },
    });
    await service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS });
    const values = timeouts().map((t) => Number(/= (\d+)$/.exec(t.sql)![1]));
    expect(values.length).toBe(2);
    for (const v of values) expect(v).toBeLessThanOrEqual(1000);
  });

  it('a slow PDP past the deadline answers 503 engine_busy at the deadline (not when the PDP finally answers)', async () => {
    const { service, pdp, hydrateQueries } = build({
      pageCandidates: mkRows(ids(3)),
      denied: new Set(),
      limits: { deadlineMs: 150, pdpMinMs: 0 }, // pdpMinMs 0: the PDP call must really start, then outlive the deadline
    });
    pdp.tryFilterResources.mockImplementation(
      (_s: unknown, _p: string, _t: string, list: string[]) =>
        new Promise((r) => (setTimeout(() => r(list), 1500) as any).unref()),
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    const t0 = Date.now();
    await expectEngineBusy(service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS }));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(pdp.tryFilterResources).toHaveBeenCalledTimes(1);
    expect(hydrateQueries()).toHaveLength(0);
  });

  it('a slow statement past the deadline answers 503 engine_busy at the deadline', async () => {
    const { service, pdp, hydrateQueries } = build({
      pageCandidates: mkRows(ids(3)),
      denied: new Set(),
      limits: { deadlineMs: 150, pdpMinMs: 0 }, // the gate must pass so the slow statement is the HYDRATE
      delayMs: (q) => (/"id" in \(/.test(q.sql) ? 1500 : 0),
    });
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    const t0 = Date.now();
    await expectEngineBusy(service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS }));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(pdp.tryFilterResources).toHaveBeenCalledTimes(1);
    expect(hydrateQueries()).toHaveLength(1);
  });

  it('never starts a statement with (almost) no time left — it would need statement_timeout 0, which is NO timeout', async () => {
    // The gate eats the deadline down to under minStatementMs but returns before it: the hydrate must not run.
    const { service, pdp, timeouts, hydrateQueries } = build({
      pageCandidates: mkRows(ids(3)),
      denied: new Set(),
      limits: { deadlineMs: 300, minStatementMs: 200, pdpMinMs: 0 },
    });
    pdp.tryFilterResources.mockImplementation(
      (_s: unknown, _p: string, _t: string, list: string[]) => new Promise((r) => setTimeout(() => r(list), 150)),
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    await expectEngineBusy(service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS }));
    expect(pdp.tryFilterResources).toHaveBeenCalledTimes(1); // the gate ran and ate the time
    expect(timeouts()).toHaveLength(1); // the candidate statement only
    expect(hydrateQueries()).toHaveLength(0);
  });

  it('SQLSTATE 57014 (statement_timeout) is a 503 engine_busy; any other DB error passes through unchanged', async () => {
    const timedOut = build({
      pageCandidates: mkRows(ids(3)),
      denied: new Set(),
      fail: (q) => (/ts_rank/.test(q.sql) ? Object.assign(new Error('canceling statement'), { code: '57014' }) : undefined),
    });
    jest.spyOn((timedOut.service as any).logger, 'warn').mockImplementation();
    await expectEngineBusy(timedOut.service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS }));
    expect(timedOut.tx).toEqual(['begin', 'rollback']);

    const broken = build({
      pageCandidates: mkRows(ids(3)),
      denied: new Set(),
      fail: (q) => (/ts_rank/.test(q.sql) ? Object.assign(new Error('boom'), { code: '42P01' }) : undefined),
    });
    await expect(
      broken.service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS }),
    ).rejects.toThrow('boom');
  });
});

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
};
const warnLines = (warn: jest.SpyInstance) => warn.mock.calls.map((c) => String(c[0])).join('\n');

describe('PdpSearchService — #696/#716 bulkheads', () => {
  const mk = (limits: Partial<SearchLimits>, pdp = heldPdp()) => {
    const sdb = searchDb({ candidates: mkRows(ids(3)) });
    const service = new PdpSearchService(
      sdb.db as any,
      { withSpace: (eb: any) => eb.lit(null).as('space') } as any,
      {} as any,
      { getUserSpaceIdsQuery: () => sdb.db.selectFrom('space_members').select('spaceId') } as any,
      {} as any,
      pdp,
      undefined,
      // A wide PDP lane unless a case is about it: these cases are about admission.
      { pdpLaneMax: 10, ...limits },
    );
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();
    return { service, pdp, warn };
  };
  const search = (s: PdpSearchService, userId: string) =>
    s.searchPage({ query: 'foo' } as any, { userId, workspaceId: WS });

  it('the env knobs parse defensively: an integer in range, clamped above, anything else the default', () => {
    expect(searchMaxConcurrent('5')).toBe(5);
    expect(searchMaxConcurrent('500')).toBe(64);
    for (const bad of [undefined, '', '0', '-2', '2.5', 'abc']) expect(searchMaxConcurrent(bad)).toBe(3);
    expect(searchPdpLane('3')).toBe(3);
    expect(searchPdpLane('99')).toBe(16);
    for (const bad of [undefined, '', '0', '-1', '1.5', 'x']) expect(searchPdpLane(bad)).toBe(1); // #716 default
    expect(searchPdpWindowMax('32')).toBe(32);
    expect(searchPdpWindowMax('1000')).toBe(128);
    for (const bad of [undefined, '', '0', '8', '15', '40.5', 'x']) expect(searchPdpWindowMax(bad)).toBe(32); // #716 default
    expect(searchMaxPerPrincipal('2')).toBe(2);
    expect(searchMaxPerPrincipal('1000')).toBe(64);
    for (const bad of [undefined, '', '0', '-3', '0.5', 'x']) expect(searchMaxPerPrincipal(bad)).toBe(1);
  });

  it('the slots are full → a search waits at most slotWaitMs, then 503 engine_busy; a freed slot admits the next', async () => {
    const { service, pdp } = mk({ maxConcurrent: 2, slotWaitMs: 50 });
    const a = search(service, 'u-a');
    const b = search(service, 'u-b');
    await until(() => pdp.pending === 2);
    await expectEngineBusy(search(service, 'u-c'));
    pdp.open();
    await expect(a).resolves.toBeDefined();
    await expect(b).resolves.toBeDefined();
    pdp.tryFilterResources.mockImplementation(async (_s: unknown, _p: string, _t: string, l: string[]) => l);
    await expect(search(service, 'u-c')).resolves.toBeDefined();
  });

  it('#716: one principal runs perPrincipal (1) search at a time — its next ones WAIT their turn in order, and nobody else waits behind them', async () => {
    const { service, pdp } = mk({ maxConcurrent: 10, perPrincipal: 1, slotWaitMs: 5000 });
    const order: string[] = [];
    const a = search(service, USER).then(() => order.push('a'));
    await until(() => pdp.pending === 1);
    const b = search(service, USER).then(() => order.push('b'));
    const c = search(service, USER).then(() => order.push('c'));
    const other = search(service, 'someone-else');
    await until(() => pdp.pending === 2); // a and someone-else run; b and c wait for USER's place
    for (let i = 0; i < 10; i++) await tick();
    expect(pdp.pending).toBe(2);
    expect((service as any).inFlight.get(`search:user:${USER}`).refs).toBe(3);
    pdp.open();
    await until(() => order.includes('a') && pdp.pending === 1); // b, and only b, admitted
    pdp.open();
    await until(() => order.includes('b') && pdp.pending === 1); // then c
    pdp.open();
    await Promise.all([a, b, c, other]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect((service as any).inFlight.size).toBe(0); // idle keys are pruned
  });

  it('#716: with the default limits two principals cannot hold every slot — a third is admitted at once', async () => {
    const { service, pdp } = mk({}); // maxConcurrent 3, perPrincipal 1
    expect((service as any).limits.perPrincipal).toBe(1);
    const a1 = search(service, 'u-a');
    const a2 = search(service, 'u-a'); // waits for u-a's place, holds no slot
    const b = search(service, 'u-b');
    await until(() => pdp.pending === 2);
    const c = search(service, 'u-c');
    await until(() => pdp.pending === 3);
    pdp.open();
    await until(() => pdp.pending === 1); // a2's turn
    pdp.open();
    await Promise.all([a1, a2, b, c]);
  });

  it('#716 review: a search waits for its own previous search up to searchTurnWaitMs (not slotWaitMs): parallel agent calls run in turn', async () => {
    const { service, pdp } = mk({ maxConcurrent: 10, perPrincipal: 1, slotWaitMs: 30, searchTurnWaitMs: 5000 });
    const a = search(service, USER);
    await until(() => pdp.pending === 1);
    const b = search(service, USER);
    await new Promise((r) => setTimeout(r, 80)); // well past slotWaitMs: b is still waiting, not shed
    expect(pdp.pending).toBe(1);
    pdp.open();
    await until(() => pdp.pending === 1); // b admitted once a finished
    pdp.open();
    await expect(a).resolves.toBeDefined();
    await expect(b).resolves.toBeDefined();
  });

  it('#716: a principal whose turn does not come within slotWaitMs is shed 503 — logged with kind, principal, slots and lane', async () => {
    const { service, pdp, warn } = mk({ maxConcurrent: 10, perPrincipal: 1, slotWaitMs: 50, searchTurnWaitMs: 50 });
    const a = search(service, USER);
    await until(() => pdp.pending === 1);
    const t0 = Date.now();
    await expectEngineBusy(search(service, USER));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40); // it waited its turn; it was not refused at once
    expect(warnLines(warn)).toMatch(
      /^SEARCH_SHED reason=principal stage=search kind=search principal=u1 slots=1\/10 lane=1\/10: answered 503 engine_busy$/m,
    );
    pdp.open();
    await a;
  });

  it('a principal waiting for a slot holds its place: its next search waits for that place, never for a slot', async () => {
    const { service, pdp } = mk({ maxConcurrent: 1, perPrincipal: 1, slotWaitMs: 5000 });
    const a = search(service, 'u-other'); // holds the only slot
    await until(() => pdp.pending === 1);
    const b = search(service, USER); // has USER's place, waits for the slot
    const c = search(service, USER); // waits for USER's place
    for (let i = 0; i < 10; i++) await tick();
    expect((service as any).slots.waiters).toHaveLength(1); // b alone
    expect((service as any).inFlight.get(`search:user:${USER}`).places.waiters).toHaveLength(1); // c
    for (let round = 0; round < 3; round++) {
      await until(() => pdp.pending === 1);
      pdp.open();
    }
    await Promise.all([a, b, c]);
  });

  it("a principal's places, the slots and the PDP lane are given back however a search ends (503s included)", async () => {
    const pdp = { tryFilterResources: jest.fn(async () => null as string[] | null) };
    const { service } = mk({ maxConcurrent: 1, perPrincipal: 1 }, pdp as any);
    for (let i = 0; i < 3; i++) {
      await expect(search(service, USER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    await tick();
    expect((service as any).inFlight.size).toBe(0);
    expect((service as any).slots.inUse).toBe(0);
    expect((service as any).pdpLane.inUse).toBe(0);
  });

  it("#716: suggestions share the bulkhead but take their own place — a mention suggestion never waits behind the user's own search", async () => {
    const { service, pdp } = mk({ maxConcurrent: 10, perPrincipal: 1 });
    (service as any).spaceMemberRepository.getUserSpaceIds = async () => ['s1'];
    const a = search(service, USER);
    await until(() => pdp.pending === 1);
    const sug = service.searchSuggestions({ query: 'p', includePages: true } as any, USER, WS);
    await until(() => pdp.pending === 2);
    pdp.open();
    await Promise.all([a, sug]);
  });

  it('#716 review: a suggestion waits for its own previous suggestion only slotWaitMs (a stale keystroke is shed, not queued long)', async () => {
    const { service, pdp, warn } = mk({ maxConcurrent: 10, perPrincipal: 1, slotWaitMs: 50, searchTurnWaitMs: 5000 });
    (service as any).spaceMemberRepository.getUserSpaceIds = async () => ['s1'];
    const first = service.searchSuggestions({ query: 'p', includePages: true } as any, USER, WS);
    await until(() => pdp.pending === 1);
    const t0 = Date.now();
    await expectEngineBusy(service.searchSuggestions({ query: 'pa', includePages: true } as any, USER, WS));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(warnLines(warn)).toMatch(/SEARCH_SHED reason=principal stage=suggest kind=suggest principal=u1 /);
    pdp.open();
    await first;
  });

  it('suggestions share the bulkhead: full slots shed a suggestion too (kind=suggest)', async () => {
    const { service, pdp, warn } = mk({ maxConcurrent: 1, slotWaitMs: 50 });
    (service as any).spaceMemberRepository.getUserSpaceIds = async () => ['s1'];
    const a = search(service, 'u-other');
    await until(() => pdp.pending === 1);
    await expectEngineBusy(service.searchSuggestions({ query: 'p', includePages: true } as any, USER, WS));
    expect(warnLines(warn)).toMatch(/SEARCH_SHED reason=slots stage=suggest kind=suggest principal=u1 slots=1\/1 /);
    pdp.open();
    await a;
  });
});

describe('PdpSearchService — #716 the search PDP lane and the adaptive window', () => {
  const mk = (limits: Partial<SearchLimits>, pdp: any = heldPdp(), candidates = mkRows(ids(3))) => {
    const sdb = searchDb({ candidates });
    const spaceMemberRepo = {
      getUserSpaceIdsQuery: () => sdb.db.selectFrom('space_members').select('spaceId'),
      getUserSpaceIds: jest.fn(async () => ['s1']),
    };
    const service = new PdpSearchService(
      sdb.db as any,
      { withSpace: (eb: any) => eb.lit(null).as('space') } as any,
      {} as any,
      spaceMemberRepo as any,
      {} as any,
      pdp,
      undefined,
      { maxConcurrent: 10, perPrincipal: 10, ...limits },
    );
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();
    return { service, pdp, warn, spaceMemberRepo, ...sdb };
  };
  const search = (s: PdpSearchService, userId: string, params: object = {}) =>
    s.searchPage({ query: 'foo', ...params } as any, { userId, workspaceId: WS });

  it('#716 load-run defaults: a lane of 1 and windows of at most 32 ids (ADR 0005 amendment)', () => {
    const { service } = mk({});
    expect((service as any).limits).toMatchObject({ pdpLaneMax: 1, pdpWindowMin: 32, pdpWindowMax: 32 });
    expect((service as any).pdpLane.max).toBe(1);
  });

  it('the first window is sized from the page (2 × need, at least 32), then doubles up to pdpWindowMax', async () => {
    const all = ids(300, 'd');
    const sizes = async (limit: number, limits: Partial<SearchLimits> = {}) => {
      const { service, pdp } = mk(limits, pdpStub({ userDenied: new Set(all) }), mkRows(all));
      await search(service, USER, { limit });
      return userLegCalls(pdp).map((c) => c[3].length);
    };
    const w64 = { pdpWindowMax: 64 };
    expect(await sizes(10, w64)).toEqual([32, 64, 64, 64, 64, 12]); // need 11
    expect(await sizes(25, w64)).toEqual([52, 64, 64, 64, 56]); // need 26
    expect(await sizes(100, w64)).toEqual([64, 64, 64, 64, 44]); // need 101
    expect(await sizes(25, { pdpWindowMax: 128 })).toEqual([52, 104, 128, 16]);
    // The #716 defaults (pdpWindowMin = pdpWindowMax = 32): every window is 32 ids, whatever the page.
    expect(await sizes(10)).toEqual([...Array(9).fill(32), 12]);
    expect(await sizes(100)).toEqual([...Array(9).fill(32), 12]);
    // The scan budget is unchanged: 1024 candidates are still walked for a page that cannot fill.
    const { service, pdp } = mk({}, pdpStub({ userDenied: new Set(ids(1200, 'd')) }), mkRows(ids(1200, 'd')));
    await search(service, USER, { limit: 25 });
    expect(userLegCalls(pdp).reduce((n, c) => n + c[3].length, 0)).toBe(1024);
  });

  it('the default window fills the same page as fixed 128-id windows (completeness unchanged)', async () => {
    const stream: string[] = [];
    for (let i = 0; i < 600; i++) stream.push(i % 7 === 0 ? `a${i}` : `d${i}`);
    const denied = new Set(stream.filter((id) => id.startsWith('d')));
    const page = async (offset: number, limits: Partial<SearchLimits>) => {
      const { service } = mk({ ...limits }, pdpStub({ userDenied: denied }), mkRows(stream));
      const out = await service.searchAuthorized({ query: 'foo', limit: 20, offset } as any, {}, { userId: USER, workspaceId: WS });
      return { ids: out.items.map((r: any) => r.id), hasMore: out.hasMore };
    };
    for (const offset of [0, 20, 60, 80]) {
      expect(await page(offset, {})).toEqual(await page(offset, { pdpWindowMin: 128, pdpWindowMax: 128 }));
    }
  });

  it('a full lane sheds the next search (503 pdp_lane) within pdpLaneWaitMs, and the PDP never sees its ids', async () => {
    // (The shed is logged after u-b gave its own slot back: slots=1/10 is u-a's.)
    const { service, pdp, warn } = mk({ pdpLaneMax: 1, pdpLaneWaitMs: 50 });
    const a = search(service, 'u-a');
    await until(() => pdp.pending === 1);
    await expectEngineBusy(search(service, 'u-b'));
    expect(pdp.tryFilterResources).toHaveBeenCalledTimes(1);
    expect(warnLines(warn)).toMatch(
      /SEARCH_SHED reason=pdp_lane stage=pdp kind=search principal=u-b slots=1\/10 lane=1\/1: answered 503 engine_busy/,
    );
    pdp.open();
    await a;
    pdp.tryFilterResources.mockImplementation(async (_s: unknown, _p: string, _t: string, l: string[]) => l);
    await expect(search(service, 'u-b')).resolves.toBeDefined(); // the freed slot admits the next
  });

  it('a call the deadline abandoned keeps its lane slot until it SETTLES — then the next search is admitted', async () => {
    const { service, pdp } = mk({ pdpLaneMax: 1, pdpLaneWaitMs: 30, deadlineMs: 100, pdpMinMs: 0 });
    await expectEngineBusy(search(service, 'u-a')); // its PDP call is still pending
    expect(pdp.pending).toBe(1);
    expect((service as any).pdpLane.inUse).toBe(1);
    await expectEngineBusy(search(service, 'u-b')); // shed: the abandoned call still holds the lane
    expect(pdp.tryFilterResources).toHaveBeenCalledTimes(1);
    pdp.open(); // the abandoned call settles
    await until(() => (service as any).pdpLane.inUse === 0);
    pdp.tryFilterResources.mockImplementation(async (_s: unknown, _p: string, _t: string, l: string[]) => l);
    await expect(search(service, 'u-b', {})).resolves.toBeDefined();
  });

  it('no PDP call starts with less than pdpMinMs of the deadline left: shed at stage pdp, the PDP never called', async () => {
    const { service, pdp, warn, hydrateQueries } = mk({ deadlineMs: 1000, pdpMinMs: 5000 }, pdpStub());
    await expectEngineBusy(search(service, USER));
    expect(pdp.tryFilterResources).not.toHaveBeenCalled();
    expect(hydrateQueries()).toHaveLength(0);
    expect(warnLines(warn)).toMatch(/SEARCH_SHED reason=deadline stage=pdp kind=search principal=u1 /);
  });

  it('the lane bounds every authorization call search makes: plain, both on-behalf-of legs, and the suggestions\' space lookup', async () => {
    let inFlight = 0;
    let peak = 0;
    const waiting: Array<() => void> = [];
    const held = <T>(v: T) =>
      new Promise<T>((resolve) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        waiting.push(() => {
          inFlight--;
          resolve(v);
        });
      });
    const pdp = {
      tryFilterResources: jest.fn((_s: unknown, _p: string, _t: string, list: string[]) => held(list)),
    };
    const { service, spaceMemberRepo } = mk({ pdpLaneMax: 2, pdpLaneWaitMs: 5000 }, pdp);
    spaceMemberRepo.getUserSpaceIds.mockImplementation(() => held(['s1']));
    const runs = [
      search(service, 'u-1'),
      search(service, 'u-2'),
      service.searchAuthorized({ query: 'foo', limit: 2 } as any, {}, { userId: 'u-3', workspaceId: WS, serviceSubjectId: 'sa-1' }),
      service.searchAuthorized({ query: 'foo', limit: 2 } as any, {}, { userId: 'u-4', workspaceId: WS, serviceSubjectId: 'sa-1' }),
      service.searchSuggestions({ query: 'p', includePages: true } as any, 'u-5', WS),
      service.searchSuggestions({ query: 'p', includePages: true } as any, 'u-6', WS),
    ];
    let done = false;
    const all = Promise.all(runs).then(() => (done = true));
    for (let i = 0; i < 2000 && !done; i++) {
      await tick();
      waiting.shift()?.();
    }
    await all;
    expect(peak).toBe(2); // reached, never exceeded
    expect(pdp.tryFilterResources.mock.calls.filter((c: any[]) => c[0]?.subjectType === 'service')).toHaveLength(2);
    expect(spaceMemberRepo.getUserSpaceIds).toHaveBeenCalledTimes(2);
    expect((service as any).pdpLane.inUse).toBe(0);
  });

  it('page suggestions: the space lookup takes the lane (a full lane sheds it before the lookup runs)', async () => {
    const { service, pdp, spaceMemberRepo, warn } = mk({ pdpLaneMax: 1, pdpLaneWaitMs: 30 });
    const a = search(service, 'u-a');
    await until(() => pdp.pending === 1);
    await expectEngineBusy(service.searchSuggestions({ query: 'p', includePages: true } as any, USER, WS));
    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
    expect(warnLines(warn)).toMatch(/SEARCH_SHED reason=pdp_lane stage=suggest-spaces kind=suggest principal=u1 /);
    pdp.open();
    await a;
  });

  it('page suggestions: a space lookup the PDP could not answer is ITS 503 (never "no spaces", never a shed), and the lane is given back', async () => {
    const { service, spaceMemberRepo, candidateQueries, warn } = mk({}, pdpStub());
    const outage = new ServiceUnavailableException('authorization is temporarily unavailable');
    spaceMemberRepo.getUserSpaceIds.mockRejectedValue(outage);
    await expect(service.searchSuggestions({ query: 'p', includePages: true } as any, USER, WS)).rejects.toBe(outage);
    expect(candidateQueries()).toHaveLength(0);
    expect(warnLines(warn)).not.toMatch(/SEARCH_SHED/);
    await tick();
    expect((service as any).pdpLane.inUse).toBe(0);
  });
});

describe('PdpSearchService — #696/#716 the anonymous share search', () => {
  afterEach(() => jest.restoreAllMocks());
  const ROOT = 'p-root';
  const SHARE = { id: 'sh', pageId: ROOT, spaceId: 'sp', workspaceId: WS, includeSubPages: true };
  const isAncestor = (q: { sql: string }) => /with recursive "ancestors"/.test(q.sql);
  const isSubtree = (q: { sql: string }) => /with recursive "page_hierarchy"/.test(q.sql);
  const isShareSearch = (q: { sql: string }) => /^select .* from "pages" where "tsv" @@ .* offset \$\d+$/.test(q.sql);
  const mk = (
    o: {
      limits?: Partial<SearchLimits>;
      share?: object | null;
      findById?: jest.Mock;
      sharingAllowed?: boolean;
      restricted?: boolean;
      subtree?: string[];
      fail?: Parameters<typeof searchDb>[0]['fail'];
    } = {},
  ) => {
    const shareRepo = { findById: o.findById ?? jest.fn().mockResolvedValue(o.share === undefined ? SHARE : o.share) };
    const gate = { isSharingAllowed: jest.fn().mockResolvedValue(o.sharingAllowed ?? true) };
    const pdp = heldPdp();
    const sdb = searchDb({
      candidates: mkRows([ROOT, 'p-child', 'p-other']),
      fail: o.fail,
      answer: (q) =>
        isAncestor(q)
          ? o.restricted
            ? [{ id: 'access-row' }]
            : []
          : isSubtree(q)
            ? (o.subtree ?? [ROOT, 'p-child']).map((id) => ({ id }))
            : undefined,
    });
    const service = new PdpSearchService(
      sdb.db as any,
      { withSpace: (eb: any) => eb.lit(null).as('space') } as any,
      shareRepo as any,
      { getUserSpaceIdsQuery: () => sdb.db.selectFrom('space_members').select('spaceId') } as any,
      {} as any, // the injected PagePermissionRepo is never used by the share search
      pdp,
      gate as any,
      o.limits,
    );
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();
    const shareSearches = () => sdb.queries.filter(isShareSearch);
    return { service, pdp, shareRepo, gate, warn, shareSearches, ...sdb };
  };
  const share = (s: PdpSearchService, extra: object = {}) =>
    s.searchPage({ query: 'roadmap', shareId: 'sh', ...extra } as any, { workspaceId: WS } as any);
  const inList = (q: { sql: string; parameters: readonly unknown[] }) =>
    /"id" in \(([^)]*)\)/
      .exec(q.sql)![1]
      .split(',')
      .map((p) => q.parameters[Number(p.trim().slice(1)) - 1]);

  it('the two confidentiality reads are upstream\'s own methods and read only this.db (so a repo built on the transaction runs them whole)', () => {
    // If upstream ever reads another dependency in either, the share search would call it on `null` and fail
    // closed; this pin reds first so the bump re-checks the share-search note in UPSTREAM_MODIFICATIONS.md §5.
    for (const fn of [
      PagePermissionRepo.prototype.hasRestrictedAncestor,
      PageRepo.prototype.getPageAndDescendantsExcludingRestricted,
    ]) {
      const used = new Set(fn.toString().match(/this\.\w+/g));
      expect([...used]).toEqual(['this.db']);
    }
  });

  it('runs EVERY statement in its own transaction under SET LOCAL statement_timeout: the restricted-ancestor read, the subtree read, the full-text search', async () => {
    const { service, queries, tx, timeouts } = mk();
    const { items } = await share(service);
    const kinds = queries.map((q) =>
      isSetTimeout(q) ? 'set' : isAncestor(q) ? 'ancestor' : isSubtree(q) ? 'subtree' : isShareSearch(q) ? 'search' : q.sql,
    );
    expect(kinds).toEqual(['set', 'ancestor', 'set', 'subtree', 'set', 'search']);
    expect(tx).toEqual(['begin', 'commit', 'begin', 'commit', 'begin', 'commit']);
    for (const t of timeouts()) {
      const ms = Number(/= (\d+)$/.exec(t.sql)![1]);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(3000);
    }
    expect(items.map((i: any) => i.id).sort()).toEqual([ROOT, 'p-child'].sort());
  });

  it('the full-text statement: only the share\'s pages, this workspace, live, a headline over left(text_content, 64 KiB), no space', async () => {
    const { service, shareSearches } = mk();
    const { items } = await share(service);
    const [q, ...rest] = shareSearches();
    expect(rest).toHaveLength(0);
    expect(inList(q)).toEqual([ROOT, 'p-child']);
    expect(q.sql).toContain(
      "ts_headline('english', left(text_content, 65536), to_tsquery('english', f_unaccent($2)),'MinWords=9, MaxWords=10, MaxFragments=3') as \"highlight\"",
    );
    expect(q.sql).toMatch(/"deleted_at" is null and "id" in \([^)]*\) and "workspace_id" = \$\d+ order by "rank" desc, "id" asc limit \$\d+ offset \$\d+$/);
    expect(q.sql).not.toMatch(/"spaces"|"space_id"/);
    expect(q.parameters).toContain(WS);
    for (const item of items) {
      expect(item).not.toHaveProperty('space');
      expect(item.highlight).not.toMatch(/\n/); // normalized as upstream does
    }
  });

  it('clamps limit to 1..25 and offset to ≥ 0, and never searches by a spaceId', async () => {
    for (const [limit, offset, want] of [
      [1e6, -5, [25, 0]],
      [-3, 7, [1, 7]],
      [undefined, undefined, [25, 0]],
      [10, 100, [10, 100]],
    ] as const) {
      const { service, shareSearches } = mk();
      await share(service, { limit, offset, spaceId: 'some-space' });
      const [q] = shareSearches();
      expect(q.parameters.slice(-2)).toEqual(want);
      expect(q.parameters).not.toContain('some-space');
    }
  });

  it('includeSubPages=false searches the shared page alone (no subtree read)', async () => {
    const { service, queries, shareSearches } = mk({ share: { ...SHARE, includeSubPages: false } });
    await share(service);
    expect(queries.some(isSubtree)).toBe(false);
    expect(inList(shareSearches()[0])).toEqual([ROOT]);
  });

  it('a restricted ancestor answers empty before any search (and an empty subtree too)', async () => {
    const restricted = mk({ restricted: true });
    expect(await share(restricted.service)).toEqual({ items: [] });
    expect(restricted.queries.some(isSubtree)).toBe(false);
    expect(restricted.shareSearches()).toHaveLength(0);
    const empty = mk({ subtree: [] });
    expect(await share(empty.service)).toEqual({ items: [] });
    expect(empty.shareSearches()).toHaveLength(0);
  });

  it.each([
    ['no shareId (upstream finds nothing without one)', { shareId: undefined }, {}],
    ['an offset past shareMaxOffset (100)', { offset: 101 }, {}],
    ['an unknown or vetoed share', {}, { share: null }],
    ['a share of another workspace', {}, { share: { ...SHARE, workspaceId: 'ws-other' } }],
    ['sharing not allowed (disabled, or the space archived)', {}, { sharingAllowed: false }],
  ])('%s → empty, with no statement run', async (_n, params, o) => {
    const m = mk(o as any);
    expect(await share(m.service, params)).toEqual({ items: [] });
    expect(m.queries).toHaveLength(0);
  });

  it('has its OWN one-slot lane: a busy lane is 503 engine_busy, and full authenticated slots never block it', async () => {
    let finish!: (v: unknown) => void;
    const findById = jest.fn(() => new Promise((r) => (finish = r)));
    const { service, pdp, warn } = mk({ findById, limits: { maxConcurrent: 1, slotWaitMs: 50 } });

    // The authenticated slot is held...
    const authed = service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS });
    await until(() => pdp.pending === 1);
    // ...and the share lane still admits one,
    const first = share(service);
    await until(() => findById.mock.calls.length === 1);
    // but only one.
    await expectEngineBusy(share(service));
    expect(warnLines(warn)).toMatch(/SEARCH_SHED reason=share_lane stage=admit kind=share principal=anonymous slots=1\/1 /);
    finish(SHARE);
    await first;
    pdp.open();
    await authed;
  });

  it('the deadline answers 503 engine_busy, but the lane is held until the work SETTLES — no statement starts after it', async () => {
    let finish!: (v: unknown) => void;
    const findById = jest.fn(() => new Promise((r) => (finish = r)));
    const { service, queries } = mk({ findById, limits: { deadlineMs: 100 } });
    await expectEngineBusy(share(service));
    expect((service as any).shareLane.inUse).toBe(1); // the abandoned work still runs
    finish(SHARE); // it resumes past the deadline: no time left, so no statement starts, and the lane is freed
    await until(() => (service as any).shareLane.inUse === 0);
    expect(queries).toHaveLength(0);
  });

  it('SQLSTATE 57014 on a share statement is 503 engine_busy (logged, anonymous); any other DB error passes through', async () => {
    const timedOut = mk({
      fail: (q) => (isSubtree(q) ? Object.assign(new Error('canceling statement'), { code: '57014' }) : undefined),
    });
    await expectEngineBusy(share(timedOut.service));
    expect(warnLines(timedOut.warn)).toMatch(/SEARCH_SHED reason=sqlstate code=57014 kind=share principal=anonymous/);
    await tick();
    expect((timedOut.service as any).shareLane.inUse).toBe(0);
    const broken = mk({ fail: (q) => (isShareSearch(q) ? Object.assign(new Error('boom'), { code: '42P01' }) : undefined) });
    await expect(share(broken.service)).rejects.toThrow('boom');
  });
});

describe('PdpSearchService — filter-then-retrieve (searchSuggestions)', () => {
  it('page suggestions exclude denied pages and stay complete up to the limit, in candidate order', async () => {
    const { service, hydrateQueries } = build({
      pageCandidates: mkRows(['d0', 'd1', 'd2', 'p0', 'p1', 'p2', 'p3']),
      denied: new Set(['d0', 'd1', 'd2']),
    });

    const { pages } = await service.searchSuggestions({ query: 'p', includePages: true, limit: 3 } as any, USER, WS);

    expect(pages.map((p: any) => p.id)).toEqual(['p0', 'p1', 'p2']);
    // Only the authorized slice is hydrated (the hydrate answers in reverse; the order is restored).
    expect(hydrateQueries()).toHaveLength(1);
    expect(hydrateQueries()[0].parameters.slice(0, 3)).toEqual(['p0', 'p1', 'p2']);
  });

  it('returns no page suggestions when the user has no accessible spaces', async () => {
    const { service, pdp } = build({ pageCandidates: mkRows(['p0']), denied: new Set(), userSpaceIds: [] });
    const { pages } = await service.searchSuggestions({ query: 'p', includePages: true } as any, USER, WS);
    expect(pages).toEqual([]);
    expect(pdp.tryFilterResources).not.toHaveBeenCalled();
  });

  it('#696: a PDP that cannot answer is a 503 for page suggestions too', async () => {
    const { service, pdp } = build({ pageCandidates: mkRows(['p0']), denied: new Set() });
    pdp.tryFilterResources.mockResolvedValue(null);
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    await expect(
      service.searchSuggestions({ query: 'p', includePages: true } as any, USER, WS),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('#696: every suggestion statement runs under a statement_timeout', async () => {
    const { service, queries } = build({ pageCandidates: mkRows(['p0']), denied: new Set() });
    await service.searchSuggestions(
      { query: 'p', includePages: true, includeUsers: true, includeGroups: true } as any,
      USER,
      WS,
    );
    const kinds = queries.map((q) => (/^set local statement_timeout/i.test(q.sql) ? 'set' : 'stmt'));
    expect(kinds).toEqual(['set', 'stmt', 'set', 'stmt', 'set', 'stmt', 'set', 'stmt']);
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
    const { service, pdp } = build({ pageCandidates: mkRows(['a']), denied: new Set() });
    await expect(
      service.searchPage({ query: overLong, limit: 25 } as any, { userId: USER, workspaceId: WS }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(pdp.tryFilterResources).not.toHaveBeenCalled(); // rejected before any retrieval work
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
