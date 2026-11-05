import { PreconditionFailedException } from '@nestjs/common';
import { Page } from '@docmost/db/types/entity.types';
import { KyselyTransaction } from '@docmost/db/types/kysely.types';
import { pageEtagOpaque } from '../page-write/page-etag';

/**
 * CCC authorization integration — NOT upstream Docmost code (#636 W6, #661, #618, #589).
 *
 * The subtree reads and locks the remote page-removal routines share: the purge (`RemotePurgeService`), the trash
 * (`RemoteTrashService`) and the trash retention (`RemoteTrashRetentionService`). Each one decides on a set of pages
 * and must then remove EXACTLY that set, so the set is read and locked here, under the caller's transaction:
 *  - {@link walkSubtree} is `PageService.forceDelete`'s walk (no workspace or trash filter): what a purge removes;
 *  - {@link walkLive} is `PageRepo.removePage`'s walk (live rows only, stopping at a trashed page): what a trash
 *    would trash;
 *  - {@link lockSubtree} locks every row of the full walk, re-walking under the locks until nothing new appears;
 *  - {@link lockSpacesShared} holds the spaces those rows live in `FOR SHARE`, so an archive (an UPDATE of the space
 *    row) waits for the removal, while a page insert or move (`FOR KEY SHARE` on the space) does not.
 * The SQL of each walk is upstream's, verbatim (the specs match on it).
 */

/** Subtree recomputations under the locks before a removal gives up with a retryable 409. */
export const SUBTREE_MAX_PASSES = 3;

/**
 * `update`: `FOR UPDATE` — the purge's lock (it conflicts with `FOR KEY SHARE`, so a restrict, a child insert and a
 * move INTO the subtree wait for it). `noKeyUpdate`: `FOR NO KEY UPDATE` — the #616 rule for every other write (a
 * trash): it excludes every other writer of the row (a restore, a move, a second trash) but lets a restrict through.
 */
export type SubtreeLockStrength = 'update' | 'noKeyUpdate';

/** A subtree row as locked: what the removal routines decide on. */
export interface LockedPageRow {
  id: string;
  spaceId: string;
  workspaceId: string;
  parentPageId: string | null;
  deletedAt: Date | null;
}

export interface LockedSpaceRow {
  id: string;
  deletedAt: Date | null;
  updatedAt: Date;
}

/** What the removal routines read of the locked target: the ETag material and the audit payload. */
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

/** The ids `forceDelete` would remove (its recursive walk: no workspace or trash filter), as of this statement. */
export async function walkSubtree(trx: KyselyTransaction, rootId: string): Promise<string[]> {
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

/**
 * The ids `PageRepo.removePage` would trash (its recursive walk: live rows only, so it stops at a trashed page), as of
 * this statement. Called under {@link lockSubtree}'s locks, it is the set a trash decides on.
 */
export async function walkLive(trx: KyselyTransaction, rootId: string): Promise<string[]> {
  const rows = await trx
    .withRecursive('page_descendants', (db) =>
      db
        .selectFrom('pages')
        .select(['id'])
        .where('id', '=', rootId)
        .where('deletedAt', 'is', null)
        .unionAll((exp) =>
          exp
            .selectFrom('pages as p')
            .select(['p.id'])
            .innerJoin('page_descendants as pd', 'pd.id', 'p.parentPageId')
            .where('p.deletedAt', 'is', null),
        ),
    )
    .selectFrom('page_descendants')
    .select(['id'])
    .execute();
  return rows.map((r) => r.id);
}

/**
 * Lock every row of the full subtree (trashed rows included), in id order and workspace-scoped, re-walking until the
 * walk adds nothing. Returns the rows of the final walk as locked, or `null` when the tree is still changing after
 * {@link SUBTREE_MAX_PASSES} walks (the caller refuses with its own retryable 409). A walk id whose row the lock
 * cannot take (another workspace) never counts as locked, so it ends in `null` too. An empty array means the root is
 * gone.
 */
export async function lockSubtree(
  trx: KyselyTransaction,
  rootId: string,
  workspaceId: string,
  strength: SubtreeLockStrength,
): Promise<LockedPageRow[] | null> {
  const locked = new Map<string, LockedPageRow>();
  let ids = await walkSubtree(trx, rootId);
  for (let pass = 1; ; pass++) {
    const fresh = ids.filter((id) => !locked.has(id));
    if (fresh.length > 0) {
      const query = trx
        .selectFrom('pages')
        .select(['id', 'spaceId', 'workspaceId', 'parentPageId', 'deletedAt'])
        .where('id', 'in', fresh)
        .where('workspaceId', '=', workspaceId)
        .orderBy('id');
      const rows = await (strength === 'update' ? query.forUpdate() : query.forNoKeyUpdate()).execute();
      for (const r of rows as LockedPageRow[]) locked.set(r.id, r);
    }
    const again = await walkSubtree(trx, rootId);
    // Stable: every page the walk now reaches is locked (a row moved out meanwhile stays locked, harmlessly).
    if (again.every((id) => locked.has(id))) return again.map((id) => locked.get(id)!);
    if (pass >= SUBTREE_MAX_PASSES) return null;
    ids = again;
  }
}

/**
 * Hold `spaceIds` (deduplicated, in id order, workspace-scoped) `FOR SHARE` until the caller's transaction ends: an
 * archive or unarchive (an UPDATE of the space row) waits, a page insert or move (the foreign key's `FOR KEY SHARE`)
 * does not. Returns the rows, or `null` when any space is missing or in another workspace — the caller fails closed.
 */
export async function lockSpacesShared(
  trx: KyselyTransaction,
  spaceIds: readonly string[],
  workspaceId: string,
): Promise<LockedSpaceRow[] | null> {
  const ids = [...new Set(spaceIds)].sort();
  if (ids.length === 0) return [];
  const rows = (await trx
    .selectFrom('spaces')
    .select(['id', 'deletedAt', 'updatedAt'])
    .where('id', 'in', ids)
    .where('workspaceId', '=', workspaceId)
    .orderBy('id')
    .forShare()
    .execute()) as LockedSpaceRow[];
  return rows.length === ids.length ? rows : null;
}

/** The distinct spaces of `rows`, in id order. */
export function spacesOf(rows: readonly LockedPageRow[]): string[] {
  return [...new Set(rows.map((r) => r.spaceId))].sort();
}

/** The target as locked, workspace-scoped (trashed pages included). */
export async function readTarget(trx: KyselyTransaction, id: string, workspaceId: string): Promise<Page | undefined> {
  return (await trx
    .selectFrom('pages')
    .select([...TARGET_FIELDS])
    .where('id', '=', id)
    .where('workspaceId', '=', workspaceId)
    .executeTakeFirst()) as Page | undefined;
}

/** `["*"]` passes on any row; otherwise one of the tags must equal the locked row's version (the conditional compare). */
export function assertExpectedEtags(expectedEtags: string[], page: Page): void {
  if (expectedEtags.length === 1 && expectedEtags[0] === '*') return;
  if (!expectedEtags.includes(pageEtagOpaque(page))) {
    throw new PreconditionFailedException({ message: 'page changed', code: 'precondition_failed' });
  }
}
