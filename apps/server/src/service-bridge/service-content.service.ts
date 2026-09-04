import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { ContentListDto, ResolvePageSpaceDto } from './dto/content-read.dto';
import { WorkspaceResolver } from './workspace-resolver';

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
    const conds = [
      sql`workspace_id = ${workspaceId}`,
      sql`deleted_at is null`,
      sql`id = any(${dto.ids}::uuid[])`,
    ];
    if (dto.spaceId) conds.push(sql`space_id = ${dto.spaceId}`);
    if (dto.before) {
      conds.push(
        sql`(date_trunc('milliseconds', updated_at), id::text) < (${dto.before.updatedAt}::timestamptz, ${dto.before.id}::text)`,
      );
    }
    const res = await sql<PageRow>`
      select id, slug_id, title, icon, space_id, parent_page_id, position, created_at, updated_at
      from pages
      where ${sql.join(conds, sql` and `)}
      order by date_trunc('milliseconds', updated_at) desc, id::text desc
      limit ${dto.limit + 1}
    `.execute(this.db);
    return { items: res.rows.map(toPageSummary) };
  }

  async listSpacesByIds(dto: ContentListDto): Promise<{ items: PublicSpaceSummary[] }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const conds = [
      sql`workspace_id = ${workspaceId}`,
      sql`deleted_at is null`,
      sql`id = any(${dto.ids}::uuid[])`,
    ];
    if (dto.before) {
      conds.push(
        sql`(date_trunc('milliseconds', updated_at), id::text) < (${dto.before.updatedAt}::timestamptz, ${dto.before.id}::text)`,
      );
    }
    const res = await sql<SpaceRow>`
      select id, name, slug, description, visibility, created_at, updated_at
      from spaces
      where ${sql.join(conds, sql` and `)}
      order by date_trunc('milliseconds', updated_at) desc, id::text desc
      limit ${dto.limit + 1}
    `.execute(this.db);
    return { items: res.rows.map(toSpaceSummary) };
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
