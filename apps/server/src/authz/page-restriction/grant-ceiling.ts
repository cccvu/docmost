import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { refusal } from '../../service-bridge/resource-version';
import { AclGrant } from './acl-state';
import { PageGrantRole } from './dto';

/**
 * CCC authorization integration — NOT upstream Docmost code (wiki-v2 #797, INV-4 / INV-6).
 *
 * The pure half of the restricted-page grant ceilings `PageRestrictionService` enforces:
 *   - INV-4 (A4): a grant never exceeds the acting human. Granting reader needs the actor's own page `view`, granting
 *     writer (or raising to it) needs page `edit` — or the workspace-admin disjunct (`workspace#admin_cascade`).
 *   - INV-6: a restricted page takes per-user grants only. A group subject is refused on a grant and on a raise
 *     (`400 group_grant_not_allowed_on_restricted_page`); an existing group grant is grandfathered (it keeps working,
 *     lowering and removal stay allowed, nothing is migrated), and {@link listRestrictedPagesWithGroupGrants} reports
 *     them for the console. The default (`is_default`) group is just a group here: refused by the same code (INV-5).
 */

/** How a grant passed INV-4 — `admin_override` is the one that is audited distinctly (see the service). */
export type CeilingBasis =
  /** The actor's own live grant row on this page (direct, or through a group they are in) plus `space#view`. */
  | 'grant'
  /** The settled PDP's page `view`/`edit` (a page-scoped role binding, typically). */
  | 'page_access'
  /** Only the workspace-admin disjunct: the actor could not see (or edit) the page themselves. */
  | 'admin_override';

export interface CeilingDecision {
  basis: CeilingBasis;
  /** The role the decision covered. */
  role: PageGrantRole;
  /**
   * `admin_override` only: the page-level answer could not be proven (the fence or the page check failed). The admin
   * disjunct alone allows the grant, so it goes through — and is audited as an override, never less.
   */
  pageAccessUnconfirmed?: boolean;
}

const RANK: Readonly<Record<string, number>> = Object.freeze({ reader: 1, writer: 2 });

/** The rank of a stored or requested page role (0 = none / unknown, which covers nothing). */
export const roleRank = (role: string | null | undefined): number => (role ? (RANK[role] ?? 0) : 0);

/** Does holding `held` cover granting `need`? reader ⇐ reader|writer; writer ⇐ writer. */
export const roleCovers = (held: string | null | undefined, need: PageGrantRole): boolean =>
  roleRank(held) >= roleRank(need) && roleRank(need) > 0;

/** The page permission INV-4 needs for a role: reader → `view`, writer → `edit`. */
export const ceilingPermission = (need: PageGrantRole): 'view' | 'edit' => (need === 'writer' ? 'edit' : 'view');

/**
 * The actor's own role on the page from the ACL rows read under its lock: the highest of their direct grant and every
 * grant held by a group they are in (a grandfathered group grant counts — INV-6 keeps it working). `null` = none.
 * The group probe runs on `trx` (the write's own connection), so it sees the same committed state as the lock.
 */
export async function localRoleOf(
  trx: KyselyTransaction | KyselyDB,
  actorId: string,
  grants: readonly AclGrant[],
): Promise<PageGrantRole | null> {
  const me = actorId.toLowerCase();
  let best = 0;
  for (const g of grants) {
    if (g.userId && g.userId.toLowerCase() === me) best = Math.max(best, roleRank(g.role));
  }
  const groupIds = [...new Set(grants.filter((g) => g.groupId && roleRank(g.role) > best).map((g) => g.groupId!))];
  if (groupIds.length > 0) {
    const mine = await trx
      .selectFrom('groupUsers')
      .select('groupId')
      .where('userId', '=', actorId)
      .where('groupId', 'in', groupIds)
      .execute();
    const inGroup = new Set(mine.map((r) => String(r.groupId).toLowerCase()));
    for (const g of grants) {
      if (g.groupId && inGroup.has(g.groupId.toLowerCase())) best = Math.max(best, roleRank(g.role));
    }
  }
  return best >= 2 ? 'writer' : best === 1 ? 'reader' : null;
}

/** INV-4: `403 { code: grant_exceeds_actor }` — audited as `page.acl_write_refused` (acl-audit.ts). */
export const grantExceedsActor = (need: PageGrantRole) =>
  refusal(
    new ForbiddenException({
      code: 'grant_exceeds_actor',
      message:
        need === 'writer'
          ? 'you can only grant edit access to a restricted page you can edit yourself'
          : 'you can only grant access to a restricted page you can view yourself',
    }),
    'grant_exceeds_actor',
  );

/** INV-6: `400 { code: group_grant_not_allowed_on_restricted_page }`. */
export const GROUP_GRANT_NOT_ALLOWED = 'group_grant_not_allowed_on_restricted_page';
export const groupGrantNotAllowed = () =>
  refusal(
    new BadRequestException({
      code: GROUP_GRANT_NOT_ALLOWED,
      message:
        'a restricted page takes grants for individual people only; add each person (an existing group grant can still be lowered or removed)',
    }),
    GROUP_GRANT_NOT_ALLOWED,
  );

/**
 * The settle fence did not confirm, so the page-level answer cannot be proven: `503 { code: grant_ceiling_unconfirmed }`
 * (retryable; never a refusal — a preview answers it exactly as the real route does).
 */
export const ceilingUnconfirmed = () =>
  new ServiceUnavailableException({
    code: 'grant_ceiling_unconfirmed',
    message: 'authorization could not confirm your access to this page; nothing was changed — retry',
  });

/** One grandfathered group grant on a restricted page (INV-6 report). Ids and roles only: never a title or name. */
export interface RestrictedGroupGrant {
  pageId: string;
  spaceId: string;
  groupId: string;
  role: string;
  /** The page is in the trash (a restore brings the grant back into force). */
  pageTrashed: boolean;
  /** The grant names the workspace's default group (INV-5: owners should remove it first). */
  isDefaultGroup: boolean;
}

export interface RestrictedGroupGrantPage {
  items: RestrictedGroupGrant[];
  /** Pass back as `after` for the next page; null when this was the last one. */
  next: { pageId: string; groupId: string } | null;
}

export const GROUP_GRANT_REPORT_MAX_LIMIT = 500;

/**
 * INV-6's read-only report: every group grant on a restricted page in `workspaceId`, keyset-paged on
 * `(page id, group id)`. It reads only (`page_access`, `page_permissions`, `pages`, `groups`), so a later service-bridge
 * read can call it with its own Kysely handle. Grandfathered grants are reported, never migrated.
 */
export async function listRestrictedPagesWithGroupGrants(
  db: KyselyDB | KyselyTransaction,
  workspaceId: string,
  opts: { limit?: number; after?: { pageId: string; groupId: string } } = {},
): Promise<RestrictedGroupGrantPage> {
  const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? 100) || 100, GROUP_GRANT_REPORT_MAX_LIMIT));
  const after = opts.after;
  const res = await sql<{
    pageId: string;
    spaceId: string;
    groupId: string;
    role: string;
    pageTrashed: boolean;
    isDefaultGroup: boolean | null;
  }>`
    select pa.page_id, p.space_id, pp.group_id, pp.role,
           (p.deleted_at is not null) as page_trashed,
           coalesce(g.is_default, false) as is_default_group
      from page_access pa
      join page_permissions pp on pp.page_access_id = pa.id
      join pages p on p.id = pa.page_id
      left join groups g on g.id = pp.group_id
     where pa.workspace_id = ${workspaceId}
       and pp.group_id is not null
       ${after ? sql`and (pa.page_id, pp.group_id) > (${after.pageId}::uuid, ${after.groupId}::uuid)` : sql``}
     order by pa.page_id, pp.group_id
     limit ${limit + 1}
  `.execute(db);
  const rows = res.rows.slice(0, limit).map((r) => ({
    pageId: String(r.pageId),
    spaceId: String(r.spaceId),
    groupId: String(r.groupId),
    role: String(r.role),
    pageTrashed: r.pageTrashed === true,
    isDefaultGroup: r.isDefaultGroup === true,
  }));
  const last = rows[rows.length - 1];
  return { items: rows, next: res.rows.length > limit && last ? { pageId: last.pageId, groupId: last.groupId } : null };
}
