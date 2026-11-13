import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Page, User } from '@docmost/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../core/casl/interfaces/space-ability.type';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';
import { getPageTitle } from '../../common/helpers';
import { asEngineBusy, boundWaits, engineBusy } from '../../service-bridge/resource-version';
import { HttpAuthzClient } from '../http-authz.client';
import { OpSemaphore, OpSemaphoreTimeout } from '../page-write/op-semaphore';
import { lockSubtree, readTarget, SUBTREE_MAX_PASSES, walkTrashBatch } from './page-subtree';
import { Decision, decideAll, humanSubject, purgeSettleWaitMs, serviceSubject, settle } from './page-delete-decision';
import { restoreGuardConflict, restoreNeedsEdit, restoreUnconfirmed } from './page-delete-errors';

export type RestoreOutcome = 'applied' | 'noop';

/**
 * Restore attempts in flight per fork process, and how long one waits for a slot (then a retryable 503 `engine_busy`).
 * Same reasoning and numbers as the trash (`TRASH_MAX_CONCURRENT`): each attempt holds a pooled connection, its
 * subtree's row locks and an xid across its PDP calls. The settle between the two attempts runs with no slot held.
 */
export const RESTORE_MAX_CONCURRENT = 2;
export const RESTORE_SLOT_WAIT_MS = 2000;

export interface RestoreResult {
  outcome: RestoreOutcome;
  /** The page as the native handler answers it, read after the commit (`findById(…, { includeHasChildren })`). */
  page: Page;
}

/** One attempt's verdict: done (applied or noop, with the locked target), or denied (rolled back). */
type Attempt = { kind: 'done'; outcome: RestoreOutcome; target: Page } | { kind: 'denied' };

/** Thrown inside the transaction to roll it back on a deny; never escapes this class. */
class RestoreDenied extends Error {
  constructor() {
    super('restore denied');
    this.name = 'RestoreDenied';
  }
}

/**
 * CCC authorization integration — NOT upstream Docmost code (#556; the fourth remote lifecycle routine, ADR 0033).
 *
 * The ONE restore routine in `AUTHZ_MODE=remote`. Upstream's `PageRepo.restorePage` un-trashes the root and EVERY
 * descendant — live ones, ones trashed with it, and ones trashed separately before — then detaches the root from a
 * trashed parent in a second statement, and upstream checks edit on the ROOT only. So the #545 g2 guard's refusal of
 * the detach left the un-trash committed (half-applied), a restore of a LIVE page un-trashed every trashed descendant,
 * and a restorer could bring back restricted sub-pages they cannot edit. Here a restore is atomic, brings back exactly
 * the pages trashed together with the root, and needs an affirmative PDP `page#edit` on EVERY one of them, for the
 * human and for a delegated service account the platform named (`acting-service.ts`) — the trash's rule (#661):
 *
 *   pre-check (404; upstream's space CASL Edit; upstream's `validateCanEdit` on the root: fast refusals that take no
 *   lock) → BEGIN → SET LOCAL lock_timeout/statement_timeout → 1. lock the full subtree (trashed rows included)
 *   `FOR NO KEY UPDATE` → 2. the locked target: live → `noop` → 3. `batch` = the pages the root's trash stamped
 *   (`walkTrashBatch`); a batch page outside the locked set → 503 → 4. decide `page#edit` on `batch` (the human, then
 *   the service account) → 5. `restorePage(trx, { pageIds: batch })` un-trashes exactly those still in the trash and
 *   detaches the root from a trashed parent, in the same transaction → COMMIT → the native `page.restored` audit.
 *
 * 1. `FOR NO KEY UPDATE` (the #616 rule). It excludes every other writer of these rows: a trash of an ancestor (its
 *    `lockSubtree` locks trashed rows too, so it locks our root) waits for us or we for it; so does a move of a subtree
 *    page. `restorePage` reads the root's parent AFTER these locks, through our transaction, so it sees a parent trash
 *    that committed while we waited and detaches. The detach's g2 trigger then takes the per-workspace advisory lock
 *    (485485) while we hold row locks; a move-to-space that holds that lock and then needs one of our rows deadlocks
 *    with us — Postgres aborts one side (40P01), which here is a retryable 503 `engine_busy`, nothing changed.
 * 3. A sub-page trashed on its own before the root carries another stamp, so it stays in the trash (it is listed as a
 *    trash root of its own, and restored by restoring it). A live root has no batch: restoring it changes nothing.
 * 4. A deny is fenced once OUTSIDE the transaction and retried, exactly as the trash does (a page created or
 *    unrestricted a moment ago may not be projected yet). Still denied → 403 `restore_needs_edit`; fence unconfirmed →
 *    503 `restore_unconfirmed`; fence disabled → 403. A PDP failure is a 503, never a 403 and never a pass.
 * 5. A g2 refusal (an unrestricted page leaving a trashed restricted parent) rolls the WHOLE restore back: 409
 *    `ccc_page_restriction_strip`, the code the platform already maps, with a restore-specific text. `restorePage`
 *    emits `PAGE_RESTORED` before our COMMIT (its listeners only enqueue jobs); a rollback after it is a refusal above.
 *
 * Native mode never reaches this class: the native handler keeps upstream's semantics (every descendant), now
 * all-or-nothing through seam #172. Entry point (`remote-purge.fitness.spec.ts` pins it): `RemotePurgeInterceptor`
 * (native `POST /api/pages/restore`, restore branch). /v1 and MCP relay that same route.
 */
@Injectable()
export class RemoteRestoreService {
  private readonly logger = new Logger(RemoteRestoreService.name);
  private readonly settleMs = purgeSettleWaitMs();
  private readonly slots = new OpSemaphore(RESTORE_MAX_CONCURRENT, RESTORE_SLOT_WAIT_MS);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly pageAccessService: PageAccessService,
    private readonly authz: HttpAuthzClient,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  /**
   * Restore `ref` (an id or slug) and the pages trashed with it for `user` — and for the delegated service account
   * `serviceSubjectId`, when the platform named one — or refuse with nothing changed: 404, 403 (upstream's checks;
   * `restore_needs_edit`), 409 (a page guard), 503 (`engine_busy`, `restore_unconfirmed`). A live target is `noop`
   * (no audit row). Either way the answer carries the page as the native handler returns it.
   */
  async restore(user: User, ref: string, workspaceId: string, serviceSubjectId?: string): Promise<RestoreResult> {
    let attempt: Attempt;
    let pageId: string;
    try {
      const resolved = await this.pageRepo.findById(ref);
      if (!resolved || resolved.workspaceId !== workspaceId) throw new NotFoundException('Page not found');
      // Upstream's own checks, in its order, as fast refusals before any lock.
      const ability = await this.spaceAbility.createForUser(user, resolved.spaceId);
      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) throw new ForbiddenException();
      await this.pageAccessService.validateCanEdit(resolved, user);
      pageId = resolved.id;

      attempt = await this.attempt(user, pageId, workspaceId, serviceSubjectId);
      if (attempt.kind === 'denied') {
        // Fence on deny only, OUTSIDE the transaction: the PDP may not have caught up with a change committed before.
        const settled = await settle(this.authz, this.db, this.settleMs);
        if (!settled.ok && settled.reason === 'settle-disabled') throw restoreNeedsEdit();
        if (!settled.ok) {
          this.logger.warn(
            `REMOTE_RESTORE_UNCONFIRMED reason=${settled.reason}${settled.position ? ` position=${settled.position}` : ''}: answered 503`,
          );
          throw restoreUnconfirmed();
        }
        attempt = await this.attempt(user, pageId, workspaceId, serviceSubjectId);
        if (attempt.kind === 'denied') throw restoreNeedsEdit();
      }
    } catch (err) {
      const busy = err instanceof OpSemaphoreTimeout ? engineBusy() : asEngineBusy(err);
      if (busy) {
        this.logger.warn(
          `REMOTE_RESTORE_BUSY code=${(err as { code?: string }).code ?? (err as Error).name}: answered 503 engine_busy`,
        );
        throw busy;
      }
      const conflict = restoreGuardConflict(err);
      if (conflict) {
        this.logger.warn(`REMOTE_RESTORE_GUARD_REFUSED code=${(conflict.getResponse() as { code: string }).code}: answered 409`);
        throw conflict;
      }
      throw err;
    }

    if (attempt.outcome === 'applied') {
      // AFTER the commit: the native handler's audit event, with its payload, about the locked target.
      const { target } = attempt;
      this.auditService.log({
        event: AuditEvent.PAGE_RESTORED,
        resourceType: AuditResource.PAGE,
        resourceId: target.id,
        spaceId: target.spaceId,
        changes: {
          after: {
            title: getPageTitle(target.title),
            spaceId: target.spaceId,
          },
        },
      });
    }
    // The native handler's answer, read after the commit.
    const page = await this.pageRepo.findById(pageId, { includeHasChildren: true });
    return { outcome: attempt.outcome, page };
  }

  /** Steps 1–5 in one bounded transaction, holding a slot. A deny rolls it back and is answered as `denied`. */
  private async attempt(
    user: User,
    pageId: string,
    workspaceId: string,
    serviceSubjectId: string | undefined,
  ): Promise<Attempt> {
    try {
      return await this.slots.run(() =>
        executeTx(this.db, async (trx) => {
          await boundWaits(trx);
          return this.decideAndRestore(trx, user, pageId, workspaceId, serviceSubjectId);
        }),
      );
    } catch (err) {
      if (err instanceof RestoreDenied) return { kind: 'denied' };
      throw err;
    }
  }

  private async decideAndRestore(
    trx: KyselyTransaction,
    user: User,
    pageId: string,
    workspaceId: string,
    serviceSubjectId: string | undefined,
  ): Promise<Attempt> {
    const rows = await lockSubtree(trx, pageId, workspaceId, 'noKeyUpdate');
    if (rows === null) {
      this.logger.warn(`REMOTE_RESTORE_UNSTABLE page=${pageId} passes=${SUBTREE_MAX_PASSES}: answered 503 engine_busy`);
      throw engineBusy();
    }
    const locked = new Set(rows.map((r) => r.id));
    const target = await readTarget(trx, pageId, workspaceId);
    if (!target || !locked.has(target.id)) throw new NotFoundException('Page not found');
    // A live page is not in the trash: nothing to restore, and its trashed descendants stay where they are.
    if (!target.deletedAt) return { kind: 'done', outcome: 'noop', target };

    const batch = (await walkTrashBatch(trx, target.id)).sort();
    if (!batch.every((id) => locked.has(id))) {
      // Impossible while the locks hold (the batch is part of the locked subtree); decide nothing on a moving tree.
      this.logger.warn(`REMOTE_RESTORE_UNSTABLE page=${target.id} stage=batch-walk: answered 503 engine_busy`);
      throw engineBusy();
    }

    // The human first; the service leg only narrows, so it is never asked about a human the PDP denied.
    if (this.verdict(await decideAll(this.authz, humanSubject(user), 'edit', 'page', batch), 'human', batch.length)) {
      throw new RestoreDenied();
    }
    if (
      serviceSubjectId !== undefined &&
      this.verdict(await decideAll(this.authz, serviceSubject(serviceSubjectId), 'edit', 'page', batch), 'service', batch.length)
    ) {
      throw new RestoreDenied();
    }

    // Restores only ids of `batch` still in the trash (never more), and detaches the root in this transaction.
    await this.pageRepo.restorePage(target.id, workspaceId, trx, { pageIds: batch });
    return { kind: 'done', outcome: 'applied', target };
  }

  /** True when denied (the caller rolls back); a PDP failure is a 503 right here. */
  private verdict(decision: Decision, leg: 'human' | 'service', pages: number): boolean {
    if (decision === 'unavailable') {
      this.logger.warn(`REMOTE_RESTORE_UNCONFIRMED reason=pdp-unavailable leg=${leg} pages=${pages}: answered 503`);
      throw restoreUnconfirmed();
    }
    return decision === 'denied';
  }
}
