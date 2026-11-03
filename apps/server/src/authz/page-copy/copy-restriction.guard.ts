import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import type { KyselyTransaction } from '@docmost/db/types/kysely.types';
import type { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import type { Page } from '@docmost/db/types/entity.types';
import { CYCLE_LOCK_CLASS } from '../../service-bridge/page-cycle-guard.installer';
import { lineageRestricted, readPageLineage } from '../../service-bridge/page-lineage';
import { asEngineBusy, boundWaits } from '../../service-bridge/resource-version';

/** The 409's `code` (the platform and the client key on it; the `message` is what a person reads). */
export const RESTRICTED_COPY = 'ccc_page_restricted_copy';

/** What a person is told. Fixed texts: no page id, title or tree detail reaches the client. */
export const RESTRICTED_COPY_MESSAGES = {
  /** A page in the copied set has its own restriction. */
  own:
    'This page or one of its sub-pages is restricted. A copy would not keep the restriction, so nothing was copied. ' +
    'Duplicate the unrestricted pages individually.',
  /** A copy to another space would lift the restriction the root only inherits. */
  section:
    'This page is in a restricted section. A copy in another space would not keep the restriction, so nothing was ' +
    'copied. Duplicate it within this space instead.',
} as const;

export interface CopyRestrictionArgs {
  /** The ids of the pages upstream is about to copy (its PDP-filtered set P) — the ORIGINALS, root included. */
  pageIds: string[];
  rootPage: Pick<Page, 'id' | 'spaceId' | 'parentPageId' | 'workspaceId'>;
  /** The space the copy lands in (upstream's resolved `spaceId`: the root's own space for a same-space duplicate). */
  targetSpaceId?: string;
}

/** The capability the #121 seam in `PageService.duplicatePage` asks the mode-selected repo for. */
export interface CopyRestrictionGuard {
  assertCopyKeepsRestrictions(trx: KyselyTransaction, args: CopyRestrictionArgs): Promise<void>;
}

/**
 * True only for a repo that carries the copy guard — `PdpPagePermissionRepo` (remote mode). The stock upstream repo
 * (native mode) has no such method, so a native duplicate keeps upstream's behaviour exactly. This reuses the one
 * mode switch the DI rebind already makes (database.module.ts): no constructor or env change in upstream code.
 */
export function hasCopyRestrictionGuard(repo: PagePermissionRepo): repo is PagePermissionRepo & CopyRestrictionGuard {
  return typeof (repo as Partial<CopyRestrictionGuard> | null)?.assertCopyKeepsRestrictions === 'function';
}

const logger = new Logger('CopyRestrictionGuard');

/**
 * CCC authorization integration — NOT upstream Docmost code (#573).
 *
 * Upstream's duplicate inserts the copies with no `page_access`/`page_permissions` rows, so a viewer of a restricted
 * page (or of a restricted page inside the copied subtree) gets an UNRESTRICTED copy, and a copy to another space
 * lands at its root, open. This refuses such a copy instead of copying the ACL (that would let a non-admin write
 * grants, possibly naming themselves, and widen access across spaces — the same choice g1 makes for move-to-space).
 *
 * It runs INSIDE the transaction that inserts the copies, on the exact set upstream is about to insert, and in order:
 *  1. The PDP dropped the root (a PDP error fails closed by dropping pages) → 503; upstream would crash on it.
 *  2. Bounded waits (`lock_timeout`/`statement_timeout`, before the first lock), then the per-workspace lock
 *     `(CYCLE_LOCK_CLASS, hashtext(ws))` that g0 (restrict), g1 (space move) and g2 (re-parent) take. So a restrict
 *     or a move either committed before this point — and every read below sees it (READ COMMITTED, new statements
 *     after the lock) — or waits until the copy commits, which is the legal "duplicate, then restrict/move". The
 *     lock order matches the ACL writes (workspace lock, then the FK's `FOR KEY SHARE` on a parent row during the
 *     insert), so it cannot cycle with a mover holding `FOR NO KEY UPDATE`. A wait past the bound, a deadlock or a
 *     statement timeout here is a retryable 503 `engine_busy`. The bounds are `SET LOCAL`, so they also cover the
 *     insert that follows (no unbounded wait while holding the workspace lock); a timeout THERE surfaces from
 *     upstream as a plain error, and the transaction still rolls back with nothing written.
 *  3. Any page in the set with its OWN `page_access` row → 409. Local truth, so a restriction the PDP has not
 *     projected yet (a stale PDP allow) is refused too.
 *  4. A copy to ANOTHER space whose root sits in a restricted section (its ancestor walk, trashed ancestors included,
 *     finds a restriction or cannot finish) → 409. A same-space copy keeps the root's parent, so it inherits.
 *
 * No PDP call here: the set comes from upstream's single PDP evaluation, made after the handler's `validateCanView`,
 * so the set holds only pages the copier can see (no oracle) and a hidden page's subtree is never in it. A refusal
 * throws inside the transaction: nothing is inserted, no PAGE_CREATED fires, no outbox row is written.
 */
export async function assertCopyKeepsRestrictions(trx: KyselyTransaction, args: CopyRestrictionArgs): Promise<void> {
  const { pageIds, rootPage, targetSpaceId } = args;
  if (!pageIds.includes(rootPage.id)) {
    logger.warn(`PAGE_COPY_ROOT_UNAUTHORIZED page=${rootPage.id}: the PDP did not return the root; answered 503 (#573)`);
    throw new ServiceUnavailableException('authorization is unavailable; the page was not copied — retry');
  }
  const crossSpace = !!targetSpaceId && targetSpaceId !== rootPage.spaceId;
  let refusal: keyof typeof RESTRICTED_COPY_MESSAGES | null = null;
  try {
    await boundWaits(trx);
    await sql`select pg_advisory_xact_lock(${sql.lit(CYCLE_LOCK_CLASS)}, hashtext(${rootPage.workspaceId}::text))`.execute(
      trx,
    );
    const own = await trx
      .selectFrom('pageAccess')
      .select('pageId')
      .where('pageId', 'in', pageIds)
      .limit(1)
      .executeTakeFirst();
    if (own) {
      refusal = 'own';
    } else if (crossSpace && rootPage.parentPageId) {
      const lineage = await readPageLineage(trx, rootPage.parentPageId, {
        includeSelf: true,
        workspaceId: rootPage.workspaceId,
      });
      if (lineageRestricted(lineage)) refusal = 'section';
    }
  } catch (err) {
    const busy = asEngineBusy(err);
    if (busy) {
      logger.warn(`PAGE_COPY_BUSY code=${(err as { code?: string }).code}: answered 503 engine_busy (#573)`);
      throw busy;
    }
    throw err;
  }
  if (refusal) {
    logger.log(`PAGE_COPY_REFUSED page=${rootPage.id} reason=${refusal}: a copy would drop a restriction (#573)`);
    throw new ConflictException({ message: RESTRICTED_COPY_MESSAGES[refusal], code: RESTRICTED_COPY });
  }
}
