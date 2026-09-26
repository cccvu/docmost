import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import {
  AddSpaceMemberDto,
  CreateSpaceDto,
  SPACE_ROLES,
  SpaceMemberPreviewDto,
  SpaceMemberRole,
  UpdateSpaceDto,
} from './dto/space-admin.dto';
import { SubCollectionPage } from './dto/sub-collection-page.dto';
import { ServiceBridgeService } from './service-bridge.service';
import { WorkspaceResolver } from './workspace-resolver';
import { shadowEmailFor } from './shadow-user';
import {
  asEngineBusy,
  assertExpectedVersion,
  boundWaits,
  memberRowVersion,
  PreviewOutcome,
  PreviewRollback,
  refusal,
  refusalCodeOf,
  spaceVersion,
} from './resource-version';
import {
  boundLedgerTx,
  IdempotencyLedgerService,
  idempotencyKeyReused,
  servicePrincipal,
} from '../authz/idempotency/idempotency-ledger.service';

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

/** #616: the space detail also carries its fork-issued `version` (see `resource-version.ts`). */
export interface SpaceDetailView extends SpaceView {
  version: string;
}

/**
 * A raw space_members row. The fork returns Docmost user/group ids ONLY; the platform maps user ids back to
 * its own identities (the real-email mapping never leaves the platform). #616: `version` is the membership's
 * version — what a role change or removal sends back as `expectedVersion`.
 */
export interface RawSpaceMember {
  memberId: string;
  userId: string | null;
  groupId: string | null;
  role: string;
  createdAt: string;
  version: string;
}

/** #616: what a member add / role change / removal WOULD do (`POST …/members/preview`). */
export interface SpaceMemberPreview {
  outcome: PreviewOutcome;
  code?: string;
  /** The membership's CURRENT version, or null when there is no membership row (an add of a non-member). */
  version: string | null;
  effect: {
    /** The live role now (null: not a live member). */
    roleBefore: string | null;
    /** The live role after (null: removed). Equals `roleBefore` when refused. */
    roleAfter: string | null;
    /** An add would first create the member's shadow account (the member has none yet). */
    provisionsAccount: boolean;
  };
}

/**
 * What a space create answers. `replayed` is present only on a KEYED create (#616): `false` when this call created the
 * space, `true` when it answers the space an earlier call with the same key created (nothing re-run).
 */
export interface CreatedSpace {
  id: string;
  slug: string;
  name: string | null;
  replayed?: boolean;
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
  updatedAt?: Date;
  deletedAt: Date | null;
  memberCount: string;
}

/** The space's version material, as `update … returning` / `select … for no key update` read it. */
interface SpaceVersionRow {
  id: string;
  name: string | null;
  slug: string;
  description: string | null;
  visibility: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** A `space_members` row as a versioned member write locks it. */
interface MemberRow {
  id?: string;
  userId: string | null;
  groupId: string | null;
  role: string;
  deletedAt: Date | null;
}

const SPACE_VERSION_COLUMNS = sql`id, name, slug, description, visibility, created_at, updated_at, deleted_at`;

const versionOfSpace = (r: SpaceVersionRow | SpaceRow): string =>
  spaceVersion({ ...r, updatedAt: r.updatedAt ?? null, archived: r.deletedAt != null });

const memberNotFound = () => refusal(new NotFoundException('member not found'), 'member_not_found');

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();

const LAST_ADMIN =
  'a space must keep at least one admin — promote another member to admin before demoting or removing this one';
const lastAdmin = () => refusal(new ConflictException(LAST_ADMIN), 'last_admin');

/** Rule M (#486) ranks: a missing or soft-deleted row is 0 (the upsert revives a soft-deleted row). */
const ROLE_RANK: Record<SpaceMemberRole, number> = { reader: 1, writer: 2, admin: 3 };
const rank = (role: string | null | undefined): number =>
  (SPACE_ROLES as readonly unknown[]).includes(role) ? ROLE_RANK[role as SpaceMemberRole] : 0;

/** The 403 body carries a machine-readable `code` the platform maps to its `self_grant` problem. */
const selfGrant = () =>
  refusal(
    new ForbiddenException({
      code: 'self_grant',
      message:
        'you cannot add yourself or raise a membership that includes you; another administrator must do this',
    }),
    'self_grant',
  );

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
 *
 * Versions (#616): the space detail and every membership carry a fork-issued `version` (`resource-version.ts`). A
 * space rename / archive and a member role change / removal take an optional `expectedVersion` (or `"*"`: it
 * exists), compared INSIDE the write's transaction after the row lock — the space row `FOR NO KEY UPDATE`, the member
 * row `FOR UPDATE`, as before — so the compare and the write are atomic: a stale version is a 412 `precondition_failed`
 * with nothing changed, checked before rule M and the last-admin guard. Only a compared write bounds its waits
 * (`lock_timeout`/`statement_timeout`); without `expectedVersion` every statement is exactly as before, and each write
 * now also answers the new version. A lock not got in time, a deadlock or a statement timeout is a retryable 503
 * `engine_busy`. `previewMember` runs the same decisions under the same locks and rolls back; it only LOOKS UP shadow
 * users (never provisions one) and writes nothing.
 */
@Injectable()
export class ServiceSpaceService {
  private readonly logger = new Logger(ServiceSpaceService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaces: WorkspaceResolver,
    private readonly bridge: ServiceBridgeService,
    private readonly ledger?: IdempotencyLedgerService, // #616 keyed create (appended)
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

  /** Space detail (workspace-scoped; 404 if not in this workspace), with its version (#616). */
  async getDetail(spaceId: string): Promise<SpaceDetailView> {
    const row = await this.loadSpaceRow(spaceId);
    return { ...this.toView(row), version: versionOfSpace(row) };
  }

  /**
   * Raw members of a space (the platform enriches user ids with its own identities). Opt-in keyset paging:
   * with `page.limit` the fork walks `(created_at, id)` ascending and returns up to limit+1 (so the platform
   * can detect hasMore + build the next cursor from the last kept row); without it the read is unpaged
   * (returns all — the backward-compatible default). The default (unpaged) query is unchanged.
   */
  async listMembers(spaceId: string, page?: SubCollectionPage): Promise<RawSpaceMember[]> {
    await this.loadSpaceRow(spaceId);
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
      // Only live rows are listed, so the membership is live.
      version: memberRowVersion(spaceId, { userId: r.userId, groupId: r.groupId, role: r.role, deletedAt: null }),
    }));
  }

  /**
   * Create a space + add the creator as its `admin` member, atomically in ONE transaction so BOTH the
   * spaces row and the initial space_members row fire the outbox capture together (the atomicity the SpiceDB
   * projection relies on). The creator's shadow user is resolved (provisioned if absent, idempotent) from
   * the opaque externalId.
   *
   * #616: with `idempotencyKey` (+ `idempotencyNamespace` + `fingerprint`) the create is KEYED — see `createKeyed`.
   * Without it, exactly the statements below (the response carries no `replayed`). `credentialId` is the service
   * credential that authenticated the call (ServiceAuthGuard); a keyed create refuses to run without it.
   */
  async create(input: CreateSpaceDto, credentialId?: string): Promise<CreatedSpace> {
    if (input.idempotencyKey !== undefined) return this.createKeyed(input, credentialId);
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

  /**
   * #616 — the KEYED create: a retry after a relay failure that followed the commit answers the space the first call
   * created instead of failing on its own slug (or creating a twin). One bounded transaction:
   *
   *   provision the creator (before, as unkeyed) → BEGIN → SET LOCAL timeouts → reserve the key in the ledger
   *     fresh    → the SAME two inserts as unkeyed → complete(slot, space.id) → COMMIT → `replayed: false`
   *     replay   → read that space (archived or not) → `replayed: true`; NOTHING re-runs (no insert, no member row,
   *                no outbox row — the platform skips its own grants on `replayed`)
   *     mismatch → 409 `idempotency_key_reused`, nothing written
   *
   * - No friendly slug pre-check: the retry of a committed create must reach the ledger, and its own space holds the
   *   slug. A slug taken by ANOTHER space surfaces as the unique index's 23505 → the same 409 as unkeyed, and the
   *   reservation rolls back with it.
   * - The creator's shadow user is provisioned before the transaction on every call, replays included, exactly as
   *   unkeyed: an idempotent upsert (same row, same `member` role; `users` carries no outbox trigger) — and its id is
   *   the acting human the key is bound to.
   * - The key is bound to (workspace, `servicePrincipal(credential, creator)`, `idempotencyNamespace`): another human,
   *   or the same human through another service credential, never reaches this entry.
   * - A lock not got within 2s (a same-key twin still in flight), a deadlock or a statement past 15s → 503 `engine_busy`.
   */
  private async createKeyed(input: CreateSpaceDto, credentialId?: string): Promise<CreatedSpace> {
    if (!this.ledger || !credentialId) {
      // Wiring bug (no ledger injected, or no authenticated credential on the request) — never create unrecorded.
      throw new InternalServerErrorException('keyed create unavailable: no idempotency ledger or service credential');
    }
    const ledger = this.ledger;
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const slug = input.slug ? input.slug.toLowerCase() : this.deriveSlug(input.name);
    if (!slug) {
      throw new BadRequestException('could not derive a valid slug from the name — provide a slug explicitly');
    }

    const { userId: creatorId } = await this.bridge.provisionShadowUser({
      externalId: input.creatorExternalId,
    });

    try {
      return await this.db.transaction().execute(async (trx) => {
        await boundLedgerTx(trx);
        const reservation = await ledger.reserve(trx, {
          workspaceId,
          principal: servicePrincipal(credentialId, creatorId),
          namespace: input.idempotencyNamespace as string,
          op: 'space.create',
          key: input.idempotencyKey as string,
          fingerprint: input.fingerprint as string,
        });
        if (reservation.outcome === 'mismatch') throw idempotencyKeyReused();
        if (reservation.outcome === 'replay') {
          const existing = await sql<{ id: string; slug: string; name: string | null }>`
            select id, slug, name from spaces where id = ${reservation.resourceId} and workspace_id = ${workspaceId}
          `.execute(trx);
          const space = existing.rows[0];
          if (!space) {
            throw new NotFoundException({
              message: 'the space created under this idempotency key no longer exists',
              code: 'idempotency_resource_gone',
            });
          }
          this.logger.log(`IDEMPOTENT_SPACE_CREATE_REPLAYED space=${space.id}: answered the space this key created`);
          return { id: space.id, slug: space.slug, name: space.name, replayed: true };
        }

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
        await ledger.complete(trx, reservation.slot, space.id);
        return { id: space.id, slug: space.slug, name: space.name, replayed: false };
      });
    } catch (e) {
      if ((e as { code?: string })?.code === '23505') {
        throw new ConflictException(`a space with the slug "${slug}" already exists`);
      }
      throw this.retryableIfBusy(e);
    }
  }

  /**
   * Rename / re-describe a space (never changes the slug — links are stable). Answers the space's new version. With
   * `expectedVersion` the space row is locked first and the version compared (412 when stale); without it, the one
   * UPDATE as before.
   */
  async update(spaceId: string, input: UpdateSpaceDto, expectedVersion?: string): Promise<{ version: string }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const fragments = [];
    if (input.name !== undefined) fragments.push(sql`name = ${input.name}`);
    if (input.description !== undefined) fragments.push(sql`description = ${input.description}`);
    if (fragments.length === 0) throw new BadRequestException('nothing to update');
    fragments.push(sql`updated_at = now()`);
    const write = async (ex: KyselyDB | KyselyTransaction) => {
      const res = await sql<SpaceVersionRow>`
        update spaces set ${sql.join(fragments, sql`, `)}
        where id = ${spaceId} and workspace_id = ${workspaceId} and deleted_at is null
        returning ${SPACE_VERSION_COLUMNS}
      `.execute(ex);
      if (res.rows.length === 0) throw new NotFoundException('space not found');
      return { version: versionOfSpace(res.rows[0]) };
    };
    if (expectedVersion === undefined) return this.busyAsRetryable(() => write(this.db));
    return this.versionedTx(true, async (trx) => {
      const row = await this.lockSpaceRow(trx, workspaceId, spaceId);
      if (!row || row.deletedAt != null) throw new NotFoundException('space not found');
      assertExpectedVersion(expectedVersion, versionOfSpace(row));
      return write(trx);
    });
  }

  /**
   * Archive (reversible soft-delete). The outbox drops `space#workspace`, severing the admin cascade. Answers the
   * archived space's version; `expectedVersion` as for `update`.
   */
  async archive(spaceId: string, expectedVersion?: string): Promise<{ version: string }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const write = async (ex: KyselyDB | KyselyTransaction) => {
      const res = await sql<SpaceVersionRow>`
        update spaces set deleted_at = now(), updated_at = now()
        where id = ${spaceId} and workspace_id = ${workspaceId} and deleted_at is null
        returning ${SPACE_VERSION_COLUMNS}
      `.execute(ex);
      if (res.rows.length === 0) throw new NotFoundException('space not found or already archived');
      return { version: versionOfSpace(res.rows[0]) };
    };
    if (expectedVersion === undefined) return this.busyAsRetryable(() => write(this.db));
    return this.versionedTx(true, async (trx) => {
      const row = await this.lockSpaceRow(trx, workspaceId, spaceId);
      if (!row || row.deletedAt != null) throw new NotFoundException('space not found or already archived');
      assertExpectedVersion(expectedVersion, versionOfSpace(row));
      return write(trx);
    });
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

  /**
   * Add (or re-add / re-role) a shadow user as a space member. The platform validates the identity first. Answers the
   * membership's version. No `expectedVersion`: there is no version before the add.
   */
  async addMember(
    spaceId: string,
    dto: AddSpaceMemberDto,
  ): Promise<{ memberId: string; userId: string; version: string }> {
    // Fast 404/400 BEFORE provisioning (no shadow user is created for a dead space); everything slow — the
    // workspace + both shadow users — is resolved before the transaction so the space lock is held briefly.
    await this.loadSpaceRow(spaceId, { activeOnly: true });
    const { userId: memberUserId } = await this.bridge.provisionShadowUser({ externalId: dto.externalId });
    const { userId: addedById } = await this.bridge.provisionShadowUser({
      externalId: dto.addedByExternalId,
    });
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    return this.versionedTx(false, async (trx) => {
      await this.lockSpace(trx, workspaceId, spaceId, true);
      await this.decideAdd(trx, spaceId, memberUserId, memberUserId === addedById, dto.role);
      const res = await sql<{ id: string }>`
        insert into space_members (user_id, space_id, role, added_by_id)
        values (${memberUserId}, ${spaceId}, ${dto.role}, ${addedById})
        on conflict (space_id, user_id) do update set role = excluded.role, deleted_at = null, updated_at = now()
        returning id
      `.execute(trx);
      return {
        memberId: res.rows[0].id,
        userId: memberUserId,
        version: memberRowVersion(spaceId, { userId: memberUserId, groupId: null, role: dto.role, deletedAt: null }),
      };
    });
  }

  /** Re-role a live member. Answers the membership's new version; `expectedVersion` compared under the row lock. */
  async changeMemberRole(
    spaceId: string,
    memberId: string,
    role: SpaceMemberRole,
    actorExternalId: string,
    expectedVersion?: string,
  ): Promise<{ version: string }> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    // Looked up, never provisioned: an actor with no shadow user cannot be covered by any membership row.
    const actorId = await this.bridge.findShadowUserId(actorExternalId);
    return this.versionedTx(expectedVersion !== undefined, async (trx) => {
      await this.lockSpace(trx, workspaceId, spaceId, true);
      const row = await this.decideRoleChange(trx, spaceId, memberId, role, actorId, expectedVersion);
      await sql`
        update space_members set role = ${role}, updated_at = now()
        where id = ${memberId} and space_id = ${spaceId}
      `.execute(trx);
      return { version: memberRowVersion(spaceId, { ...row, role, deletedAt: null }) };
    });
  }

  /** Remove a member. Allowed on an ARCHIVED space too (as before) — and still guarded: there a direct admin
   *  row is the only administer path left (the workspace cascade is severed), so orphaning it is worse.
   *  `expectedVersion` (a soft-deleted row's version says `live: false`) is compared under the row lock. */
  async removeMember(spaceId: string, memberId: string, expectedVersion?: string): Promise<void> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    await this.versionedTx(expectedVersion !== undefined, async (trx) => {
      await this.lockSpace(trx, workspaceId, spaceId, false);
      await this.decideRemove(trx, spaceId, memberId, expectedVersion);
      await sql`delete from space_members where id = ${memberId} and space_id = ${spaceId}`.execute(trx);
    });
  }

  /**
   * #616: what a member add / role change / removal WOULD do. The same decisions as the real write (rule M, the
   * last-admin guard, the version compare), in a transaction under the same locks, rolled back. Shadow users are only
   * LOOKED UP (`findShadowUserId`), never provisioned: an add of an identity with no shadow user yet reports
   * `provisionsAccount: true`, and rule M then compares the two identities by their shadow email, which is exactly how
   * provisioning would have resolved them. A state-dependent refusal is `{ outcome: 'refused', code }` (`self_grant`,
   * `last_admin`, `member_not_found`, `space_archived`, `precondition_failed`); a missing space is a 404 and a
   * malformed body a 400, as on the real route.
   */
  async previewMember(spaceId: string, dto: SpaceMemberPreviewDto): Promise<SpaceMemberPreview> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const need = <T>(v: T | undefined, name: string): T => {
      if (v === undefined || v === null) throw new BadRequestException(`${name} is required for action ${dto.action}`);
      return v;
    };
    let current: { version: string | null; role: string | null } = { version: null, role: null };
    try {
      switch (dto.action) {
        case 'add': {
          const externalId = need(dto.externalId, 'externalId');
          const addedByExternalId = need(dto.addedByExternalId, 'addedByExternalId');
          const role = need(dto.role, 'role');
          const memberUserId = await this.bridge.findShadowUserId(externalId);
          const addedById = await this.bridge.findShadowUserId(addedByExternalId);
          // Provisioning maps an externalId to ONE shadow user by its lower-cased shadow email.
          const isSelf =
            memberUserId !== null && addedById !== null
              ? memberUserId === addedById
              : shadowEmailFor(externalId) === shadowEmailFor(addedByExternalId);
          return await this.versionedTx(
            true,
            async (trx) => {
              await this.lockSpace(trx, workspaceId, spaceId, true);
              const live = memberUserId ? await this.liveUserRow(trx, spaceId, memberUserId) : undefined;
              const row = live && { userId: memberUserId, groupId: null, role: live.role, deletedAt: null };
              current = this.snapshotOf(spaceId, row);
              await this.decideAdd(trx, spaceId, memberUserId, isSelf, role);
              return this.previewOf(current, role, memberUserId === null);
            },
            true,
          );
        }
        case 'update': {
          const memberId = need(dto.memberId, 'memberId');
          const role = need(dto.role, 'role');
          const actorId = await this.bridge.findShadowUserId(need(dto.actorExternalId, 'actorExternalId'));
          return await this.versionedTx(
            true,
            async (trx) => {
              await this.lockSpace(trx, workspaceId, spaceId, true);
              current = this.snapshotOf(spaceId, await this.memberRow(trx, spaceId, memberId, true));
              await this.decideRoleChange(trx, spaceId, memberId, role, actorId, dto.expectedVersion);
              return this.previewOf(current, role, false);
            },
            true,
          );
        }
        case 'remove': {
          const memberId = need(dto.memberId, 'memberId');
          return await this.versionedTx(
            true,
            async (trx) => {
              await this.lockSpace(trx, workspaceId, spaceId, false);
              current = this.snapshotOf(spaceId, await this.memberRow(trx, spaceId, memberId, false));
              await this.decideRemove(trx, spaceId, memberId, dto.expectedVersion);
              // The row is deleted even when it was soft-deleted already (then only its version goes away).
              return { ...this.previewOf(current, null, false), outcome: 'would_apply' as const };
            },
            true,
          );
        }
        default:
          throw new BadRequestException('unknown action');
      }
    } catch (err) {
      const code = refusalCodeOf(err);
      if (!code) throw err;
      return {
        outcome: 'refused',
        code,
        version: current.version,
        effect: { roleBefore: current.role, roleAfter: current.role, provisionsAccount: false },
      };
    }
  }

  private snapshotOf(spaceId: string, row: MemberRow | undefined | null): { version: string | null; role: string | null } {
    if (!row) return { version: null, role: null };
    return { version: memberRowVersion(spaceId, row), role: row.deletedAt == null ? row.role : null };
  }

  private previewOf(
    current: { version: string | null; role: string | null },
    roleAfter: string | null,
    provisionsAccount: boolean,
  ): SpaceMemberPreview {
    return {
      outcome: current.role === roleAfter && !provisionsAccount ? 'noop' : 'would_apply',
      version: current.version,
      effect: { roleBefore: current.role, roleAfter, provisionsAccount },
    };
  }

  // ---- the member-write decisions, shared by the writes and the preview (the caller holds the space lock) --------

  /** An add (an upsert on (space, user)): rule M on the member's live row, then the last-admin guard. */
  private async decideAdd(
    trx: KyselyTransaction,
    spaceId: string,
    memberUserId: string | null,
    isSelf: boolean,
    role: SpaceMemberRole,
  ): Promise<void> {
    // The upsert re-roles an existing LIVE row, so it can demote the last admin like a PATCH can.
    const row = memberUserId ? await this.liveUserRow(trx, spaceId, memberUserId) : undefined;
    // Rule M: adding yourself, or raising your own row (a soft-deleted one ranks 0), is refused.
    if (isSelf && rank(role) > rank(row?.role)) throw selfGrant();
    if (row?.role === 'admin' && role !== 'admin') await this.assertAnotherAdmin(trx, spaceId, row.id);
  }

  /** A role change: the live row (404), the version compare (412), rule M (403), the last-admin guard (409). */
  private async decideRoleChange(
    trx: KyselyTransaction,
    spaceId: string,
    memberId: string,
    role: SpaceMemberRole,
    actorId: string | null,
    expectedVersion: string | undefined,
  ): Promise<MemberRow> {
    // `id AND space_id`: a memberId from another space is a 404 (never a cross-space write, and never
    // "not self" — the row must be found before rule M can be judged).
    const row = await this.memberRow(trx, spaceId, memberId, true);
    if (!row) throw memberNotFound();
    assertExpectedVersion(expectedVersion, memberRowVersion(spaceId, row));
    if (rank(role) > rank(row.role) && actorId !== null && (await this.covers(trx, row, actorId))) {
      throw selfGrant();
    }
    if (row.role === 'admin' && role !== 'admin') await this.assertAnotherAdmin(trx, spaceId, memberId);
    return row;
  }

  /** A removal: the row, live or soft-deleted (404), the version compare (412), the last-admin guard (409). */
  private async decideRemove(
    trx: KyselyTransaction,
    spaceId: string,
    memberId: string,
    expectedVersion: string | undefined,
  ): Promise<MemberRow> {
    const row = await this.memberRow(trx, spaceId, memberId, false);
    if (!row) throw memberNotFound();
    assertExpectedVersion(expectedVersion, memberRowVersion(spaceId, row));
    if (row.role === 'admin' && row.deletedAt == null) await this.assertAnotherAdmin(trx, spaceId, memberId);
    return row;
  }

  /** The member row by id AND space, locked `FOR UPDATE` (live rows only unless `liveOnly` is false). */
  private async memberRow(
    trx: KyselyTransaction,
    spaceId: string,
    memberId: string,
    liveOnly: boolean,
  ): Promise<MemberRow | undefined> {
    const cur = await sql<MemberRow>`
      select user_id, group_id, role, deleted_at from space_members
      where id = ${memberId} and space_id = ${spaceId}${liveOnly ? sql` and deleted_at is null` : sql``}
      for update
    `.execute(trx);
    return cur.rows[0];
  }

  /** A user's LIVE membership row in the space, locked `FOR UPDATE` (what the add upsert would re-role). */
  private async liveUserRow(
    trx: KyselyTransaction,
    spaceId: string,
    userId: string,
  ): Promise<{ id: string; role: string } | undefined> {
    const cur = await sql<{ id: string; role: string }>`
      select id, role from space_members
      where space_id = ${spaceId} and user_id = ${userId} and deleted_at is null
      for update
    `.execute(trx);
    return cur.rows[0];
  }

  /**
   * One transaction for a member / space write. `bounded` (a compared write, a preview) sets the lock and statement
   * timeouts first; without it the statements are exactly the pre-#616 ones. A busy-engine SQLSTATE becomes a
   * retryable 503 `engine_busy` (the transaction rolled back); a `preview` rolls back and hands its result out.
   */
  private async versionedTx<T>(
    bounded: boolean,
    fn: (trx: KyselyTransaction) => Promise<T>,
    preview = false,
  ): Promise<T> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        if (bounded) await boundWaits(trx);
        const result = await fn(trx);
        if (preview) throw new PreviewRollback(result);
        return result;
      });
    } catch (err) {
      if (err instanceof PreviewRollback) return err.result as T;
      throw this.retryableIfBusy(err);
    }
  }

  private async busyAsRetryable<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw this.retryableIfBusy(err);
    }
  }

  private retryableIfBusy(err: unknown): unknown {
    const busy = asEngineBusy(err);
    if (!busy) return err;
    this.logger.warn(`SPACE_WRITE_BUSY code=${(err as { code?: string }).code}: answered 503 engine_busy`);
    return busy;
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
    if (activeOnly && row.deletedAt != null) {
      throw refusal(new BadRequestException('space is archived'), 'space_archived');
    }
  }

  /** The space row with its version material, locked like `lockSpace` (#616: a compared rename / archive). */
  private async lockSpaceRow(
    trx: KyselyTransaction,
    workspaceId: string,
    spaceId: string,
  ): Promise<SpaceVersionRow | undefined> {
    const res = await sql<SpaceVersionRow>`
      select ${SPACE_VERSION_COLUMNS} from spaces where id = ${spaceId} and workspace_id = ${workspaceId}
      for no key update
    `.execute(trx);
    return res.rows[0];
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
    if ((res.rows[0]?.n ?? 0) === 0) throw lastAdmin();
  }

  /** Load a space scoped to the default workspace (404 if absent / wrong tenant / archived when activeOnly). */
  private async loadSpaceRow(spaceId: string, opts?: { activeOnly?: boolean }): Promise<SpaceRow> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const res = await sql<SpaceRow>`
      select s.id, s.name, s.slug, s.description, s.visibility, s.created_at, s.updated_at, s.deleted_at,
             (select count(*) from space_members sm where sm.space_id = s.id and sm.deleted_at is null) as member_count
      from spaces s where s.id = ${spaceId} and s.workspace_id = ${workspaceId}
    `.execute(this.db);
    const row = res.rows[0];
    if (!row) throw new NotFoundException('space not found');
    if (opts?.activeOnly && row.deletedAt != null) throw new BadRequestException('space is archived');
    return row;
  }
}
