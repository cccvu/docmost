import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import { maxCommittedPosition } from '../../service-bridge/authz-change-feed.service';
import { asEngineBusy, boundWaits, engineBusy } from '../../service-bridge/resource-version';
import { HttpAuthzClient } from '../http-authz.client';
import { OpSemaphore, OpSemaphoreTimeout } from '../page-write/op-semaphore';
import { pageEtagOpaque } from '../page-write/page-etag';
import { queuePageAttachmentDeletion } from './page-attachment-jobs';

/** Subtree recomputations under the locks before the purge gives up with a retryable 409. */
export const PURGE_MAX_PASSES = 3;
/** The longest the purge waits, holding its locks, for the platform to confirm the settle fence. */
export const PURGE_SETTLE_MAX_MS = 3000;
/** The platform's `/authz/check-bulk` caps `checks` at @ArrayMaxSize(256); larger subtrees are decided in chunks. */
export const PURGE_CHECK_CHUNK = 256;
/** Purges in flight per fork process (each holds a pooled connection and row locks), and how long one waits. */
export const PURGE_MAX_CONCURRENT = 2;
export const PURGE_SLOT_WAIT_MS = 2000;

/**
 * The settle wait: the SAME knob as the narrowing routes (`AUTHZ_NARROWING_SETTLE_TIMEOUT_MS`, parsed exactly as
 * `narrowingSettleTimeoutMs` in `live-access/narrowing-settle.interceptor.ts` — the spec cross-checks the two), capped
 * at {@link PURGE_SETTLE_MAX_MS}. `0` (the narrowing rollback switch) means no fence can be proven, so purges are
 * refused. Not imported: that module pulls the live-session revalidator's gateway graph into every importer.
 */
export function purgeSettleWaitMs(raw = process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS): number {
  const fallback = 3000;
  let ms = fallback;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    ms = Number.isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), 5000) : fallback;
  }
  return Math.min(ms, PURGE_SETTLE_MAX_MS);
}

export interface PurgeResult {
  /** The target row as locked (the audit's `before`). */
  page: Page;
  /** Every page the purge removed: the target and all its descendants, trashed ones included. */
  deletedIds: string[];
}

/** What the purge reads of the locked target: the ETag material and the audit payload. */
const TARGET_FIELDS = [
  'id',
  'slugId',
  'title',
  'spaceId',
  'workspaceId',
  'parentPageId',
  'updatedAt',
  'lastUpdatedById',
  'deletedAt',
  'content',
] as const;

export function purgeNeedsEdit(): ForbiddenException {
  return new ForbiddenException({
    message: 'a permanent delete needs edit access to every page it removes',
    code: 'purge_needs_edit',
  });
}

/** 503, retryable: the purge could not establish its authorization (fence unconfirmed, PDP unreachable). Nothing changed. */
export function purgeUnconfirmed(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: 'access changes could not be confirmed as enforced; nothing was deleted — retry shortly',
    code: 'purge_unconfirmed',
  });
}

/** 409, retryable: the subtree kept changing under the purge. Nothing changed. */
export function purgeSubtreeChanged(): ConflictException {
  return new ConflictException({
    message: 'the page tree changed while it was being deleted; nothing was deleted — retry',
    code: 'purge_subtree_changed',
  });
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
 *   slot (≤2 per process) → pre-check (404, space admin: a fast refusal that takes no lock) → BEGIN → SET LOCAL
 *   lock_timeout/statement_timeout → 1. lock the subtree → 2. 404 / ETag on the locked target → 3. settle fence →
 *   4. decide (space admin again, then `page#edit` on every locked id) → 5. `forceDelete(trx)` and verify the deleted
 *   set IS the locked set → COMMIT → attachment jobs → the native `page.deleted` audit.
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
 * 4. A page the PDP has not placed (a create in flight) has no `edit`, so it is refused — #524's rule. A PDP failure is
 *    distinguished from a deny (`tryCheckBulk`) and is a 503, never a 403 and never a pass.
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
   * Permanently delete `ref` (an id or slug) and its whole subtree for `user`, or refuse with nothing changed: 404
   * (missing, other workspace), 403 (not a space admin; `purge_needs_edit`), 412 (`expectedEtags` given and none
   * matches), 409 (`purge_subtree_changed`), 503 (`engine_busy`, `purge_unconfirmed`).
   */
  async purge(user: User, ref: string, workspaceId: string, expectedEtags?: string[]): Promise<PurgeResult> {
    const done = await this.run(async () => {
      const resolved = await this.pageRepo.findById(ref);
      if (!resolved || resolved.workspaceId !== workspaceId) throw new NotFoundException('Page not found');
      // Fast refusal before any lock: a caller who is not a space admin never holds the subtree or waits on a settle.
      await this.requireSpaceAdmin(user, resolved.spaceId);
      return this.inTx(async (trx) => {
        const ids = await this.lockSubtree(trx, resolved.id, workspaceId);
        const page = await this.readTarget(trx, resolved.id, workspaceId);
        if (!page || !ids.has(page.id)) throw new NotFoundException('Page not found');
        if (expectedEtags) assertExpected(expectedEtags, page);

        await this.fence(trx);
        // The authoritative decisions, on the settled PDP: the space-admin check again (the page may have moved, a
        // binding may have been revoked), then edit on every page the purge will remove.
        await this.requireSpaceAdmin(user, page.spaceId);
        await this.requireEditOnAll(user, [...ids].sort());

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

  /** The ids `forceDelete` would remove (its recursive walk: no workspace or trash filter), as of this statement. */
  protected async walk(trx: KyselyTransaction, rootId: string): Promise<string[]> {
    const rows = await trx
      .withRecursive('page_descendants', (db) =>
        db
          .selectFrom('pages')
          .select(['id'])
          .where('id', '=', rootId)
          .unionAll((exp) =>
            exp
              .selectFrom('pages as p')
              .select(['p.id'])
              .innerJoin('page_descendants as pd', 'pd.id', 'p.parentPageId'),
          ),
      )
      .selectFrom('page_descendants')
      .select(['id'])
      .execute();
    return rows.map((r) => r.id);
  }

  /** Step 1: lock every subtree row `FOR UPDATE` in id order, re-walking until the walk adds nothing; else 409. */
  protected async lockSubtree(trx: KyselyTransaction, rootId: string, workspaceId: string): Promise<Set<string>> {
    const locked = new Set<string>();
    let ids = await this.walk(trx, rootId);
    for (let pass = 1; ; pass++) {
      const fresh = ids.filter((id) => !locked.has(id));
      if (fresh.length > 0) {
        const rows = await trx
          .selectFrom('pages')
          .select(['id'])
          .where('id', 'in', fresh)
          .where('workspaceId', '=', workspaceId)
          .orderBy('id')
          .forUpdate()
          .execute();
        for (const r of rows) locked.add(r.id);
      }
      const again = await this.walk(trx, rootId);
      // Stable: every page the delete would now remove is locked (a row moved out meanwhile stays locked, harmlessly).
      if (again.every((id) => locked.has(id))) return new Set(again);
      if (pass >= PURGE_MAX_PASSES) {
        this.logger.warn(`REMOTE_PURGE_UNSTABLE page=${rootId} passes=${pass}: answered 409`);
        throw purgeSubtreeChanged();
      }
      ids = again;
    }
  }

  /** Step 2's read: the target as locked, workspace-scoped (trashed pages included — purging trash is the usual case). */
  protected async readTarget(trx: KyselyTransaction, id: string, workspaceId: string): Promise<Page | undefined> {
    return (await trx
      .selectFrom('pages')
      .select([...TARGET_FIELDS])
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst()) as Page | undefined;
  }

  /** Step 3: settle to the max committed outbox position read now (after the locks); anything but `confirmed` → 503. */
  protected async fence(trx: KyselyTransaction): Promise<void> {
    if (this.settleMs === 0) {
      this.logger.warn('REMOTE_PURGE_UNCONFIRMED reason=settle-disabled: answered 503');
      throw purgeUnconfirmed();
    }
    const position = await maxCommittedPosition(trx);
    const settled = await this.authz.settleProjection(position, this.settleMs);
    if (settled.status !== 'confirmed') {
      this.logger.warn(`REMOTE_PURGE_UNCONFIRMED reason=${settled.reason} position=${position}: answered 503`);
      throw purgeUnconfirmed();
    }
  }

  /** Upstream's purge requirement (space CASL `Manage Settings`), with upstream's refusal. */
  private async requireSpaceAdmin(user: User, spaceId: string): Promise<void> {
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
      throw new ForbiddenException('Only space admins can permanently delete pages');
    }
  }

  /** Step 4: an affirmative `page#edit` for the human on every id. A deny → 403; a failed or malformed answer → 503. */
  private async requireEditOnAll(user: User, ids: string[]): Promise<void> {
    const subject = { provider: 'docmost', externalId: user.id } as const;
    for (let i = 0; i < ids.length; i += PURGE_CHECK_CHUNK) {
      const batch = ids.slice(i, i + PURGE_CHECK_CHUNK);
      const results = await this.authz.tryCheckBulk(
        subject,
        batch.map((resourceId) => ({ permission: 'edit', resourceType: 'page', resourceId })),
      );
      if (results === null) {
        this.logger.warn(`REMOTE_PURGE_UNCONFIRMED reason=pdp-unavailable pages=${ids.length}: answered 503`);
        throw purgeUnconfirmed();
      }
      if (results.length !== batch.length || results.some((allowed) => allowed !== true)) throw purgeNeedsEdit();
    }
  }
}

/** `["*"]` passes on any row; otherwise one of the tags must equal the locked row's version (the conditional delete's compare). */
function assertExpected(expectedEtags: string[], page: Page): void {
  if (expectedEtags.length === 1 && expectedEtags[0] === '*') return;
  if (!expectedEtags.includes(pageEtagOpaque(page))) {
    throw new PreconditionFailedException({ message: 'page changed', code: 'precondition_failed' });
  }
}
