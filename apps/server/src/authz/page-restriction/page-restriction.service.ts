import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { InsertablePagePermission, Page, User } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../core/casl/interfaces/space-ability.type';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { HttpAuthzClient } from '../http-authz.client';
import { WsService } from '../../ws/ws.service';
import {
  AddPagePermissionDto,
  PageGrantRole,
  RemovePagePermissionDto,
  RestrictionPreviewDto,
  UpdatePagePermissionDto,
} from './dto';
import {
  asEngineBusy,
  assertExpectedVersion,
  boundWaits,
  PreviewOutcome,
  PreviewRollback,
  refusal,
  refusalCodeOf,
} from '../../service-bridge/resource-version';
import { AclEffect, AclState, aclVersionOf, diffAcl, isNoop, noEffect, readAclState } from './acl-state';

/** A1 (#486): the 403 body carries a machine-readable `code`, the same one rule M uses on the bridge. */
const selfGrant = () =>
  refusal(
    new ForbiddenException({
      code: 'self_grant',
      message:
        'you cannot grant yourself, or a group you belong to, access to a page; another administrator must do this',
    }),
    'self_grant',
  );

/**
 * #616: the first half of the per-page ACL lock `pg_advisory_xact_lock(PAGE_ACL_LOCK_CLASS, hashtext(pageId))` — the
 * same two-int4 key form as the #485/#545 guards' per-workspace `(CYCLE_LOCK_CLASS = 485485, hashtext(ws))`, in a
 * class of its own (the single-bigint install locks live in a separate key space). Two pages whose ids collide in
 * `hashtext` only serialize; a transaction never takes two of these, so a collision cannot deadlock.
 */
export const PAGE_ACL_LOCK_CLASS = 616616;

/** `expectedVersion` for an ACL write: the page ACL version (`GET …/permissions` `version`), or `"*"`. */
export interface AclWriteOptions {
  expectedVersion?: string;
}

/** What an ACL write answers: the ACL's version AFTER the write (the next write's `expectedVersion`) and its effect. */
export interface AclWriteResult {
  version: string;
  effect: AclEffect;
}

/** What a preview answers. `version` is the CURRENT version (nothing was written). */
export interface AclPreviewResult {
  outcome: PreviewOutcome;
  code?: string;
  version: string;
  effect: AclEffect;
}

interface RunOptions {
  expectedVersion?: string;
  preview?: boolean;
}

interface AclRun {
  outcome: 'applied' | 'noop';
  version: string;
  versionBefore: string;
  effect: AclEffect;
  page: Page;
  /** Set by a restrict that wrote: the space whose socket.io restriction cache is dropped after the commit. */
  invalidateSpace?: string;
}

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The page-restriction WRITE feature (Docmost gates this behind EE and does not vendor the server
 * half here). It only writes Docmost's own `page_access` / `page_permissions` tables via the existing
 * repo methods; the platform's DB-trigger outbox then projects the change to SpiceDB (`#restricted` /
 * `#viewer` / `#editor`) — so NO SpiceDB/policy logic lives here. Managing restrictions is gated on
 * space-admin (`Manage` on space Settings); refine per product later.
 *
 * Self-dealing (#486) — restriction management must never become a way to reach content the actor could not
 * already see, on ANY path (native UI and the platform relay both land here):
 *   - A1: a grant or re-role that names the actor, or a group the actor is in, is refused (403 `self_grant`);
 *     revoking your own grant stays allowed.
 *   - A2: restrict keeps only the access the actor already had — the auto-grant role is decided from a STRICT
 *     PDP read before anything is written (remote mode; native keeps upstream's writer self-grant).
 *   - A3: an unrestrict carrying `requireActorCoverage` (the platform relay always sends it) is refused unless
 *     the actor can edit the page and no direct sub-page is unrestricted (it would be exposed). Without the
 *     flag — the native UI — unrestrict is unchanged: the human break-glass for an orphaned page.
 * The PDP is only ever asked space view/edit and page edit here — never `locked` (issue 499).
 *
 * Versioned writes (#616): each of the five writes is ONE transaction under a per-page ACL lock (`aclTx`), with every
 * repo write passed that transaction, so a write lands whole or not at all — outbox rows included, since the capture
 * trigger writes them in the same transaction. Inside it the ACL is re-read, its version compared with the caller's
 * optional `expectedVersion` (412 `precondition_failed`, nothing changed), and the write re-validated against what
 * the lock now protects (still restricted, grant still there, A3's children). The PDP reads (A2, A3) and the A1
 * group probe stay BEFORE the lock: no HTTP call is ever made while holding it. Each write answers the ACL's new
 * `version` and its `effect`; `preview` runs the same code and rolls it back.
 */
@Injectable()
export class PageRestrictionService {
  private readonly logger = new Logger(PageRestrictionService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly authz: HttpAuthzClient,
    // #501: the socket.io plane caches "does this space have ANY restriction" (Redis, 30 s) to decide whether
    // a tree/comment event may go to the whole space room. A space's FIRST restriction must drop that entry,
    // or the newly restricted page's titles and comment bodies keep going to every member for up to 30 s.
    // Optional only so the unit specs can omit it; the @Global WsModule always provides it in the app.
    @Optional() private readonly wsService?: WsService,
  ) {}

  private subject(user: User) {
    return { provider: 'docmost', externalId: user.id } as const;
  }

  /** A1: refuse a grant whose grantees include the actor (any case) or a group the actor belongs to. */
  private async refuseSelfGrant(user: User, userIds: string[], groupIds: string[]): Promise<void> {
    const me = user.id.toLowerCase();
    if (userIds.some((id) => id.toLowerCase() === me)) throw selfGrant();
    if (groupIds.length === 0) return;
    const mine = await this.db
      .selectFrom('groupUsers')
      .select('groupId')
      .where('userId', '=', user.id)
      .where('groupId', 'in', groupIds)
      .executeTakeFirst();
    if (mine) throw selfGrant();
  }

  /**
   * A2: the role the actor keeps on a page they are about to restrict — exactly the access they have now.
   * The page has no `page_access` row yet (restrict returns early otherwise), and an unrestricted page cannot
   * hold grants, so inside an unrestricted section the actor's page access IS their space access: space
   * view+edit → writer, view only → reader, neither → none. Under a restricted ancestor nobody but that
   * section's own grantees can see the page, so the actor keeps nothing. `hasRestrictedAncestor` reads the
   * local tables (read-only upstream repo use), so a freshly created page has no projection lag. A PDP error
   * refuses the restrict (503) before anything is written.
   */
  private async retainedRole(page: Page, user: User): Promise<PageGrantRole | null> {
    if (this.mode !== 'remote') return 'writer'; // native standalone: upstream behaviour, unchanged
    if (await this.pagePermissionRepo.hasRestrictedAncestor(page.id)) return null;
    const res = await this.authz.tryCheckBulk(this.subject(user), [
      { permission: 'view', resourceType: 'space', resourceId: page.spaceId },
      { permission: 'edit', resourceType: 'space', resourceId: page.spaceId },
    ]);
    if (!res) {
      throw new ServiceUnavailableException('authorization is unavailable; the page was not restricted — retry');
    }
    const [view, edit] = res;
    return view ? (edit ? 'writer' : 'reader') : null;
  }

  /**
   * A3 (a): may the actor edit the page right now? Remote: a STRICT PDP `page#edit` (no answer → 503, never a
   * guess). Native (no PDP; the platform never sends the flag there, but a caller may): upstream's own rule —
   * the actor already passed `authorize` (space admin ⊇ space edit), so it reduces to the page-level grant
   * when the page or an ancestor is restricted.
   */
  private async actorCanEdit(page: Page, user: User): Promise<boolean> {
    if (this.mode !== 'remote') {
      const r = await this.pagePermissionRepo.canUserEditPage(user.id, page.id);
      return !r.hasAnyRestriction || r.canEdit;
    }
    const res = await this.authz.tryCheckBulk(this.subject(user), [
      { permission: 'edit', resourceType: 'page', resourceId: page.id },
    ]);
    if (!res) {
      throw new ServiceUnavailableException('authorization is unavailable; the restriction was not removed — retry');
    }
    return res[0];
  }

  /** Load the page and enforce that `user` may manage its restrictions (space admin). */
  private async authorize(pageId: string, user: User): Promise<Page> {
    const page = await this.pageRepo.findById(pageId);
    if (!page) throw new NotFoundException('page not found');
    const ability = await this.spaceAbility.createForUser(user, page.spaceId);
    if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
      throw new ForbiddenException('only a space admin may manage page restrictions');
    }
    return page;
  }

  /** A pre-check (outside the transaction, today's 400): the write re-checks inside, under the lock. */
  private async requireAccessId(pageId: string): Promise<string> {
    const access = await this.pagePermissionRepo.findPageAccessByPageId(pageId);
    if (!access) throw notRestricted();
    return access.id;
  }

  /**
   * #616: one transaction per ACL write, serialized per page. Lock order (never a cycle with the #545 guards): this
   * page's ACL lock `(PAGE_ACL_LOCK_CLASS, hashtext(pageId))` FIRST — the only lock no guard takes — then, only if the
   * write inserts or updates `page_access`, g0's per-workspace `(CYCLE_LOCK_CLASS, hashtext(ws))`, then the foreign-key
   * `FOR KEY SHARE` on the page row, which never conflicts with the `FOR NO KEY UPDATE` a mover holds while it waits
   * for that workspace lock inside g1/g2. Nobody takes the ACL lock after the workspace lock (the guards never take
   * it), so no two transactions can wait on each other in a circle; the pg spec runs a restrict against a concurrent
   * move in the same workspace both ways round.
   *
   * The waits are bounded (`lock_timeout`, `statement_timeout`, set before the first lock); a lock not got in time, a
   * deadlock or a statement timeout is a retryable 503 `engine_busy` and the whole write rolls back. Every read the
   * write depends on runs INSIDE the transaction (never `this.db`, which would take a second pooled connection).
   * A preview runs the same function and rolls it back with a sentinel.
   */
  private async aclTx<T>(pageId: string, preview: boolean, fn: (trx: KyselyTransaction) => Promise<T>): Promise<T> {
    try {
      return await executeTx(this.db, async (trx) => {
        await boundWaits(trx);
        await sql`select pg_advisory_xact_lock(${sql.lit(PAGE_ACL_LOCK_CLASS)}, hashtext(${pageId}::text))`.execute(trx);
        const result = await fn(trx);
        if (preview) throw new PreviewRollback(result);
        return result;
      });
    } catch (err) {
      if (err instanceof PreviewRollback) return err.result as T;
      const busy = asEngineBusy(err);
      if (busy) {
        this.logger.warn(`PAGE_ACL_WRITE_BUSY code=${(err as { code?: string }).code}: answered 503 engine_busy`);
        throw busy;
      }
      throw err;
    }
  }

  /** The ACL as it is committed now (a refusal's current version, an already-restricted page's version). */
  private async committedAcl(pageId: string, workspaceId?: string) {
    const state = await readAclState(this.db, pageId, workspaceId);
    return { state, version: aclVersionOf(pageId, state) };
  }

  /**
   * Make a page restricted, granting the actor the access they already had (A2) so they don't lock themselves
   * out — and nothing more. The role is decided BEFORE any lock or write.
   */
  async restrict(pageId: string, user: User, opts: AclWriteOptions = {}): Promise<AclWriteResult> {
    return this.settle(await this.runRestrict(pageId, user, { expectedVersion: opts.expectedVersion }));
  }

  private async runRestrict(pageId: string, user: User, run: RunOptions): Promise<AclRun> {
    const page = await this.authorize(pageId, user);
    if (run.expectedVersion === undefined && (await this.pagePermissionRepo.findPageAccessByPageId(pageId))) {
      // Already restricted: nothing is written and the PDP is not asked (today's behaviour).
      const { state, version } = await this.committedAcl(page.id, page.workspaceId);
      return { outcome: 'noop', version, versionBefore: version, effect: noEffect(state), page };
    }
    const retained = await this.retainedRole(page, user);
    return this.aclTx(page.id, !!run.preview, async (trx) => {
      const before = await readAclState(trx, page.id, page.workspaceId);
      const versionBefore = aclVersionOf(page.id, before);
      assertExpectedVersion(run.expectedVersion, versionBefore);
      if (before.restricted) {
        return { outcome: 'noop' as const, version: versionBefore, versionBefore, effect: noEffect(before), page };
      }
      const access = await this.pagePermissionRepo.insertPageAccess(
        {
          pageId: page.id,
          workspaceId: page.workspaceId,
          spaceId: page.spaceId,
          accessLevel: 'members',
          creatorId: user.id,
        },
        trx,
      );
      if (retained && access) {
        await this.pagePermissionRepo.insertPagePermissions(
          [{ pageAccessId: access.id, userId: user.id, role: retained, addedById: user.id }],
          trx,
        );
      }
      const after = await readAclState(trx, page.id, page.workspaceId);
      return {
        outcome: 'applied' as const,
        version: aclVersionOf(page.id, after),
        versionBefore,
        effect: { ...diffAcl(before, after), restrictedAfter: true, retainedRole: retained },
        page,
        invalidateSpace: page.spaceId,
      };
    });
  }

  /**
   * Remove restriction — page_access delete cascades all grants (and the platform clears the tuples). With
   * `requireActorCoverage` (A3) it is refused unless the actor can edit the page (403) and every DIRECT
   * sub-page carries its own restriction (409): an unrestricted child of a restricted page is locked through
   * its parent and cannot hold grants of its own, so nobody can see it — lifting the parent would expose it.
   * Direct children suffice: a deeper page is unlocked only via an unrestricted chain, whose top is a direct
   * child. Trashed children count (they can be restored). The child check runs inside the transaction.
   */
  async unrestrict(
    pageId: string,
    user: User,
    opts: { requireActorCoverage?: boolean } & AclWriteOptions = {},
  ): Promise<AclWriteResult> {
    return this.settle(
      await this.runUnrestrict(pageId, user, opts.requireActorCoverage === true, { expectedVersion: opts.expectedVersion }),
    );
  }

  private async runUnrestrict(pageId: string, user: User, requireActorCoverage: boolean, run: RunOptions): Promise<AclRun> {
    const page = await this.authorize(pageId, user);
    if (requireActorCoverage) {
      if (!(await this.actorCanEdit(page, user))) {
        throw refusal(
          new ForbiddenException('you can only remove the restriction from a page you can edit'),
          'actor_cannot_edit',
        );
      }
    }
    return this.aclTx(page.id, !!run.preview, async (trx) => {
      const before = await readAclState(trx, page.id, page.workspaceId);
      const versionBefore = aclVersionOf(page.id, before);
      assertExpectedVersion(run.expectedVersion, versionBefore);
      if (requireActorCoverage) {
        const exposed = await trx
          .selectFrom('pages as c')
          .select('c.id')
          .where('c.parentPageId', '=', page.id)
          .where((eb) =>
            eb.not(eb.exists(eb.selectFrom('pageAccess as pa').select('pa.id').whereRef('pa.pageId', '=', 'c.id'))),
          )
          .limit(1)
          .executeTakeFirst();
        if (exposed) {
          throw refusal(
            new ConflictException(
              'the page has sub-pages that are not restricted; unrestricting it would expose them — restrict them first or use the wiki UI',
            ),
            'exposes_subpages',
          );
        }
      }
      await this.pagePermissionRepo.deletePageAccess(page.id, trx);
      const after = await readAclState(trx, page.id, page.workspaceId);
      return this.ran(page, before, after, versionBefore);
    });
  }

  /** Grant users/groups access to a restricted page (idempotent: replaces any existing grant). */
  async addPermission(dto: AddPagePermissionDto, user: User): Promise<AclWriteResult> {
    return this.settle(await this.runAddPermission(dto, user, { expectedVersion: dto.expectedVersion }));
  }

  private async runAddPermission(dto: AddPagePermissionDto, user: User, run: RunOptions): Promise<AclRun> {
    const page = await this.authorize(dto.pageId, user);
    await this.requireAccessId(dto.pageId);
    const userIds = dto.userIds ?? [];
    const groupIds = dto.groupIds ?? [];
    if (userIds.length === 0 && groupIds.length === 0) {
      throw new BadRequestException('userIds or groupIds required');
    }
    await this.refuseSelfGrant(user, userIds, groupIds);
    return this.aclTx(page.id, !!run.preview, async (trx) => {
      const before = await readAclState(trx, page.id, page.workspaceId);
      const versionBefore = aclVersionOf(page.id, before);
      assertExpectedVersion(run.expectedVersion, versionBefore);
      if (!before.accessId) throw notRestricted(); // lifted since the pre-check
      const accessId = before.accessId;
      // Replace any existing grant for these subjects so add is idempotent / doubles as a role change.
      await this.pagePermissionRepo.deletePagePermissionsByUserIds(accessId, userIds, trx);
      await this.pagePermissionRepo.deletePagePermissionsByGroupIds(accessId, groupIds, trx);
      const perms: InsertablePagePermission[] = [
        ...userIds.map((userId) => ({ pageAccessId: accessId, userId, role: dto.role, addedById: user.id })),
        ...groupIds.map((groupId) => ({ pageAccessId: accessId, groupId, role: dto.role, addedById: user.id })),
      ];
      await this.pagePermissionRepo.insertPagePermissions(perms, trx);
      const after = await readAclState(trx, page.id, page.workspaceId);
      return this.ran(page, before, after, versionBefore);
    });
  }

  /** Revoke users'/groups' access to a restricted page (revoking your own grant is always allowed). */
  async removePermission(dto: RemovePagePermissionDto, user: User): Promise<AclWriteResult> {
    return this.settle(await this.runRemovePermission(dto, user, { expectedVersion: dto.expectedVersion }));
  }

  private async runRemovePermission(dto: RemovePagePermissionDto, user: User, run: RunOptions): Promise<AclRun> {
    const page = await this.authorize(dto.pageId, user);
    await this.requireAccessId(dto.pageId);
    return this.aclTx(page.id, !!run.preview, async (trx) => {
      const before = await readAclState(trx, page.id, page.workspaceId);
      const versionBefore = aclVersionOf(page.id, before);
      assertExpectedVersion(run.expectedVersion, versionBefore);
      if (!before.accessId) throw notRestricted();
      if (dto.userIds?.length) {
        await this.pagePermissionRepo.deletePagePermissionsByUserIds(before.accessId, dto.userIds, trx);
      }
      if (dto.groupIds?.length) {
        await this.pagePermissionRepo.deletePagePermissionsByGroupIds(before.accessId, dto.groupIds, trx);
      }
      const after = await readAclState(trx, page.id, page.workspaceId);
      return this.ran(page, before, after, versionBefore);
    });
  }

  /**
   * Change a subject's role (reader ↔ writer) on a restricted page. #486: 404 when the subject holds no grant
   * here — upstream's `updatePagePermissionRole` returns void and cannot tell, so a PATCH for a non-grantee used
   * to answer success. The grant row is found and locked in this transaction, then updated by its id.
   */
  async updatePermission(dto: UpdatePagePermissionDto, user: User): Promise<AclWriteResult> {
    return this.settle(await this.runUpdatePermission(dto, user, { expectedVersion: dto.expectedVersion }));
  }

  private async runUpdatePermission(dto: UpdatePagePermissionDto, user: User, run: RunOptions): Promise<AclRun> {
    if (!dto.userId === !dto.groupId) {
      throw new BadRequestException('exactly one of userId or groupId is required');
    }
    const page = await this.authorize(dto.pageId, user);
    await this.refuseSelfGrant(user, dto.userId ? [dto.userId] : [], dto.groupId ? [dto.groupId] : []);
    await this.requireAccessId(dto.pageId);
    return this.aclTx(page.id, !!run.preview, async (trx) => {
      const before = await readAclState(trx, page.id, page.workspaceId);
      const versionBefore = aclVersionOf(page.id, before);
      assertExpectedVersion(run.expectedVersion, versionBefore);
      if (!before.accessId) throw notRestricted();
      const grant = await trx
        .selectFrom('pagePermissions')
        .select(['id', 'role'])
        .where('pageAccessId', '=', before.accessId)
        .$if(!!dto.userId, (q) => q.where('userId', '=', dto.userId!))
        .$if(!!dto.groupId, (q) => q.where('groupId', '=', dto.groupId!))
        .forUpdate()
        .executeTakeFirst();
      if (!grant) {
        throw refusal(new NotFoundException('no permission for this user or group on the page'), 'grant_not_found');
      }
      await trx
        .updateTable('pagePermissions')
        .set({ role: dto.role, updatedAt: new Date() })
        .where('id', '=', grant.id)
        .execute();
      const after = await readAclState(trx, page.id, page.workspaceId);
      return this.ran(page, before, after, versionBefore);
    });
  }

  /**
   * #616: what one of the five ACL writes WOULD do. It runs the real write — same authorization, same PDP reads, same
   * refusals, same locks, same triggers — inside a transaction it then rolls back, so nothing survives: no row, no
   * outbox row (so no SpiceDB write and no live-session revalidation), no notification-cache invalidation. The
   * `version` is the ACL's CURRENT version (what the real write's `expectedVersion` should carry). A state-dependent
   * refusal (self-grant, not restricted, the A3 checks, no such grant, a stale `expectedVersion`) is reported as
   * `{ outcome: 'refused', code }`; an authorization failure, a malformed body or a busy engine answers exactly as the
   * real route would.
   */
  async preview(dto: RestrictionPreviewDto, user: User): Promise<AclPreviewResult> {
    const run: RunOptions = { expectedVersion: dto.expectedVersion, preview: true };
    const needRole = () => {
      if (!dto.role) throw new BadRequestException('role is required');
      return dto.role;
    };
    try {
      let r: AclRun;
      switch (dto.action) {
        case 'restrict':
          r = await this.runRestrict(dto.pageId, user, run);
          break;
        case 'unrestrict':
          r = await this.runUnrestrict(dto.pageId, user, dto.requireActorCoverage === true, run);
          break;
        case 'add':
          r = await this.runAddPermission(
            { pageId: dto.pageId, role: needRole(), userIds: dto.userIds, groupIds: dto.groupIds },
            user,
            run,
          );
          break;
        case 'remove':
          r = await this.runRemovePermission({ pageId: dto.pageId, userIds: dto.userIds, groupIds: dto.groupIds }, user, run);
          break;
        case 'update':
          r = await this.runUpdatePermission(
            { pageId: dto.pageId, role: needRole(), userId: dto.userId, groupId: dto.groupId },
            user,
            run,
          );
          break;
        default:
          throw new BadRequestException('unknown action');
      }
      return { outcome: r.outcome === 'applied' ? 'would_apply' : 'noop', version: r.versionBefore, effect: r.effect };
    } catch (err) {
      const code = refusalCodeOf(err);
      if (!code) throw err;
      // Refusals happen only after `authorize` found the page, so it exists: report its current ACL.
      const page = await this.pageRepo.findById(dto.pageId);
      const { state, version } = await this.committedAcl(page?.id ?? dto.pageId, page?.workspaceId);
      return { outcome: 'refused', code, version, effect: noEffect(state) };
    }
  }

  private ran(page: Page, before: AclState, after: AclState, versionBefore: string): AclRun {
    const effect = diffAcl(before, after);
    return {
      outcome: isNoop(effect) ? 'noop' : 'applied',
      version: aclVersionOf(page.id, after),
      versionBefore,
      effect,
      page,
    };
  }

  /**
   * After the COMMIT: the socket.io plane's "does this space have any restriction" cache. Dropped only after a
   * restrict actually committed — inside the transaction a concurrent reader could re-cache the pre-commit answer —
   * and never for a preview (which never reaches here). A cache failure never fails the write (the entry expires).
   */
  private async settle(run: AclRun): Promise<AclWriteResult> {
    if (run.outcome === 'applied' && run.invalidateSpace) {
      await this.wsService?.invalidateSpaceRestrictionCache(run.invalidateSpace).catch(() => undefined);
    }
    return { version: run.version, effect: run.effect };
  }
}

/** A1/#486-style refusal: the page carries no restriction, so it has no grants to change. */
const notRestricted = () => refusal(new BadRequestException('page is not restricted'), 'not_restricted');
