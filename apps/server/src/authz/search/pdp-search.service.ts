import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SearchService } from '../../core/search/search.service';
import type { ShareService } from '../../core/share/share.service';
import { MAX_SEARCH_QUERY_LENGTH, SearchDTO, SearchSuggestionDTO } from '../../core/search/dto/search.dto';
import { SearchResponseDto } from '../../core/search/dto/search-response.dto';
import { normalizeLabelName } from '../../core/label/utils';
import { isIsoInstant } from '../../service-bridge/dto/sub-collection-page.dto';
import { asEngineBusy, engineBusy } from '../../service-bridge/resource-version';
import type { AuthzSubject } from '../http-authz.client';
import { OpSemaphore, OpSemaphoreTimeout } from '../page-write/op-semaphore';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsquery = require('pg-tsquery')();

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Permission-aware search: **filter-then-retrieve** (architecture D9 / §8 / §9). Upstream
 * `SearchService` runs the FTS query with `LIMIT/OFFSET` and only THEN drops inaccessible pages via
 * `filterAccessiblePageIds` (the PDP-rebound repo). That is confidentiality-safe (a restricted page
 * never survives the post-filter) but it is *retrieve-then-filter*: the SQL limit is spent on rows the
 * caller may not see, so an authenticated search can under-return — worst case, return zero results
 * while accessible matches sit just past the truncated window (the `authorized-k-under-truncation`
 * gap), and OFFSET paging skips/duplicates.
 *
 * This subclass makes the guarantee **structural**: the authorized object set gates retrieval BEFORE
 * `limit/offset` are applied. One rank-ordered candidate statement reads at most `budget` narrow rows (id + rank —
 * no headline, no space, #696); `collectAuthorized` passes that list through the PDP gate (`POST /authz/filter-
 * resources`, the same decision `PdpPagePermissionRepo.filterAccessiblePageIds` makes) in bounded windows, in rank
 * order, until it has `offset + limit + 1` authorized ids (or the list is exhausted, or the scan budget is hit —
 * which it logs; not silent server-side). Then it slices `[offset, offset+limit]` over the *authorized* set; the one
 * extra row is the `hasMore` peek of `searchAuthorized` (#615). Only that final slice is HYDRATED — the response
 * columns, the space and the headline — so the expensive `ts_headline` runs over ≤ limit already-authorized pages,
 * never over a candidate the caller may not see. No total-hit count or unauthorized row's score is exposed (no
 * count/score side-channel). A bounded *timing* channel remains — the PDP round-trips scale with how many
 * higher-ranked matches the caller cannot see, up to the scan budget — accepted as low-risk here (see
 * docs/adr/0005-permission-aware-retrieval.md); a higher-sensitivity RAG path should flatten it.
 *
 * Search can no longer take the engine down (#696): every search has ONE deadline; each statement runs in its own
 * short transaction under `statement_timeout = min(3 s, what is left)` and no transaction is ever held across a PDP
 * call; authenticated searches share a small bulkhead (and one principal holds at most two places in it); the
 * anonymous share search has its own one-slot lane. Overload, a statement timeout or the deadline answer
 * 503 `engine_busy`; a PDP that cannot answer aborts the search with a 503 (never an empty "no results").
 *
 * The single `collectAuthorized` loop is the one filter-then-retrieve primitive — the RAG blueprint:
 * when a vector/`page_embeddings` similarity path lands, its candidate top-k MUST pass through the same
 * gate before truncation (see docs/adr/0005-permission-aware-retrieval.md). Bound to the `SearchService`
 * token in core/search/search.module.ts (seam #5, see UPSTREAM_MODIFICATIONS.md).
 *
 * NOTE (upstream-bump drift): the FTS query below mirrors `SearchService.searchPage` /
 * `searchSuggestions` as of Docmost v0.95.0. It is duplicated (there is no query-build seam to reuse),
 * so on an upstream bump re-check the SQL against core/search/search.service.ts. Drift can only cost
 * search feature-parity (e.g. a new ranking column) — the authorization gate is applied regardless.
 */
/**
 * #615: candidate filters for the service-bridge search. Every one is a predicate in the candidate SQL, so it
 * narrows the stream BEFORE the authorization windows (never a post-filter, which would under-fill a page and
 * make `hasMore` lie). Ids are Docmost ids (the platform translates identities before calling).
 */
export interface SearchCandidateFilters {
  creatorId?: string;
  lastUpdatedById?: string;
  parentPageId?: string;
  /** A page label of the searching workspace; normalized here as Docmost stores label names. */
  labelName?: string;
  /** updated-at range [since, until), ISO-8601 instants. */
  updatedSince?: string;
  updatedUntil?: string;
}

export interface SearchAuthorizedOpts {
  /** The searching user's Docmost id; every window is gated for this user. */
  userId: string;
  workspaceId: string;
  /**
   * An on-behalf-of credential's SERVICE-ACCOUNT principal id (a platform id, never a Docmost id). When set,
   * every window is ALSO gated for that service account, so the page and `hasMore` are service ∩ user.
   */
  serviceSubjectId?: string;
}

/** One authorized page of hits, plus whether at least one more authorized hit follows it (never a count). */
export interface AuthorizedSearchPage {
  items: SearchResponseDto[];
  hasMore: boolean;
}

/**
 * The PDP decision search gates through: of `candidateIds`, those `subject` holds `permission` on — or `null` when
 * the authorization service could not answer (transport error, timeout, non-2xx, malformed body). `null` is never a
 * deny: the search aborts with a 503 on it instead of scanning on (#696). `HttpAuthzClient` satisfies it.
 */
export interface SearchPdpClient {
  tryFilterResources(
    subject: AuthzSubject,
    permission: string,
    resourceType: string,
    candidateIds: string[],
  ): Promise<string[] | null>;
}

/** The bounds that keep search from taking the engine down (#696). */
export interface SearchLimits {
  /** One wall-clock deadline per search, from entry — under the platform's 8 s relay timeout. */
  deadlineMs: number;
  /** Per statement: `statement_timeout = min(this, what is left of the deadline)`. */
  statementTimeoutMs: number;
  /**
   * Below this much time left no statement starts (503): `SET statement_timeout = 0` would mean NO timeout, and a
   * statement with a few ms cannot finish anyway.
   */
  minStatementMs: number;
  /** Authenticated searches (and suggestions) in flight per process. */
  maxConcurrent: number;
  /** How long a search may wait for a slot (capped by its deadline). */
  slotWaitMs: number;
  /** Searches one principal may have in flight (waiting for a slot or running). */
  perPrincipal: number;
  /** The anonymous share-search lane: its own slots, never the authenticated ones. */
  shareLaneMax: number;
  shareMaxLimit: number;
  /** Rows the share search pulls past are headlined too (upstream SQL), so its offset is bounded. */
  shareMaxOffset: number;
  /** `ts_headline` input cap (chars): its cost grows with the text it is given. */
  headlineInputChars: number;
}

export const SEARCH_DEFAULT_MAX_CONCURRENT = 3;

/** `SEARCH_MAX_CONCURRENT`, defensively: anything but a positive integer is the default (never 0 = no search). */
export function searchMaxConcurrent(raw: string | undefined = process.env.SEARCH_MAX_CONCURRENT): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 64) : SEARCH_DEFAULT_MAX_CONCURRENT;
}

export function defaultSearchLimits(): SearchLimits {
  return {
    deadlineMs: 6000,
    statementTimeoutMs: 3000,
    minStatementMs: 50,
    maxConcurrent: searchMaxConcurrent(),
    slotWaitMs: 1500,
    perPrincipal: 2,
    shareLaneMax: 1,
    shareMaxLimit: 25,
    shareMaxOffset: 100,
    headlineInputChars: 65536,
  };
}

/** Why a search was shed (internal; answered as 503 `engine_busy`). */
class SearchShed extends Error {
  constructor(
    readonly reason: 'deadline' | 'slots' | 'principal' | 'share_lane',
    readonly stage: string,
  ) {
    super(`search shed: ${reason} at ${stage}`);
    this.name = 'SearchShed';
  }
}

/** The ordered candidate list: ids (and the rank the native response returns), never content. */
type Candidate = { id: string; rank?: number };

@Injectable()
export class PdpSearchService extends SearchService {
  private readonly logger = new Logger(PdpSearchService.name);

  /** Ids per PDP round. ≤ the platform's 1000-item filter-resources cap. */
  private static readonly CANDIDATE_WINDOW = 128;
  /** Caller `limit` is clamped to this — a huge limit can't force an unbounded candidate scan. */
  private static readonly MAX_LIMIT = 100;
  /**
   * Candidate scan budget per request: it scales with `need` (= offset + limit) so an in-range page
   * always completes, but is floored + capped so the worst-case candidate rows and PDP round-trips stay
   * bounded (round-trips = ceil(scanned / CANDIDATE_WINDOW)).
   */
  private static readonly BASE_SCAN = 1024;
  private static readonly HARD_SCAN_CAP = 2048;
  private static readonly OVERSCAN = 4;

  // The parent keeps its deps `private`, so we cannot reuse them from here — re-hold our own
  // distinctly-named references (and pass the params straight through to super).
  private readonly database: KyselyDB;
  private readonly pageRepository: PageRepo;
  private readonly spaceMemberRepository: SpaceMemberRepo;
  /** The PDP client for BOTH legs (the user, and the service account of an on-behalf-of search, #615). It is the
   *  decision `PdpPagePermissionRepo.filterAccessiblePageIds` makes, but it reports failure. Absent → every
   *  authenticated search refuses (503) rather than run ungated. */
  private readonly pdp: SearchPdpClient | null;
  private readonly shareRepository: ShareRepo;
  /** The public share-search gate (#660): sharing enabled and the space not archived. Absent → the anonymous
   *  share search answers empty (fail closed), never the upstream path that skips the check. */
  private readonly shareSharing: Pick<ShareService, 'isSharingAllowed'> | null;

  private readonly limits: SearchLimits;
  /** Authenticated searches and suggestions. */
  private readonly slots: OpSemaphore;
  /** The anonymous share search, apart: an outsider can never take a signed-in user's slot. */
  private readonly shareLane: OpSemaphore;
  /** Searches in flight per principal (waiting or running). */
  private readonly inFlight = new Map<string, number>();

  constructor(
    @InjectKysely() db: KyselyDB,
    pageRepo: PageRepo,
    shareRepo: ShareRepo,
    spaceMemberRepo: SpaceMemberRepo,
    pagePermissionRepo: PagePermissionRepo,
    pdp?: SearchPdpClient,
    shareSharing?: Pick<ShareService, 'isSharingAllowed'>,
    limits?: Partial<SearchLimits>,
  ) {
    super(db, pageRepo, shareRepo, spaceMemberRepo, pagePermissionRepo);
    this.shareRepository = shareRepo;
    this.shareSharing = shareSharing ?? null;
    this.database = db;
    this.pageRepository = pageRepo;
    this.spaceMemberRepository = spaceMemberRepo;
    this.pdp = pdp ?? null;
    this.limits = { ...defaultSearchLimits(), ...limits };
    this.slots = new OpSemaphore(this.limits.maxConcurrent, this.limits.slotWaitMs);
    this.shareLane = new OpSemaphore(this.limits.shareLaneMax, this.limits.slotWaitMs);
  }

  override async searchPage(
    searchParams: SearchDTO,
    opts: { userId?: string; workspaceId: string },
  ): Promise<{ items: SearchResponseDto[] }> {
    const { query } = searchParams;
    if (!query || query.length < 1) {
      return { items: [] };
    }

    // ReDoS guard (sweep F6): reject an over-long query HERE, ahead of the super() delegation below, so
    // this ONE fork-owned choke point covers BOTH the authenticated path (tsquery below) AND the @Public
    // /search/share-search path (which reaches the upstream tsquery via super.searchPage before any DB
    // lookup). Bounding length keeps pg-tsquery's O(N²) backtracking negligible. Defensive twin to the DTO
    // @MaxLength edge validation — same MAX_SEARCH_QUERY_LENGTH so the two bounds can never drift.
    if (query.length > MAX_SEARCH_QUERY_LENGTH) {
      throw new BadRequestException(`search query too long (max ${MAX_SEARCH_QUERY_LENGTH} characters)`);
    }

    if (!opts.userId) {
      return this.searchShare(searchParams, opts.workspaceId);
    }

    // The native route keeps its `{ items }` shape; the authorized page (and its one-row peek) is shared with the
    // service-bridge search, so both run the same gate over the same candidate SQL.
    const { items } = await this.searchAuthorized(
      searchParams,
      { creatorId: searchParams.creatorId },
      { userId: opts.userId, workspaceId: opts.workspaceId },
    );
    return { items };
  }

  /**
   * Anonymous / public-share path: there is no principal, and retrieval is already gated by an explicit page-id set
   * (getPageAndDescendantsExcludingRestricted + the restricted-ancestor check). Nothing for the per-principal PDP
   * loop to add. Upstream never asks whether the share is still public (sharing disabled for the workspace or space,
   * or the space archived), so that is decided here first, in this workspace (#660); then defer to upstream, whose
   * `findById` re-read is the repo's expiry veto.
   *
   * #696: it keeps upstream's SQL (which headlines every row it pulls, including the OFFSET rows), so it is bounded
   * here instead — its own one-slot lane (an outsider never takes a signed-in user's search slot), `limit` 1..25,
   * `offset` 0..100 (past that: nothing), and never a `spaceId` (upstream would search the whole space with it; the
   * controller strips it too). The upstream statement runs on the parent's own connection, so it has no
   * `statement_timeout`; the lane holds its slot until that statement ends, so it is never more than one connection.
   */
  private async searchShare(searchParams: SearchDTO, workspaceId: string): Promise<{ items: SearchResponseDto[] }> {
    const offset = Math.max(Math.trunc(Number(searchParams.offset) || 0), 0);
    if (offset > this.limits.shareMaxOffset) return { items: [] };
    const limit = Math.min(Math.max(Math.trunc(Number(searchParams.limit) || 25), 1), this.limits.shareMaxLimit);
    const params = { ...searchParams, spaceId: undefined, limit, offset } as SearchDTO;

    let release: () => void;
    try {
      release = await this.shareLane.acquire();
    } catch (err) {
      if (err instanceof OpSemaphoreTimeout) throw this.shed(new SearchShed('share_lane', 'admit'));
      throw err;
    }
    try {
      if (params.shareId) {
        const share = await this.shareRepository.findById(params.shareId);
        if (!share || !this.shareSharing || !(await this.shareSharing.isSharingAllowed(workspaceId, share.spaceId))) {
          return { items: [] };
        }
      }
      return await super.searchPage(params, { workspaceId });
    } finally {
      release();
    }
  }

  /**
   * One page of authorized hits for `userId` (and, when named, the service account too), plus `hasMore`.
   * `searchParams` supplies the query, the space and the paging; every other narrowing comes from `filters`, as a
   * candidate-SQL predicate. `hasMore` comes from collecting ONE authorized row past the page (a peek, never a
   * count), so it is true only when a further hit exists that the same principals may see.
   */
  async searchAuthorized(
    searchParams: SearchDTO,
    filters: SearchCandidateFilters,
    opts: SearchAuthorizedOpts,
  ): Promise<AuthorizedSearchPage> {
    const { query } = searchParams;
    if (!query || query.length < 1) {
      return { items: [], hasMore: false };
    }
    // Same bound as searchPage (this is also a direct entry point for the service bridge).
    if (query.length > MAX_SEARCH_QUERY_LENGTH) {
      throw new BadRequestException(`search query too long (max ${MAX_SEARCH_QUERY_LENGTH} characters)`);
    }
    // A principal is mandatory here: there is no anonymous branch on this path.
    if (!opts.userId) {
      throw new BadRequestException('search requires a user');
    }
    if (!this.pdp) {
      // Never run a search without its gate (and never an on-behalf-of search on one leg).
      throw new ServiceUnavailableException('search is not available');
    }
    for (const k of ['updatedSince', 'updatedUntil'] as const) {
      // A Date.parse-lenient but Postgres-invalid bound (bare '2026') must 400 here, not 500 at the cast.
      const v = filters[k];
      if (v !== undefined && v !== null && !isIsoInstant(v)) {
        throw new BadRequestException(`${k} must be an ISO-8601 timestamp`);
      }
    }

    const searchQuery = tsquery(query.trim() + '*');
    // Clamp pagination in the fork (SearchDTO is upstream-owned + unvalidated): a huge limit can't force
    // an unbounded scan, and a negative offset can't slice-from-end over the authorized set.
    const limit = Math.min(
      Math.max(Math.trunc(Number(searchParams.limit) || 25), 1),
      PdpSearchService.MAX_LIMIT,
    );
    const offset = Math.max(Math.trunc(Number(searchParams.offset) || 0), 0);
    const labelName = filters.labelName ? normalizeLabelName(filters.labelName) : '';
    const need = offset + limit + 1; // ONE past the page: that peek is `hasMore` (no count, no score crosses)
    const budget = PdpSearchService.budgetFor(need);

    // Candidate generation (rank-ordered, id-tiebroken so the list is deterministic) — the coarse space
    // pre-filter (mirror subquery or the caller's spaceId) is a cheap net; the PDP gate below is
    // authoritative, so a stale mirror cannot leak (the fresh gate drops anything it wrongly admits).
    // The #615 filters are predicates HERE, ahead of the gate, so a filtered page fills from the filtered
    // stream (never an authorized page trimmed afterwards). Narrow rows only: no headline, no space.
    const candidateSql = (db: KyselyDB | KyselyTransaction) => {
      const q = db
        .selectFrom('pages')
        .select([
          'id',
          sql<number>`ts_rank(tsv, to_tsquery('english', f_unaccent(${searchQuery})))`.as('rank'),
        ])
        .where('tsv', '@@', sql<string>`to_tsquery('english', f_unaccent(${searchQuery}))`)
        .$if(Boolean(filters.creatorId), (qb) => qb.where('creatorId', '=', filters.creatorId))
        .$if(Boolean(filters.lastUpdatedById), (qb) => qb.where('lastUpdatedById', '=', filters.lastUpdatedById))
        .$if(Boolean(filters.parentPageId), (qb) => qb.where('parentPageId', '=', filters.parentPageId))
        .$if(Boolean(labelName), (qb) =>
          // Only a PAGE label of THIS workspace; `labels` is unique on (workspace_id, type, name).
          qb.where(
            sql<boolean>`exists (
            select 1 from page_labels pl join labels l on l.id = pl.label_id
            where pl.page_id = pages.id and l.workspace_id = ${opts.workspaceId} and l.type = 'page'
              and l.name = ${labelName}
          )`,
          ),
        )
        .$if(Boolean(filters.updatedSince), (qb) =>
          qb.where('updatedAt', '>=', sql<Date>`${filters.updatedSince}::timestamptz`),
        )
        .$if(Boolean(filters.updatedUntil), (qb) =>
          qb.where('updatedAt', '<', sql<Date>`${filters.updatedUntil}::timestamptz`),
        )
        .where('deletedAt', 'is', null)
        .where('workspaceId', '=', opts.workspaceId);
      return (
        searchParams.spaceId
          ? q.where('spaceId', '=', searchParams.spaceId)
          : q.where('spaceId', 'in', this.spaceMemberRepository.getUserSpaceIdsQuery(opts.userId))
      )
        .orderBy('rank', 'desc')
        .orderBy('id', 'asc')
        .limit(budget);
    };

    return this.bounded('search', opts.userId, async (deadline) => {
      const candidates: Candidate[] = await this.statement(deadline, 'candidates', (trx) =>
        candidateSql(trx).execute(),
      );
      const authorized = await this.collectAuthorized(candidates, deadline, {
        userId: opts.userId,
        serviceSubjectId: opts.serviceSubjectId,
        need,
        budget,
      });

      const slice = authorized.slice(offset, offset + limit);
      const items = await this.hydrateSearch(slice, searchQuery, opts.workspaceId, deadline);

      // The peek alone decides: true only when an authorized row past the page was actually COLLECTED. A
      // scan-budget stop never turns into `true` (collectAuthorized logs it): the next page would usually get the
      // same budget, re-scan the same candidates and come back empty — a promise that cannot fill — and a
      // budget-derived bit would tell the caller that ~budget matches it cannot see exist (a count side-channel
      // ADR 0005 rules out). A page trashed between the gate and the hydrate drops out of `items` without moving it.
      const hasMore = authorized.length > offset + limit;
      return { items, hasMore };
    });
  }

  /**
   * The response rows for the final, already-authorized slice — and only for it: the native columns, the space and
   * the headline (over at most `headlineInputChars` of the text). Re-pinned to the workspace and to live pages, so a
   * page trashed after the gate never surfaces; returned in candidate order (SQL `in` has none), with the rank the
   * candidate statement computed (the order the caller sees is the order of that rank).
   */
  private async hydrateSearch(
    slice: Candidate[],
    searchQuery: string,
    workspaceId: string,
    deadline: number,
  ): Promise<SearchResponseDto[]> {
    if (slice.length === 0) return [];
    const rows: any[] = await this.statement(deadline, 'hydrate', (trx) =>
      trx
        .selectFrom('pages')
        .select([
          'id',
          'slugId',
          'title',
          'icon',
          'parentPageId',
          'creatorId',
          'createdAt',
          'updatedAt',
          sql<string>`ts_headline('english', left(text_content, ${sql.lit(this.limits.headlineInputChars)}), to_tsquery('english', f_unaccent(${searchQuery})),'MinWords=9, MaxWords=10, MaxFragments=3')`.as(
            'highlight',
          ),
        ])
        .select((eb) => this.pageRepository.withSpace(eb))
        .where(
          'id',
          'in',
          slice.map((c) => c.id),
        )
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .execute(),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items: SearchResponseDto[] = [];
    for (const c of slice) {
      const r = byId.get(c.id);
      if (!r) continue; // trashed or gone since the gate: dropped, never back-filled with an ungated row
      items.push({
        id: r.id,
        slugId: r.slugId,
        title: r.title,
        icon: r.icon,
        parentPageId: r.parentPageId,
        creatorId: r.creatorId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        rank: c.rank,
        highlight: r.highlight ? r.highlight.replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ') : r.highlight,
        space: r.space,
      } as SearchResponseDto);
    }
    return items;
  }

  override async searchSuggestions(
    suggestion: SearchSuggestionDTO,
    userId: string,
    workspaceId: string,
  ) {
    // Clamp (SearchSuggestionDTO.limit is upstream-owned + unvalidated).
    const limit = Math.min(
      Math.max(Math.trunc(Number(suggestion?.limit) || 10), 1),
      PdpSearchService.MAX_LIMIT,
    );
    const query = suggestion.query.toLowerCase().trim();
    if (suggestion.includePages && !this.pdp) {
      throw new ServiceUnavailableException('search is not available');
    }

    // The same class of DB cost as search (unindexed `like '%q%'` scans, on every keystroke of a mention), so the
    // same bounds: the bulkhead, the per-principal cap, one deadline, a timeout on every statement.
    return this.bounded('suggest', userId, async (deadline) => {
      let users = [];
      let groups = [];
      let pages = [];

      if (suggestion.includeUsers) {
        users = await this.statement(deadline, 'suggest-users', (trx) =>
          trx
            .selectFrom('users')
            .select(['id', 'name', 'email', 'avatarUrl'])
            .where('workspaceId', '=', workspaceId)
            .where('deletedAt', 'is', null)
            .where((eb) =>
              eb.or([
                eb(sql`LOWER(f_unaccent(users.name))`, 'like', sql`LOWER(f_unaccent(${`%${query}%`}))`),
                eb(sql`users.email`, 'ilike', sql`f_unaccent(${`%${query}%`})`),
              ]),
            )
            .limit(limit)
            .execute(),
        );
      }

      if (suggestion.includeGroups) {
        groups = await this.statement(deadline, 'suggest-groups', (trx) =>
          trx
            .selectFrom('groups')
            .select(['id', 'name', 'description'])
            .where((eb) =>
              eb(sql`LOWER(f_unaccent(groups.name))`, 'like', sql`LOWER(f_unaccent(${`%${query}%`}))`),
            )
            .where('workspaceId', '=', workspaceId)
            .limit(limit)
            .execute(),
        );
      }

      if (suggestion.includePages) {
        // The array form IS PDP-backed (lookupResources) — a coarse pre-filter; the gate below is
        // authoritative and truncation-complete, exactly as in searchPage.
        const userSpaceIds = await this.within(
          deadline,
          'suggest-spaces',
          this.spaceMemberRepository.getUserSpaceIds(userId),
        );

        if (userSpaceIds?.length > 0) {
          const need = limit;
          const budget = PdpSearchService.budgetFor(need);
          const candidates: Candidate[] = await this.statement(deadline, 'suggest-candidates', (trx) => {
            let base = trx
              .selectFrom('pages')
              .select(['id'])
              .where((eb) =>
                eb(sql`LOWER(f_unaccent(pages.title))`, 'like', sql`LOWER(f_unaccent(${`%${query}%`}))`),
              )
              .where('deletedAt', 'is', null)
              .where('workspaceId', '=', workspaceId)
              .where('spaceId', 'in', userSpaceIds);
            if (suggestion?.spaceId) {
              base = base.orderBy(sql`CASE WHEN pages."space_id" = ${suggestion.spaceId} THEN 0 ELSE 1 END`, 'asc');
            }
            // Stable tiebreaker so the candidate list is deterministic.
            return base.orderBy('id', 'asc').limit(budget).execute();
          });

          const authorized = await this.collectAuthorized(candidates, deadline, { userId, need, budget });
          pages = await this.hydrateSuggestions(authorized.slice(0, limit), workspaceId, deadline);
        }
      }

      return { users, groups, pages };
    });
  }

  /** The page suggestions' columns for the authorized slice only, live and in this workspace, in candidate order. */
  private async hydrateSuggestions(slice: Candidate[], workspaceId: string, deadline: number): Promise<any[]> {
    if (slice.length === 0) return [];
    const rows: any[] = await this.statement(deadline, 'suggest-hydrate', (trx) =>
      trx
        .selectFrom('pages')
        .select(['id', 'slugId', 'title', 'icon', 'spaceId'])
        .select((eb) => this.pageRepository.withSpace(eb))
        .where(
          'id',
          'in',
          slice.map((c) => c.id),
        )
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .execute(),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return slice.map((c) => byId.get(c.id)).filter((r) => r !== undefined);
  }

  /** Scan budget: scales with `need` (an in-range page completes) but is floored + capped. */
  private static budgetFor(need: number): number {
    return Math.min(
      PdpSearchService.HARD_SCAN_CAP,
      Math.max(PdpSearchService.BASE_SCAN, need * PdpSearchService.OVERSCAN),
    );
  }

  /**
   * The one filter-then-retrieve gate. Walks the rank-ordered candidate list (one statement, at most `budget` rows)
   * in bounded windows, keeps only the PDP-authorized ids (in candidate order), and stops once `need` authorized ids
   * are collected, the list is exhausted, or the scan ceiling is hit (logged — never a silent cap, but never reported
   * to the caller either: that bit would be a count side-channel). The caller slices its own `[offset, offset+limit]`
   * window over the returned ids.
   *
   * With `serviceSubjectId` (#615, on-behalf-of) each window is gated for the user AND for that service account:
   * an id is kept only when both may view it, so the collected set is service ∩ user and a row the service
   * account cannot see never takes a slot (the next authorized row fills it). The service leg only sees the
   * user-authorized ids of the window. A leg that cannot answer aborts the search (503) — never "nothing authorized"
   * followed by more windows (#696).
   */
  private async collectAuthorized(
    candidates: Candidate[],
    deadline: number,
    opts: { userId: string; need: number; budget: number; serviceSubjectId?: string },
  ): Promise<Candidate[]> {
    const authorized: Candidate[] = [];
    const seen = new Set<string>(); // an id is collected once, whatever the list holds
    let cursor = 0;

    while (authorized.length < opts.need && cursor < candidates.length) {
      const window = candidates.slice(cursor, cursor + PdpSearchService.CANDIDATE_WINDOW);
      cursor += window.length;

      const userOk = await this.gate(
        { provider: 'docmost', externalId: opts.userId },
        window.map((r) => r.id),
        deadline,
      );
      const okIds = opts.serviceSubjectId
        ? await this.gate(
            { principalId: opts.serviceSubjectId, subjectType: 'service' },
            window.filter((r) => userOk.has(r.id)).map((r) => r.id),
            deadline,
          )
        : userOk;
      for (const row of window) {
        if (okIds.has(row.id) && !seen.has(row.id)) {
          seen.add(row.id);
          authorized.push(row);
        }
      }
    }

    // The statement returned fewer than `budget` rows ⇒ that was every match; otherwise rows past the budget exist.
    const exhausted = candidates.length < opts.budget && cursor >= candidates.length;
    if (authorized.length < opts.need && !exhausted) {
      this.logger.warn(
        `filter-then-retrieve hit the candidate scan budget (${opts.budget}) before collecting ` +
          `${opts.need} authorized results (userId=${opts.userId}); the result set may be ` +
          `incomplete for a very deep page of a heavily-restricted space`,
      );
    }

    return authorized;
  }

  /** The ids of `pageIds` `subject` may view. The PDP not answering is a 503, never an empty set. */
  private async gate(subject: AuthzSubject, pageIds: string[], deadline: number): Promise<Set<string>> {
    if (pageIds.length === 0) return new Set();
    const ids = await this.within(deadline, 'pdp', this.pdp!.tryFilterResources(subject, 'view', 'page', pageIds));
    if (ids === null) {
      this.logger.warn('SEARCH_PDP_UNAVAILABLE: the authorization service did not answer; answered 503');
      throw new ServiceUnavailableException('authorization is temporarily unavailable; the search did not run — retry');
    }
    return new Set(ids);
  }

  /**
   * Admission for an authenticated search: the per-principal cap (refused at once — a principal never queues behind
   * itself), then a bulkhead slot (a bounded wait, capped by the deadline). The deadline starts here, so time spent
   * waiting counts. A shed, an expired deadline or a busy SQLSTATE is a 503 `engine_busy`; anything else passes.
   */
  private async bounded<T>(kind: string, userId: string, fn: (deadline: number) => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.limits.deadlineMs;
    const key = `user:${userId}`;
    const held = this.inFlight.get(key) ?? 0;
    if (held >= this.limits.perPrincipal) throw this.shed(new SearchShed('principal', kind));
    this.inFlight.set(key, held + 1);
    try {
      let release: () => void;
      try {
        release = await this.slots.acquire(Math.max(0, Math.min(this.limits.slotWaitMs, deadline - Date.now())));
      } catch (err) {
        if (err instanceof OpSemaphoreTimeout) throw new SearchShed('slots', kind);
        throw err;
      }
      try {
        return await fn(deadline);
      } finally {
        release();
      }
    } catch (err) {
      if (err instanceof SearchShed) throw this.shed(err);
      const busy = asEngineBusy(err);
      if (busy) {
        this.logger.warn(`SEARCH_SHED reason=sqlstate code=${(err as { code?: string }).code} kind=${kind}: answered 503 engine_busy`);
        throw busy;
      }
      throw err;
    } finally {
      const n = (this.inFlight.get(key) ?? 1) - 1;
      if (n > 0) this.inFlight.set(key, n);
      else this.inFlight.delete(key);
    }
  }

  private shed(err: SearchShed): ServiceUnavailableException {
    this.logger.warn(`SEARCH_SHED reason=${err.reason} stage=${err.stage}: answered 503 engine_busy`);
    return engineBusy();
  }

  /**
   * One statement in its own short transaction, under `statement_timeout = min(statementTimeoutMs, what is left)`,
   * decided AFTER the connection is acquired (a pool wait counts). Never a transaction across a PDP call. The caller
   * also stops waiting at the deadline: an abandoned statement then finds no time left and rolls back at once.
   */
  private statement<T>(deadline: number, stage: string, run: (trx: KyselyTransaction) => Promise<T>): Promise<T> {
    return this.within(
      deadline,
      stage,
      executeTx(this.database, async (trx) => {
        const ms = Math.min(this.limits.statementTimeoutMs, deadline - Date.now());
        if (ms < this.limits.minStatementMs) throw new SearchShed('deadline', stage);
        await sql`SET LOCAL statement_timeout = ${sql.lit(Math.floor(ms))}`.execute(trx);
        return run(trx);
      }),
    );
  }

  /** `p`, unless the deadline passes first (then a shed; `p` settles unobserved). */
  private within<T>(deadline: number, stage: string, p: Promise<T>): Promise<T> {
    p.catch(() => undefined); // an abandoned step never becomes an unhandled rejection
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(new SearchShed('deadline', stage));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SearchShed('deadline', stage)), left);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    return Promise.race([p, expiry]).finally(() => clearTimeout(timer));
  }
}
