import { BadRequestException } from '@nestjs/common';
import { RawBuilder, sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  ACTIVITY_AUDIT_TYPES,
  ACTIVITY_TYPES,
  ActivityType,
  ContentActivityListDto,
} from './dto/content-activity.dto';
import { isIsoInstant } from './dto/sub-collection-page.dto';

/**
 * CCC service-bridge — NOT upstream Docmost code (#615).
 *
 * The read side of `/v1/activity`: a keyset-paged union of what already happened to the pages the platform
 * authorized. A PRIVILEGED DATA PLANE like the content lists — it trusts `ids` (the belt) and does NOT
 * re-authorize, so every source below is pinned to pages in `ids` and to the workspace, and nothing else is read.
 *
 * Sources, one union branch each (no event store of our own):
 *  - `page.created`        ← `pages`        (created_at, creator_id)         key `p:<pageId>`
 *  - `page.updated`        ← `page_history` (created_at, last_updated_by_id) key `h:<historyId>`, versionId
 *  - `comment.created`     ← `comments`     (created_at, creator_id)         key `c:<commentId>`, commentId
 *  - `attachment.uploaded` ← `attachments`  (created_at, creator_id)         key `a:<attachmentId>`
 *  - the lifecycle events  ← Docmost's `audit` table (event, created_at, actor_id) key `e:<auditId>`; the page is
 *    `resource_id` for a page event and `metadata->>'pageId'` for a comment event.
 *
 * `spaceId` and `pageTitle` come from the page's CURRENT row (a trashed page keeps its events, without a title), so a
 * purged page leaves the feed. Order: `(occurredAt truncated to ms, key)` descending, the key compared under the "C"
 * collation so the order is total and the same on every database. Each branch applies the whole filter and the
 * keyset and stops at limit+1 BEFORE the union, so the union is a merge of per-source tops and never reads a
 * source's full history.
 */

/** One activity event as the fork serves it (the platform maps `actorId` to its own identity and never relays it). */
export interface PublicActivityEvent {
  key: string;
  type: ActivityType;
  occurredAt: string;
  /** The acting Docmost user id, or null when the source records none. */
  actorId: string | null;
  actorName: string | null;
  pageId: string;
  /** The page's CURRENT space. */
  spaceId: string;
  /** The page's current title, or null while the page is trashed. */
  pageTitle: string | null;
  commentId: string | null;
  /** The `page_history` row a `page.updated` event is (a page version id). */
  versionId: string | null;
}

interface ActivityRow {
  key: string;
  type: ActivityType;
  occurredAt: Date;
  actorId: string | null;
  actorName: string | null;
  pageId: string;
  spaceId: string;
  pageTitle: string | null;
  commentId: string | null;
  versionId: string | null;
}

// A uuid as Postgres prints one: the only `metadata->>'pageId'` the audit branch casts, so a malformed value in the
// metadata can never fail the whole feed at the `::uuid` cast (the row simply has no page and drops out).
const UUID_TEXT = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** A branch's per-source expressions; everything else (window, actor, keyset, page) is shared. */
interface Branch {
  key: RawBuilder<unknown>;
  type: RawBuilder<unknown>;
  at: RawBuilder<unknown>;
  actor: RawBuilder<unknown>;
  commentId: RawBuilder<unknown>;
  versionId: RawBuilder<unknown>;
  /** `from …` including the join to the authorized pages (`ap`). */
  from: RawBuilder<unknown>;
  where: RawBuilder<unknown>[];
}

export async function listActivityByPageIds(
  db: KyselyDB,
  workspaceId: string,
  dto: ContentActivityListDto,
): Promise<{ items: PublicActivityEvent[] }> {
  for (const [name, v] of [
    ['since', dto.since],
    ['until', dto.until],
    ['before.occurredAt', dto.before?.occurredAt],
  ] as const) {
    // A Date.parse-lenient-but-Postgres-invalid instant (bare '2026') must 400 here, not 500 at the cast.
    if (v !== undefined && v !== null && !isIsoInstant(v)) {
      throw new BadRequestException(`${name} must be an ISO-8601 timestamp`);
    }
  }
  if (dto.ids.length === 0) return { items: [] };

  const wanted = new Set<ActivityType>(dto.types?.length ? dto.types : ACTIVITY_TYPES);
  const auditTypes = ACTIVITY_AUDIT_TYPES.filter((t) => wanted.has(t));
  const n = dto.limit + 1;

  const title = sql`case when ap.deleted_at is null then ap.title end`;
  const branches: Branch[] = [];
  if (wanted.has('page.created')) {
    branches.push({
      key: sql`('p:' || ap.id::text) collate "C"`,
      type: sql`'page.created'::text`,
      at: sql`ap.created_at`,
      actor: sql`ap.creator_id`,
      commentId: sql`null::uuid`,
      versionId: sql`null::uuid`,
      from: sql`ap`,
      where: [],
    });
  }
  if (wanted.has('page.updated')) {
    branches.push({
      key: sql`('h:' || h.id::text) collate "C"`,
      type: sql`'page.updated'::text`,
      at: sql`h.created_at`,
      actor: sql`h.last_updated_by_id`,
      commentId: sql`null::uuid`,
      versionId: sql`h.id`,
      from: sql`page_history h join ap on ap.id = h.page_id`,
      where: [sql`h.workspace_id = ${workspaceId}`],
    });
  }
  if (wanted.has('comment.created')) {
    branches.push({
      key: sql`('c:' || c.id::text) collate "C"`,
      type: sql`'comment.created'::text`,
      at: sql`c.created_at`,
      actor: sql`c.creator_id`,
      commentId: sql`c.id`,
      versionId: sql`null::uuid`,
      from: sql`comments c join ap on ap.id = c.page_id`,
      where: [sql`c.workspace_id = ${workspaceId}`, sql`c.deleted_at is null`],
    });
  }
  if (wanted.has('attachment.uploaded')) {
    branches.push({
      key: sql`('a:' || f.id::text) collate "C"`,
      type: sql`'attachment.uploaded'::text`,
      at: sql`f.created_at`,
      actor: sql`f.creator_id`,
      commentId: sql`null::uuid`,
      versionId: sql`null::uuid`,
      from: sql`attachments f join ap on ap.id = f.page_id`,
      where: [sql`f.workspace_id = ${workspaceId}`, sql`f.deleted_at is null`],
    });
  }
  if (auditTypes.length > 0) {
    // The page an audit row is about: `resource_id` for a page event, `metadata->>'pageId'` for a comment event
    // (only when it is a well-formed uuid). Any other pairing has no page and so never joins.
    const auditPage = sql`case
      when a.resource_type = 'page' and a.event like 'page.%' then a.resource_id
      when a.resource_type = 'comment' and a.event like 'comment.%' and (a.metadata->>'pageId') ~ ${UUID_TEXT}
        then (a.metadata->>'pageId')::uuid
    end`;
    branches.push({
      key: sql`('e:' || a.id::text) collate "C"`,
      type: sql`a.event::text`,
      at: sql`a.created_at`,
      actor: sql`a.actor_id`,
      commentId: sql`case when a.resource_type = 'comment' then a.resource_id end`,
      versionId: sql`null::uuid`,
      from: sql`audit a join ap on ap.id = ${auditPage}`,
      where: [sql`a.workspace_id = ${workspaceId}`, sql`a.event = any(${auditTypes}::text[])`],
    });
  }

  const shared = (b: Branch): RawBuilder<unknown>[] => {
    const conds = [...b.where, sql`${b.at} >= ${dto.since}::timestamptz`];
    if (dto.until) conds.push(sql`${b.at} < ${dto.until}::timestamptz`);
    if (dto.actorId) conds.push(sql`${b.actor} = ${dto.actorId}`);
    if (dto.before) {
      const { occurredAt, key } = dto.before;
      conds.push(
        sql`(date_trunc('milliseconds', ${b.at}), ${b.key}) < (${occurredAt}::timestamptz, ${key}::text collate "C")`,
      );
    }
    return conds;
  };
  const union = sql.join(
    branches.map(
      (b) => sql`(
        select ${b.key} as key, ${b.type} as type, date_trunc('milliseconds', ${b.at}) as occurred_at,
               ${b.actor} as actor_id, ap.id as page_id, ap.space_id, ${title} as page_title,
               ${b.commentId} as comment_id, ${b.versionId} as version_id
        from ${b.from}
        where ${sql.join(shared(b), sql` and `)}
        order by occurred_at desc, key desc
        limit ${n}
      )`,
    ),
    sql` union all `,
  );

  // `ap` = the authorized pages (the belt ∩ workspace, narrowed by the page filters), trashed ones included: a
  // trashed page keeps its PDP decision (#493) and its events, only its title is withheld.
  const apConds = [sql`p.workspace_id = ${workspaceId}`, sql`p.id = any(${dto.ids}::uuid[])`];
  if (dto.spaceId) apConds.push(sql`p.space_id = ${dto.spaceId}`);
  if (dto.pageId) apConds.push(sql`p.id = ${dto.pageId}`);

  const res = await sql<ActivityRow>`
    with ap as (
      select p.id, p.space_id, p.title, p.deleted_at, p.created_at, p.creator_id
      from pages p
      where ${sql.join(apConds, sql` and `)}
    )
    select e.key, e.type, e.occurred_at, e.actor_id, u.name as actor_name, e.page_id, e.space_id, e.page_title,
           e.comment_id, e.version_id
    from (${union}) e
    left join users u on u.id = e.actor_id and u.workspace_id = ${workspaceId}
    order by e.occurred_at desc, e.key collate "C" desc
    limit ${n}
  `.execute(db);

  return {
    items: res.rows.map((r) => ({
      key: r.key,
      type: r.type,
      occurredAt: new Date(r.occurredAt).toISOString(),
      actorId: r.actorId ?? null,
      actorName: r.actorName ?? null,
      pageId: r.pageId,
      spaceId: r.spaceId,
      pageTitle: r.pageTitle ?? null,
      commentId: r.commentId ?? null,
      versionId: r.versionId ?? null,
    })),
  };
}
