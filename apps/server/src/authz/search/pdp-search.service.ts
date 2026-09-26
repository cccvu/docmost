import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SearchService } from '../../core/search/search.service';
import { MAX_SEARCH_QUERY_LENGTH, SearchDTO, SearchSuggestionDTO } from '../../core/search/dto/search.dto';
import { SearchResponseDto } from '../../core/search/dto/search-response.dto';
import { normalizeLabelName } from '../../core/label/utils';
import { isIsoInstant } from '../../service-bridge/dto/sub-collection-page.dto';
import { HttpAuthzClient } from '../http-authz.client';

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
 * `limit/offset` are applied. It walks the rank-ordered FTS candidate stream in bounded windows,
 * passes each window through the same PDP gate (`filterAccessiblePageIds` → `POST /authz/filter-
 * resources`, bounded + ZedToken-fresh + decision-cached), and collects authorized rows in rank order
 * until it has `offset + limit + 1` of them (or the stream is exhausted, or the scan budget is hit —
 * which it logs; not silent server-side). Then it slices `[offset, offset+limit]` over the *authorized*
 * set; the one extra row is the `hasMore` peek of `searchAuthorized` (#615). No total-hit count or
 * unauthorized row's score is exposed (no count/score side-channel). A
 * bounded *timing* channel remains — the window count (DB+PDP round-trips) scales with how many
 * higher-ranked matches the caller cannot see, up to the scan budget — accepted as low-risk here (see
 * docs/adr/0005-permission-aware-retrieval.md); a higher-sensitivity RAG path should flatten it.
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

@Injectable()
export class PdpSearchService extends SearchService {
  private readonly logger = new Logger(PdpSearchService.name);

  /** Rows fetched per FTS round. ≤ the platform's 1000-item filter-resources cap. */
  private static readonly CANDIDATE_WINDOW = 128;
  /** Caller `limit` is clamped to this — a huge limit can't force an unbounded candidate scan. */
  private static readonly MAX_LIMIT = 100;
  /**
   * Candidate scan budget per request: it scales with `need` (= offset + limit) so an in-range page
   * always completes, but is floored + capped so the worst-case DB+PDP round-trips stay bounded
   * (round-trips = ceil(scanned / CANDIDATE_WINDOW)).
   */
  private static readonly BASE_SCAN = 1024;
  private static readonly HARD_SCAN_CAP = 2048;
  private static readonly OVERSCAN = 4;

  // The parent keeps its deps `private`, so we cannot reuse them from here — re-hold our own
  // distinctly-named references (and pass the params straight through to super).
  private readonly database: KyselyDB;
  private readonly pageRepository: PageRepo;
  private readonly spaceMemberRepository: SpaceMemberRepo;
  private readonly pagePermissionRepository: PagePermissionRepo;
  /** The PDP client for the SERVICE leg of an on-behalf-of search (#615). The user leg stays on the rebound
   *  repo above. Absent → a service-leg search refuses (503) rather than run with one leg. */
  private readonly serviceAuthz: Pick<HttpAuthzClient, 'filterResources'> | null;

  constructor(
    @InjectKysely() db: KyselyDB,
    pageRepo: PageRepo,
    shareRepo: ShareRepo,
    spaceMemberRepo: SpaceMemberRepo,
    pagePermissionRepo: PagePermissionRepo,
    serviceAuthz?: Pick<HttpAuthzClient, 'filterResources'>,
  ) {
    super(db, pageRepo, shareRepo, spaceMemberRepo, pagePermissionRepo);
    this.database = db;
    this.pageRepository = pageRepo;
    this.spaceMemberRepository = spaceMemberRepo;
    this.pagePermissionRepository = pagePermissionRepo;
    this.serviceAuthz = serviceAuthz ?? null;
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

    // Anonymous / public-share path: there is no principal, and retrieval is already gated by an
    // explicit page-id set (getPageAndDescendantsExcludingRestricted + the restricted-ancestor check).
    // Nothing for the per-principal PDP loop to add — defer to upstream unchanged.
    if (!opts.userId) {
      return super.searchPage(searchParams, opts);
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
    if (opts.serviceSubjectId && !this.serviceAuthz) {
      // Never run an on-behalf-of search on the user leg alone (that is wider than service ∩ user).
      throw new ServiceUnavailableException('service-principal search is not available');
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

    // Candidate generation (rank-ordered, id-tiebroken for deterministic windowing) — the coarse space
    // pre-filter (mirror subquery or the caller's spaceId) is a cheap net; the PDP gate below is
    // authoritative, so a stale mirror cannot leak (the fresh gate drops anything it wrongly admits).
    // The #615 filters are predicates HERE, ahead of the windows, so a filtered page fills from the filtered
    // stream (never an authorized page trimmed afterwards).
    const baseSelect = this.database
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
        sql<number>`ts_rank(tsv, to_tsquery('english', f_unaccent(${searchQuery})))`.as(
          'rank',
        ),
        sql<string>`ts_headline('english', text_content, to_tsquery('english', f_unaccent(${searchQuery})),'MinWords=9, MaxWords=10, MaxFragments=3')`.as(
          'highlight',
        ),
      ])
      .select((eb) => this.pageRepository.withSpace(eb))
      .where(
        'tsv',
        '@@',
        sql<string>`to_tsquery('english', f_unaccent(${searchQuery}))`,
      )
      .$if(Boolean(filters.creatorId), (qb) =>
        qb.where('creatorId', '=', filters.creatorId),
      )
      .$if(Boolean(filters.lastUpdatedById), (qb) =>
        qb.where('lastUpdatedById', '=', filters.lastUpdatedById),
      )
      .$if(Boolean(filters.parentPageId), (qb) =>
        qb.where('parentPageId', '=', filters.parentPageId),
      )
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
      .where('workspaceId', '=', opts.workspaceId)
      .orderBy('rank', 'desc')
      .orderBy('id', 'asc');

    const base = searchParams.spaceId
      ? baseSelect.where('spaceId', '=', searchParams.spaceId)
      : baseSelect.where(
          'spaceId',
          'in',
          this.spaceMemberRepository.getUserSpaceIdsQuery(opts.userId),
        );

    // Collect ONE past the page: that peek is `hasMore` (no count, no score crosses).
    const rows = await this.collectAuthorized(base, {
      userId: opts.userId,
      spaceId: searchParams.spaceId,
      serviceSubjectId: opts.serviceSubjectId,
      need: offset + limit + 1,
    });

    const items = rows.slice(offset, offset + limit).map((result: any) => {
      if (result.highlight) {
        result.highlight = result.highlight
          .replace(/\r\n|\r|\n/g, ' ')
          .replace(/\s+/g, ' ');
      }
      return result as SearchResponseDto;
    });

    // The peek alone decides: true only when an authorized row past the page was actually COLLECTED. A scan-budget
    // stop never turns into `true` (collectAuthorized logs it): the next page would usually get the same budget,
    // re-scan the same candidates and come back empty — a promise that cannot fill — and a budget-derived bit would
    // tell the caller that ~budget matches it cannot see exist (a count side-channel ADR 0005 rules out).
    const hasMore = rows.length > offset + limit;

    return { items, hasMore };
  }

  override async searchSuggestions(
    suggestion: SearchSuggestionDTO,
    userId: string,
    workspaceId: string,
  ) {
    let users = [];
    let groups = [];
    let pages = [];

    // Clamp (SearchSuggestionDTO.limit is upstream-owned + unvalidated).
    const limit = Math.min(
      Math.max(Math.trunc(Number(suggestion?.limit) || 10), 1),
      PdpSearchService.MAX_LIMIT,
    );
    const query = suggestion.query.toLowerCase().trim();

    if (suggestion.includeUsers) {
      users = await this.database
        .selectFrom('users')
        .select(['id', 'name', 'email', 'avatarUrl'])
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb(
              sql`LOWER(f_unaccent(users.name))`,
              'like',
              sql`LOWER(f_unaccent(${`%${query}%`}))`,
            ),
            eb(sql`users.email`, 'ilike', sql`f_unaccent(${`%${query}%`})`),
          ]),
        )
        .limit(limit)
        .execute();
    }

    if (suggestion.includeGroups) {
      groups = await this.database
        .selectFrom('groups')
        .select(['id', 'name', 'description'])
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(groups.name))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('workspaceId', '=', workspaceId)
        .limit(limit)
        .execute();
    }

    if (suggestion.includePages) {
      // The array form IS PDP-backed (lookupResources) — a coarse pre-filter; the gate below is
      // authoritative and truncation-complete, exactly as in searchPage.
      const userSpaceIds =
        await this.spaceMemberRepository.getUserSpaceIds(userId);

      if (userSpaceIds?.length > 0) {
        let base = this.database
          .selectFrom('pages')
          .select(['id', 'slugId', 'title', 'icon', 'spaceId'])
          .select((eb) => this.pageRepository.withSpace(eb))
          .where((eb) =>
            eb(
              sql`LOWER(f_unaccent(pages.title))`,
              'like',
              sql`LOWER(f_unaccent(${`%${query}%`}))`,
            ),
          )
          .where('deletedAt', 'is', null)
          .where('workspaceId', '=', workspaceId)
          .where('spaceId', 'in', userSpaceIds);

        if (suggestion?.spaceId) {
          base = base.orderBy(
            sql`CASE WHEN pages."space_id" = ${suggestion.spaceId} THEN 0 ELSE 1 END`,
            'asc',
          );
        }
        // Stable tiebreaker so bounded windowing pages deterministically over the candidate stream.
        base = base.orderBy('id', 'asc');

        const rows = await this.collectAuthorized(base, {
          userId,
          need: limit,
        });
        pages = rows.slice(0, limit);
      }
    }

    return { users, groups, pages };
  }

  /**
   * The one filter-then-retrieve gate. Walks the rank-ordered candidate query in bounded windows,
   * keeps only the PDP-authorized rows (in candidate order), and stops once `need` authorized rows are
   * collected, the stream is exhausted, or the scan ceiling is hit (logged — never a silent cap, but never reported
   * to the caller either: that bit would be a count side-channel). The caller slices its own
   * `[offset, offset+limit]` window over the returned rows.
   *
   * With `serviceSubjectId` (#615, on-behalf-of) each window is gated for the user AND for that service account:
   * a row is kept only when both may view it, so the collected set is service ∩ user and a row the service
   * account cannot see never takes a slot (the next authorized row fills it). The service leg only sees the
   * user-authorized ids of the window. Both legs fail closed (an error admits nothing).
   */
  private async collectAuthorized(
    base: any,
    opts: { userId: string; spaceId?: string; need: number; serviceSubjectId?: string },
  ): Promise<any[]> {
    // Scan budget scales with `need` (an in-range page completes) but is floored + capped (bounds
    // round-trips — including during a platform outage, where the gate denies every window).
    const budget = Math.min(
      PdpSearchService.HARD_SCAN_CAP,
      Math.max(PdpSearchService.BASE_SCAN, opts.need * PdpSearchService.OVERSCAN),
    );
    const authorized: any[] = [];
    const seen = new Set<string>(); // dedup across windows (a concurrent insert can shift a row)
    let cursor = 0;
    let scanned = 0;
    let exhausted = false;

    while (authorized.length < opts.need && scanned < budget) {
      const window: any[] = await base
        .limit(PdpSearchService.CANDIDATE_WINDOW)
        .offset(cursor)
        .execute();

      if (window.length === 0) {
        exhausted = true; // candidate stream exhausted
        break;
      }
      scanned += window.length;
      cursor += window.length;

      const userOk = new Set(
        await this.pagePermissionRepository.filterAccessiblePageIds({
          pageIds: window.map((r) => r.id),
          userId: opts.userId,
          spaceId: opts.spaceId,
        }),
      );
      const okIds = opts.serviceSubjectId
        ? await this.serviceLeg(
            opts.serviceSubjectId,
            window.filter((r) => userOk.has(r.id)).map((r) => r.id),
          )
        : userOk;
      for (const row of window) {
        if (okIds.has(row.id) && !seen.has(row.id)) {
          seen.add(row.id);
          authorized.push(row);
        }
      }

      if (window.length < PdpSearchService.CANDIDATE_WINDOW) {
        exhausted = true; // last (partial) window
        break;
      }
    }

    const truncated = authorized.length < opts.need && !exhausted;
    if (truncated) {
      this.logger.warn(
        `filter-then-retrieve hit the candidate scan budget (${budget}) before collecting ` +
          `${opts.need} authorized results (userId=${opts.userId}); the result set may be ` +
          `incomplete for a very deep page of a heavily-restricted space`,
      );
    }

    return authorized;
  }

  /** #615: the ids of `pageIds` the SERVICE ACCOUNT may view (fail-closed: an error yields none). */
  private async serviceLeg(serviceSubjectId: string, pageIds: string[]): Promise<Set<string>> {
    if (pageIds.length === 0) return new Set();
    return new Set(
      await this.serviceAuthz!.filterResources(
        { principalId: serviceSubjectId, subjectType: 'service' },
        'view',
        'page',
        pageIds,
      ),
    );
  }
}
