import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  AddSpaceMemberDto,
  CreateSpaceDto,
  SpaceMemberRole,
  UpdateSpaceDto,
} from './dto/space-admin.dto';
import { ServiceBridgeService } from './service-bridge.service';
import { WorkspaceResolver } from './workspace-resolver';

/** Space summary the platform relays to the console (createdAt as an ISO string over the wire). */
export interface SpaceView {
  id: string;
  name: string | null;
  slug: string;
  description: string | null;
  visibility: string;
  memberCount: number;
  archived: boolean;
  createdAt: string;
}

/**
 * A raw space_members row. The fork returns Docmost user/group ids ONLY; the platform maps user ids back to
 * its own identities (the real-email mapping never leaves the platform).
 */
export interface RawSpaceMember {
  memberId: string;
  userId: string | null;
  groupId: string | null;
  role: string;
  createdAt: string;
}

// The fork's Kysely runs CamelCasePlugin, so raw-sql result keys come back camelCased (created_at ->
// createdAt, member_count -> memberCount, user_id -> userId, ...). The SELECTs use the real snake_case
// columns; the row shapes below read the camelCased result keys.
interface SpaceRow {
  id: string;
  name: string | null;
  slug: string;
  description: string | null;
  visibility: string;
  createdAt: Date;
  deletedAt: Date | null;
  memberCount: string;
}

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * The platform-governed space + membership control plane. The platform is the authorization authority: it
 * checks `space#administer` (workspace/space) BEFORE calling these endpoints, which are a service-secret-
 * guarded DATA plane carrying no policy. Spaces live in Docmost's DB, so these writes previously ran in the
 * platform process reaching into Docmost's schema; they now live in the fork (which owns the schema). The
 * existing Docmost-DB outbox triggers mirror the writes into SpiceDB (`space#workspace`, `space#<role>`), so
 * a moved write projects identically.
 *
 * Behaviour is a FAITHFUL port of the platform's queries (soft-delete archive, the exact member upsert, the
 * simple member count) via `sql` templates — deliberately NOT the fork's own SpaceRepo/SpaceMemberRepo,
 * which hard-delete and emit SPACE_DELETED events (different semantics that would drift the outbox and break
 * archive reversibility). No `users.role` is ever touched: a space `admin` is a per-space role only.
 */
@Injectable()
export class ServiceSpaceService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaces: WorkspaceResolver,
    private readonly bridge: ServiceBridgeService,
  ) {}

  /** Derive a valid, lowercased Docmost slug from a source string; null if nothing usable remains. */
  private deriveSlug(source: string): string | null {
    // Slice BEFORE trimming so a truncation that lands on a hyphen can't leave a trailing `-`.
    const slug = source
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 60)
      .replace(/^-+|-+$/g, '');
    return /^[a-z0-9][a-z0-9_-]*$/.test(slug) ? slug : null;
  }

  private toView(r: SpaceRow): SpaceView {
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      visibility: r.visibility,
      memberCount: Number(r.memberCount),
      archived: r.deletedAt != null,
      createdAt: iso(r.createdAt),
    };
  }

  /** List non-personal spaces (+ live member count). Archived hidden unless requested. */
  async list(includeArchived = false): Promise<SpaceView[]> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const res = await sql<SpaceRow>`
      select s.id, s.name, s.slug, s.description, s.visibility, s.created_at, s.deleted_at,
             (select count(*) from space_members sm where sm.space_id = s.id and sm.deleted_at is null) as member_count
      from spaces s
      where s.workspace_id = ${workspaceId}
        and coalesce(s.is_personal, false) = false
        ${includeArchived ? sql`` : sql`and s.deleted_at is null`}
      order by s.deleted_at nulls first, s.name asc nulls last
    `.execute(this.db);
    return res.rows.map((r) => this.toView(r));
  }

  /** Space detail (workspace-scoped; 404 if not in this workspace). */
  async getDetail(spaceId: string): Promise<SpaceView> {
    return this.loadSpace(spaceId);
  }

  /** Raw members of a space (the platform enriches user ids with its own identities). */
  async listMembers(spaceId: string): Promise<RawSpaceMember[]> {
    await this.loadSpace(spaceId);
    const res = await sql<{
      id: string;
      userId: string | null;
      groupId: string | null;
      role: string;
      createdAt: Date;
    }>`
      select id, user_id, group_id, role, created_at
      from space_members where space_id = ${spaceId} and deleted_at is null
      order by created_at asc
    `.execute(this.db);
    return res.rows.map((r) => ({
      memberId: r.id,
      userId: r.userId,
      groupId: r.groupId,
      role: r.role,
      createdAt: iso(r.createdAt),
    }));
  }

  /**
   * Create a space + add the creator as its `admin` member, atomically in ONE transaction so BOTH the
   * spaces row and the initial space_members row fire the outbox capture together (the atomicity the SpiceDB
   * projection relies on). The creator's shadow user is resolved (provisioned if absent, idempotent) from
   * the opaque externalId.
   */
  async create(input: CreateSpaceDto): Promise<{ id: string; slug: string; name: string | null }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const slug = input.slug ? input.slug.toLowerCase() : this.deriveSlug(input.name);
    if (!slug) {
      throw new BadRequestException('could not derive a valid slug from the name — provide a slug explicitly');
    }
    // Friendly pre-check before the unique constraint. Docmost's (slug, workspace_id) unique index is NOT
    // partial, so an ARCHIVED space still reserves its slug — match that here (no deleted_at filter).
    const dupe = await sql`
      select 1 from spaces where lower(slug) = lower(${slug}) and workspace_id = ${workspaceId}
    `.execute(this.db);
    if (dupe.rows.length) throw new ConflictException(`a space with the slug "${slug}" already exists`);

    const { userId: creatorId } = await this.bridge.provisionShadowUser({
      externalId: input.creatorExternalId,
    });

    try {
      return await this.db.transaction().execute(async (trx) => {
        const s = await sql<{ id: string; slug: string; name: string | null }>`
          insert into spaces (name, description, slug, creator_id, workspace_id)
          values (${input.name}, ${input.description ?? null}, ${slug}, ${creatorId}, ${workspaceId})
          returning id, slug, name
        `.execute(trx);
        const space = s.rows[0];
        await sql`
          insert into space_members (user_id, space_id, role, added_by_id)
          values (${creatorId}, ${space.id}, 'admin', ${creatorId})
        `.execute(trx);
        return { id: space.id, slug: space.slug, name: space.name };
      });
    } catch (e) {
      if ((e as { code?: string })?.code === '23505') {
        throw new ConflictException(`a space with the slug "${slug}" already exists`);
      }
      throw e;
    }
  }

  /** Rename / re-describe a space (never changes the slug — links are stable). */
  async update(spaceId: string, input: UpdateSpaceDto): Promise<void> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const fragments = [];
    if (input.name !== undefined) fragments.push(sql`name = ${input.name}`);
    if (input.description !== undefined) fragments.push(sql`description = ${input.description}`);
    if (fragments.length === 0) throw new BadRequestException('nothing to update');
    fragments.push(sql`updated_at = now()`);
    const res = await sql<{ id: string }>`
      update spaces set ${sql.join(fragments, sql`, `)}
      where id = ${spaceId} and workspace_id = ${workspaceId} and deleted_at is null
      returning id
    `.execute(this.db);
    if (res.rows.length === 0) throw new NotFoundException('space not found');
  }

  /** Archive (reversible soft-delete). The outbox drops `space#workspace`, severing the admin cascade. */
  async archive(spaceId: string): Promise<void> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const res = await sql<{ id: string }>`
      update spaces set deleted_at = now(), updated_at = now()
      where id = ${spaceId} and workspace_id = ${workspaceId} and deleted_at is null
      returning id
    `.execute(this.db);
    if (res.rows.length === 0) throw new NotFoundException('space not found or already archived');
  }

  async unarchive(spaceId: string): Promise<void> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const res = await sql<{ id: string }>`
      update spaces set deleted_at = null, updated_at = now()
      where id = ${spaceId} and workspace_id = ${workspaceId} and deleted_at is not null
      returning id
    `.execute(this.db);
    if (res.rows.length === 0) throw new NotFoundException('space not found or not archived');
  }

  /** Add (or re-add / re-role) a shadow user as a space member. The platform validates the identity first. */
  async addMember(
    spaceId: string,
    dto: AddSpaceMemberDto,
  ): Promise<{ memberId: string; userId: string }> {
    await this.loadSpace(spaceId, { activeOnly: true });
    const { userId: memberUserId } = await this.bridge.provisionShadowUser({ externalId: dto.externalId });
    const { userId: addedById } = await this.bridge.provisionShadowUser({
      externalId: dto.addedByExternalId,
    });
    const res = await sql<{ id: string }>`
      insert into space_members (user_id, space_id, role, added_by_id)
      values (${memberUserId}, ${spaceId}, ${dto.role}, ${addedById})
      on conflict (space_id, user_id) do update set role = excluded.role, deleted_at = null, updated_at = now()
      returning id
    `.execute(this.db);
    return { memberId: res.rows[0].id, userId: memberUserId };
  }

  async changeMemberRole(spaceId: string, memberId: string, role: SpaceMemberRole): Promise<void> {
    await this.loadSpace(spaceId, { activeOnly: true });
    const res = await sql<{ id: string }>`
      update space_members set role = ${role}, updated_at = now()
      where id = ${memberId} and space_id = ${spaceId} and deleted_at is null
      returning id
    `.execute(this.db);
    if (res.rows.length === 0) throw new NotFoundException('member not found');
  }

  async removeMember(spaceId: string, memberId: string): Promise<void> {
    await this.loadSpace(spaceId);
    const res = await sql<{ id: string }>`
      delete from space_members where id = ${memberId} and space_id = ${spaceId} returning id
    `.execute(this.db);
    if (res.rows.length === 0) throw new NotFoundException('member not found');
  }

  /** Load a space scoped to the default workspace (404 if absent / wrong tenant / archived when activeOnly). */
  private async loadSpace(spaceId: string, opts?: { activeOnly?: boolean }): Promise<SpaceView> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const res = await sql<SpaceRow>`
      select s.id, s.name, s.slug, s.description, s.visibility, s.created_at, s.deleted_at,
             (select count(*) from space_members sm where sm.space_id = s.id and sm.deleted_at is null) as member_count
      from spaces s where s.id = ${spaceId} and s.workspace_id = ${workspaceId}
    `.execute(this.db);
    const row = res.rows[0];
    if (!row) throw new NotFoundException('space not found');
    if (opts?.activeOnly && row.deletedAt != null) throw new BadRequestException('space is archived');
    return this.toView(row);
  }
}
