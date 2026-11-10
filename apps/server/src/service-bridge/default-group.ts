import { BadRequestException } from '@nestjs/common';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { refusal } from './resource-version';

/**
 * CCC service-bridge — NOT upstream Docmost code (wiki-v2 #797, INV-5).
 *
 * The workspace's default group (`groups.is_default`, created by first-run setup) is the integrating platform's
 * baseline group: every signed-in human is put in it (`POST service/groups/default/ensure`), so it must never carry a
 * grant. Anything it held would reach every account at once. These helpers are the ONE predicate for "is this the
 * default group" and "does the default group hold anything", shared by the group control plane, the space member
 * sinks and any other fork sink that must refuse it (the page-ACL sinks add their own check through
 * {@link isDefaultGroup}).
 *
 * The rows that count as a grant are the fork's own: a LIVE `space_members` row (a soft-deleted one grants nothing
 * and is never revived: every add of the default group is refused) and ANY `page_permissions` row (no soft delete).
 * The integrator's own grants that may name the group (role bindings) are its to check before it calls the ensure.
 */

/** Logged (and alarmed by the integrator) whenever the ensure finds the default group holding a grant. */
export const BASIC_GROUP_HAS_GRANTS = 'BASIC_GROUP_HAS_GRANTS';

type Executor = KyselyDB | KyselyTransaction;

export interface DefaultGroupRow {
  id: string;
  name: string;
  description: string | null;
}

/**
 * The workspace's live default group, or undefined. `lock` takes the row `FOR UPDATE` (the ensure serializes on it
 * against a concurrent ensure, rename or grant). Upstream creates exactly one; if a tampered database holds two, the
 * oldest wins deterministically.
 */
export async function findDefaultGroup(
  ex: Executor,
  workspaceId: string,
  opts: { lock?: boolean } = {},
): Promise<DefaultGroupRow | undefined> {
  const res = await sql<DefaultGroupRow>`
    select id, name, description from groups
    where workspace_id = ${workspaceId} and is_default = true and deleted_at is null
    order by created_at asc, id asc
    limit 1
    ${opts.lock ? sql`for update` : sql``}
  `.execute(ex);
  return res.rows[0];
}

/** True when `groupId` names a default group of `workspaceId` (live or not: a soft-deleted default is still refused). */
export async function isDefaultGroup(ex: Executor, groupId: string, workspaceId: string): Promise<boolean> {
  const res = await sql<{ isDefault: boolean }>`
    select is_default from groups where id = ${groupId} and workspace_id = ${workspaceId}
  `.execute(ex);
  return res.rows[0]?.isDefault === true;
}

export interface GroupGrantCounts {
  spaceRows: number;
  pageRows: number;
}

/** The fork rows that grant something through `groupId`: live space memberships and page grants. */
export async function groupGrantCounts(ex: Executor, groupId: string): Promise<GroupGrantCounts> {
  const res = await sql<{ spaceRows: number; pageRows: number }>`
    select
      (select count(*)::int from space_members where group_id = ${groupId} and deleted_at is null) as space_rows,
      (select count(*)::int from page_permissions where group_id = ${groupId}) as page_rows
  `.execute(ex);
  const row = res.rows[0];
  return { spaceRows: Number(row?.spaceRows ?? 0), pageRows: Number(row?.pageRows ?? 0) };
}

export const hasGrants = (c: GroupGrantCounts): boolean => c.spaceRows > 0 || c.pageRows > 0;

/** 400 `basic_group_not_grantable`: the default group can never be granted anything (INV-5). Nothing was written. */
export function basicNotGrantable(): BadRequestException {
  return refusal(
    new BadRequestException({
      message: 'the default group is the baseline every account belongs to; it can never be granted access',
      code: 'basic_group_not_grantable',
    }),
    'basic_group_not_grantable',
  );
}
