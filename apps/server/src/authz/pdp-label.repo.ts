import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { InferResult, sql } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { LabelRepo, LabelType } from '@docmost/db/repos/label/label.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import {
  CursorPaginationResult,
  emptyCursorPaginationResult,
  executeWithCursorPagination,
} from '@docmost/db/pagination/cursor-pagination';

/** Candidate pages per window: ≤ the platform's 1000-item filter-resources cap (as PdpSearchService). */
const PAGE_WINDOW = 128;
/** Candidate labels per window. Each round of a window reads ≈ LABEL_ROUND_IDS candidate pages, split across its
 *  still-undecided labels (never fewer than PAGES_PER_LABEL_ROUND each), and asks the PDP about all of them in
 *  ONE call (≤ the 1000-item cap). A label with PER_LABEL_CAP hidden candidates and no viewable one is left out
 *  (logged) rather than let one heavily restricted label spend the whole budget and end the list before it. */
const LABEL_WINDOW = 64;
const LABEL_ROUND_IDS = 512;
const PAGES_PER_LABEL_ROUND = 8;
const PER_LABEL_CAP = 512;
/** Scan budget (candidate page checks per request): scales with `need` so an in-range page completes, floored
 *  and capped so the DB+PDP round-trips stay bounded — the same numbers as PdpSearchService. */
const BASE_SCAN = 1024;
const HARD_SCAN_CAP = 2048;
const OVERSCAN = 4;
/** PaginationOptions' own @Max — re-applied here so an unvalidated caller cannot force an unbounded walk. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
/** Below every real uuid: the "nothing checked yet" page cursor for a label (keeps nulls out of the uuid[]). */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** Upstream's per-row cursor key (`executeWithCursorPagination({ cursorPerRow })`); stripped before returning. */
const CURSOR_KEY = '$cursor' as const;

export const LABEL_SCAN = {
  PAGE_WINDOW,
  LABEL_WINDOW,
  LABEL_ROUND_IDS,
  PAGES_PER_LABEL_ROUND,
  PER_LABEL_CAP,
  BASE_SCAN,
  HARD_SCAN_CAP,
  OVERSCAN,
  MAX_LIMIT,
} as const;

/** The scan budget for a walk that must collect `need` authorized rows. */
export const scanBudget = (need: number): number =>
  Math.min(HARD_SCAN_CAP, Math.max(BASE_SCAN, need * OVERSCAN));

const clampLimit = (limit: unknown): number =>
  Math.min(Math.max(Math.trunc(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);

/** A candidate row as one keyset window returns it: upstream's own cursor for that row attached. */
export type CursoredRow<R> = R & { [CURSOR_KEY]: string };

/** What the PDP gate decided about one window (rows in walk order). `undecided` rows ran out of budget. */
export interface WindowVerdict {
  allowed: Set<string>;
  cost: number;
  undecided: Set<string>;
}

export interface AuthorizedKeysetPageOpts<R extends { id: string }> {
  /** How many rows a page holds: the caller's limit, clamped. Sizes the walk only — never echoed. */
  perPage: number;
  /**
   * The caller's RAW `pagination.limit`, echoed as `meta.limit` exactly as upstream's paginator echoes it. Never the
   * clamped `perPage`: the controller answers an unknown label name with `emptyCursorPaginationResult(limit)` using
   * the raw value, and the ValidationPipe admits a non-integer or null limit, so a clamped echo would tell a
   * hidden-only label (`limit: 1.5` → 1) from a label that does not exist (1.5).
   */
  metaLimit: number;
  cursor?: string;
  beforeCursor?: string;
  window: number;
  budget: number;
  /** One keyset window of CANDIDATE rows, in natural order, exactly as upstream's paginator returns it. */
  fetchWindow: (bounds: {
    perPage: number;
    cursor?: string;
    beforeCursor?: string;
  }) => Promise<{ items: CursoredRow<R>[]; meta: { hasNextPage: boolean } }>;
  /** The PDP gate: which of these rows the caller may see. `remaining` is the budget left for this window. */
  gate: (rows: CursoredRow<R>[], remaining: number) => Promise<WindowVerdict>;
  /** The walk stopped early (budget, or an undecided row): the page may be incomplete. Never silent. */
  onTruncated: (info: { budget: number; spent: number; collected: number; need: number }) => void;
}

/**
 * The filter-then-retrieve walk behind both native label lists, with upstream's `{ items, meta }` contract.
 *
 * It walks the candidate keyset stream in bounded windows (upstream's own paginator, so cursors keep upstream's
 * format), gates each window through the PDP, and stops once it holds `perPage + 1` AUTHORIZED rows, the stream
 * ends, or the scan budget is spent. The meta is then computed the way upstream computes it, but over the
 * authorized rows: `hasNextPage` means another AUTHORIZED row exists, and `nextCursor`/`prevCursor` only ever
 * encode an authorized row (a cursor is base64 of the row's sort keys, so one taken from a denied row would hand
 * the caller that row's name or id). The result is prefix-complete: the walk never skips a row the gate could not
 * decide (budget) to reach a later one — the page ends before it.
 *
 * Two deliberate differences from upstream, both about denied rows:
 *  - an EMPTY page is always the canonical empty result (`hasPrevPage: false`), even when a cursor was sent.
 *    The label controller answers an unknown label name with that canonical result, so a label whose pages are
 *    all hidden must be byte-identical to a label that does not exist (otherwise `hasPrevPage` would tell them
 *    apart).
 *  - when the budget is spent before `perPage + 1` rows are found, `hasNextPage` is false. The walk is not
 *    resumable past rows the caller cannot see (the cursor would have to encode one), and a "maybe more" answer
 *    would disclose that many hidden rows follow. The truncation is logged instead, as in PdpSearchService.
 *
 * `meta.limit` is always the caller's raw limit (`metaLimit`), as upstream — see that option.
 */
export async function authorizedKeysetPage<R extends { id: string }>(
  opts: AuthorizedKeysetPageOpts<R>,
): Promise<CursorPaginationResult<R>> {
  const need = opts.perPage + 1; // the peek row
  // Upstream's direction rule: a lone beforeCursor walks backwards (nearest row first) and returns natural order.
  const reversed = !!opts.beforeCursor && !opts.cursor;
  let cursor = opts.cursor;
  let beforeCursor = opts.beforeCursor;
  const out: CursoredRow<R>[] = [];
  const seen = new Set<string>(); // a concurrent update can shift a row across a window edge
  let spent = 0;
  let truncated = false;

  walk: while (out.length < need) {
    if (spent >= opts.budget) {
      truncated = true;
      break;
    }
    const win = await opts.fetchWindow({ perPage: opts.window, cursor, beforeCursor });
    if (win.items.length === 0) break;
    const rows = reversed ? [...win.items].reverse() : win.items;
    const verdict = await opts.gate(rows, opts.budget - spent);
    // Every window costs at least its row count, so the walk stays bounded even if a gate reports no cost.
    spent += Math.max(verdict.cost, rows.length);
    for (const row of rows) {
      if (out.length >= need) break walk; // rows past the peek do not matter, decided or not
      if (verdict.undecided.has(row.id)) {
        truncated = true;
        break walk;
      }
      if (verdict.allowed.has(row.id) && !seen.has(row.id)) {
        seen.add(row.id);
        out.push(row);
      }
    }
    if (!win.meta.hasNextPage) break;
    const edge = rows[rows.length - 1][CURSOR_KEY];
    if (reversed) beforeCursor = edge;
    else cursor = edge;
  }

  if (truncated) {
    opts.onTruncated({ budget: opts.budget, spent, collected: out.length, need });
  }

  const hasNextPage = out.length > opts.perPage;
  const kept = out.slice(0, opts.perPage);
  if (reversed) kept.reverse();
  if (kept.length === 0) return emptyCursorPaginationResult<R>(opts.metaLimit);

  const hasPrevPage = !!opts.cursor;
  return {
    items: kept.map(({ [CURSOR_KEY]: _cursor, ...row }) => row as unknown as R),
    meta: {
      limit: opts.metaLimit,
      hasNextPage,
      hasPrevPage,
      nextCursor: hasNextPage ? kept[kept.length - 1][CURSOR_KEY] : null,
      prevCursor: hasPrevPage ? kept[0][CURSOR_KEY] : null,
    },
  };
}

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * PDP-backed LabelRepo (#615): the native label lists are filter-then-retrieve. Upstream scopes them to SPACE
 * membership read from the local mirror — "per-page permission restrictions intentionally do not narrow this
 * further" — so `POST /api/labels` listed the name of every label attached to a restricted page in any space the
 * caller belongs to, and `POST /api/labels/pages` paginated BEFORE its post-filter (short pages; `hasNextPage`
 * and the cursors computed over rows the caller cannot see).
 *
 * Both overrides keep upstream's candidates and `{ items, meta }` shapes (the stock client keeps working), swap the
 * mirror subquery for the PDP-backed space set (`getUserSpaceIds` → lookup-resources), and gate every candidate
 * window through the PDP BEFORE pagination (`authorizedKeysetPage`):
 *  - `findLabels` (the vocabulary / label picker) lists a label only if at least one live page carrying it is
 *    PDP-viewable by the caller. A label window is usually decided with ONE lateral read and ONE PDP call; a
 *    label is only read deeper while none of its pages so far is viewable, up to a per-label cap.
 *  - `findPagesByLabelId` returns only viewable pages, and its meta is computed over them.
 *  - `getLabelPageCountForUser` (upstream's `/labels/info` usage count; the route is commented out upstream but
 *    the stock client already calls it) counts only viewable pages, so re-enabling it cannot leak.
 * Every other method is by-id, a write, or internal — its caller gates the page or label first (the surface is
 * pinned in pdp-label.repo.spec.ts, so an upstream bump that adds a user-scoped read goes red).
 *
 * `LabelService.findPagesByLabel` still post-filters our (already authorized) page through the PDP: a redundant
 * call that can only narrow, and it keeps our meta. The PDP is the authority; the space set only prunes
 * candidates. Selected by `labelRepoProvider` (authz/mode/repo-providers.ts, seam #1) — native mode keeps the
 * stock repo.
 *
 * NOTE (upstream-bump drift): the candidate queries mirror `LabelRepo` as of Docmost v0.95.0 (there is no
 * query-build seam to reuse). On an upstream bump re-check them against database/repos/label/label.repo.ts; the
 * PDP gate applies regardless. The pages sort compares `date_trunc('milliseconds', updated_at)`, not the raw
 * column: the cursor carries a millisecond Date, and this walk crosses a keyset edge every window, not only every
 * page, so a same-millisecond row after an edge would otherwise be skipped.
 */
@Injectable()
export class PdpLabelRepo extends LabelRepo {
  private readonly logger = new Logger(PdpLabelRepo.name);

  // The parent keeps its deps `private` — hold our own distinctly-named references.
  constructor(
    @InjectKysely() private readonly database: KyselyDB,
    private readonly spaceMembers: SpaceMemberRepo,
    private readonly pagePermissions: PagePermissionRepo,
  ) {
    super(database, spaceMembers);
  }

  override async findLabels(
    workspaceId: string,
    userId: string,
    type: LabelType,
    pagination: PaginationOptions,
  ) {
    const perPage = clampLimit(pagination.limit);
    const spaceIds = await this.spaceMembers.getUserSpaceIds(userId);

    let query = this.database
      .selectFrom('labels')
      .select(['id', 'name', 'type', 'createdAt', 'updatedAt', 'workspaceId'])
      .where('workspaceId', '=', workspaceId)
      .where('type', '=', type)
      .where(
        'id',
        'in',
        this.database
          .selectFrom('pageLabels')
          .innerJoin('pages', 'pages.id', 'pageLabels.pageId')
          .select('pageLabels.labelId')
          .where('pages.deletedAt', 'is', null)
          .where('pages.workspaceId', '=', workspaceId)
          .where(sql<boolean>`pages.space_id = any(${spaceIds}::uuid[])`),
      );

    if (pagination.query) {
      query = query.where('name', 'like', `%${pagination.query.toLowerCase()}%`);
    }

    type Row = InferResult<typeof query>[number];
    // The caller's raw limit, never the clamped perPage (see AuthorizedKeysetPageOpts.metaLimit).
    if (spaceIds.length === 0) return emptyCursorPaginationResult<Row>(pagination.limit);
    return authorizedKeysetPage<Row>({
      perPage,
      metaLimit: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      window: LABEL_WINDOW,
      budget: scanBudget(perPage + 1),
      fetchWindow: (b) =>
        executeWithCursorPagination(query, {
          perPage: b.perPage,
          cursor: b.cursor,
          beforeCursor: b.beforeCursor,
          cursorPerRow: CURSOR_KEY,
          fields: [
            { expression: 'name', direction: 'asc' },
            { expression: 'id', direction: 'asc' },
          ],
          parseCursor: (cursor) => ({
            name: cursor.name,
            id: cursor.id,
          }),
        }),
      gate: (rows, remaining) =>
        this.labelsOnViewablePages(
          rows.map((r) => r.id),
          { userId, workspaceId, spaceIds },
          remaining,
        ),
      onTruncated: (info) => this.warnTruncated('labels', userId, info),
    });
  }

  override async findPagesByLabelId(
    labelId: string,
    userId: string,
    opts: {
      spaceId?: string;
      query?: string;
      pagination: PaginationOptions;
    },
  ) {
    const perPage = clampLimit(opts.pagination.limit);
    // A caller-named space was already authorized by the controller (CASL, PDP-backed in remote mode), as upstream.
    const spaceIds = opts.spaceId ? [opts.spaceId] : await this.spaceMembers.getUserSpaceIds(userId);

    let query = this.database
      .selectFrom('pages')
      .innerJoin('pageLabels', 'pageLabels.pageId', 'pages.id')
      .select((eb) => [
        'pages.id',
        'pages.slugId',
        'pages.title',
        'pages.icon',
        'pages.spaceId',
        'pages.createdAt',
        'pages.updatedAt',
        jsonObjectFrom(
          eb
            .selectFrom('spaces')
            .select(['spaces.id', 'spaces.name', 'spaces.slug', 'spaces.logo'])
            .whereRef('spaces.id', '=', 'pages.spaceId'),
        ).as('space'),
        jsonObjectFrom(
          eb
            .selectFrom('users')
            .select(['users.id', 'users.name', 'users.avatarUrl'])
            .whereRef('users.id', '=', 'pages.creatorId'),
        ).as('creator'),
        jsonArrayFrom(
          eb
            .selectFrom('labels')
            .innerJoin('pageLabels as pl', 'pl.labelId', 'labels.id')
            .select(['labels.id', 'labels.name'])
            .whereRef('pl.pageId', '=', 'pages.id')
            .where('labels.type', '=', LabelType.PAGE)
            .orderBy('pl.id', 'asc'),
        ).as('labels'),
      ])
      .where('pageLabels.labelId', '=', labelId)
      .where('pages.deletedAt', 'is', null)
      .where(sql<boolean>`pages.space_id = any(${spaceIds}::uuid[])`);

    if (opts.query) {
      query = query.where('pages.title', 'ilike', `%${opts.query}%`);
    }

    type Row = InferResult<typeof query>[number];
    // The caller's raw limit, never the clamped perPage: this empty result must be byte-identical to the
    // controller's unknown-name answer, emptyCursorPaginationResult(pagination.limit) (AuthorizedKeysetPageOpts).
    if (spaceIds.length === 0) return emptyCursorPaginationResult<Row>(opts.pagination.limit);
    return authorizedKeysetPage<Row>({
      perPage,
      metaLimit: opts.pagination.limit,
      cursor: opts.pagination.cursor,
      beforeCursor: opts.pagination.beforeCursor,
      window: PAGE_WINDOW,
      budget: scanBudget(perPage + 1),
      fetchWindow: (b) =>
        executeWithCursorPagination(query, {
          perPage: b.perPage,
          cursor: b.cursor,
          beforeCursor: b.beforeCursor,
          cursorPerRow: CURSOR_KEY,
          fields: [
            {
              expression: sql<Date>`date_trunc('milliseconds', pages.updated_at)`,
              direction: 'desc',
              key: 'updatedAt',
            },
            { expression: 'pages.id', direction: 'desc', key: 'id' },
          ],
          parseCursor: (cursor) => ({
            updatedAt: new Date(cursor.updatedAt),
            id: cursor.id,
          }),
        }),
      gate: async (rows) => ({
        allowed: new Set(
          await this.pagePermissions.filterAccessiblePageIds({
            pageIds: rows.map((r) => r.id),
            userId,
            spaceId: opts.spaceId,
          }),
        ),
        cost: rows.length,
        undecided: new Set<string>(),
      }),
      onTruncated: (info) => this.warnTruncated('label pages', userId, info),
    });
  }

  override async getLabelPageCountForUser(
    labelId: string,
    userId: string,
    spaceId?: string,
  ): Promise<number> {
    const spaceIds = spaceId ? [spaceId] : await this.spaceMembers.getUserSpaceIds(userId);
    if (spaceIds.length === 0) return 0;

    let count = 0;
    let scanned = 0;
    let after = NIL_UUID;
    while (scanned < HARD_SCAN_CAP) {
      const res = await sql<{ id: string }>`
        select p.id
        from page_labels pl
        join pages p on p.id = pl.page_id
        where pl.label_id = ${labelId}
          and p.deleted_at is null
          and p.space_id = any(${spaceIds}::uuid[])
          and p.id > ${after}
        order by p.id
        limit ${PAGE_WINDOW}
      `.execute(this.database);
      if (res.rows.length === 0) return count;
      scanned += res.rows.length;
      const pageIds = res.rows.map((r) => r.id);
      count += (await this.pagePermissions.filterAccessiblePageIds({ pageIds, userId, spaceId }))
        .length;
      if (res.rows.length < PAGE_WINDOW) return count;
      after = pageIds[pageIds.length - 1];
    }
    this.logger.warn(
      `label usage count hit the candidate scan budget (${HARD_SCAN_CAP}) (userId=${userId}); ` +
        `the count is a lower bound over viewable pages`,
    );
    return count;
  }

  /**
   * Decide which labels have at least one live, PDP-viewable page. Each round reads the next candidate pages of
   * every undecided label (a lateral join, candidates as in `findLabels`; ≈ LABEL_ROUND_IDS pages split across
   * them) and asks the PDP about all of them at once. A label with a viewable page is listed; a label whose
   * candidates ran out, or that reached PER_LABEL_CAP hidden candidates, is not. Stops when every label is decided
   * or `remaining` is spent; the rest come back `undecided`.
   */
  private async labelsOnViewablePages(
    labelIds: string[],
    ctx: { userId: string; workspaceId: string; spaceIds: string[] },
    remaining: number,
  ): Promise<WindowVerdict> {
    const allowed = new Set<string>();
    // label → the last candidate page checked (keyset) and how many were checked
    const pending = new Map(labelIds.map((id) => [id, { after: NIL_UUID, checked: 0 }]));
    let capped = 0;
    let cost = 0;
    while (pending.size > 0 && cost < remaining) {
      const ids = [...pending.keys()];
      const afters = ids.map((id) => pending.get(id)!.after);
      const perLabel = Math.max(PAGES_PER_LABEL_ROUND, Math.floor(LABEL_ROUND_IDS / ids.length));
      const res = await sql<{ labelId: string; pageId: string }>`
        select l.label_id, c.page_id
        from unnest(${ids}::uuid[], ${afters}::uuid[]) as l(label_id, after_page_id)
        cross join lateral (
          select pl.page_id
          from page_labels pl
          join pages p on p.id = pl.page_id
          where pl.label_id = l.label_id
            and pl.page_id > l.after_page_id
            and p.deleted_at is null
            and p.workspace_id = ${ctx.workspaceId}
            and p.space_id = any(${ctx.spaceIds}::uuid[])
          order by pl.page_id
          limit ${perLabel}
        ) c
        order by l.label_id, c.page_id
      `.execute(this.database);
      cost += res.rows.length;

      const ok = new Set(
        await this.pagePermissions.filterAccessiblePageIds({
          pageIds: [...new Set(res.rows.map((r) => r.pageId))],
          userId: ctx.userId,
        }),
      );
      const pagesOf = new Map<string, string[]>();
      for (const r of res.rows) {
        const pages = pagesOf.get(r.labelId) ?? [];
        pages.push(r.pageId);
        pagesOf.set(r.labelId, pages);
      }
      for (const id of ids) {
        const pages = pagesOf.get(id) ?? [];
        const state = pending.get(id)!;
        state.checked += pages.length;
        if (pages.some((p) => ok.has(p))) {
          allowed.add(id);
          pending.delete(id);
        } else if (pages.length < perLabel) {
          pending.delete(id); // no candidate left: no viewable page carries it
        } else if (state.checked >= PER_LABEL_CAP) {
          pending.delete(id); // left out: a fail-closed omission, never a leak
          capped += 1;
        } else {
          state.after = pages[pages.length - 1];
        }
      }
    }
    if (capped > 0) {
      this.logger.warn(
        `label list left out ${capped} label(s) after ${PER_LABEL_CAP} hidden candidate pages each ` +
          `(userId=${ctx.userId}); a label whose first viewable page comes later is not listed`,
      );
    }
    return { allowed, cost, undecided: new Set(pending.keys()) };
  }

  private warnTruncated(
    what: string,
    userId: string,
    info: { budget: number; spent: number; collected: number; need: number },
  ): void {
    this.logger.warn(
      `filter-then-retrieve hit the candidate scan budget (${info.budget}, spent ${info.spent}) before ` +
        `collecting ${info.need} authorized ${what} (collected ${info.collected}, userId=${userId}); the ` +
        `result may be incomplete when the caller cannot see most candidates`,
    );
  }
}
