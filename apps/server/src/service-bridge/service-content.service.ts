import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { RawBuilder, sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  CONTENT_DESCENDANT_DEFAULT_DEPTH,
  ContentAncestorsDto,
  ContentCursorDto,
  ContentListDto,
  ContentSortDto,
  ContentSortField,
  ResolvePageSpaceDto,
  SpaceCommentPolicyDto,
} from './dto/content-read.dto';
import { ContentLabelListDto } from './dto/content-labels.dto';
import { ContentActivityListDto } from './dto/content-activity.dto';
import { isIsoInstant, SubCollectionPage } from './dto/sub-collection-page.dto';
import { WorkspaceResolver } from './workspace-resolver';
import { spaceVersion } from './resource-version';
import { aclVersionOf, readAclState } from '../authz/page-restriction/acl-state';
import { readPageLineage } from './page-lineage';
import { listActivityByPageIds, PublicActivityEvent } from './service-content-activity';
import { normalizeLabelName } from '../core/label/utils';

// Escape LIKE/ILIKE metacharacters so a user-supplied substring matches literally (Postgres LIKE's default
// escape char is backslash). Prevents a stray `%`/`_` from becoming a wildcard.
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c);
const contains = (s: string): string => '%' + likeEscape(s) + '%';

/**
 * Compact page shape for `/v1` list responses (ISO timestamps over the wire). The creator / last-editor ids are
 * Docmost user ids (#615): WIRE-ONLY, for the platform to map to its own identities — they never reach `/v1`.
 */
export interface PublicPageSummary {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceId: string;
  parentPageId: string | null;
  position: string | null;
  createdAt: string;
  updatedAt: string;
  creatorId: string | null;
  creatorName: string | null;
  lastUpdatedById: string | null;
  lastUpdatedByName: string | null;
}

/** #615: a page's ancestors, nearest first, the page itself excluded. `complete` = the walk reached a root. */
export interface PageAncestors {
  ancestorIds: string[];
  complete: boolean;
}

/** #615: a page label as the label list serves it — the name and how many of the AUTHORIZED pages carry it. */
export interface PublicLabelSummary {
  name: string;
  pageCount: number;
}

/** #615: whether a space lets viewers comment (Docmost's `settings.comments.allowViewerComments`). */
export interface SpaceCommentPolicy {
  allowViewerComments: boolean;
}

/** Compact public space shape for `/v1` list responses. */
export interface PublicSpaceSummary {
  id: string;
  name: string | null;
  slug: string;
  description: string | null;
  visibility: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * #616: the single-space read (`GET content/spaces/:id`, the `/v1` space GET) also carries the space's fork-issued
 * `version` — over every field above plus the archived state (`resource-version.ts` SPACE_VERSION_KEYS), so it is a
 * strong validator for this representation. The list items do not carry it.
 */
export interface PublicSpaceDetail extends PublicSpaceSummary {
  version: string;
}

/**
 * #616: the ACL read also answers whether the page carries its own restriction and the ACL's `version` — over the
 * WHOLE ACL (every grant, not only the page of `items` returned), what a restrict / grant / revoke / re-role sends
 * back as `expectedVersion`.
 */
export interface PagePermissionsResult {
  items: RawPagePermission[];
  restricted: boolean;
  version: string;
}

/** A raw ACL grant on a page — grantee by Docmost user/group id (the platform maps the user id to identity). */
export interface RawPagePermission {
  id: string;
  userId: string | null;
  groupId: string | null;
  role: string;
  createdAt: string;
}

// The fork's Kysely runs CamelCasePlugin, so raw-sql result keys come back camelCased (slug_id -> slugId,
// space_id -> spaceId, created_at -> createdAt, ...). The SELECTs use the real snake_case columns; the row
// shapes below read the camelCased result keys.
interface PageRow {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceId: string;
  parentPageId: string | null;
  position: string | null;
  createdAt: Date;
  updatedAt: Date;
  creatorId: string | null;
  creatorName: string | null;
  lastUpdatedById: string | null;
  lastUpdatedByName: string | null;
}

interface SpaceRow {
  id: string;
  name: string | null;
  slug: string;
  description: string | null;
  visibility: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * The read side of the platform's `/v1` filter-then-retrieve model, moved into the fork. This is a
 * PRIVILEGED DATA PLANE, NOT an authorization gate: the `ids` are the PDP-authorized set the platform
 * computed FIRST (the belt), and this endpoint returns metadata for EXACTLY those ids without any
 * re-authorization. The security of `/v1` therefore rests entirely on the platform passing only authorized
 * ids; a future change here must NOT assume the fork re-checks access.
 *
 * The correctness-sensitive keyset (millisecond-truncated updated_at + id::text tiebreak, `id = any(...)`
 * against the uuid PK for index use) is a byte-faithful port of the platform's query. Cursor encode/decode
 * stays on the PLATFORM (the fork takes the decoded bound + returns limit+1 rows), so the `/v1` cursor
 * format is unchanged. The fork resolves its own default workspace (single-tenant), so the caller never
 * supplies a Docmost workspace id.
 */
@Injectable()
export class ServiceContentService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  /** Resolve a page's owning space id (fail-closed 404 on any miss). */
  async resolvePageSpace(dto: ResolvePageSpaceDto): Promise<{ pageId: string; spaceId: string }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const res = await sql<{ spaceId: string }>`
      select space_id from pages
      where id = ${dto.pageId} and workspace_id = ${workspaceId}
      ${dto.includeDeleted ? sql`` : sql`and deleted_at is null`}
    `.execute(this.db);
    const row = res.rows[0];
    if (!row) throw new NotFoundException('page not found');
    return { pageId: dto.pageId, spaceId: row.spaceId };
  }

  async listPagesByIds(dto: ContentListDto): Promise<{ items: PublicPageSummary[] }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    this.assertSortAllowed(dto.sort, 'title'); // pages sort by title (not name)
    assertPageRelationFilters(dto);
    for (const k of ['updatedSince', 'updatedUntil', 'createdSince', 'createdUntil'] as const) {
      // A Date.parse-lenient-but-Postgres-invalid bound (bare '2026') must 400 here, not 500 at the cast.
      if (present(dto[k]) && !isIsoInstant(dto[k] as string)) {
        throw new BadRequestException(`${k} must be an ISO-8601 timestamp`);
      }
    }
    const conds = [
      sql`workspace_id = ${workspaceId}`,
      sql`deleted_at is null`,
      sql`id = any(${dto.ids}::uuid[])`,
    ];
    if (dto.spaceId) conds.push(sql`space_id = ${dto.spaceId}`);
    // Allowlisted page filters (params are bound; ilike metacharacters are escaped).
    if (dto.parentPageId) conds.push(sql`parent_page_id = ${dto.parentPageId}`);
    if (dto.topLevel === true) conds.push(sql`parent_page_id is null`);
    if (dto.topLevel === false) conds.push(sql`parent_page_id is not null`);
    if (dto.titleContains) conds.push(sql`title ilike ${contains(dto.titleContains)}`);
    if (dto.creatorId) conds.push(sql`creator_id = ${dto.creatorId}`);
    if (dto.lastUpdatedById) conds.push(sql`last_updated_by_id = ${dto.lastUpdatedById}`);
    if (dto.labelName) {
      // Only a PAGE label of THIS workspace; `labels` is unique on (workspace_id, type, name).
      conds.push(sql`exists (
        select 1 from page_labels pl join labels l on l.id = pl.label_id
        where pl.page_id = pages.id and l.workspace_id = ${workspaceId} and l.type = 'page'
          and l.name = ${normalizeLabelName(dto.labelName)}
      )`);
    }
    if (dto.createdSince) conds.push(sql`created_at >= ${dto.createdSince}::timestamptz`);
    if (dto.createdUntil) conds.push(sql`created_at < ${dto.createdUntil}::timestamptz`);
    if (dto.updatedSince) conds.push(sql`updated_at >= ${dto.updatedSince}::timestamptz`);
    if (dto.updatedUntil) conds.push(sql`updated_at < ${dto.updatedUntil}::timestamptz`);
    // Links (#615): `backlinks` rows are (source links to target), maintained by Docmost from page content.
    if (dto.linksTo) {
      conds.push(sql`id in (
        select b.source_page_id from backlinks b
        where b.target_page_id = ${dto.linksTo} and b.workspace_id = ${workspaceId}
      )`);
    }
    if (dto.linkedFrom) {
      conds.push(sql`id in (
        select b.target_page_id from backlinks b
        where b.source_page_id = ${dto.linkedFrom} and b.workspace_id = ${workspaceId}
      )`);
    }
    let withClause = sql``;
    if (dto.descendantOf) {
      const depth = dto.maxDepth ?? CONTENT_DESCENDANT_DEFAULT_DEPTH;
      withClause = this.descendantsCte(workspaceId, dto.descendantOf, depth, dto.ids);
      conds.push(sql`id in (select d.id from descendants d)`);
    }
    if (dto.before) conds.push(this.keysetCond(dto.sort, 'title', dto.before));
    // The creator / last-editor names are scalar subqueries on the page's own workspace; every outer column stays
    // unqualified (only `pages` is in FROM), so the default-path SQL keeps its legacy shape.
    const res = await sql<PageRow>`
      ${withClause}
      select id, slug_id, title, icon, space_id, parent_page_id, position, created_at, updated_at,
             creator_id, last_updated_by_id,
             (select u.name from users u
               where u.id = pages.creator_id and u.workspace_id = pages.workspace_id) as creator_name,
             (select u.name from users u
               where u.id = pages.last_updated_by_id and u.workspace_id = pages.workspace_id) as last_updated_by_name
      from pages
      where ${sql.join(conds, sql` and `)}
      ${this.orderClause(dto.sort, 'title')}
      limit ${dto.limit + 1}
    `.execute(this.db);
    return { items: res.rows.map(toPageSummary) };
  }

  /**
   * #615: the pages below `rootId`, at most `maxDepth` levels down, reached ONLY through pages in `ids` that are live
   * and in the workspace — an unauthorized or trashed page stops the walk, so a page under it is never returned and
   * its existence never inferred. The root itself is excluded (it seeds the path, so a cycle cannot bring it back).
   */
  private descendantsCte(workspaceId: string, rootId: string, maxDepth: number, ids: string[]): RawBuilder<unknown> {
    return sql`with recursive descendants(id, depth, path) as (
        select c.id, 1, array[${rootId}::uuid, c.id]
        from pages c
        where c.parent_page_id = ${rootId} and c.id <> ${rootId}
          and c.workspace_id = ${workspaceId} and c.deleted_at is null and c.id = any(${ids}::uuid[])
        union all
        select c.id, d.depth + 1, d.path || c.id
        from descendants d
        join pages c on c.parent_page_id = d.id
        where d.depth < ${maxDepth} and not (c.id = any(d.path))
          and c.workspace_id = ${workspaceId} and c.deleted_at is null and c.id = any(${ids}::uuid[])
      )`;
  }

  async listSpacesByIds(dto: ContentListDto): Promise<{ items: PublicSpaceSummary[] }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    this.assertSortAllowed(dto.sort, 'name'); // spaces sort by name (not title)
    const conds = [
      sql`workspace_id = ${workspaceId}`,
      sql`deleted_at is null`,
      sql`id = any(${dto.ids}::uuid[])`,
    ];
    // Allowlisted space filters.
    if (dto.nameContains) conds.push(sql`name ilike ${contains(dto.nameContains)}`);
    if (dto.createdSince) conds.push(sql`created_at >= ${dto.createdSince}::timestamptz`);
    if (dto.createdUntil) conds.push(sql`created_at < ${dto.createdUntil}::timestamptz`);
    if (dto.updatedSince) conds.push(sql`updated_at >= ${dto.updatedSince}::timestamptz`);
    if (dto.updatedUntil) conds.push(sql`updated_at < ${dto.updatedUntil}::timestamptz`);
    if (dto.before) conds.push(this.keysetCond(dto.sort, 'name', dto.before));
    const res = await sql<SpaceRow>`
      select id, name, slug, description, visibility, created_at, updated_at
      from spaces
      where ${sql.join(conds, sql` and `)}
      ${this.orderClause(dto.sort, 'name')}
      limit ${dto.limit + 1}
    `.execute(this.db);
    return { items: res.rows.map(toSpaceSummary) };
  }

  // --- keyset sort helpers (pages/spaces share these; `textCol` is the resource's text sort column) --------
  //
  // Backward-compat is load-bearing: with NO `sort`, orderClause + keysetCond emit the EXACT legacy SQL
  // (`date_trunc('milliseconds', updated_at) desc`, id-tiebroken) so an un-updated platform (the C9 bump gap)
  // and the SQL-shape guard tests are unchanged. A `sort` opts into the generalized keyset.

  /** Reject a sort field that isn't valid for this resource (title/position↔pages, name↔spaces; timestamps for both). */
  private assertSortAllowed(sort: ContentSortDto | undefined, textCol: 'title' | 'name'): void {
    if (!sort) return;
    const allowed = new Set<ContentSortField>(['updatedAt', 'createdAt', textCol]);
    if (textCol === 'title') allowed.add('position');
    if (!allowed.has(sort.field)) {
      throw new BadRequestException(`unsupported sort field '${sort.field}' for this resource`);
    }
  }

  private orderClause(sort: ContentSortDto | undefined, textCol: 'title' | 'name'): RawBuilder<unknown> {
    if (!sort) return sql`order by date_trunc('milliseconds', updated_at) desc, id::text desc`;
    const dir = sort.direction === 'asc' ? sql`asc` : sql`desc`;
    return sql`order by ${this.sortExpr(sort.field, textCol)} ${dir}, id::text ${dir}`;
  }

  private keysetCond(
    sort: ContentSortDto | undefined,
    textCol: 'title' | 'name',
    before: ContentCursorDto,
  ): RawBuilder<unknown> {
    if (!sort) {
      // Legacy default: `updatedAt desc` — the bound is `before.updatedAt`.
      if (before.updatedAt === undefined) throw new BadRequestException('cursor is missing updatedAt');
      return sql`(date_trunc('milliseconds', updated_at), id::text) < (${before.updatedAt}::timestamptz, ${before.id}::text)`;
    }
    const isTimestamp = sort.field === 'updatedAt' || sort.field === 'createdAt';
    // A TEXT sort (title/name) MUST carry `value`: falling back to a timestamp `updatedAt` would compare a
    // timestamp string against titles and paginate WRONG (Correctness #2). Timestamp sorts may use either
    // (both are instants), keeping the legacy `updatedAt`-only cursor working.
    const bound = isTimestamp ? (before.value ?? before.updatedAt) : before.value;
    if (bound === undefined) {
      throw new BadRequestException(
        isTimestamp
          ? 'cursor is missing its bound value'
          : `sort by '${sort.field}' requires a cursor 'value'`,
      );
    }
    // Guard the cast: a Date.parse-lenient-but-Postgres-invalid bound (e.g. bare '2026') must 400 HERE, not
    // 500 at the ::timestamptz cast (Security F1 / Correctness #1).
    if (isTimestamp && !isIsoInstant(bound)) {
      throw new BadRequestException("cursor bound is not a valid ISO-8601 timestamp");
    }
    const cmp = sort.direction === 'asc' ? sql`>` : sql`<`;
    const expr = this.sortExpr(sort.field, textCol);
    // Timestamp fields cast the bound to ::timestamptz; text fields (coalesced) compare as ::text — position under
    // the same "C" collation as its sort expression.
    const boundExpr = isTimestamp
      ? sql`${bound}::timestamptz`
      : sort.field === 'position'
        ? sql`${bound}::text collate "C"`
        : sql`${bound}::text`;
    return sql`(${expr}, id::text) ${cmp} (${boundExpr}, ${before.id}::text)`;
  }

  private sortExpr(field: ContentSortField, textCol: 'title' | 'name'): RawBuilder<unknown> {
    switch (field) {
      case 'updatedAt':
        return sql`date_trunc('milliseconds', updated_at)`;
      case 'createdAt':
        return sql`date_trunc('milliseconds', created_at)`;
      // Text sorts coalesce null → '' so null titles/names page deterministically (and the bound is a plain
      // string the platform derives as `row.title ?? ''`). assertSortAllowed guarantees field matches textCol.
      case 'title':
        return sql`coalesce(title, '')`;
      case 'name':
        return sql`coalesce(name, '')`;
      // #615 sibling order, exactly as Docmost orders a tree level (its `(space_id, parent_page_id, position
      // COLLATE "C")` index): byte order, and a null position ('~' sorts after every fractional-index key) last. The
      // platform's cursor bound is `position ?? '~'`.
      case 'position':
        return sql`coalesce(position, '~') collate "C"`;
    }
  }

  /**
   * #615: a page's ancestors, nearest first, the page itself excluded — the shared lineage walk (`page-lineage.ts`),
   * pinned to the workspace. Ids only: the platform authorizes each one (and stops at the first it may not show),
   * and the walk's restriction facts are deliberately NOT returned. 404 unless the page is live in the workspace.
   */
  async pageAncestors(dto: ContentAncestorsDto): Promise<PageAncestors> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const live = await sql<{ id: string }>`
      select id from pages where id = ${dto.pageId} and workspace_id = ${workspaceId} and deleted_at is null
    `.execute(this.db);
    if (!live.rows[0]) throw new NotFoundException('page not found');
    const lineage = await readPageLineage(this.db, dto.pageId, { includeSelf: false, workspaceId });
    // `chain` starts with the page itself (depth 0); an empty chain means the page vanished between the reads.
    return {
      ancestorIds: lineage.chain[0] === dto.pageId ? lineage.chain.slice(1) : [],
      complete: lineage.chain[0] === dto.pageId && lineage.complete,
    };
  }

  /**
   * #615: the page labels on the AUTHORIZED live pages (`ids`, in the workspace), each with the number of those pages
   * that carry it — so a label only on pages the caller cannot see is never named, and a count never reveals one.
   * Keyset on the name ("C" collation; unique per workspace and type), ascending; returns up to limit+1.
   */
  async listLabels(dto: ContentLabelListDto): Promise<{ items: PublicLabelSummary[] }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    if (dto.ids.length === 0) return { items: [] };
    const conds = [
      sql`l.workspace_id = ${workspaceId}`,
      sql`l.type = 'page'`,
      sql`p.workspace_id = ${workspaceId}`,
      sql`p.deleted_at is null`,
      sql`p.id = any(${dto.ids}::uuid[])`,
    ];
    if (dto.spaceId) conds.push(sql`p.space_id = ${dto.spaceId}`);
    if (dto.nameContains) conds.push(sql`l.name ilike ${contains(normalizeLabelName(dto.nameContains))}`);
    if (dto.before) conds.push(sql`l.name collate "C" > ${dto.before.name}::text collate "C"`);
    const res = await sql<{ name: string; pageCount: number }>`
      select l.name, count(*)::int as page_count
      from labels l
      join page_labels pl on pl.label_id = l.id
      join pages p on p.id = pl.page_id
      where ${sql.join(conds, sql` and `)}
      group by l.name
      order by l.name collate "C" asc
      limit ${dto.limit + 1}
    `.execute(this.db);
    return { items: res.rows.map((r) => ({ name: r.name, pageCount: Number(r.pageCount) })) };
  }

  /** #615: the activity feed over the authorized pages (see `service-content-activity.ts`). */
  async listActivity(dto: ContentActivityListDto): Promise<{ items: PublicActivityEvent[] }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    return listActivityByPageIds(this.db, workspaceId, dto);
  }

  /**
   * #615: whether a space lets viewers comment — the setting Docmost's `validateCanComment` reads. A fact, not a
   * decision: the platform combines it with the PDP. An archived space answers its stored setting (the PDP denies it
   * anyway); a space outside the workspace is a 404.
   */
  async spaceCommentPolicy(dto: SpaceCommentPolicyDto): Promise<SpaceCommentPolicy> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const res = await sql<{ allowViewerComments: boolean }>`
      select coalesce((settings->'comments'->>'allowViewerComments') = 'true', false) as allow_viewer_comments
      from spaces where id = ${dto.spaceId} and workspace_id = ${workspaceId}
    `.execute(this.db);
    const row = res.rows[0];
    if (!row) throw new NotFoundException('space not found');
    return { allowViewerComments: row.allowViewerComments === true };
  }

  /** A single space by id (workspace-scoped, active only), with its version. Null -> 404 handled by the caller. */
  async getSpace(spaceId: string): Promise<PublicSpaceDetail> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const res = await sql<SpaceRow>`
      select id, name, slug, description, visibility, created_at, updated_at
      from spaces where id = ${spaceId} and workspace_id = ${workspaceId} and deleted_at is null
    `.execute(this.db);
    const row = res.rows[0];
    if (!row) throw new NotFoundException('space not found');
    return { ...toSpaceSummary(row), version: spaceVersion({ ...row, archived: false }) }; // active only
  }

  /**
   * The explicit ACL grants on a page (page_permissions ⋈ page_access); grantee by Docmost user/group id.
   * Opt-in keyset paging (same contract as space members): with `page.limit` the fork walks
   * `(pp.created_at, pp.id)` ascending and returns up to limit+1; without it the read is unpaged (all grants).
   * The default (unpaged) query is unchanged. #616: the items, `restricted` and the ACL `version` come from ONE
   * snapshot (a read-only REPEATABLE READ transaction), so the version always describes the grants returned.
   */
  async listPagePermissions(
    pageId: string,
    page?: SubCollectionPage,
  ): Promise<PagePermissionsResult> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const paged = page?.limit !== undefined;
    const conds = [sql`pa.page_id = ${pageId}`, sql`pa.workspace_id = ${workspaceId}`];
    if (paged && page!.before) {
      conds.push(
        sql`(date_trunc('milliseconds', pp.created_at), pp.id::text) > (${page!.before.createdAt}::timestamptz, ${page!.before.id}::text)`,
      );
    }
    const order = paged
      ? sql`order by date_trunc('milliseconds', pp.created_at) asc, pp.id::text asc`
      : sql`order by pp.created_at asc`;
    const limitClause = paged ? sql`limit ${page!.limit! + 1}` : sql``;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const res = await sql<{
          id: string;
          userId: string | null;
          groupId: string | null;
          role: string;
          createdAt: Date;
        }>`
          select pp.id, pp.user_id, pp.group_id, pp.role, pp.created_at
          from page_permissions pp
          join page_access pa on pa.id = pp.page_access_id
          where ${sql.join(conds, sql` and `)}
          ${order}
          ${limitClause}
        `.execute(trx);
        const acl = await readAclState(trx, pageId, workspaceId);
        return {
          items: res.rows.map((r) => ({
            id: r.id,
            userId: r.userId,
            groupId: r.groupId,
            role: r.role,
            createdAt: iso(r.createdAt),
          })),
          restricted: acl.restricted,
          version: aclVersionOf(pageId, acl),
        };
      });
  }
}

function toPageSummary(r: PageRow): PublicPageSummary {
  return {
    id: r.id,
    slugId: r.slugId,
    title: r.title,
    icon: r.icon,
    spaceId: r.spaceId,
    parentPageId: r.parentPageId,
    position: r.position,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    creatorId: r.creatorId ?? null,
    creatorName: r.creatorName ?? null,
    lastUpdatedById: r.lastUpdatedById ?? null,
    lastUpdatedByName: r.lastUpdatedByName ?? null,
  };
}

/** Set, as opposed to omitted: the DTO's @IsOptional() lets an explicit null through, which counts as omitted. */
const present = (v: unknown): boolean => v !== undefined && v !== null;

/**
 * #615: the page-relation filters that cannot be combined — each would silently narrow another to nothing, or (for
 * `descendantOf`) replace the tree walk with a different relation. A 400 rather than a guess.
 */
function assertPageRelationFilters(dto: ContentListDto): void {
  if (present(dto.topLevel) && present(dto.parentPageId)) {
    throw new BadRequestException('topLevel cannot be combined with parentPageId');
  }
  if (present(dto.linksTo) && present(dto.linkedFrom)) {
    throw new BadRequestException('linksTo cannot be combined with linkedFrom');
  }
  if (present(dto.descendantOf)) {
    for (const k of ['parentPageId', 'topLevel', 'linksTo', 'linkedFrom'] as const) {
      if (present(dto[k])) throw new BadRequestException(`descendantOf cannot be combined with ${k}`);
    }
  } else if (present(dto.maxDepth)) {
    throw new BadRequestException('maxDepth requires descendantOf');
  }
}

function toSpaceSummary(r: SpaceRow): PublicSpaceSummary {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    visibility: r.visibility,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}
