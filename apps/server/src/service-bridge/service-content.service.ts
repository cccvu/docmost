import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { RawBuilder, sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  ContentCursorDto,
  ContentListDto,
  ContentSortDto,
  ContentSortField,
  ResolvePageSpaceDto,
} from './dto/content-read.dto';
import { WorkspaceResolver } from './workspace-resolver';

// Escape LIKE/ILIKE metacharacters so a user-supplied substring matches literally (Postgres LIKE's default
// escape char is backslash). Prevents a stray `%`/`_` from becoming a wildcard.
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c);
const contains = (s: string): string => '%' + likeEscape(s) + '%';

/** Compact, PII-free page shape for `/v1` list responses (ISO timestamps over the wire). */
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
    const conds = [
      sql`workspace_id = ${workspaceId}`,
      sql`deleted_at is null`,
      sql`id = any(${dto.ids}::uuid[])`,
    ];
    if (dto.spaceId) conds.push(sql`space_id = ${dto.spaceId}`);
    // Allowlisted page filters (params are bound; ilike metacharacters are escaped).
    if (dto.parentPageId) conds.push(sql`parent_page_id = ${dto.parentPageId}`);
    if (dto.titleContains) conds.push(sql`title ilike ${contains(dto.titleContains)}`);
    if (dto.creatorId) conds.push(sql`creator_id = ${dto.creatorId}`);
    if (dto.updatedSince) conds.push(sql`updated_at >= ${dto.updatedSince}::timestamptz`);
    if (dto.updatedUntil) conds.push(sql`updated_at < ${dto.updatedUntil}::timestamptz`);
    if (dto.before) conds.push(this.keysetCond(dto.sort, 'title', dto.before));
    const res = await sql<PageRow>`
      select id, slug_id, title, icon, space_id, parent_page_id, position, created_at, updated_at
      from pages
      where ${sql.join(conds, sql` and `)}
      ${this.orderClause(dto.sort, 'title')}
      limit ${dto.limit + 1}
    `.execute(this.db);
    return { items: res.rows.map(toPageSummary) };
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

  /** Reject a sort field that isn't valid for this resource (title↔pages, name↔spaces; timestamps for both). */
  private assertSortAllowed(sort: ContentSortDto | undefined, textCol: 'title' | 'name'): void {
    if (!sort) return;
    const allowed = new Set<ContentSortField>(['updatedAt', 'createdAt', textCol]);
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
    const bound = before.value ?? before.updatedAt;
    if (bound === undefined) throw new BadRequestException('cursor is missing its bound value');
    const cmp = sort.direction === 'asc' ? sql`>` : sql`<`;
    const expr = this.sortExpr(sort.field, textCol);
    // Timestamp fields cast the bound to ::timestamptz; text fields (coalesced) compare as ::text.
    const isTimestamp = sort.field === 'updatedAt' || sort.field === 'createdAt';
    const boundExpr = isTimestamp ? sql`${bound}::timestamptz` : sql`${bound}::text`;
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
    }
  }

  /** A single space by id (workspace-scoped, active only). Null -> 404 handled by the caller. */
  async getSpace(spaceId: string): Promise<PublicSpaceSummary> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const res = await sql<SpaceRow>`
      select id, name, slug, description, visibility, created_at, updated_at
      from spaces where id = ${spaceId} and workspace_id = ${workspaceId} and deleted_at is null
    `.execute(this.db);
    const row = res.rows[0];
    if (!row) throw new NotFoundException('space not found');
    return toSpaceSummary(row);
  }

  /** The explicit ACL grants on a page (page_permissions ⋈ page_access); grantee by Docmost user/group id. */
  async listPagePermissions(pageId: string): Promise<{ items: RawPagePermission[] }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
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
      where pa.page_id = ${pageId} and pa.workspace_id = ${workspaceId}
      order by pp.created_at asc
    `.execute(this.db);
    return {
      items: res.rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        groupId: r.groupId,
        role: r.role,
        createdAt: iso(r.createdAt),
      })),
    };
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
  };
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
