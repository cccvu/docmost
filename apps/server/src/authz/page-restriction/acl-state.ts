import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { aclEntry, aclVersion, byCodePoint } from '../../service-bridge/resource-version';

/**
 * CCC authorization integration — NOT upstream Docmost code (wiki-v2 #616, Stage 2).
 *
 * A page's ACL as the version is derived from it: whether the page carries its own restriction (`page_access`), and
 * every grant on it (`page_permissions`). Read in ONE statement, so a caller that is not inside a transaction still
 * gets a consistent pair; a write reads it inside its transaction, under the page's ACL lock.
 */
export interface AclGrant {
  userId: string | null;
  groupId: string | null;
  role: string;
}

export interface AclChange {
  userId: string | null;
  groupId: string | null;
  fromRole: string;
  toRole: string;
}

export interface AclState {
  /** The `page_access` row id, or null when the page carries no restriction of its own. */
  accessId: string | null;
  restricted: boolean;
  grants: AclGrant[];
}

/** What an ACL write did (or, for a preview, would do). Grantees are Docmost user / group ids. */
export interface AclEffect {
  restrictedBefore: boolean;
  restrictedAfter: boolean;
  added: AclGrant[];
  changed: AclChange[];
  removed: AclGrant[];
  /** Restrict only: the role the actor keeps on the page (null = none). Absent when the restrict changes nothing. */
  retainedRole?: 'reader' | 'writer' | null;
}

export async function readAclState(
  ex: KyselyDB | KyselyTransaction,
  pageId: string,
  workspaceId?: string,
): Promise<AclState> {
  const res = await sql<{ accessId: string | null; userId: string | null; groupId: string | null; role: string | null }>`
    select pa.id as access_id, pp.user_id, pp.group_id, pp.role
    from page_access pa left join page_permissions pp on pp.page_access_id = pa.id
    where pa.page_id = ${pageId}
    ${workspaceId ? sql`and pa.workspace_id = ${workspaceId}` : sql``}
  `.execute(ex);
  const rows = res.rows;
  if (rows.length === 0) return { accessId: null, restricted: false, grants: [] };
  const grants = rows
    .filter((r) => typeof r.role === 'string' && (r.userId || r.groupId))
    .map((r) => ({ userId: r.userId ?? null, groupId: r.groupId ?? null, role: r.role as string }));
  return { accessId: rows[0].accessId ?? null, restricted: true, grants };
}

export function aclVersionOf(pageId: string, state: Pick<AclState, 'restricted' | 'grants'>): string {
  return aclVersion({ pageId, restricted: state.restricted, entries: state.grants.map(aclEntry) });
}

const subjectKey = (g: { userId: string | null; groupId: string | null }): string =>
  g.userId ? `u:${g.userId.toLowerCase()}` : `g:${String(g.groupId).toLowerCase()}`;

const bySubject = (a: { userId: string | null; groupId: string | null }, b: typeof a) =>
  byCodePoint(subjectKey(a), subjectKey(b));

/** The difference between two ACL states, subject by subject (sorted, so the effect is deterministic). */
export function diffAcl(before: AclState, after: AclState): AclEffect {
  const was = new Map(before.grants.map((g) => [subjectKey(g), g]));
  const now = new Map(after.grants.map((g) => [subjectKey(g), g]));
  const added: AclGrant[] = [];
  const changed: AclChange[] = [];
  const removed: AclGrant[] = [];
  for (const [k, g] of now) {
    const old = was.get(k);
    if (!old) added.push({ ...g });
    else if (old.role !== g.role) changed.push({ userId: g.userId, groupId: g.groupId, fromRole: old.role, toRole: g.role });
  }
  for (const [k, g] of was) if (!now.has(k)) removed.push({ ...g });
  return {
    restrictedBefore: before.restricted,
    restrictedAfter: after.restricted,
    added: added.sort(bySubject),
    changed: changed.sort(bySubject),
    removed: removed.sort(bySubject),
  };
}

/** The effect of a write that changes nothing. */
export function noEffect(state: AclState): AclEffect {
  return { restrictedBefore: state.restricted, restrictedAfter: state.restricted, added: [], changed: [], removed: [] };
}

export function isNoop(e: AclEffect): boolean {
  return (
    e.restrictedBefore === e.restrictedAfter && e.added.length === 0 && e.changed.length === 0 && e.removed.length === 0
  );
}
