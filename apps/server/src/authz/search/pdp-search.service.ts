import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SearchService } from '../../core/search/search.service';
import { SearchDTO, SearchSuggestionDTO } from '../../core/search/dto/search.dto';
import { SearchResponseDto } from '../../core/search/dto/search-response.dto';

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
 * until it has `offset + limit` of them (or the stream is exhausted, or a hard scan ceiling is hit —
 * which it logs; no silent truncation). Then it slices `[offset, offset+limit]` over the *authorized*
 * set. No total-hit count is exposed, so there is no count/score side-channel.
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
@Injectable()
export class PdpSearchService extends SearchService {
  private readonly logger = new Logger(PdpSearchService.name);

  /** Rows fetched per FTS round. ≤ the platform's 1000-item filter-resources cap. */
  private static readonly CANDIDATE_WINDOW = 128;
  /** Hard ceiling on candidate rows scanned across all windows for one query (bounds worst-case cost). */
  private static readonly MAX_CANDIDATES = 1024;

  // The parent keeps its deps `private`, so we cannot reuse them from here — re-hold our own
  // distinctly-named references (and pass the params straight through to super).
  private readonly database: KyselyDB;
  private readonly pageRepository: PageRepo;
  private readonly spaceMemberRepository: SpaceMemberRepo;
  private readonly pagePermissionRepository: PagePermissionRepo;

  constructor(
    @InjectKysely() db: KyselyDB,
    pageRepo: PageRepo,
    shareRepo: ShareRepo,
    spaceMemberRepo: SpaceMemberRepo,
    pagePermissionRepo: PagePermissionRepo,
  ) {
    super(db, pageRepo, shareRepo, spaceMemberRepo, pagePermissionRepo);
    this.database = db;
    this.pageRepository = pageRepo;
    this.spaceMemberRepository = spaceMemberRepo;
    this.pagePermissionRepository = pagePermissionRepo;
  }

  override async searchPage(
    searchParams: SearchDTO,
    opts: { userId?: string; workspaceId: string },
  ): Promise<{ items: SearchResponseDto[] }> {
    const { query } = searchParams;
    if (!query || query.length < 1) {
      return { items: [] };
    }

    // Anonymous / public-share path: there is no principal, and retrieval is already gated by an
    // explicit page-id set (getPageAndDescendantsExcludingRestricted + the restricted-ancestor check).
    // Nothing for the per-principal PDP loop to add — defer to upstream unchanged.
    if (!opts.userId) {
      return super.searchPage(searchParams, opts);
    }

    const searchQuery = tsquery(query.trim() + '*');
    const limit = searchParams.limit || 25;
    const offset = searchParams.offset || 0;

    // Candidate generation (rank-ordered, id-tiebroken for deterministic windowing) — the coarse space
    // pre-filter (mirror subquery or the caller's spaceId) is a cheap net; the PDP gate below is
    // authoritative, so a stale mirror cannot leak (the fresh gate drops anything it wrongly admits).
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
      .$if(Boolean(searchParams.creatorId), (qb) =>
        qb.where('creatorId', '=', searchParams.creatorId),
      )
      .where('deletedAt', 'is', null)
      .orderBy('rank', 'desc')
      .orderBy('id', 'asc');

    const base = searchParams.spaceId
      ? baseSelect.where('spaceId', '=', searchParams.spaceId)
      : baseSelect
          .where(
            'spaceId',
            'in',
            this.spaceMemberRepository.getUserSpaceIdsQuery(opts.userId),
          )
          .where('workspaceId', '=', opts.workspaceId);

    const authorized = await this.collectAuthorized(base, {
      userId: opts.userId,
      spaceId: searchParams.spaceId,
      need: offset + limit,
    });

    const items = authorized.slice(offset, offset + limit).map((result: any) => {
      if (result.highlight) {
        result.highlight = result.highlight
          .replace(/\r\n|\r|\n/g, ' ')
          .replace(/\s+/g, ' ');
      }
      return result as SearchResponseDto;
    });

    return { items };
  }

  override async searchSuggestions(
    suggestion: SearchSuggestionDTO,
    userId: string,
    workspaceId: string,
  ) {
    let users = [];
    let groups = [];
    let pages = [];

    const limit = suggestion?.limit || 10;
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

        const authorized = await this.collectAuthorized(base, {
          userId,
          need: limit,
        });
        pages = authorized.slice(0, limit);
      }
    }

    return { users, groups, pages };
  }

  /**
   * The one filter-then-retrieve gate. Walks the rank-ordered candidate query in bounded windows,
   * keeps only the PDP-authorized rows (in candidate order), and stops once `need` authorized rows are
   * collected, the stream is exhausted, or the scan ceiling is hit (logged — never a silent cap). The
   * caller slices its own `[offset, offset+limit]` window over the returned authorized rows.
   */
  private async collectAuthorized(
    base: any,
    opts: { userId: string; spaceId?: string; need: number },
  ): Promise<any[]> {
    const authorized: any[] = [];
    let cursor = 0;
    let scanned = 0;

    while (
      authorized.length < opts.need &&
      scanned < PdpSearchService.MAX_CANDIDATES
    ) {
      const window: any[] = await base
        .limit(PdpSearchService.CANDIDATE_WINDOW)
        .offset(cursor)
        .execute();

      if (window.length === 0) break; // candidate stream exhausted
      scanned += window.length;
      cursor += window.length;

      const okIds = new Set(
        await this.pagePermissionRepository.filterAccessiblePageIds({
          pageIds: window.map((r) => r.id),
          userId: opts.userId,
          spaceId: opts.spaceId,
        }),
      );
      for (const row of window) {
        if (okIds.has(row.id)) authorized.push(row);
      }

      if (window.length < PdpSearchService.CANDIDATE_WINDOW) break; // last (partial) window
    }

    if (
      authorized.length < opts.need &&
      scanned >= PdpSearchService.MAX_CANDIDATES
    ) {
      this.logger.warn(
        `filter-then-retrieve hit the candidate scan cap (${PdpSearchService.MAX_CANDIDATES}) ` +
          `before collecting ${opts.need} authorized results (userId=${opts.userId}); ` +
          `the result set may be incomplete for a very deep page of a heavily-restricted space`,
      );
    }

    return authorized;
  }
}
