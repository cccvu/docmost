import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Page, User } from '@docmost/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../../core/page/services/page.service';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../core/casl/interfaces/space-ability.type';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';
import { QueueName } from '../../integrations/queue/constants';
import { getPageTitle } from '../../common/helpers';
import { asEngineBusy, boundWaits, engineBusy } from '../../service-bridge/resource-version';
import { AuthzSubject, HttpAuthzClient } from '../http-authz.client';
import { OpSemaphore, OpSemaphoreTimeout } from '../page-write/op-semaphore';
import { queuePageAttachmentDeletion } from './page-attachment-jobs';
import {
  assertExpectedEtags,
  lockSpacesShared,
  lockSubtree,
  readTarget,
  spacesOf,
  SUBTREE_MAX_PASSES,
} from './page-subtree';
import {
  decideAll,
  DECIDE_CHUNK,
  humanSubject,
  purgeSettleWaitMs,
  serviceSubject,
  settle,
  SETTLE_MAX_MS,
} from './page-delete-decision';
import {
  purgeNeedsEdit,
  purgeSubtreeChanged,
  purgeUnconfirmed,
  spaceAdminRequired,
  spaceArchived,
} from './page-delete-errors';

export { purgeSettleWaitMs } from './page-delete-decision';
export { purgeNeedsEdit, purgeSubtreeChanged, purgeUnconfirmed } from './page-delete-errors';

/** Subtree recomputations under the locks before the purge gives up with a retryable 409. */
export const PURGE_MAX_PASSES = SUBTREE_MAX_PASSES;
/** The longest the purge waits, holding its locks, for the platform to confirm the settle fence. */
export const PURGE_SETTLE_MAX_MS = SETTLE_MAX_MS;
/** The platform's `/authz/check-bulk` caps `checks` at @ArrayMaxSize(256); larger subtrees are decided in chunks. */
export const PURGE_CHECK_CHUNK = DECIDE_CHUNK;
/** Purges in flight per fork process (each holds a pooled connection and row locks), and how long one waits. */
export const PURGE_MAX_CONCURRENT = 2;
export const PURGE_SLOT_WAIT_MS = 2000;

export interface PurgeResult {
  /** The target row as locked (the audit's `before`). */
  page: Page;
  /** Every page the purge removed: the target and all its descendants, trashed ones included. */
  deletedIds: string[];
}

const sameSet = (a: readonly string[], b: ReadonlySet<string>) => a.length === b.size && a.every((id) => b.has(id));

/**
 * CCC authorization integration — NOT upstream Docmost code (#636 W6, ADR 0025).
 *
 * The ONE permanent-delete routine in `AUTHZ_MODE=remote`. Upstream gates a purge only on space CASL `Manage Settings`
 * — in remote `space#administer`, which a `manage_members`-only binding or a workspace `admin_cascade` also satisfies —
 * and `PageService.forceDelete` then removes the page AND every descendant. So a space administrator locked out of a
 * restricted page (or a restricted child under an editable parent) could irreversibly purge it. Here a purge also
 * needs an affirmative PDP `page#edit` for the human on EVERY page it removes, decided under locks after a settle
 * fence, so no access change can slip between the check and the delete:
 *
 *   slot (≤2 per process) → pre-check (404, space admin, the root's space archived → 409: fast refusals that take
 *   no lock) → BEGIN → SET LOCAL lock_timeout/statement_timeout → 1. lock the subtree → 2. 404 / ETag on the locked
 *   target → 2b. hold every space of the locked rows `FOR SHARE`; any archived → 409 `space_archived` → 3. settle
 *   fence → 4. decide (space CASL again; then for the human PDP `space#administer` on EVERY space of the subtree and
 *   `page#edit` on every locked id; then the same two for a delegated service account, when the platform named one)
 *   → 5. `forceDelete(trx)` and verify the deleted set IS the locked set → COMMIT → attachment jobs → the native
 *   `page.deleted` audit.
 *
 * 1. `SELECT … FOR UPDATE` every subtree row (the `forceDelete` walk, trashed pages included), in id order, then walk
 *    again under the locks; a new row (a child committed while we waited) is locked too, and a tree still changing
 *    after {@link PURGE_MAX_PASSES} walks is a retryable 409. FOR UPDATE — a deliberate exception to the #616 rule that
 *    a conditional op locks `FOR NO KEY UPDATE` — because it is the only row lock that conflicts with `FOR KEY SHARE`:
 *     - a restrict writes `page_access` (g0), whose foreign key takes `FOR KEY SHARE` on the page, so it waits for us;
 *     - a child insert or a move INTO the subtree takes `FOR KEY SHARE` on its new parent, so it waits for us — the
 *       parent foreign key's cascade would otherwise purge a child the decision never saw;
 *     - a move, re-parent or move-to-space OF a subtree page updates the row, so it waits for us.
 *    The `DELETE` takes this lock strength anyway; we only take it earlier, and in id order. The #616 deadlock that rule
 *    avoids needs a transaction that holds the row and THEN asks for g0/g1/g2's per-workspace advisory lock; a purge
 *    never asks for it (no trigger on a `pages` or `page_access` DELETE takes it — `remote-purge.pg.spec.ts` runs a
 *    restrict, a move and a child insert against a held purge), so a restrict holding that lock waits on us and never
 *    the reverse. Any other lock-order conflict ends in `lock_timeout` / a detected deadlock — a 503, never a partial
 *    purge. A grant or grant removal (`page_permissions`) takes no page lock: one committed before the fence is in the
 *    PDP's answer, one committed after it is ordered after the purge (step 3).
 * 3. `P` = the max COMMITTED outbox position, read AFTER the locks (ADR 0026 §4: never the xmin-gated head), then
 *    `POST /sync/settle` to `P`, bounded. Anything but `confirmed` is a 503: the delete cannot be undone, and trash
 *    still works. So every access change committed before the locks were held is enforced by the PDP when it is asked,
 *    and the locks stop any new one on these pages; a change committed after `P` on another object (a membership) is
 *    ordered after the purge — the semantics of every other check. While our transaction holds its xid, the relay
 *    cannot pass a row from a LATER transaction, so a busy outbox can make the fence time out: a 503, never a pass.
 * 2b. An archived space is frozen against irreversible removal (#589): a direct space admin keeps `edit` there, and a
 *    workspace admin's restore must bring the space back whole. `FOR SHARE` makes an archive that starts now wait for
 *    the purge; a page insert or move only takes `FOR KEY SHARE` on the space, which it does not block.
 * 4. A page the PDP has not placed (a create in flight) has no `edit`, so it is refused — #524's rule. A PDP failure is
 *    distinguished from a deny (`tryCheckBulk`) and is a 503, never a 403 and never a pass. A subtree can span spaces
 *    (a move-to-space leaves a page it skipped behind), so space admin is decided on EVERY space it touches (#618), by
 *    the PDP — not CASL, which turns a PDP outage into a 404. The service leg (#670, `acting-service.ts`) only narrows:
 *    it runs after every human check passed, so it is never consulted for a human the PDP denied.
 *
 * Upstream's space-admin check is kept, never replaced. Native mode never reaches this class: the native handler and
 * the conditional delete keep their upstream behaviour there. Entry points (`remote-purge.fitness.spec.ts` pins them):
 * `RemotePurgeInterceptor` (native `POST /api/pages/delete {permanentlyDelete:true}`) and
 * `ConditionalPageOpsController.conditionalDelete` (its permanent branch).
 */
@Injectable()
export class RemotePurgeService {
  private readonly logger = new Logger(RemotePurgeService.name);
  private readonly slots = new OpSemaphore(PURGE_MAX_CONCURRENT, PURGE_SLOT_WAIT_MS);
  private readonly settleMs = purgeSettleWaitMs();

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly authz: HttpAuthzClient,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE) private readonly attachmentQueue: Queue,
  ) {}

  /**
   * Permanently delete `ref` (an id or slug) and its whole subtree for `user` — and for the delegated service account
   * `serviceSubjectId`, when the platform named one — or refuse with nothing changed: 404 (missing, other workspace),
   * 403 (not a space admin of every space; `purge_needs_edit`), 409 (`space_archived`, `purge_subtree_changed`), 412
   * (`expectedEtags` given and none matches), 503 (`engine_busy`, `purge_unconfirmed`).
   */
  async purge(
    user: User,
    ref: string,
    workspaceId: string,
    expectedEtags?: string[],
    serviceSubjectId?: string,
  ): Promise<PurgeResult> {
    const done = await this.run(async () => {
      const resolved = await this.pageRepo.findById(ref);
      if (!resolved || resolved.workspaceId !== workspaceId) throw new NotFoundException('Page not found');
      // Fast refusals before any lock: a caller who is not a space admin never holds the subtree or waits on a
      // settle, and a purge in an archived space is refused outright (#589; re-checked under the locks below).
      await this.requireSpaceAdmin(user, resolved.spaceId);
      if (await this.rootSpaceArchived(resolved.spaceId, workspaceId)) {
        this.logger.warn(`REMOTE_PURGE_ARCHIVED page=${resolved.id} stage=pre-check: answered 409`);
        throw spaceArchived();
      }
      return this.inTx(async (trx) => {
        const rows = await lockSubtree(trx, resolved.id, workspaceId, 'update');
        if (rows === null) {
          this.logger.warn(`REMOTE_PURGE_UNSTABLE page=${resolved.id} passes=${PURGE_MAX_PASSES}: answered 409`);
          throw purgeSubtreeChanged();
        }
        const ids = new Set(rows.map((r) => r.id));
        const page = await readTarget(trx, resolved.id, workspaceId);
        if (!page || !ids.has(page.id)) throw new NotFoundException('Page not found');
        if (expectedEtags) assertExpectedEtags(expectedEtags, page);

        // Every space the subtree touches, held FOR SHARE until the commit: an archive waits for us (#589).
        const spaceIds = spacesOf(rows);
        const spaces = await lockSpacesShared(trx, spaceIds, workspaceId);
        if (spaces === null || spaces.some((s) => s.deletedAt != null)) {
          this.logger.warn(`REMOTE_PURGE_ARCHIVED page=${page.id} stage=locked: answered 409`);
          throw spaceArchived();
        }

        await this.fence(trx);
        // The authoritative decisions, on the settled PDP: upstream's space-admin check again (the page may have
        // moved, a binding may have been revoked), then for the human and then for the delegated service account:
        // space admin on EVERY space of the subtree (#618), and edit on every page the purge will remove.
        await this.requireSpaceAdmin(user, page.spaceId);
        const sortedIds = [...ids].sort();
        await this.requirePurgeRights(humanSubject(user), spaceIds, sortedIds, 'human');
        if (serviceSubjectId !== undefined) {
          await this.requirePurgeRights(serviceSubject(serviceSubjectId), spaceIds, sortedIds, 'service');
        }

        const deletedIds = await this.pageService.forceDelete(page.id, workspaceId, trx);
        if (!sameSet(deletedIds, ids)) {
          // Impossible while the locks hold; if it ever happens, nothing the decision did not cover may be removed.
          this.logger.error(
            `REMOTE_PURGE_SET_MISMATCH page=${page.id} locked=${ids.size} deleted=${deletedIds.length}: rolled back`,
          );
          throw purgeSubtreeChanged();
        }
        return { page, deletedIds };
      });
    });

    // AFTER the commit (forceDelete skips its jobs under a caller transaction; a job before a rollback would delete
    // the files of a page that survives), then the native handler's audit event, with its payload.
    await queuePageAttachmentDeletion(this.attachmentQueue, done.deletedIds, this.logger);
    const { page } = done;
    this.auditService.log({
      event: AuditEvent.PAGE_DELETED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      changes: {
        before: {
          pageId: page.id,
          slugId: page.slugId,
          title: getPageTitle(page.title),
          spaceId: page.spaceId,
        },
      },
    });
    return done;
  }

  /** One slot; busy SQLSTATEs and a full semaphore become a retryable 503. Every other error passes through. */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.slots.run(fn);
    } catch (err) {
      const busy = err instanceof OpSemaphoreTimeout ? engineBusy() : asEngineBusy(err);
      if (busy) {
        this.logger.warn(
          `REMOTE_PURGE_BUSY code=${(err as { code?: string }).code ?? (err as Error).name}: answered 503 engine_busy`,
        );
        throw busy;
      }
      throw err;
    }
  }

  /** One transaction, its waits bounded BEFORE the first lock (`lock_timeout` 2s, `statement_timeout` 15s). */
  protected inTx<T>(fn: (trx: KyselyTransaction) => Promise<T>): Promise<T> {
    return executeTx(this.db, async (trx) => {
      await boundWaits(trx);
      return fn(trx);
    });
  }

  /** The root's space is archived (or gone): read without a lock, a fast refusal only — re-checked under the locks. */
  private async rootSpaceArchived(spaceId: string, workspaceId: string): Promise<boolean> {
    const space = await this.db
      .selectFrom('spaces')
      .select(['deletedAt'])
      .where('id', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    return !space || space.deletedAt != null;
  }

  /** Step 3: settle to the max committed outbox position read now (after the locks); anything but `confirmed` → 503. */
  protected async fence(trx: KyselyTransaction): Promise<void> {
    const settled = await settle(this.authz, trx, this.settleMs);
    if (!settled.ok) {
      this.logger.warn(
        `REMOTE_PURGE_UNCONFIRMED reason=${settled.reason}${settled.position ? ` position=${settled.position}` : ''}: answered 503`,
      );
      throw purgeUnconfirmed();
    }
  }

  /** Upstream's purge requirement (space CASL `Manage Settings`), with upstream's refusal. */
  private async requireSpaceAdmin(user: User, spaceId: string): Promise<void> {
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
      throw spaceAdminRequired();
    }
  }

  /**
   * Step 4, for one subject: PDP `space#administer` on every space of the subtree (#618; a deny → upstream's 403), then
   * an affirmative `page#edit` on every id (a deny → 403 `purge_needs_edit`). A failed or malformed answer → 503.
   */
  private async requirePurgeRights(
    subject: AuthzSubject,
    spaceIds: string[],
    ids: string[],
    leg: 'human' | 'service',
  ): Promise<void> {
    const admin = await decideAll(this.authz, subject, 'administer', 'space', spaceIds);
    if (admin === 'unavailable') this.unavailable(leg, ids.length);
    if (admin === 'denied') throw spaceAdminRequired();
    const edit = await decideAll(this.authz, subject, 'edit', 'page', ids);
    if (edit === 'unavailable') this.unavailable(leg, ids.length);
    if (edit === 'denied') throw purgeNeedsEdit();
  }

  private unavailable(leg: 'human' | 'service', pages: number): never {
    this.logger.warn(`REMOTE_PURGE_UNCONFIRMED reason=pdp-unavailable leg=${leg} pages=${pages}: answered 503`);
    throw purgeUnconfirmed();
  }
}
