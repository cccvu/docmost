import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

/**
 * CCC service-bridge — NOT upstream Docmost code (#485, #524).
 *
 * The ONE restriction-lineage walk over the fork's own rows, shared by the `/v1` lifecycle facts
 * (`ServicePageLifecycleService`) and the PEP (`PdpPagePermissionRepo`, #524) so the two can never disagree about
 * which pages sit in a restricted section. It reads `pages`/`page_access` directly because the PDP cannot answer
 * this for a page it has not placed: trashing reaps a page's `#space`/`#parent` edges, and a new, restored or
 * re-parented page has none until the relay projects it.
 */

/**
 * Bound on every tree walk. Real page trees are a handful of levels deep; a walk that reaches this bound — or
 * meets a cycle, or a parent it cannot read — is reported as INCOMPLETE, and every caller treats an incomplete
 * lineage as restricted (fail closed). Nothing here ever reports "unrestricted" for a lineage it did not finish.
 */
export const LIFECYCLE_MAX_DEPTH = 256;

/** A page's restriction lineage: the restricted ids on the walk, and whether the walk reached a root. */
export interface Lineage {
  /** Every page id on the walk, nearest first (the start page first when it was included). */
  chain: string[];
  /** The ids on the walk that carry a restriction (a `page_access` row). */
  restrictedIds: string[];
  /** False when the walk stopped early: depth bound, a cycle, or an unreadable parent. */
  complete: boolean;
}

/**
 * Walk UP from `startId` (trashed pages included — a trashed ancestor's restriction still governs), cycle-safe and
 * bounded. `includeSelf` decides whether the start page counts toward `restrictedIds`. The walk never leaves the
 * start page's workspace: `workspaceId` pins the start row to it, and without one the start row's own workspace is
 * carried down the walk. It is complete only when it ends at a page with no parent; a cycle, the depth bound or a
 * parent it cannot read (missing, or in another workspace) end it early — and a start page it cannot read yields
 * an empty, incomplete walk.
 */
export async function readPageLineage(
  db: KyselyDB,
  startId: string,
  opts: { includeSelf: boolean; workspaceId?: string },
): Promise<Lineage> {
  const inWorkspace =
    opts.workspaceId === undefined
      ? sql``
      : sql`and p.workspace_id = ${opts.workspaceId}`;
  const res = await sql<{
    id: string;
    parentPageId: string | null;
    depth: number;
    restricted: boolean;
  }>`
    with recursive anc(id, parent_page_id, workspace_id, depth, path) as (
      select p.id, p.parent_page_id, p.workspace_id, 0, array[p.id]
      from pages p where p.id = ${startId} ${inWorkspace}
      union all
      select q.id, q.parent_page_id, q.workspace_id, a.depth + 1, a.path || q.id
      from anc a
      join pages q on q.id = a.parent_page_id and q.workspace_id = a.workspace_id
      where a.depth < ${LIFECYCLE_MAX_DEPTH} and not (q.id = any(a.path))
    )
    select a.id, a.parent_page_id, a.depth,
           exists (select 1 from page_access pa where pa.page_id = a.id) as restricted
    from anc a
    order by a.depth
  `.execute(db);
  const rows = res.rows;
  const last = rows[rows.length - 1];
  return {
    chain: rows.map((r) => r.id),
    restrictedIds: rows
      .filter((r) => r.restricted && (opts.includeSelf || Number(r.depth) > 0))
      .map((r) => r.id),
    complete: !!last && last.parentPageId === null,
  };
}
