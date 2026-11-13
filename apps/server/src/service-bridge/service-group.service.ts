import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { ServiceBridgeService } from './service-bridge.service';
import { WorkspaceResolver } from './workspace-resolver';
import { SubCollectionPage } from './dto/sub-collection-page.dto';
import {
  AddGroupMembersDto,
  CreateGroupDto,
  EnsureDefaultGroupDto,
  UpdateGroupDto,
} from './dto/group-admin.dto';
import { EXTERNAL_ID } from './dto/space-admin.dto';
import { externalIdOfShadow } from './shadow-user';
import { asEngineBusy, refusal } from './resource-version';
import { BASIC_GROUP_HAS_GRANTS, findDefaultGroup, groupGrantCounts, hasGrants } from './default-group';

/** A group as the platform's console lists it (createdAt as an ISO string over the wire). */
export interface GroupView {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  memberCount: number;
  createdAt: string;
}

/**
 * A raw group membership. `userId` is the Docmost user id; `externalId` is the integrator identity the shadow user
 * stands for (derived from its reserved shadow email), or null for a user outside the shadow namespace (a native
 * anchor). `memberId` + `addedAt` of the last row are the next page's keyset cursor (`beforeId`, `beforeCreatedAt`).
 */
export interface RawGroupMember {
  memberId: string;
  userId: string;
  externalId: string | null;
  addedAt: string;
}

/** A live group one identity is in (the integrator's rule-B fallback read). */
export interface GroupMembershipSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

/** What a group grants through the fork's rows: live space memberships and page grants (a read). */
export interface GroupUsage {
  spaces: { spaceId: string; memberId: string; role: string }[];
  pages: { pageId: string; permissionId: string; role: string }[];
}

/** A member add, by externalId: newly added vs already a member (nothing written for those). */
export interface AddedGroupMembers {
  added: string[];
  alreadyMember: string[];
}

export interface EnsuredDefaultGroup {
  groupId: string;
  /** The name or description changed. */
  renamed: boolean;
  /** The externalIds that were not yet members (now are). */
  added: string[];
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  memberCount: number | string;
  createdAt: Date | string;
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** Advisory key 1 for the per-workspace group-name lock (the second key is `hashtext(workspace_id)`). */
const GROUP_NAME_LOCK = 797797;

/** Provisioning hashes an unusable password per NEW shadow user (bcrypt): at most this many at a time. */
const PROVISION_CONCURRENCY = 4;

const groupNotFound = () =>
  refusal(new NotFoundException({ message: 'group not found', code: 'group_not_found' }), 'group_not_found');

const nameTaken = () =>
  refusal(
    new ConflictException({ message: 'a group with this name already exists', code: 'group_name_taken' }),
    'group_name_taken',
  );

/** 409: the default group is changed only by the ensure op. */
const defaultGroupImmutable = () =>
  refusal(
    new ConflictException({
      message: 'the default group is managed by the platform and cannot be changed here',
      code: 'default_group_immutable',
    }),
    'default_group_immutable',
  );

/** 409: a group that still grants something cannot be deleted (a delete must never take access away). */
const groupInUse = (spaceCount: number, pageCount: number) =>
  refusal(
    new ConflictException({
      message: 'this group still has space or page access; remove that access before deleting it',
      code: 'group_in_use',
      spaceCount,
      pageCount,
    }),
    'group_in_use',
  );

/** 409 + log token: the default group holds a grant, so putting people in it would hand that grant to everyone. */
const basicGroupHasGrants = () =>
  refusal(
    new ConflictException({
      message: 'the default group holds space or page access; remove it before members can be added',
      code: 'basic_group_has_grants',
    }),
    'basic_group_has_grants',
  );

/**
 * CCC service-bridge — NOT upstream Docmost code (wiki-v2 #797).
 *
 * The governed group control plane. In `AUTHZ_MODE=remote` the engine's native group admin routes are refused
 * (`authz/remote-refusal`), so these service-secret-guarded endpoints are the only way groups change; the platform
 * authorizes a workspace admin, applies its self-grant rules and audits BEFORE calling. Policy stays there; this class
 * enforces only the data invariants that must hold under the fork's own locks:
 *  - the workspace's default group is never renamed, joined, left or deleted here (409 `default_group_immutable`):
 *    only {@link ensureDefault} changes it, and only while it holds no grant (409 `basic_group_has_grants`, INV-5);
 *  - names are unique case-insensitively per workspace (409 `group_name_taken`, serialized on a per-workspace advisory
 *    lock — the table's own unique key is case-sensitive);
 *  - a group that grants anything (a live space membership or a page grant) is not deleted (409 `group_in_use`), so a
 *    delete never narrows access;
 *  - members are users only, named by externalId and provisioned as shadow users exactly as a space add does.
 *
 * Projection: `group_users` carries the fork's outbox trigger (`authz-outbox.installer.ts`), so every insert and delete
 * here reaches the PDP as `GroupMemberChanged` through the same relay as the native group service's writes (which use
 * the same plain inserts/deletes). A member removal is a narrowing route (`authz/live-access/narrowing-routes.ts`): it
 * answers only once the PDP enforces it, and live connections are re-checked. A busy engine is a retryable 503.
 */
@Injectable()
export class ServiceGroupService {
  private readonly logger = new Logger(ServiceGroupService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaces: WorkspaceResolver,
    private readonly bridge: ServiceBridgeService,
  ) {}

  // ---- reads ---------------------------------------------------------------------------------------------------

  /**
   * The live groups of the workspace, the default first, then by name. `q` filters by a case-insensitive name
   * substring (LIKE metacharacters are matched literally); `limit` caps the rows (1..200; default: all).
   */
  async list(opts: { q?: string; limit?: number } = {}): Promise<GroupView[]> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const q = opts.q?.trim();
    const pattern = q ? `%${escapeLike(q)}%` : null;
    const res = await sql<GroupRow>`
      select g.id, g.name, g.description, g.is_default, g.created_at,
             (select count(*)::int from group_users gu where gu.group_id = g.id) as member_count
      from groups g
      where g.workspace_id = ${workspaceId} and g.deleted_at is null
        ${pattern ? sql`and g.name ilike ${pattern}` : sql``}
      order by g.is_default desc, lower(g.name) asc, g.id asc
      ${opts.limit !== undefined ? sql`limit ${opts.limit}` : sql``}
    `.execute(this.db);
    return res.rows.map(toView);
  }

  async get(groupId: string): Promise<GroupView> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const row = await this.readGroup(this.db, workspaceId, groupId);
    if (!row) throw groupNotFound();
    return toView(row);
  }

  /** A group's members, as Docmost user ids. Opt-in keyset paging on `(created_at, id)`, as for space members. */
  async listMembers(groupId: string, page?: SubCollectionPage): Promise<RawGroupMember[]> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    if (!(await this.readGroup(this.db, workspaceId, groupId))) throw groupNotFound();
    const paged = page?.limit !== undefined;
    const conds = [sql`gu.group_id = ${groupId}`];
    if (paged && page!.before) {
      conds.push(
        sql`(date_trunc('milliseconds', gu.created_at), gu.id::text) > (${page!.before.createdAt}::timestamptz, ${page!.before.id}::text)`,
      );
    }
    const order = paged
      ? sql`order by date_trunc('milliseconds', gu.created_at) asc, gu.id::text asc`
      : sql`order by gu.created_at asc, gu.id asc`;
    const res = await sql<{ id: string; userId: string; email: string | null; createdAt: Date }>`
      select gu.id, gu.user_id, u.email, gu.created_at
      from group_users gu left join users u on u.id = gu.user_id
      where ${sql.join(conds, sql` and `)}
      ${order}
      ${paged ? sql`limit ${page!.limit! + 1}` : sql``}
    `.execute(this.db);
    return res.rows.map((r) => ({
      memberId: r.id,
      userId: r.userId,
      externalId: externalIdOfShadow(r.email),
      addedAt: iso(r.createdAt),
    }));
  }

  /** The live groups one identity is in (looked up, never provisioned; no shadow user means no groups). */
  async lookupMemberships(externalId: string): Promise<{ groups: GroupMembershipSummary[] }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const userId = await this.bridge.findShadowUserId(externalId);
    if (userId === null) return { groups: [] };
    const res = await sql<GroupMembershipSummary>`
      select g.id, g.name, g.is_default from group_users gu
      join groups g on g.id = gu.group_id
      where gu.user_id = ${userId} and g.workspace_id = ${workspaceId} and g.deleted_at is null
      order by g.is_default desc, lower(g.name) asc, g.id asc
    `.execute(this.db);
    return { groups: res.rows.map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault === true })) };
  }

  /** What the group grants through the fork's rows (live space memberships, page grants). 404 when no such group. */
  async usage(groupId: string): Promise<GroupUsage> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    if (!(await this.readGroup(this.db, workspaceId, groupId))) throw groupNotFound();
    const spaces = await sql<{ spaceId: string; memberId: string; role: string }>`
      select space_id, id as member_id, role from space_members
      where group_id = ${groupId} and deleted_at is null
      order by space_id asc, id asc
    `.execute(this.db);
    const pages = await sql<{ pageId: string; permissionId: string; role: string }>`
      select pa.page_id, pp.id as permission_id, pp.role from page_permissions pp
      join page_access pa on pa.id = pp.page_access_id
      where pp.group_id = ${groupId}
      order by pa.page_id asc, pp.id asc
    `.execute(this.db);
    return {
      spaces: spaces.rows.map((r) => ({ spaceId: r.spaceId, memberId: r.memberId, role: r.role })),
      pages: pages.rows.map((r) => ({ pageId: r.pageId, permissionId: r.permissionId, role: r.role })),
    };
  }

  // ---- writes --------------------------------------------------------------------------------------------------

  /** Create a group (never a default one). 409 `group_name_taken` on a case-insensitive clash. */
  async create(dto: CreateGroupDto): Promise<GroupView> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const { userId: creatorId } = await this.bridge.provisionShadowUser({ externalId: dto.actorExternalId });
    return this.tx(async (trx) => {
      await this.lockNames(trx, workspaceId);
      await this.assertNameFree(trx, workspaceId, dto.name, null);
      const res = await sql<GroupRow>`
        insert into groups (name, description, is_default, workspace_id, creator_id)
        values (${dto.name}, ${dto.description ?? null}, false, ${workspaceId}, ${creatorId})
        returning id, name, description, is_default, created_at, 0 as member_count
      `.execute(trx);
      return toView(res.rows[0]);
    });
  }

  /** Rename / re-describe a group. Never the default group (409). */
  async update(groupId: string, dto: UpdateGroupDto): Promise<GroupView> {
    if (dto.name === undefined && dto.description === undefined) throw new BadRequestException('nothing to update');
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    return this.tx(async (trx) => {
      if (dto.name !== undefined) await this.lockNames(trx, workspaceId);
      await this.lockGroup(trx, workspaceId, groupId);
      if (dto.name !== undefined) await this.assertNameFree(trx, workspaceId, dto.name, groupId);
      const sets = [sql`updated_at = now()`];
      if (dto.name !== undefined) sets.push(sql`name = ${dto.name}`);
      if (dto.description !== undefined) sets.push(sql`description = ${dto.description === '' ? null : dto.description}`);
      await sql`update groups set ${sql.join(sets, sql`, `)} where id = ${groupId}`.execute(trx);
      return toView((await this.readGroup(trx, workspaceId, groupId)) as GroupRow);
    });
  }

  /**
   * Add 1..200 identities to a group (never the default group). Each is resolved to its shadow user — provisioned
   * when absent, exactly as a space add does — before the transaction; the inserts are `ON CONFLICT DO NOTHING`, so a
   * repeat is a no-op and reports `added: false`.
   */
  async addMembers(groupId: string, dto: AddGroupMembersDto): Promise<AddedGroupMembers> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    // Fast 404/409 before provisioning anyone (re-checked under the lock below).
    const pre = await this.readGroup(this.db, workspaceId, groupId);
    if (!pre) throw groupNotFound();
    if (pre.isDefault) throw defaultGroupImmutable();
    const resolved = await this.resolveUsers(dto.externalIds);
    return this.tx(async (trx) => {
      await this.lockGroup(trx, workspaceId, groupId);
      const inserted = await this.insertMembers(trx, groupId, resolved.map((r) => r.userId));
      return {
        added: resolved.filter((r) => inserted.has(r.userId)).map((r) => r.externalId),
        alreadyMember: resolved.filter((r) => !inserted.has(r.userId)).map((r) => r.externalId),
      };
    });
  }

  /**
   * Remove one identity from a group (never the default group). A NARROWING route: it answers once the PDP enforces
   * the removal (`Authz-Propagation`), and live connections are re-checked. Idempotent: `removed: false` when the
   * identity was not a member (or has no shadow user — then it is in no group; nothing is created to find out).
   */
  async removeMember(groupId: string, externalId: string): Promise<{ removed: boolean }> {
    if (!EXTERNAL_ID.test(externalId)) throw new BadRequestException('externalId must be 1-128 chars of [A-Za-z0-9._+-]');
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const userId = await this.bridge.findShadowUserId(externalId);
    return this.tx(async (trx) => {
      await this.lockGroup(trx, workspaceId, groupId);
      if (userId === null) return { removed: false };
      const res = await sql<{ id: string }>`
        delete from group_users where group_id = ${groupId} and user_id = ${userId} returning id
      `.execute(trx);
      return { removed: res.rows.length > 0 };
    });
  }

  /**
   * Delete a group (never the default group). 409 `group_in_use` while any live space membership or page grant names
   * it — checked under the group row lock, which every grant insert's foreign key waits for — so a delete never takes
   * access away through the fork's rows. Its memberships go with it (the outbox records each removal).
   */
  async delete(groupId: string): Promise<void> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    await this.tx(async (trx) => {
      await this.lockGroup(trx, workspaceId, groupId);
      const counts = await groupGrantCounts(trx, groupId);
      if (hasGrants(counts)) throw groupInUse(counts.spaceRows, counts.pageRows);
      await sql`delete from groups where id = ${groupId} and workspace_id = ${workspaceId}`.execute(trx);
    });
  }

  /**
   * The baseline group (INV-5). Under the default group's row lock: refuse (409 `basic_group_has_grants`, logged
   * `BASIC_GROUP_HAS_GRANTS`, nothing written) while any live space membership or page grant names it; otherwise set
   * its name/description to the integrator's text (when different; 409 `group_name_taken` if another group has the
   * name) and insert each identity `ON CONFLICT DO NOTHING`, shadow users provisioned as a space add does. Idempotent.
   * The integrator checks its own grants naming the group (role bindings) before it calls.
   */
  async ensureDefault(dto: EnsureDefaultGroupDto): Promise<EnsuredDefaultGroup> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const pre = await findDefaultGroup(this.db, workspaceId);
    if (!pre) {
      throw refusal(
        new NotFoundException({ message: 'the workspace has no default group', code: 'default_group_missing' }),
        'default_group_missing',
      );
    }
    // Fast refusal before provisioning anyone (re-checked under the lock below).
    await this.assertNoGrants(this.db, pre.id);
    const resolved = await this.resolveUsers(dto.externalIds);
    const description = dto.description === undefined || dto.description === '' ? null : dto.description;
    return this.tx(async (trx) => {
      await this.lockNames(trx, workspaceId);
      const group = await findDefaultGroup(trx, workspaceId, { lock: true });
      if (!group) throw new NotFoundException({ message: 'the workspace has no default group', code: 'default_group_missing' });
      await this.assertNoGrants(trx, group.id);
      const renamed = group.name !== dto.name || (group.description ?? null) !== description;
      if (renamed) {
        await this.assertNameFree(trx, workspaceId, dto.name, group.id);
        await sql`
          update groups set name = ${dto.name}, description = ${description}, updated_at = now() where id = ${group.id}
        `.execute(trx);
      }
      const inserted = await this.insertMembers(trx, group.id, resolved.map((r) => r.userId));
      return {
        groupId: group.id,
        renamed,
        added: resolved.filter((r) => inserted.has(r.userId)).map((r) => r.externalId),
      };
    });
  }

  // ---- helpers -------------------------------------------------------------------------------------------------

  private async assertNoGrants(ex: KyselyDB | KyselyTransaction, groupId: string): Promise<void> {
    const counts = await groupGrantCounts(ex, groupId);
    if (!hasGrants(counts)) return;
    this.logger.warn(
      `${BASIC_GROUP_HAS_GRANTS} group=${groupId} spaceRows=${counts.spaceRows} pageRows=${counts.pageRows}: ` +
        `the default group holds access; ensure refused (409), nothing written`,
    );
    throw basicGroupHasGrants();
  }

  /** Each externalId's shadow user: looked up in one query, the missing ones provisioned (bounded concurrency). */
  private async resolveUsers(externalIds: string[]): Promise<{ externalId: string; userId: string }[]> {
    const unique = [...new Set(externalIds)];
    if (unique.length === 0) return [];
    const found = await this.bridge.lookupShadowUserIds(unique);
    const out = new Map<string, string>();
    const missing: string[] = [];
    for (const f of found) {
      if (f.userId) out.set(f.externalId, f.userId);
      else missing.push(f.externalId);
    }
    for (let i = 0; i < missing.length; i += PROVISION_CONCURRENCY) {
      const batch = missing.slice(i, i + PROVISION_CONCURRENCY);
      const made = await Promise.all(batch.map((externalId) => this.bridge.provisionShadowUser({ externalId })));
      batch.forEach((externalId, j) => out.set(externalId, made[j].userId));
    }
    return unique.map((externalId) => ({ externalId, userId: out.get(externalId) as string }));
  }

  /** Insert memberships `ON CONFLICT DO NOTHING`; answers the user ids that were newly added. */
  private async insertMembers(trx: KyselyTransaction, groupId: string, userIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Set();
    const res = await sql<{ userId: string }>`
      insert into group_users (user_id, group_id)
      values ${sql.join(unique.map((userId) => sql`(${userId}, ${groupId})`))}
      on conflict (group_id, user_id) do nothing
      returning user_id
    `.execute(trx);
    return new Set(res.rows.map((r) => r.userId));
  }

  private async readGroup(
    ex: KyselyDB | KyselyTransaction,
    workspaceId: string,
    groupId: string,
  ): Promise<GroupRow | undefined> {
    const res = await sql<GroupRow>`
      select g.id, g.name, g.description, g.is_default, g.created_at,
             (select count(*)::int from group_users gu where gu.group_id = g.id) as member_count
      from groups g
      where g.id = ${groupId} and g.workspace_id = ${workspaceId} and g.deleted_at is null
    `.execute(ex);
    return res.rows[0];
  }

  /** Lock the live, non-default group row `FOR UPDATE`: 404 `group_not_found`, 409 `default_group_immutable`. */
  private async lockGroup(trx: KyselyTransaction, workspaceId: string, groupId: string): Promise<void> {
    const res = await sql<{ id: string; isDefault: boolean }>`
      select id, is_default from groups
      where id = ${groupId} and workspace_id = ${workspaceId} and deleted_at is null
      for update
    `.execute(trx);
    const row = res.rows[0];
    if (!row) throw groupNotFound();
    if (row.isDefault) throw defaultGroupImmutable();
  }

  /** Serialize name changes per workspace (the case-insensitive uniqueness check reads, then writes). */
  private async lockNames(trx: KyselyTransaction, workspaceId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(${GROUP_NAME_LOCK}, hashtext(${workspaceId}))`.execute(trx);
  }

  private async assertNameFree(
    trx: KyselyTransaction,
    workspaceId: string,
    name: string,
    exceptGroupId: string | null,
  ): Promise<void> {
    const res = await sql`
      select 1 from groups
      where workspace_id = ${workspaceId} and lower(name) = lower(${name})
        ${exceptGroupId ? sql`and id <> ${exceptGroupId}` : sql``}
      limit 1
    `.execute(trx);
    if (res.rows.length > 0) throw nameTaken();
  }

  private async tx<T>(fn: (trx: KyselyTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction().execute(fn);
    } catch (err) {
      // The case-sensitive unique key (a race the advisory lock cannot see: a native write in native mode).
      if ((err as { code?: string })?.code === '23505') throw nameTaken();
      if ((err as { code?: string })?.code === '23503') throw groupNotFound();
      const busy = asEngineBusy(err);
      if (busy) {
        this.logger.warn(`GROUP_WRITE_BUSY code=${(err as { code?: string }).code}: answered 503 engine_busy`);
        throw busy;
      }
      throw err;
    }
  }
}

/** A LIKE pattern body that matches `q` literally (backslash is Postgres' default LIKE escape). */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => '\\' + c);
}

function toView(r: GroupRow): GroupView {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    isDefault: r.isDefault === true,
    memberCount: Number(r.memberCount ?? 0),
    createdAt: iso(r.createdAt),
  };
}
