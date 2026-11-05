import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { validate } from 'class-validator';
import { PdpSearchService, SearchLimits, searchMaxConcurrent } from './pdp-search.service';
import { SearchService } from '../../core/search/search.service';
import {
  MAX_SEARCH_QUERY_LENGTH,
  SearchDTO,
  SearchShareDTO,
  SearchSuggestionDTO,
} from '../../core/search/dto/search.dto';
import { pdpStub, searchDb, SearchRow, userLegCalls } from './search-db.testkit';

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
 *     transactions never spanning a PDP call, the bulkhead and per-principal cap, the anonymous share lane.
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
    const { service, pdp } = build({ pageCandidates: mkRows(all), denied: new Set(all) });
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
    const { service, pdp, candidateQueries } = build({ pageCandidates: mkRows(all), denied: new Set(ids(299, 'd')) });

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
      limits: { deadlineMs: 150 },
    });
    pdp.tryFilterResources.mockImplementation(
      (_s: unknown, _p: string, _t: string, list: string[]) =>
        new Promise((r) => (setTimeout(() => r(list), 1500) as any).unref()),
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    const t0 = Date.now();
    await expectEngineBusy(service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS }));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(hydrateQueries()).toHaveLength(0);
  });

  it('a slow statement past the deadline answers 503 engine_busy at the deadline', async () => {
    const { service } = build({
      pageCandidates: mkRows(ids(3)),
      denied: new Set(),
      limits: { deadlineMs: 150 },
      delayMs: (q) => (/"id" in \(/.test(q.sql) ? 1500 : 0),
    });
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    const t0 = Date.now();
    await expectEngineBusy(service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS }));
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('never starts a statement with (almost) no time left — it would need statement_timeout 0, which is NO timeout', async () => {
    // The gate eats the deadline down to under minStatementMs but returns before it: the hydrate must not run.
    const { service, pdp, timeouts, hydrateQueries } = build({
      pageCandidates: mkRows(ids(3)),
      denied: new Set(),
      limits: { deadlineMs: 300, minStatementMs: 200 },
    });
    pdp.tryFilterResources.mockImplementation(
      (_s: unknown, _p: string, _t: string, list: string[]) => new Promise((r) => setTimeout(() => r(list), 150)),
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    await expectEngineBusy(service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS }));
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

describe('PdpSearchService — #696 bulkheads', () => {
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
      limits,
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    return { service, pdp };
  };
  const search = (s: PdpSearchService, userId: string) =>
    s.searchPage({ query: 'foo' } as any, { userId, workspaceId: WS });
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await tick();
    expect(cond()).toBe(true);
  };

  it('SEARCH_MAX_CONCURRENT: a positive integer, anything else the default 3', () => {
    expect(searchMaxConcurrent('5')).toBe(5);
    for (const bad of [undefined, '', '0', '-2', '2.5', 'abc']) expect(searchMaxConcurrent(bad)).toBe(3);
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

  it('one principal holds at most perPrincipal (2) places — its third search is refused at once, others are not', async () => {
    const { service, pdp } = mk({ maxConcurrent: 10, perPrincipal: 2 });
    const a = search(service, USER);
    const b = search(service, USER);
    await until(() => pdp.pending === 2);
    const t0 = Date.now();
    await expectEngineBusy(search(service, USER));
    expect(Date.now() - t0).toBeLessThan(100); // never queued behind itself
    const other = search(service, 'someone-else');
    await until(() => pdp.pending === 3);
    pdp.open();
    await Promise.all([a, b, other]);
  });

  it('a principal waiting for a slot counts toward its cap', async () => {
    const { service, pdp } = mk({ maxConcurrent: 1, perPrincipal: 2, slotWaitMs: 2000 });
    const a = search(service, USER); // running
    await until(() => pdp.pending === 1);
    const b = search(service, USER); // waiting for the slot
    await tick();
    await expectEngineBusy(search(service, USER));
    pdp.open();
    await a;
    await until(() => pdp.pending === 1);
    pdp.open();
    await b;
  });

  it('a principal\'s places are given back however a search ends (503s included)', async () => {
    const pdp = { tryFilterResources: jest.fn(async () => null as string[] | null) };
    const { service } = mk({ maxConcurrent: 1, perPrincipal: 1 }, pdp as any);
    for (let i = 0; i < 3; i++) {
      await expect(search(service, USER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    expect((service as any).inFlight.size).toBe(0);
    expect((service as any).slots.inUse).toBe(0);
  });

  it('suggestions share the bulkhead and the per-principal cap', async () => {
    const { service, pdp } = mk({ maxConcurrent: 10, perPrincipal: 1 });
    (service as any).spaceMemberRepository.getUserSpaceIds = async () => ['s1'];
    const a = search(service, USER);
    await until(() => pdp.pending === 1);
    await expectEngineBusy(service.searchSuggestions({ query: 'p', includePages: true } as any, USER, WS));
    pdp.open();
    await a;
  });
});

describe('PdpSearchService — #696 the anonymous share-search lane', () => {
  afterEach(() => jest.restoreAllMocks());
  const mk = (limits: Partial<SearchLimits> = {}) => {
    const shareRepo = { findById: jest.fn().mockResolvedValue({ id: 'sh', spaceId: 'sp' }) };
    const gate = { isSharingAllowed: jest.fn().mockResolvedValue(true) };
    const pdp = heldPdp();
    const sdb = searchDb({ candidates: mkRows(ids(3)) });
    const service = new PdpSearchService(
      sdb.db as any,
      { withSpace: (eb: any) => eb.lit(null).as('space') } as any,
      shareRepo as any,
      { getUserSpaceIdsQuery: () => sdb.db.selectFrom('space_members').select('spaceId') } as any,
      {} as any,
      pdp,
      gate as any,
      limits,
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    return { service, pdp };
  };
  const share = (s: PdpSearchService, extra: object = {}) =>
    s.searchPage({ query: 'roadmap', shareId: 'sh', ...extra } as any, { workspaceId: WS } as any);

  it('clamps limit to 1..25 and offset to ≥ 0, and never passes a spaceId upstream', async () => {
    const upstream = jest.spyOn(SearchService.prototype, 'searchPage').mockResolvedValue({ items: [] } as any);
    const { service } = mk();
    for (const [limit, offset, want] of [
      [1e6, -5, { limit: 25, offset: 0 }],
      [-3, 7, { limit: 1, offset: 7 }],
      [undefined, undefined, { limit: 25, offset: 0 }],
      [10, 100, { limit: 10, offset: 100 }],
    ] as const) {
      upstream.mockClear();
      await share(service, { limit, offset, spaceId: 'some-space' });
      expect(upstream).toHaveBeenCalledTimes(1);
      const [params] = upstream.mock.calls[0];
      expect({ limit: params.limit, offset: params.offset }).toEqual(want);
      expect(params.spaceId).toBeUndefined();
    }
  });

  it('an offset past shareMaxOffset (100) answers empty without running upstream SQL', async () => {
    const upstream = jest.spyOn(SearchService.prototype, 'searchPage').mockResolvedValue({ items: ['x'] } as any);
    const { service } = mk();
    expect(await share(service, { offset: 101 })).toEqual({ items: [] });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('has its OWN one-slot lane: a busy lane is 503 engine_busy, and full authenticated slots never block it', async () => {
    let finish!: () => void;
    const upstream = jest
      .spyOn(SearchService.prototype, 'searchPage')
      .mockImplementation(() => new Promise((r) => (finish = () => r({ items: [] } as any))));
    const { service, pdp } = mk({ maxConcurrent: 1, slotWaitMs: 50 });

    // The authenticated slot is held...
    const authed = service.searchPage({ query: 'foo' } as any, { userId: USER, workspaceId: WS });
    for (let i = 0; i < 50 && pdp.pending === 0; i++) await tick();
    // ...and the share lane still admits one,
    const first = share(service);
    for (let i = 0; i < 50 && upstream.mock.calls.length === 0; i++) await tick();
    expect(upstream).toHaveBeenCalledTimes(1);
    // but only one.
    await expectEngineBusy(share(service));
    finish();
    await first;
    pdp.open();
    await authed;
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
