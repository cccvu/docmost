import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { RawBuilder, sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { LIFECYCLE_MAX_DEPTH } from './page-lineage';
import { PageAuthzStateDto } from './dto/page-authz-state.dto';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** One page's authorization-relevant structure, read in ONE statement (so never torn across a concurrent move). */
export interface PageAuthzState {
  pageId: string;
  /** False when no row has this id (never created, or purged): the platform reaps every tuple the page owns. */
  exists: boolean;
  spaceId: string | null;
  parentPageId: string | null;
  /** The page itself carries a restriction (a `page_access` row). */
  restricted: boolean;
  /**
   * The page OR any ancestor is restricted, or the walk did not finish — `lineageRestricted(readPageLineage(
   * includeSelf))`, the #524 rule. The platform projects it as the per-page `lineage_restricted` marker, so a page's
   * lock never depends on its ancestors' `#parent` edges being projected (#545).
   */
  lineageRestricted: boolean;
  /** The walk reached a root within the bound (no cycle, no unreadable parent). */
  lineageComplete: boolean;
}

export interface PageAuthzStateResult {
  pages: PageAuthzState[];
  /** The keyset position for the next page of a subtree/keyset read, or null when done (always null for `pageIds`). */
  nextAfter: string | null;
}

type Mode =
  | { kind: 'ids'; pageIds: string[] }
  | { kind: 'subtree'; rootId: string; after: string; limit: number }
  | { kind: 'all'; after: string; limit: number };

/** Exactly one mode per request; any mix is a 400 rather than a guess. */
export function parsePageAuthzStateMode(dto: PageAuthzStateDto): Mode {
  if (dto.pageIds !== undefined) {
    if (dto.subtreeRootId !== undefined || dto.after !== undefined || dto.limit !== undefined) {
      throw new BadRequestException('pageIds cannot be combined with subtreeRootId, after or limit');
    }
    return { kind: 'ids', pageIds: dto.pageIds };
  }
  if (dto.limit === undefined) {
    throw new BadRequestException('either pageIds or limit is required');
  }
  const after = dto.after ?? ZERO_UUID;
  return dto.subtreeRootId !== undefined
    ? { kind: 'subtree', rootId: dto.subtreeRootId, after, limit: dto.limit }
    : { kind: 'all', after, limit: dto.limit };
}

interface Row {
  pageId: string;
  pageExists: boolean;
  spaceId: string | null;
  parentPageId: string | null;
  restricted: boolean;
  lineageRestricted: boolean;
  lineageComplete: boolean;
}

/**
 * CCC service-bridge — NOT upstream Docmost code (#545, #493).
 *
 * The CURRENT authorization structure of pages, which the platform's page projector writes to SpiceDB level-
 * triggered: it re-reads the pages an event names instead of trusting the event's payload, so a stale, reordered or
 * skipped event can never leave a stale edge. Facts only — the platform decides and writes.
 *
 * Every response is ONE SQL statement, so under READ COMMITTED it sees one snapshot: a row's `parentPageId` and its
 * `lineageRestricted` always describe the same committed tree (the #485 lifecycle read is several statements and is
 * deliberately not reused). Walks follow `parent_page_id` through trashed and cross-space rows (trash is lifecycle
 * only: a trashed ancestor's restriction still governs), stay inside the start page's workspace, are cycle-safe and
 * bounded by LIFECYCLE_MAX_DEPTH, and report an unfinished walk as restricted — never as open.
 */
@Injectable()
export class PageAuthzStateService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async read(dto: PageAuthzStateDto): Promise<PageAuthzStateResult> {
    const mode = parsePageAuthzStateMode(dto);
    const res = await sql<Row>`
      with recursive ${this.starts(mode)},
      anc(start_id, id, parent_page_id, workspace_id, depth, path) as (
        select p.id, p.id, p.parent_page_id, p.workspace_id, 0, array[p.id]
        from starts s join pages p on p.id = s.id
        union all
        select a.start_id, q.id, q.parent_page_id, q.workspace_id, a.depth + 1, a.path || q.id
        from anc a
        join pages q on q.id = a.parent_page_id and q.workspace_id = a.workspace_id
        where a.depth < ${LIFECYCLE_MAX_DEPTH} and not (q.id = any(a.path))
      ),
      walk as (
        select a.start_id,
               bool_or(pa.page_id is not null) as any_restricted,
               bool_or(a.parent_page_id is null) as complete
        from anc a left join page_access pa on pa.page_id = a.id
        group by a.start_id
      )
      select s.id as page_id,
             p.id is not null as page_exists,
             p.space_id,
             p.parent_page_id,
             exists (select 1 from page_access pa where pa.page_id = s.id) as restricted,
             coalesce(w.any_restricted, false) or not coalesce(w.complete, false) as lineage_restricted,
             coalesce(w.complete, false) as lineage_complete
      from starts s
      left join pages p on p.id = s.id
      left join walk w on w.start_id = s.id
      order by s.id
    `.execute(this.db);

    const pages = res.rows.map(
      (r): PageAuthzState => ({
        pageId: r.pageId,
        exists: r.pageExists,
        spaceId: r.pageExists ? r.spaceId : null,
        parentPageId: r.pageExists ? r.parentPageId : null,
        restricted: r.restricted,
        lineageRestricted: r.lineageRestricted,
        lineageComplete: r.lineageComplete,
      }),
    );
    const nextAfter = mode.kind !== 'ids' && pages.length === mode.limit ? pages[pages.length - 1].pageId : null;
    return { pages, nextAfter };
  }

  /** The `starts(id)` CTE for the mode — the pages this response describes. */
  private starts(mode: Mode): RawBuilder<unknown> {
    switch (mode.kind) {
      case 'ids':
        return sql`starts(id) as (select distinct unnest(${mode.pageIds}::uuid[]))`;
      case 'all':
        return sql`starts(id) as (
          select id from pages where id > ${mode.after}::uuid order by id limit ${mode.limit}
        )`;
      case 'subtree':
        // Descendants through trashed and cross-space rows, in the root's workspace; the root itself is excluded.
        // A page deeper than the bound below the root is not listed: its own walk cannot finish either, so its
        // marker is always set and a fan-out never has to change it.
        return sql`sub(id, workspace_id, depth, path) as (
          select p.id, p.workspace_id, 0, array[p.id] from pages p where p.id = ${mode.rootId}::uuid
          union all
          select c.id, c.workspace_id, d.depth + 1, d.path || c.id
          from sub d join pages c on c.parent_page_id = d.id and c.workspace_id = d.workspace_id
          where d.depth < ${LIFECYCLE_MAX_DEPTH} and not (c.id = any(d.path))
        ),
        starts(id) as (
          select distinct id from sub where id <> ${mode.rootId}::uuid and id > ${mode.after}::uuid
          order by id limit ${mode.limit}
        )`;
    }
  }
}
