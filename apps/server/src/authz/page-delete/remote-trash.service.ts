import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Page, User } from '@docmost/db/types/entity.types';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../../core/page/services/page.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';
import { getPageTitle } from '../../common/helpers';
import { asEngineBusy, boundWaits } from '../../service-bridge/resource-version';
import { HttpAuthzClient } from '../http-authz.client';
import { assertExpectedEtags, lockSubtree, readTarget, SUBTREE_MAX_PASSES, walkLive } from './page-subtree';
import { Decision, decideAll, humanSubject, purgeSettleWaitMs, serviceSubject, settle } from './page-delete-decision';
import { trashNeedsEdit, trashSubtreeChanged, trashUnconfirmed } from './page-delete-errors';

export type TrashOutcome = 'applied' | 'noop';

export interface TrashResult {
  outcome: TrashOutcome;
  /** The target row as locked (the audit's `before`). */
  page: Page;
}

/** One attempt's verdict: done (applied or noop), or denied (rolled back; the caller may fence and retry once). */
type Attempt = { kind: 'done'; result: TrashResult } | { kind: 'denied' };

/** Thrown inside the transaction to roll it back on a deny; never escapes this class. */
class TrashDenied extends Error {
  constructor() {
    super('trash denied');
    this.name = 'TrashDenied';
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const bs = new Set(b);
  return a.length === bs.size && a.every((id) => bs.has(id));
};

/**
 * CCC authorization integration — NOT upstream Docmost code (#661, #634; ADR 0026).
 *
 * The ONE trash routine in `AUTHZ_MODE=remote`. Upstream checks edit on the ROOT only, and `PageRepo.removePage` then
 * trashes every live descendant — restricted ones the caller cannot even view, ones left in another space by a
 * move-to-space, ones a delegated service account cannot edit — and the retention job later purges them with no
 * decision at all. Here a trash needs an affirmative PDP `page#edit` on EVERY page it trashes, for the human and for a
 * delegated service account the platform named (`acting-service.ts`, #670), and trashes exactly the pages decided:
 *
 *   pre-check (404; upstream's `validateCanEdit` on the root: a fast refusal that takes no lock) → BEGIN → SET LOCAL
 *   lock_timeout/statement_timeout → 1. lock the full subtree (trashed rows included) `FOR NO KEY UPDATE` → 2. the
 *   locked target: already trashed → `noop`; the ETag → 3. `live` = removePage's walk under the locks; a live page
 *   outside the locked set → 409 → 4. decide `page#edit` on `live` (the human, then the service account) →
 *   5. `removePage(trx, { pageIds: live })` trashes exactly those, and the trashed set must BE `live` → COMMIT →
 *   the native `page.trashed` audit.
 *
 * 1. `FOR NO KEY UPDATE` (the #616 rule; `FOR UPDATE` would block every restrict in the workspace behind g0's advisory
 *    lock, and could deadlock with a move). It excludes every other writer of these rows: a concurrent restore of a
 *    trashed descendant (which would make it live, and undecided) waits for us; so does a move of a subtree page.
 *    A restrict is NOT blocked: a trash is reversible, and a restriction that commits after the decision is ordered
 *    after the trash, as for every other eventual check (ADR 0026).
 * 4. A deny is never final on the first look: the PDP may simply not have caught up (a page created or unrestricted a
 *    moment ago). So the transaction rolls back, the PDP is settled to the max COMMITTED outbox position — read OUTSIDE
 *    any transaction (a transaction holding an xid holds the relay back) — and the attempt runs once more. Still denied
 *    → 403 `trash_needs_edit`; fence unconfirmed → 503 `trash_unconfirmed`; fence disabled (`0`) → 403. An allow is
 *    never fenced, so the happy path adds no latency. A PDP failure is a 503, never a 403 and never a pass.
 * 5. A child created during the trash, after the live walk, is left live under the trashed parent (upstream's restore
 *    re-roots such a page). Retention never purges a live page (`RemoteTrashRetentionService`).
 *
 * No slot semaphore (a trash holds its locks for one PDP round trip, like the native one). Busy SQLSTATEs are a
 * retryable 503 `engine_busy`. Native mode never reaches this class. Entry points (`remote-purge.fitness.spec.ts`
 * pins them): `RemotePurgeInterceptor` (native `POST /api/pages/delete`, trash branch) and
 * `ConditionalPageOpsController.conditionalDelete` (its remote trash branch).
 */
@Injectable()
export class RemoteTrashService {
  private readonly logger = new Logger(RemoteTrashService.name);
  private readonly settleMs = purgeSettleWaitMs();

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly pageAccessService: PageAccessService,
    private readonly authz: HttpAuthzClient,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  /**
   * Trash `ref` (an id or slug) and its live subtree for `user` — and for the delegated service account
   * `serviceSubjectId`, when the platform named one — or refuse with nothing changed: 404, 403 (upstream's root check;
   * `trash_needs_edit`), 409 (`trash_subtree_changed`), 412 (`expectedEtags` given and none matches), 503
   * (`engine_busy`, `trash_unconfirmed`). An already-trashed target is `noop` (no audit row).
   */
  async trash(
    user: User,
    ref: string,
    workspaceId: string,
    expectedEtags?: string[],
    serviceSubjectId?: string,
  ): Promise<TrashResult> {
    let result: TrashResult;
    try {
      const resolved = await this.pageRepo.findById(ref);
      if (!resolved || resolved.workspaceId !== workspaceId) throw new NotFoundException('Page not found');
      // Upstream's own check, on the root, as a fast refusal before any lock.
      await this.pageAccessService.validateCanEdit(resolved, user);

      let attempt = await this.attempt(user, resolved.id, workspaceId, expectedEtags, serviceSubjectId);
      if (attempt.kind === 'denied') {
        // Fence on deny only, OUTSIDE the transaction: the PDP may not have caught up with a change committed before.
        const settled = await settle(this.authz, this.db, this.settleMs);
        if (!settled.ok && settled.reason === 'settle-disabled') throw trashNeedsEdit();
        if (!settled.ok) {
          this.logger.warn(
            `REMOTE_TRASH_UNCONFIRMED reason=${settled.reason}${settled.position ? ` position=${settled.position}` : ''}: answered 503`,
          );
          throw trashUnconfirmed();
        }
        attempt = await this.attempt(user, resolved.id, workspaceId, expectedEtags, serviceSubjectId);
        if (attempt.kind === 'denied') throw trashNeedsEdit();
      }
      result = attempt.result;
    } catch (err) {
      const busy = asEngineBusy(err);
      if (busy) {
        this.logger.warn(
          `REMOTE_TRASH_BUSY code=${(err as { code?: string }).code ?? (err as Error).name}: answered 503 engine_busy`,
        );
        throw busy;
      }
      throw err;
    }

    if (result.outcome === 'applied') {
      // AFTER the commit: the native handler's audit event, with its payload, about the locked target.
      const { page } = result;
      this.auditService.log({
        event: AuditEvent.PAGE_TRASHED,
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
    }
    return result;
  }

  /** Steps 1–5 in one bounded transaction. A deny rolls it back and is answered as `{ kind: 'denied' }`. */
  private async attempt(
    user: User,
    pageId: string,
    workspaceId: string,
    expectedEtags: string[] | undefined,
    serviceSubjectId: string | undefined,
  ): Promise<Attempt> {
    try {
      const result = await executeTx(this.db, async (trx) => {
        await boundWaits(trx);
        return this.decideAndTrash(trx, user, pageId, workspaceId, expectedEtags, serviceSubjectId);
      });
      return { kind: 'done', result };
    } catch (err) {
      if (err instanceof TrashDenied) return { kind: 'denied' };
      throw err;
    }
  }

  private async decideAndTrash(
    trx: KyselyTransaction,
    user: User,
    pageId: string,
    workspaceId: string,
    expectedEtags: string[] | undefined,
    serviceSubjectId: string | undefined,
  ): Promise<TrashResult> {
    const rows = await lockSubtree(trx, pageId, workspaceId, 'noKeyUpdate');
    if (rows === null) {
      this.logger.warn(`REMOTE_TRASH_UNSTABLE page=${pageId} passes=${SUBTREE_MAX_PASSES}: answered 409`);
      throw trashSubtreeChanged();
    }
    const locked = new Set(rows.map((r) => r.id));
    const page = await readTarget(trx, pageId, workspaceId);
    if (!page || !locked.has(page.id)) throw new NotFoundException('Page not found');
    // Convergence before the compare: a retry of a trash that already committed is `noop`, never a 412.
    if (page.deletedAt) return { outcome: 'noop', page };
    if (expectedEtags) assertExpectedEtags(expectedEtags, page);

    const live = (await walkLive(trx, page.id)).sort();
    if (!live.every((id) => locked.has(id))) {
      // A live page the locks do not cover (a child committed after the last walk): decide nothing on a moving tree.
      this.logger.warn(`REMOTE_TRASH_UNSTABLE page=${page.id} stage=live-walk: answered 409`);
      throw trashSubtreeChanged();
    }

    // The human first; the service leg only narrows, so it is never asked about a human the PDP denied.
    if (this.verdict(await decideAll(this.authz, humanSubject(user), 'edit', 'page', live), 'human', live.length)) {
      throw new TrashDenied();
    }
    if (
      serviceSubjectId !== undefined &&
      this.verdict(await decideAll(this.authz, serviceSubject(serviceSubjectId), 'edit', 'page', live), 'service', live.length)
    ) {
      throw new TrashDenied();
    }

    const trashed = await this.pageService.removePage(page.id, user.id, workspaceId, trx, { pageIds: live });
    if (!sameSet(trashed, live)) {
      // Impossible while the locks hold; if it ever happens, nothing the decision did not cover may be trashed.
      this.logger.error(
        `REMOTE_TRASH_SET_MISMATCH page=${page.id} decided=${live.length} trashed=${trashed.length}: rolled back`,
      );
      throw trashSubtreeChanged();
    }
    return { outcome: 'applied', page };
  }

  /** True when denied (the caller rolls back); a PDP failure is a 503 right here. */
  private verdict(decision: Decision, leg: 'human' | 'service', pages: number): boolean {
    if (decision === 'unavailable') {
      this.logger.warn(`REMOTE_TRASH_UNCONFIRMED reason=pdp-unavailable leg=${leg} pages=${pages}: answered 503`);
      throw trashUnconfirmed();
    }
    return decision === 'denied';
  }
}
