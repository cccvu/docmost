import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import {
  AddSpaceMemberDto,
  CreateSpaceDto,
  SpaceMemberRole,
  UpdateSpaceDto,
} from './dto/space-admin.dto';
import { SubCollectionPage } from './dto/sub-collection-page.dto';
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

const LAST_ADMIN =
  'a space must keep at least one admin — promote another member to admin before demoting or removing this one';

/** Rule M (#486) ranks: a missing or soft-deleted row is 0 (the upsert revives a soft-deleted row). */
const ROLE_RANK: Record<SpaceMemberRole, number> = { reader: 1, writer: 2, admin: 3 };
const rank = (role: string | null | undefined): number =>
  role && role in ROLE_RANK ? ROLE_RANK[role as SpaceMemberRole] : 0;

/** The 403 body carries a machine-readable `code` the platform maps to its `self_grant` problem. */
const selfGrant = () =>
  new ForbiddenException({
    code: 'self_grant',
    message:
      'you cannot add yourself or raise a membership that includes you; another administrator must do this',
  });

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
 *
 * It carries no AUTHORIZATION policy, but it does enforce one DATA invariant, per upstream parity
 * (`SpaceMemberService.validateLastAdmin`): a member mutation may not leave the space without a live admin
 * (#486). Every member mutation runs in ONE transaction that first locks the space row (`lockSpace`), so two
 * concurrent bridge mutations on one space serialize; under READ COMMITTED each statement after the lock takes
 * a fresh snapshot, so the admin count sees whatever the previously serialized transaction committed.
 * Residual: the native `/api/spaces/members/*` path (upstream SpaceMemberService) takes no such lock, so a
 * native change racing a bridge change can still orphan a space (a workspace admin recovers via the cascade).
 *
 * Rule M (#486, self-dealing): inside that same transaction, a write that sets a role on a membership row the
 * ACTOR is covered by (their own user row, or a group row they are in) is refused (403 `self_grant`) when the
 * new role outranks the row's current live role. Narrowing (self-demote, removing yourself or your group)
 * stays allowed, subject to the last-admin guard. Both sides of every comparison are Docmost user ids read from
 * this database (shadow users derive from the lower-cased externalId), so an id's case variants cannot slip by.
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

  /**
   * Raw members of a space (the platform enriches user ids with its own identities). Opt-in keyset paging:
   * with `page.limit` the fork walks `(created_at, id)` ascending and returns up to limit+1 (so the platform
   * can detect hasMore + build the next cursor from the last kept row); without it the read is unpaged
   * (returns all — the backward-compatible default). The default (unpaged) query is unchanged.
   */
  async listMembers(spaceId: string, page?: SubCollectionPage): Promise<RawSpaceMember[]> {
    await this.loadSpace(spaceId);
    const paged = page?.limit !== undefined;
    const conds = [sql`space_id = ${spaceId}`, sql`deleted_at is null`];
    if (paged && page!.before) {
      conds.push(
        sql`(date_trunc('milliseconds', created_at), id::text) > (${page!.before.createdAt}::timestamptz, ${page!.before.id}::text)`,
      );
    }
    const order = paged
      ? sql`order by date_trunc('milliseconds', created_at) asc, id::text asc`
      : sql`order by created_at asc`;
    const limitClause = paged ? sql`limit ${page!.limit! + 1}` : sql``;
    const res = await sql<{
      id: string;
      userId: string | null;
      groupId: string | null;
      role: string;
      createdAt: Date;
    }>`
      select id, user_id, group_id, role, created_at
      from space_members where ${sql.join(conds, sql` and `)}
      ${order}
      ${limitClause}
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
    let res: { rows: { id: string }[] };
    try {
      res = await sql<{ id: string }>`
        update spaces set deleted_at = null, updated_at = now()
        where id = ${spaceId} and workspace_id = ${workspaceId} and deleted_at is not null
        returning id
      `.execute(this.db);
    } catch (e) {
      // Only `spaces_personal_creator_unique` (partial on deleted_at IS NULL) can fire here: the owner of an
      // archived PERSONAL space already has another live one. The slug index is not partial, so an archived
      // space still holds its slug and reviving it cannot collide. The message deliberately names no owner.
      if ((e as { code?: string })?.code === '23505') {
        throw new ConflictException('cannot restore this space: its owner already has an active personal space');
      }
      throw e;
    }
    if (res.rows.length === 0) throw new NotFoundException('space not found or not archived');
  }

  /** Add (or re-add / re-role) a shadow user as a space member. The platform validates the identity first. */
  async addMember(
    spaceId: string,
    dto: AddSpaceMemberDto,
  ): Promise<{ memberId: string; userId: string }> {
    // Fast 404/400 BEFORE provisioning (no shadow user is created for a dead space); everything slow — the
    // workspace + both shadow users — is resolved before the transaction so the space lock is held briefly.
    await this.loadSpace(spaceId, { activeOnly: true });
    const { userId: memberUserId } = await this.bridge.provisionShadowUser({ externalId: dto.externalId });
    const { userId: addedById } = await this.bridge.provisionShadowUser({
      externalId: dto.addedByExternalId,
    });
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    return this.db.transaction().execute(async (trx) => {
      await this.lockSpace(trx, workspaceId, spaceId, true);
      // The upsert re-roles an existing LIVE row, so it can demote the last admin like a PATCH can.
      const cur = await sql<{ id: string; role: string }>`
        select id, role from space_members
        where space_id = ${spaceId} and user_id = ${memberUserId} and deleted_at is null
        for update
      `.execute(trx);
      const row = cur.rows[0];
      // Rule M: adding yourself, or raising your own row (a soft-deleted one ranks 0), is refused.
      if (memberUserId === addedById && rank(dto.role) > rank(row?.role)) throw selfGrant();
      if (row?.role === 'admin' && dto.role !== 'admin') await this.assertAnotherAdmin(trx, spaceId, row.id);
      const res = await sql<{ id: string }>`
        insert into space_members (user_id, space_id, role, added_by_id)
        values (${memberUserId}, ${spaceId}, ${dto.role}, ${addedById})
        on conflict (space_id, user_id) do update set role = excluded.role, deleted_at = null, updated_at = now()
        returning id
      `.execute(trx);
      return { memberId: res.rows[0].id, userId: memberUserId };
    });
  }

  async changeMemberRole(
    spaceId: string,
    memberId: string,
    role: SpaceMemberRole,
    actorExternalId: string,
  ): Promise<void> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    // Looked up, never provisioned: an actor with no shadow user cannot be covered by any membership row.
    const actorId = await this.bridge.findShadowUserId(actorExternalId);
    await this.db.transaction().execute(async (trx) => {
      await this.lockSpace(trx, workspaceId, spaceId, true);
      // `id AND space_id`: a memberId from another space is a 404 (never a cross-space write, and never
      // "not self" — the row must be found before rule M can be judged).
      const cur = await sql<{ userId: string | null; groupId: string | null; role: string }>`
        select user_id, group_id, role from space_members
        where id = ${memberId} and space_id = ${spaceId} and deleted_at is null
        for update
      `.execute(trx);
      const row = cur.rows[0];
      if (!row) throw new NotFoundException('member not found');
      if (rank(role) > rank(row.role) && actorId !== null && (await this.covers(trx, row, actorId))) {
        throw selfGrant();
      }
      if (row.role === 'admin' && role !== 'admin') await this.assertAnotherAdmin(trx, spaceId, memberId);
      await sql`
        update space_members set role = ${role}, updated_at = now()
        where id = ${memberId} and space_id = ${spaceId}
      `.execute(trx);
    });
  }

  /** Remove a member. Allowed on an ARCHIVED space too (as before) — and still guarded: there a direct admin
   *  row is the only administer path left (the workspace cascade is severed), so orphaning it is worse. */
  async removeMember(spaceId: string, memberId: string): Promise<void> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    await this.db.transaction().execute(async (trx) => {
      await this.lockSpace(trx, workspaceId, spaceId, false);
      const cur = await sql<{ role: string; deletedAt: Date | null }>`
        select role, deleted_at from space_members
        where id = ${memberId} and space_id = ${spaceId}
        for update
      `.execute(trx);
      const row = cur.rows[0];
      if (!row) throw new NotFoundException('member not found');
      if (row.role === 'admin' && row.deletedAt == null) await this.assertAnotherAdmin(trx, spaceId, memberId);
      await sql`delete from space_members where id = ${memberId} and space_id = ${spaceId}`.execute(trx);
    });
  }

  /** Rule M: the row is the actor's own user row, or a group row the actor is a member of (groups are flat). */
  private async covers(
    trx: KyselyTransaction,
    row: { userId: string | null; groupId: string | null },
    actorId: string,
  ): Promise<boolean> {
    if (row.userId !== null) return row.userId === actorId;
    if (row.groupId === null) return false;
    const res = await sql`
      select 1 from group_users where group_id = ${row.groupId} and user_id = ${actorId}
    `.execute(trx);
    return res.rows.length > 0;
  }

  /**
   * Lock the space row for this transaction (404 if absent / wrong tenant; 400 if archived when activeOnly).
   * FOR NO KEY UPDATE, not FOR UPDATE: two NO KEY UPDATE locks conflict (so this space's bridge member
   * mutations — and archive/unarchive — serialize), but it does not block the FOR KEY SHARE that FK checks take,
   * so page / page_access / space_members inserts referencing this space are never held up.
   */
  private async lockSpace(
    trx: KyselyTransaction,
    workspaceId: string,
    spaceId: string,
    activeOnly: boolean,
  ): Promise<void> {
    const res = await sql<{ id: string; deletedAt: Date | null }>`
      select id, deleted_at from spaces where id = ${spaceId} and workspace_id = ${workspaceId}
      for no key update
    `.execute(trx);
    const row = res.rows[0];
    if (!row) throw new NotFoundException('space not found');
    if (activeOnly && row.deletedAt != null) throw new BadRequestException('space is archived');
  }

  /**
   * Upstream `validateLastAdmin` parity: at least one LIVE admin row (user OR group — a group admin row is a
   * real PDP admin path) must remain once `excludingMemberId` stops being one. The `deleted_at` filter is our
   * deviation: the outbox projects a soft-deleted row as removed, so it is no admin in the PDP. Called only
   * when the target IS a live admin, so a space that already has no admin never becomes unmanageable.
   */
  private async assertAnotherAdmin(
    trx: KyselyTransaction,
    spaceId: string,
    excludingMemberId: string,
  ): Promise<void> {
    const res = await sql<{ n: number }>`
      select count(*)::int as n from space_members
      where space_id = ${spaceId} and role = 'admin' and deleted_at is null and id <> ${excludingMemberId}
    `.execute(trx);
    if ((res.rows[0]?.n ?? 0) === 0) throw new ConflictException(LAST_ADMIN);
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
