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
 * call; authenticated searches share a small bulkhead (one principal runs at most `perPrincipal` searches and
 * `perPrincipal` suggestions in it; more of its own wait their turn); the anonymous share search has its own one-slot
 * lane. Overload, a statement timeout or the deadline answer 503 `engine_busy`; a PDP that cannot answer aborts the
 * search with a 503 (never an empty "no results").
 *
 * Search sheds only searches (#716): every authorization call search makes (the user leg, the service leg of an
 * on-behalf-of search, the suggestions' space lookup) goes through ONE process-wide PDP lane, and a slot is held until
 * that call SETTLES — not until the search gives up on it — so a search burst puts at most about lane × window checks
 * on the PDP, however many searches it abandons. A full lane sheds the search (503 `engine_busy`), never the point
 * decisions and lists that share the PDP with it. The first window is sized from what the page needs, doubling after.
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
  /** How long a search may wait for admission in all — its principal's turn, then a slot (capped by its deadline). */
  slotWaitMs: number;
  /**
   * Searches one principal may have admitted per kind (search / suggest), waiting for a slot or running
   * (`SEARCH_MAX_PER_PRINCIPAL`). Its further ones wait their turn in arrival order within `slotWaitMs`, never
   * refused at once (#716: a debounced keystroke must not 503 behind the user's own previous search).
   */
  perPrincipal: number;
  /**
   * #716 review: how long a SEARCH (not a suggestion) may wait for its own principal's previous search, within its
   * deadline. Longer than `slotWaitMs` so an agent's parallel searches run one after another instead of the second
   * being shed 503 after 1.5 s (before #716 both ran at once); a suggestion keeps `slotWaitMs`, because a stale
   * keystroke's answer is worth less the longer it waits. The bulkhead slot wait after it is still `slotWaitMs`.
   */
  searchTurnWaitMs: number;
  /**
   * The search PDP lane (#716, `SEARCH_PDP_LANE`): authorization calls search may have in flight per process. A slot
   * is held until the call settles (≤ the client's `PLATFORM_AUTHZ_TIMEOUT_MS`), so abandoned calls stay counted.
   * Per process: with N engine tasks the bound is N × this. Default 1 with 32-id windows (#716 A2 load run): at 2 / 64
   * the search lane's SpiceDB LookupResources load still pushed other routes' PDP calls past their deadline (503).
   */
  pdpLaneMax: number;
  /** How long one authorization call may wait for a lane slot (also capped by the deadline less `pdpMinMs`). */
  pdpLaneWaitMs: number;
  /** No authorization call starts with less than this left of the deadline: it would mostly be abandoned. */
  pdpMinMs: number;
  /** The smallest first window (ids per PDP call). */
  pdpWindowMin: number;
  /** The largest window (`SEARCH_PDP_WINDOW_MAX`); ≤ the platform's 1000-id filter-resources cap. */
  pdpWindowMax: number;
  /** The anonymous share-search lane: its own slots, never the authenticated ones. */
  shareLaneMax: number;
  shareMaxLimit: number;
  /** Rows the share search pulls past are headlined too (upstream SQL), so its offset is bounded. */
  shareMaxOffset: number;
  /** `ts_headline` input cap (chars): its cost grows with the text it is given. */
  headlineInputChars: number;
}

export const SEARCH_DEFAULT_MAX_CONCURRENT = 3;
export const SEARCH_DEFAULT_PDP_LANE = 1;
export const SEARCH_DEFAULT_PDP_WINDOW_MAX = 32;
export const SEARCH_DEFAULT_MAX_PER_PRINCIPAL = 1;

/**
 * An integer env knob, defensively: anything but an integer ≥ `min` is the default (never 0 = no search, never a
 * window that cannot move); above `max` is `max`.
 */
function intKnob(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? Math.min(n, max) : fallback;
}

/** `SEARCH_MAX_CONCURRENT`: 1..64, default 3. */
export function searchMaxConcurrent(raw: string | undefined = process.env.SEARCH_MAX_CONCURRENT): number {
  return intKnob(raw, SEARCH_DEFAULT_MAX_CONCURRENT, 1, 64);
}

/** `SEARCH_PDP_LANE`: 1..16, default 1 (#716 load evidence: ADR 0005 amendment). */
export function searchPdpLane(raw: string | undefined = process.env.SEARCH_PDP_LANE): number {
  return intKnob(raw, SEARCH_DEFAULT_PDP_LANE, 1, 16);
}

/** `SEARCH_PDP_WINDOW_MAX`: 16..128, default 32 (#716 load evidence: ADR 0005 amendment). */
export function searchPdpWindowMax(raw: string | undefined = process.env.SEARCH_PDP_WINDOW_MAX): number {
  return intKnob(raw, SEARCH_DEFAULT_PDP_WINDOW_MAX, 16, 128);
}

/** `SEARCH_MAX_PER_PRINCIPAL`: 1..64, default 1. */
export function searchMaxPerPrincipal(raw: string | undefined = process.env.SEARCH_MAX_PER_PRINCIPAL): number {
  return intKnob(raw, SEARCH_DEFAULT_MAX_PER_PRINCIPAL, 1, 64);
}

export function defaultSearchLimits(): SearchLimits {
  return {
    deadlineMs: 6000,
    statementTimeoutMs: 3000,
    minStatementMs: 50,
    maxConcurrent: searchMaxConcurrent(),
    slotWaitMs: 1500,
    perPrincipal: searchMaxPerPrincipal(),
    searchTurnWaitMs: 4000,
    pdpLaneMax: searchPdpLane(),
    pdpLaneWaitMs: 1500,
    pdpMinMs: 500,
    pdpWindowMin: 32,
    pdpWindowMax: searchPdpWindowMax(),
    shareLaneMax: 1,
    shareMaxLimit: 25,
    shareMaxOffset: 100,
    headlineInputChars: 65536,
  };
}

/** Why a search was shed (internal; answered as 503 `engine_busy`). */
class SearchShed extends Error {
  constructor(
    readonly reason: 'deadline' | 'slots' | 'principal' | 'share_lane' | 'pdp_lane',
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

  /** Caller `limit` is clamped to this — a huge limit can't force an unbounded candidate scan. */
  private static readonly MAX_LIMIT = 100;
  /**
   * Candidate scan budget per request: it scales with `need` (= offset + limit) so an in-range page
   * always completes, but is floored + capped so the worst-case candidate rows and PDP round-trips stay
   * bounded (round-trips ≈ scanned / `pdpWindowMax`, plus the smaller first windows).
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
  /**
   * Each principal's places per kind (`<kind>:user:<id>`): a semaphore of `perPrincipal` (its waiters are served in
   * arrival order) and how many searches hold or await it. A key is dropped when nobody does, so the map stays the
   * size of the principals searching now.
   */
  private readonly inFlight = new Map<string, { places: OpSemaphore; refs: number }>();
  /** The process-wide search PDP lane (#716): one instance per process (search.provider.ts builds one service). */
  private readonly pdpLane: OpSemaphore;

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
    this.pdpLane = new OpSemaphore(this.limits.pdpLaneMax, this.limits.pdpLaneWaitMs);
  }

  override async searchPage(
    searchParams: SearchDTO,
    opts: { userId?: string; workspaceId: string },
  ): Promise<{ items: SearchResponseDto[] }> {
    const { query } = searchParams;
    if (!query || query.length < 1) {
      return { items: [] };
    }

    // ReDoS guard (sweep F6): reject an over-long query HERE, ahead of the share branch below, so
    // this ONE fork-owned choke point covers BOTH the authenticated path (tsquery below) AND the @Public
    // /search/share-search path (whose tsquery runs in runShare). Bounding length keeps pg-tsquery's O(N²) backtracking negligible. Defensive twin to the DTO
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
   * (the share's subtree minus restricted pages, and the restricted-ancestor check). Nothing for the per-principal PDP
   * loop to add. Upstream never asks whether the share is still public (sharing disabled for the workspace or space,
   * or the space archived), so that is decided here first, in this workspace (#660), after `findById` (the repo's
   * expiry veto).
   *
   * #696: bounded like the authenticated search — its own one-slot lane (an outsider never takes a signed-in user's
   * search slot), `limit` 1..25, `offset` 0..100 (past that: nothing), and never a `spaceId` (upstream would search the
   * whole space with it; the controller strips it too).
   *
   * #716: one deadline, and every statement under `SET LOCAL statement_timeout` (see `runShare`). The lane slot is
   * released only when the work SETTLES, not when the deadline answers: an abandoned statement still holds its
   * connection until its own timeout ends it, so an outsider can never stack more than `shareLaneMax` of them.
   */
  private async searchShare(searchParams: SearchDTO, workspaceId: string): Promise<{ items: SearchResponseDto[] }> {
    const offset = Math.max(Math.trunc(Number(searchParams.offset) || 0), 0);
    if (offset > this.limits.shareMaxOffset) return { items: [] };
    const limit = Math.min(Math.max(Math.trunc(Number(searchParams.limit) || 25), 1), this.limits.shareMaxLimit);
    // Upstream: an anonymous search that names no share finds nothing (the spaceId it would otherwise honor is never
    // passed on here).
    if (!searchParams.shareId) return { items: [] };

    const deadline = Date.now() + this.limits.deadlineMs;
    let release: () => void;
    try {
      release = await this.shareLane.acquire(Math.max(0, Math.min(this.limits.slotWaitMs, deadline - Date.now())));
    } catch (err) {
      if (err instanceof OpSemaphoreTimeout) throw this.shed(new SearchShed('share_lane', 'admit'), 'share', 'anonymous');
      throw err;
    }
    let work: Promise<{ items: SearchResponseDto[] }>;
    try {
      work = this.runShare(searchParams.query, searchParams.shareId, searchParams.creatorId, workspaceId, {
        limit,
        offset,
        deadline,
      });
    } catch (err) {
      release();
      throw err;
    }
    work.then(release, release);
    try {
      return await this.within(deadline, 'share', work);
    } catch (err) {
      if (err instanceof SearchShed) throw this.shed(err, 'share', 'anonymous');
      const busy = asEngineBusy(err);
      if (busy) {
        this.logger.warn(
          `SEARCH_SHED reason=sqlstate code=${(err as { code?: string }).code} kind=share principal=anonymous: answered 503 engine_busy`,
        );
        throw busy;
      }
      throw err;
    }
  }

  /**
   * The share search itself, mirroring upstream `SearchService.searchPage`'s share branch (v0.95.0). Its three heavy
   * statements (the restricted-ancestor read, the descendant walk and the full-text query) each run in their own short
   * transaction under `statement_timeout` (#716). The share lookup and the sharing check before them are indexed point
   * reads through the injected repos, outside that bound. The two confidentiality reads are upstream's OWN
   * methods (`hasRestrictedAncestor`, `getPageAndDescendantsExcludingRestricted`), run on that transaction through
   * repos built over it — so the restriction semantics are never copied and cannot drift. Both read only `this.db`
   * (pinned by pdp-search.service.spec.ts); should either start using another dependency, it would throw here
   * (fail closed — no results), never run unbounded. Only the full-text statement is the fork's: upstream's, with
   * the headline over at most `headlineInputChars` and no space in the row (upstream selects none for a share).
   *
   * Never wrapped in `within()`: the caller races it against the deadline and holds the lane until it settles.
   */
  private async runShare(
    query: string,
    shareId: string,
    creatorId: string | undefined,
    workspaceId: string,
    o: { limit: number; offset: number; deadline: number },
  ): Promise<{ items: SearchResponseDto[] }> {
    const share = await this.shareRepository.findById(shareId);
    if (!share || share.workspaceId !== workspaceId) return { items: [] };
    if (!this.shareSharing || !(await this.shareSharing.isSharingAllowed(workspaceId, share.spaceId))) {
      return { items: [] };
    }

    const restricted = await this.txStatement(o.deadline, 'share-ancestor', (trx) =>
      new PagePermissionRepo(trx, null as never, null as never).hasRestrictedAncestor(share.pageId),
    );
    if (restricted) return { items: [] };

    const pageIds = share.includeSubPages
      ? (
          await this.txStatement(o.deadline, 'share-subtree', (trx) =>
            new PageRepo(trx, null as never, null as never).getPageAndDescendantsExcludingRestricted(share.pageId, {
              includeContent: false,
            }),
          )
        ).map((p) => p.id)
      : [share.pageId];
    if (pageIds.length === 0) return { items: [] };

    const searchQuery = tsquery(query.trim() + '*');
    const rows: any[] = await this.txStatement(o.deadline, 'share-search', (trx) =>
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
          sql<number>`ts_rank(tsv, to_tsquery('english', f_unaccent(${searchQuery})))`.as('rank'),
          sql<string>`ts_headline('english', left(text_content, ${sql.lit(this.limits.headlineInputChars)}), to_tsquery('english', f_unaccent(${searchQuery})),'MinWords=9, MaxWords=10, MaxFragments=3')`.as(
            'highlight',
          ),
        ])
        .where('tsv', '@@', sql<string>`to_tsquery('english', f_unaccent(${searchQuery}))`)
        .$if(Boolean(creatorId), (qb) => qb.where('creatorId', '=', creatorId))
        .where('deletedAt', 'is', null)
        .where('id', 'in', pageIds)
        .where('workspaceId', '=', workspaceId)
        // Upstream orders by rank alone; the id tiebreak only makes equal-rank paging deterministic.
        .orderBy('rank', 'desc')
        .orderBy('id', 'asc')
        .limit(o.limit)
        .offset(o.offset)
        .execute(),
    );
    const items = rows.map((r) => ({
      ...r,
      highlight: r.highlight ? r.highlight.replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ') : r.highlight,
    })) as SearchResponseDto[];
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

      // wiki-v2 #797: in remote mode group names are part of the workspace directory, which is not shown to wiki
      // users; only a caller who administers the workspace or a space (and so may grant a space to a group) gets them.
      if (suggestion.includeGroups && (await this.mayListGroups(userId, workspaceId, deadline))) {
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
        // authoritative and truncation-complete, exactly as in searchPage. It is an authorization call too, so it
        // takes the PDP lane (#716); kept over the local mirror, which would drop the spaces a role binding or the
        // admin cascade grants. A PDP that cannot answer throws its own 503 here — never "no spaces".
        const userSpaceIds = await this.inPdpLane(deadline, 'suggest-spaces', () =>
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
    // #716: the first window is sized from the page (twice what it needs, at least pdpWindowMin), then doubles up to
    // pdpWindowMax — a 10-result page asks about 32 ids, not 128. At the defaults (min = max = 32) every window is 32
    // ids. The scan budget is unchanged.
    const windowMax = Math.max(1, this.limits.pdpWindowMax);
    let size = Math.min(windowMax, Math.max(this.limits.pdpWindowMin, 2 * opts.need, 1));

    while (authorized.length < opts.need && cursor < candidates.length) {
      const window = candidates.slice(cursor, cursor + size);
      cursor += window.length;
      size = Math.min(size * 2, windowMax);

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

  /**
   * wiki-v2 #797: may this caller see group names in suggestions? Yes only with `workspace#admin_cascade`, or
   * `space#administer` on at least one space of the workspace (archived ones included: a direct admin keeps it there).
   * Decided by the PDP in the search lane; a PDP that cannot answer is a 503, never a silent "no groups" (a deny-shaped
   * answer the client would cache as "there are none"). No PDP client → no groups (fail closed).
   */
  private async mayListGroups(userId: string, workspaceId: string, deadline: number): Promise<boolean> {
    if (!this.pdp) return false;
    const subject: AuthzSubject = { provider: 'docmost', externalId: userId };
    const unavailable = () => {
      this.logger.warn('SEARCH_PDP_UNAVAILABLE: the authorization service did not answer (group suggestions); answered 503');
      return new ServiceUnavailableException('authorization is temporarily unavailable; retry');
    };
    const admin = await this.inPdpLane(deadline, 'suggest-groups-admin', () =>
      this.pdp!.tryFilterResources(subject, 'admin_cascade', 'workspace', [workspaceId]),
    );
    if (admin === null) throw unavailable();
    if (admin.includes(workspaceId)) return true;
    const spaces: Array<{ id: string }> = await this.statement(deadline, 'suggest-groups-spaces', (trx) =>
      trx.selectFrom('spaces').select(['id']).where('workspaceId', '=', workspaceId).execute(),
    );
    if (spaces.length === 0) return false;
    const administered = await this.inPdpLane(deadline, 'suggest-groups-spaces', () =>
      this.pdp!.tryFilterResources(
        subject,
        'administer',
        'space',
        spaces.map((r) => r.id),
      ),
    );
    if (administered === null) throw unavailable();
    return administered.length > 0;
  }

  /** The ids of `pageIds` `subject` may view. The PDP not answering is a 503, never an empty set. */
  private async gate(subject: AuthzSubject, pageIds: string[], deadline: number): Promise<Set<string>> {
    if (pageIds.length === 0) return new Set();
    const ids = await this.inPdpLane(deadline, 'pdp', () =>
      this.pdp!.tryFilterResources(subject, 'view', 'page', pageIds),
    );
    if (ids === null) {
      this.logger.warn('SEARCH_PDP_UNAVAILABLE: the authorization service did not answer; answered 503');
      throw new ServiceUnavailableException('authorization is temporarily unavailable; the search did not run — retry');
    }
    return new Set(ids);
  }

  /**
   * One authorization call in the search PDP lane (#716). No call starts with less than `pdpMinMs` of the deadline
   * left; the wait for a slot is capped by `pdpLaneWaitMs` and by the deadline less `pdpMinMs`, and running out is a
   * shed (`pdp_lane`, 503 `engine_busy`) — only this search, never the point decisions sharing the PDP. The slot is
   * released when the call SETTLES, not when the deadline gives up on it, so abandoned calls stay inside the bound
   * (the HTTP client times every call out, so a slot is never held for long). No abort is passed down: the platform
   * would keep running a window's checks anyway, and freeing the slot early is exactly what would let them escape.
   */
  private async inPdpLane<T>(deadline: number, stage: string, call: () => Promise<T>): Promise<T> {
    const left = deadline - Date.now();
    if (left < this.limits.pdpMinMs) throw new SearchShed('deadline', stage);
    let release: () => void;
    try {
      release = await this.pdpLane.acquire(
        Math.max(0, Math.min(this.limits.pdpLaneWaitMs, left - this.limits.pdpMinMs)),
      );
    } catch (err) {
      if (err instanceof OpSemaphoreTimeout) throw new SearchShed('pdp_lane', stage);
      throw err;
    }
    let p: Promise<T>;
    try {
      p = call();
    } catch (err) {
      release();
      throw err;
    }
    p.then(release, release);
    return this.within(deadline, stage, p);
  }

  /**
   * Admission for an authenticated search: its principal's turn for this kind (`perPrincipal` at a time; the rest
   * wait in arrival order, a search up to `searchTurnWaitMs`, a suggestion up to `slotWaitMs`), then a bulkhead slot
   * (up to `slotWaitMs` more). Every wait is capped by the deadline, which starts here, so time spent waiting counts. A shed, an expired deadline or a busy SQLSTATE is a 503
   * `engine_busy`; anything else passes.
   */
  private async bounded<T>(
    kind: 'search' | 'suggest',
    userId: string,
    fn: (deadline: number) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + this.limits.deadlineMs;
    const turnWaitMs = kind === 'search' ? Math.max(this.limits.searchTurnWaitMs, this.limits.slotWaitMs) : this.limits.slotWaitMs;
    const turnBy = Math.min(Date.now() + turnWaitMs, deadline);
    const key = `${kind}:user:${userId}`;
    let entry = this.inFlight.get(key);
    if (!entry) {
      entry = { places: new OpSemaphore(Math.max(1, this.limits.perPrincipal), this.limits.slotWaitMs), refs: 0 };
      this.inFlight.set(key, entry);
    }
    entry.refs++;
    try {
      let releasePlace: () => void;
      try {
        releasePlace = await entry.places.acquire(Math.max(0, turnBy - Date.now()));
      } catch (err) {
        if (err instanceof OpSemaphoreTimeout) throw new SearchShed('principal', kind);
        throw err;
      }
      try {
        let release: () => void;
        try {
          const slotBy = Math.min(Date.now() + this.limits.slotWaitMs, deadline);
          release = await this.slots.acquire(Math.max(0, slotBy - Date.now()));
        } catch (err) {
          if (err instanceof OpSemaphoreTimeout) throw new SearchShed('slots', kind);
          throw err;
        }
        try {
          return await fn(deadline);
        } finally {
          release();
        }
      } finally {
        releasePlace();
      }
    } catch (err) {
      if (err instanceof SearchShed) throw this.shed(err, kind, userId);
      const busy = asEngineBusy(err);
      if (busy) {
        this.logger.warn(
          `SEARCH_SHED reason=sqlstate code=${(err as { code?: string }).code} kind=${kind} principal=${userId}: answered 503 engine_busy`,
        );
        throw busy;
      }
      throw err;
    } finally {
      if (--entry.refs === 0) this.inFlight.delete(key);
    }
  }

  /** Log a shed with who and how full everything was (#716), and answer it as 503 `engine_busy`. */
  private shed(err: SearchShed, kind: 'search' | 'suggest' | 'share', principal: string): ServiceUnavailableException {
    const slots =
      kind === 'share'
        ? `${this.shareLane.inUse}/${this.limits.shareLaneMax}`
        : `${this.slots.inUse}/${this.limits.maxConcurrent}`;
    this.logger.warn(
      `SEARCH_SHED reason=${err.reason} stage=${err.stage} kind=${kind} principal=${principal} slots=${slots} ` +
        `lane=${this.pdpLane.inUse}/${this.limits.pdpLaneMax}: answered 503 engine_busy`,
    );
    return engineBusy();
  }

  /**
   * One statement in its own short transaction, under `statement_timeout = min(statementTimeoutMs, what is left)`,
   * decided AFTER the connection is acquired (a pool wait counts). Never a transaction across a PDP call. The caller
   * also stops waiting at the deadline: an abandoned statement then finds no time left and rolls back at once.
   */
  private statement<T>(deadline: number, stage: string, run: (trx: KyselyTransaction) => Promise<T>): Promise<T> {
    return this.within(deadline, stage, this.txStatement(deadline, stage, run));
  }

  /**
   * `statement` without the race against the deadline: it settles only when the transaction does (bounded by its own
   * `statement_timeout`). The share search runs on this so its lane is held until its statements really end.
   *
   * Four round trips (BEGIN, SET LOCAL, the statement, COMMIT), knowingly (#716 S4): Postgres reads
   * `statement_timeout` when a statement STARTS, so it cannot be set inside the statement it bounds, and folding
   * `BEGIN; SET LOCAL …` into one simple-protocol call would bypass Kysely's transaction handling to save two
   * sub-millisecond round trips on a path whose cost is its PDP calls.
   */
  private txStatement<T>(deadline: number, stage: string, run: (trx: KyselyTransaction) => Promise<T>): Promise<T> {
    return executeTx(this.database, async (trx) => {
      const ms = Math.min(this.limits.statementTimeoutMs, deadline - Date.now());
      if (ms < this.limits.minStatementMs) throw new SearchShed('deadline', stage);
      await sql`SET LOCAL statement_timeout = ${sql.lit(Math.floor(ms))}`.execute(trx);
      return run(trx);
    });
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
