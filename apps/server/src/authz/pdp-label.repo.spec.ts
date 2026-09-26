import { FactoryProvider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { LabelRepo, LabelType } from '@docmost/db/repos/label/label.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { emptyCursorPaginationResult } from '@docmost/db/pagination/cursor-pagination';
import {
  AuthorizedKeysetPageOpts,
  CursoredRow,
  LABEL_SCAN,
  PdpLabelRepo,
  WindowVerdict,
  authorizedKeysetPage,
  scanBudget,
} from './pdp-label.repo';
import { AUTHZ_MODE, AuthzMode } from './mode/authz-mode';
import {
  labelRepoProvider,
  pagePermissionRepoProvider,
  spaceMemberRepoProvider,
} from './mode/repo-providers';
import { HttpAuthzClient } from './http-authz.client';
import { PdpPagePermissionRepo } from './pdp-page-permission.repo';
import { PdpSpaceMemberRepo } from './pdp-space-member.repo';

/**
 * CCC authorization integration test — NOT upstream Docmost code.
 *
 * The filter-then-retrieve walk behind the native label lists (#615), against an in-memory candidate stream:
 * the page and its meta are computed over AUTHORIZED rows only, no cursor ever encodes a denied row, and the walk
 * is bounded by its scan budget (logged, never silent). The real SQL — candidates, the label rounds, upstream
 * shape parity — is proven on Postgres in pdp-label.repo.pg.spec.ts.
 */

type Row = { id: string; name: string };
const W = 4; // window size for the fake stream

/** A fake keyset stream with upstream's paginator semantics (natural order; a lone beforeCursor walks back). */
function stream(ids: string[]) {
  const rows: CursoredRow<Row>[] = ids.map((id) => ({ id, name: `name-${id}`, $cursor: `c:${id}` }));
  const at = (c: string) => rows.findIndex((r) => r.$cursor === c);
  const calls: Array<{ perPage: number; cursor?: string; beforeCursor?: string }> = [];
  const fetchWindow: AuthorizedKeysetPageOpts<Row>['fetchWindow'] = async (b) => {
    calls.push({ ...b });
    const lo = b.cursor ? at(b.cursor) + 1 : 0;
    const hi = b.beforeCursor ? at(b.beforeCursor) : rows.length;
    const range = rows.slice(lo, hi);
    if (b.beforeCursor && !b.cursor) {
      const items = range.slice(Math.max(range.length - b.perPage, 0));
      return { items, meta: { hasNextPage: range.length > b.perPage } };
    }
    return { items: range.slice(0, b.perPage), meta: { hasNextPage: range.length > b.perPage } };
  };
  return { rows, fetchWindow, calls };
}

const pdpGate =
  (viewable: Set<string>) =>
  async (rows: CursoredRow<Row>[]): Promise<WindowVerdict> => ({
    allowed: new Set(rows.filter((r) => viewable.has(r.id)).map((r) => r.id)),
    cost: rows.length,
    undecided: new Set(),
  });

const run = (
  s: ReturnType<typeof stream>,
  over: Partial<AuthorizedKeysetPageOpts<Row>> & { viewable?: Set<string> },
) => {
  const onTruncated = jest.fn();
  const result = authorizedKeysetPage<Row>({
    perPage: 2,
    metaLimit: 2,
    window: W,
    budget: 1000,
    fetchWindow: s.fetchWindow,
    gate: pdpGate(over.viewable ?? new Set(s.rows.map((r) => r.id))),
    onTruncated,
    ...over,
  });
  return { result, onTruncated };
};

const ids = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);

describe('authorizedKeysetPage — the filter-then-retrieve walk (#615)', () => {
  it('pages over AUTHORIZED rows across windows; hasNextPage/cursors come only from authorized rows', async () => {
    const s = stream(ids(12));
    // Only r05, r09, r11 are viewable: the first page needs three windows to find its two rows + the peek.
    const { result, onTruncated } = run(s, { viewable: new Set(['r05', 'r09', 'r11']) });
    const page = await result;
    expect(page.items.map((r) => r.id)).toEqual(['r05', 'r09']);
    expect(page.meta).toEqual({
      limit: 2,
      hasNextPage: true,
      hasPrevPage: false,
      nextCursor: 'c:r09', // the last RETURNED authorized row — never the denied r10 or the window edge
      prevCursor: null,
    });
    expect(s.calls.map((c) => c.cursor)).toEqual([undefined, 'c:r03', 'c:r07']);
    expect(onTruncated).not.toHaveBeenCalled();
    // The per-row cursor never reaches the caller.
    for (const item of page.items) expect(Object.keys(item)).toEqual(['id', 'name']);
  });

  it('the next page resumes from that cursor and ends with hasNextPage=false', async () => {
    const s = stream(ids(12));
    const page = await run(s, { viewable: new Set(['r05', 'r09', 'r11']), cursor: 'c:r09' }).result;
    expect(page.items.map((r) => r.id)).toEqual(['r11']);
    expect(page.meta).toEqual({
      limit: 2,
      hasNextPage: false,
      hasPrevPage: true,
      nextCursor: null,
      prevCursor: 'c:r11',
    });
  });

  it('a full stream of viewable rows reproduces upstream paging exactly (limit, peek, cursors)', async () => {
    const s = stream(ids(5));
    const page = await run(s, {}).result;
    expect(page.items.map((r) => r.id)).toEqual(['r00', 'r01']);
    expect(page.meta).toMatchObject({ hasNextPage: true, nextCursor: 'c:r01' });
    expect(s.calls).toHaveLength(1); // one window held perPage + 1
  });

  it('no authorized row ⇒ the canonical empty result, even with a cursor (hidden reads as absent)', async () => {
    const s = stream(ids(6));
    const empty = emptyCursorPaginationResult(2);
    expect(await run(s, { viewable: new Set() }).result).toEqual(empty);
    expect(await run(stream(ids(6)), { viewable: new Set(), cursor: 'c:r01' }).result).toEqual(empty);
  });

  it.each([1.5, null, 250])(
    'meta.limit echoes the caller\'s raw limit (%p), never the clamped perPage — empty and non-empty alike',
    async (raw) => {
      // The controller's unknown-name answer is emptyCursorPaginationResult(rawLimit): a clamped echo here would
      // tell a hidden-only label from a missing one (a label-name existence oracle).
      const hidden = await run(stream(ids(6)), { viewable: new Set(), metaLimit: raw as number }).result;
      expect(hidden).toEqual(emptyCursorPaginationResult(raw as number));
      const shown = await run(stream(ids(6)), { metaLimit: raw as number }).result;
      expect(shown.items).toHaveLength(2); // perPage still sizes the page
      expect(shown.meta.limit).toBe(raw);
    },
  );

  it('spends at most the scan budget when the PDP denies everything, warns, claims no next page', async () => {
    const s = stream(ids(40));
    const { result, onTruncated } = run(s, { viewable: new Set(['r39']), budget: 12 });
    const page = await result;
    expect(page).toEqual(emptyCursorPaginationResult(2));
    expect(s.calls).toHaveLength(3); // 12 / W windows, then stop — r39 is never reached
    expect(onTruncated).toHaveBeenCalledWith({ budget: 12, spent: 12, collected: 0, need: 3 });
  });

  it('a budget hit after some rows returns them with hasNextPage=false (no cursor past hidden rows)', async () => {
    const s = stream(ids(40));
    const { result, onTruncated } = run(s, { viewable: new Set(['r01', 'r39']), budget: 8 });
    const page = await result;
    expect(page.items.map((r) => r.id)).toEqual(['r01']);
    expect(page.meta).toMatchObject({ hasNextPage: false, nextCursor: null });
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  it('charges every window at least its row count, even if the gate reports no cost', async () => {
    const s = stream(ids(40));
    const gate = async () => ({ allowed: new Set<string>(), cost: 0, undecided: new Set<string>() });
    const { result } = run(s, { gate, budget: 8 });
    await result;
    expect(s.calls).toHaveLength(2);
  });

  it('an undecided row ends the page BEFORE it (prefix-complete) and warns', async () => {
    const s = stream(ids(8));
    const gate = async (rows: CursoredRow<Row>[]): Promise<WindowVerdict> => ({
      allowed: new Set(rows.map((r) => r.id).filter((id) => id !== 'r01')),
      cost: rows.length,
      undecided: new Set(rows.map((r) => r.id).filter((id) => id === 'r01')),
    });
    const { result, onTruncated } = run(s, { gate, perPage: 5 });
    const page = await result;
    expect(page.items.map((r) => r.id)).toEqual(['r00']); // r02/r03 are allowed but come after the gap
    expect(page.meta).toMatchObject({ hasNextPage: false, nextCursor: null });
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  it('an undecided row AFTER the peek row is irrelevant: full page, next page, no warning', async () => {
    const s = stream(ids(8));
    const gate = async (rows: CursoredRow<Row>[]): Promise<WindowVerdict> => ({
      allowed: new Set(['r00', 'r01', 'r02']),
      cost: rows.length,
      undecided: new Set(['r03']),
    });
    const { result, onTruncated } = run(s, { gate });
    const page = await result;
    expect(page.items.map((r) => r.id)).toEqual(['r00', 'r01']);
    expect(page.meta).toMatchObject({ hasNextPage: true, nextCursor: 'c:r01' });
    expect(onTruncated).not.toHaveBeenCalled();
  });

  it('passes the remaining budget to the gate', async () => {
    const s = stream(ids(12));
    const seen: number[] = [];
    const gate = async (rows: CursoredRow<Row>[], remaining: number) => {
      seen.push(remaining);
      return { allowed: new Set<string>(), cost: rows.length, undecided: new Set<string>() };
    };
    await run(s, { gate, budget: 10 }).result;
    expect(seen).toEqual([10, 6, 2]);
  });

  it('a lone beforeCursor walks backwards (nearest first) and returns natural order, like upstream', async () => {
    const s = stream(ids(12));
    const page = await run(s, { viewable: new Set(['r01', 'r02', 'r08']), beforeCursor: 'c:r10' }).result;
    // Nearest authorized rows before r10: r08, r02 (+ peek r01) → returned in natural order.
    expect(page.items.map((r) => r.id)).toEqual(['r02', 'r08']);
    expect(page.meta).toEqual({
      limit: 2,
      hasNextPage: true,
      hasPrevPage: false,
      nextCursor: 'c:r08', // upstream: the natural-order end row
      prevCursor: null,
    });
    expect(s.calls.map((c) => c.beforeCursor)).toEqual(['c:r10', 'c:r06', 'c:r02']);
  });

  it('cursor + beforeCursor walks forward and keeps the upper bound on every window', async () => {
    const s = stream(ids(12));
    const page = await run(s, { viewable: new Set(['r07', 'r10']), cursor: 'c:r00', beforeCursor: 'c:r09' }).result;
    expect(page.items.map((r) => r.id)).toEqual(['r07']);
    expect(page.meta.hasNextPage).toBe(false);
    for (const c of s.calls) expect(c.beforeCursor).toBe('c:r09');
  });

  it('never returns the same row twice when a row shifts across a window edge', async () => {
    const rows: CursoredRow<Row>[] = ['a', 'b', 'b', 'c'].map((id, i) => ({ id, name: id, $cursor: `c${i}` }));
    let call = 0;
    const fetchWindow = async () => {
      const items = call === 0 ? rows.slice(0, 2) : rows.slice(2);
      call += 1;
      return { items, meta: { hasNextPage: call === 1 } };
    };
    const page = await authorizedKeysetPage<Row>({
      perPage: 5,
      metaLimit: 5,
      window: 2,
      budget: 100,
      fetchWindow,
      gate: pdpGate(new Set(['a', 'b', 'c'])),
      onTruncated: jest.fn(),
    });
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('scanBudget scales with need, floored and capped like PdpSearchService', () => {
    expect(scanBudget(21)).toBe(LABEL_SCAN.BASE_SCAN);
    expect(scanBudget(400)).toBe(1600);
    expect(scanBudget(10_000)).toBe(LABEL_SCAN.HARD_SCAN_CAP);
    // Every label round stays under the platform's 1000-id filter cap (≈ LABEL_ROUND_IDS, never fewer than
    // PAGES_PER_LABEL_ROUND per label for a full window).
    expect(LABEL_SCAN.LABEL_ROUND_IDS).toBeLessThanOrEqual(1000);
    expect(LABEL_SCAN.LABEL_WINDOW * LABEL_SCAN.PAGES_PER_LABEL_ROUND).toBeLessThanOrEqual(1000);
    // A capped label cannot spend a whole budget by itself.
    expect(LABEL_SCAN.PER_LABEL_CAP).toBeLessThan(LABEL_SCAN.BASE_SCAN);
    expect(LABEL_SCAN.PAGE_WINDOW).toBeLessThanOrEqual(1000);
  });
});

describe('PdpLabelRepo — no viewable space short-circuits (no candidate read, no PDP call)', () => {
  // Compiled offline (no connection): a query that executed would throw here.
  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool: {} as any }),
    plugins: [new CamelCasePlugin()],
  });
  const spaceMembers = { getUserSpaceIds: jest.fn(async () => []) };
  const pagePermissions = { filterAccessiblePageIds: jest.fn() };
  const repo = new PdpLabelRepo(db as any, spaceMembers as any, pagePermissions as any);
  const calls = {
    findLabels: (pagination: any) => repo.findLabels('w1', 'u1', LabelType.PAGE, pagination),
    findPagesByLabelId: (pagination: any) => repo.findPagesByLabelId('l1', 'u1', { pagination }),
  };

  // The raw limit is echoed, never clamped: 1.5 and null pass the ValidationPipe, and the controller's unknown-name
  // answer is emptyCursorPaginationResult(rawLimit) — a clamped echo would be a label-name existence oracle.
  it.each([
    ['findLabels', 25],
    ['findPagesByLabelId', 25],
    ['findLabels', 1.5],
    ['findPagesByLabelId', 1.5],
    ['findLabels', null],
    ['findPagesByLabelId', null],
  ] as const)('%s (limit %p)', async (name, limit) => {
    expect(await calls[name]({ limit, cursor: 'x' })).toEqual(emptyCursorPaginationResult(limit as number));
    expect(pagePermissions.filterAccessiblePageIds).not.toHaveBeenCalled();
  });

  it('getLabelPageCountForUser', async () => {
    expect(await repo.getLabelPageCountForUser('l1', 'u1')).toBe(0);
  });
});

describe('labelRepoProvider — the label repo moves with AUTHZ_MODE', () => {
  const p = labelRepoProvider as FactoryProvider;
  const stub = {} as any;

  it('names AUTHZ_MODE first and resolves the (mode-selected) page repo it gates through', () => {
    expect(p.provide).toBe(LabelRepo);
    expect(p.inject?.[0]).toBe(AUTHZ_MODE);
    expect(p.inject).toEqual(expect.arrayContaining([SpaceMemberRepo, PagePermissionRepo]));
  });

  it('native → stock LabelRepo, never the PDP subclass', () => {
    const inst = p.useFactory('native', stub, stub, stub);
    expect(inst).toBeInstanceOf(LabelRepo);
    expect(inst).not.toBeInstanceOf(PdpLabelRepo);
  });

  it('remote → PdpLabelRepo', () => {
    expect(p.useFactory('remote', stub, stub, stub)).toBeInstanceOf(PdpLabelRepo);
  });

  // Resolved through Nest DI with the real provider set of seam #1: the label repo's gate is the SAME mode's page
  // repo, so a remote label list can never fall back to the stock (mirror-based) page decision.
  const resolve = async (mode: AuthzMode) =>
    (
      await Test.createTestingModule({
        providers: [
          { provide: AUTHZ_MODE, useValue: mode },
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: stub },
          { provide: GroupRepo, useValue: stub },
          { provide: SpaceRepo, useValue: stub },
          { provide: CACHE_MANAGER, useValue: stub },
          { provide: HttpAuthzClient, useValue: stub },
          spaceMemberRepoProvider,
          pagePermissionRepoProvider,
          labelRepoProvider,
        ],
      }).compile()
    ).get(LabelRepo) as any;

  it('remote (DI): PdpLabelRepo gates through PdpPagePermissionRepo, spaces from PdpSpaceMemberRepo', async () => {
    const repo = await resolve('remote');
    expect(repo).toBeInstanceOf(PdpLabelRepo);
    expect(repo.pagePermissions).toBeInstanceOf(PdpPagePermissionRepo);
    expect(repo.spaceMembers).toBeInstanceOf(PdpSpaceMemberRepo);
  });

  it('native (DI): the stock LabelRepo', async () => {
    const repo = await resolve('native');
    expect(repo).toBeInstanceOf(LabelRepo);
    expect(repo).not.toBeInstanceOf(PdpLabelRepo);
  });
});

describe('LabelRepo surface pin — every user-scoped read is PDP-overridden', () => {
  // A user-scoped read takes the caller's userId and decides what they see: it must be overridden. Every other
  // method is by-id, a write, or internal, and its caller gates the page/label first (page.controller /pages/labels*
  // → PageAccessService; the label controller resolves a name or id, then calls a user-scoped read). An upstream
  // bump that adds or renames a method turns this red: classify it here, and override it if it is user-scoped.
  const USER_SCOPED = ['findLabels', 'findPagesByLabelId', 'getLabelPageCountForUser'];
  const GATED_BY_CALLER = [
    'constructor',
    'findById',
    'findByNameAndWorkspace',
    'findOrCreate',
    'findLabelsByPageId',
    'addLabelToPage',
    'removeLabelFromPage',
    'getPageLabelCount',
    'getLabelPageCount',
    'deleteLabel',
  ];

  it('the upstream surface is exactly the classified set', () => {
    expect(Object.getOwnPropertyNames(LabelRepo.prototype).sort()).toEqual(
      [...USER_SCOPED, ...GATED_BY_CALLER].sort(),
    );
  });

  it.each(USER_SCOPED)('PdpLabelRepo overrides %s', (method) => {
    expect(Object.getOwnPropertyNames(PdpLabelRepo.prototype)).toContain(method);
  });
});
