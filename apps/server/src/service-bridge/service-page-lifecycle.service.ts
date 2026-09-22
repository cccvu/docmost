import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { WorkspaceResolver } from './workspace-resolver';
import { PageLifecycleStateDto, TrashListDto } from './dto/page-lifecycle.dto';

/**
 * Bound on every tree walk. Real page trees are a handful of levels deep; a walk that reaches this bound — or
 * meets a cycle, or a parent it cannot read — is reported as INCOMPLETE, and the platform treats an incomplete
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

export interface DescendantFacts {
  restricted: boolean;
  trashed: boolean;
  crossSpace: boolean;
  /** False when the walk stopped early (depth bound or a cycle) — every flag must then be read as TRUE. */
  complete: boolean;
}

export interface LifecycleTarget {
  /** The requested parent (`null` = the space root). */
  parentPageId: string | null;
  exists: boolean;
  spaceId: string | null;
  deletedAt: string | null;
  /** Restricted ids on the target's self-and-ancestors walk — what a page placed under it would inherit. */
  restrictedLineageIds: string[];
  lineageComplete: boolean;
  /** The target is the page itself or one of its descendants (moving there would form a cycle). */
  isSelfOrDescendant: boolean;
  /** A position after the target's last live child (mirrors `PageService.nextPagePosition`). */
  nextPosition: string | null;
}

export interface PageLifecycleState {
  pageId: string;
  spaceId: string;
  parentPageId: string | null;
  deletedAt: string | null;
  /** The current parent's facts, or null for a root page (or a parent that cannot be read). */
  parent: { spaceId: string; deletedAt: string | null } | null;
  /** Restricted STRICT ancestors (the page itself excluded) — what the page inherits today. */
  restrictedAncestorIds: string[];
  ancestorsComplete: boolean;
  selfRestricted: boolean;
  descendants: DescendantFacts;
  target?: LifecycleTarget;
}

export interface TrashedPageRow {
  id: string;
  title: string | null;
  icon: string | null;
  parentPageId: string | null;
  deletedAt: string;
  /** Display name of who trashed it — never an internal user id. */
  deletedBy: string | null;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

/**
 * CCC service-bridge — NOT upstream Docmost code (#485).
 *
 * FACTS about a page's place in the tree that the platform's `/v1` lifecycle routes (move, restore, trash list)
 * need and cannot read from the PDP: restriction lineage through TRASHED ancestors (trashing reaps the SpiceDB
 * edges), descendants that are restricted / trashed / in another space, cycle membership, and the next sibling
 * position. POLICY stays in the platform — this serves facts only, workspace-scoped, and every walk is cycle-safe
 * and bounded, reporting incompleteness rather than guessing.
 */
@Injectable()
export class ServicePageLifecycleService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  async lifecycleState(dto: PageLifecycleStateDto): Promise<PageLifecycleState> {
    const ws = await this.workspaces.resolveDefaultWorkspaceId();
    const page = await this.pageRow(ws, dto.pageId);
    if (!page) throw new NotFoundException('page not found');

    const parent = page.parentPageId ? await this.pageRow(ws, page.parentPageId) : null;
    const ancestors = await this.lineage(ws, page.id, false);
    const selfRestricted = await this.isRestricted(page.id);
    const descendants = await this.descendantFacts(ws, page.id, page.spaceId);

    const state: PageLifecycleState = {
      pageId: page.id,
      spaceId: page.spaceId,
      parentPageId: page.parentPageId,
      deletedAt: iso(page.deletedAt),
      parent: parent ? { spaceId: parent.spaceId, deletedAt: iso(parent.deletedAt) } : null,
      restrictedAncestorIds: ancestors.restrictedIds,
      ancestorsComplete: ancestors.complete,
      selfRestricted,
      descendants,
    };
    if (dto.targetParentPageId !== undefined) {
      state.target = await this.targetFacts(ws, page, dto.targetParentPageId);
    }
    return state;
  }

  /**
   * The ROOTS of trashed subtrees in a space, newest first, keyset-paged on `(deletedAt ms, id)`. A trashed page
   * is a root when its parent is live, missing, in another space, or absent. A root whose lineage carries a
   * restriction — or whose lineage walk is incomplete — is excluded IN SQL, before the LIMIT, so a page is never
   * filtered after the fact (and a page of results is never short because of it).
   */
  async trash(dto: TrashListDto): Promise<{ items: TrashedPageRow[] }> {
    const ws = await this.workspaces.resolveDefaultWorkspaceId();
    const before = dto.before
      ? sql`and (date_trunc('milliseconds', c.deleted_at), c.id::text) < (${dto.before.deletedAt}::timestamptz, ${dto.before.id})`
      : sql``;
    const res = await sql<{
      id: string;
      title: string | null;
      icon: string | null;
      parentPageId: string | null;
      deletedAt: Date;
      deletedBy: string | null;
    }>`
      with recursive cand as (
        select p.id, p.title, p.icon, p.parent_page_id, p.deleted_at, p.deleted_by_id
        from pages p
        left join pages par on par.id = p.parent_page_id and par.workspace_id = ${ws}
        where p.workspace_id = ${ws}
          and p.space_id = ${dto.spaceId}
          and p.deleted_at is not null
          and (p.parent_page_id is null or par.id is null or par.deleted_at is null or par.space_id <> p.space_id)
      ),
      anc(root_id, id, parent_page_id, depth, path) as (
        select c.id, c.id, c.parent_page_id, 0, array[c.id] from cand c
        union all
        select a.root_id, q.id, q.parent_page_id, a.depth + 1, a.path || q.id
        from anc a
        join pages q on q.id = a.parent_page_id and q.workspace_id = ${ws}
        where a.depth < ${LIFECYCLE_MAX_DEPTH} and not (q.id = any(a.path))
      ),
      excluded as (
        select distinct a.root_id from anc a
        where exists (select 1 from page_access pa where pa.page_id = a.id)
           or (
             a.parent_page_id is not null
             and not exists (select 1 from anc a2 where a2.root_id = a.root_id and a2.depth = a.depth + 1)
           )
      )
      select c.id, c.title, c.icon, c.parent_page_id,
             date_trunc('milliseconds', c.deleted_at) as deleted_at,
             u.name as deleted_by
      from cand c
      left join users u on u.id = c.deleted_by_id
      where not exists (select 1 from excluded e where e.root_id = c.id)
      ${before}
      order by date_trunc('milliseconds', c.deleted_at) desc, c.id::text desc
      limit ${dto.limit + 1}
    `.execute(this.db);
    return {
      items: res.rows.map((r) => ({
        id: r.id,
        title: r.title,
        icon: r.icon,
        parentPageId: r.parentPageId,
        deletedAt: iso(r.deletedAt)!,
        deletedBy: r.deletedBy,
      })),
    };
  }

  private async pageRow(
    ws: string,
    id: string,
  ): Promise<{ id: string; spaceId: string; parentPageId: string | null; deletedAt: Date | null } | null> {
    const res = await sql<{ id: string; spaceId: string; parentPageId: string | null; deletedAt: Date | null }>`
      select id, space_id, parent_page_id, deleted_at from pages where id = ${id} and workspace_id = ${ws}
    `.execute(this.db);
    return res.rows[0] ?? null;
  }

  private async isRestricted(pageId: string): Promise<boolean> {
    const res = await sql<{ r: boolean }>`
      select exists (select 1 from page_access where page_id = ${pageId}) as r
    `.execute(this.db);
    return !!res.rows[0]?.r;
  }

  /**
   * Walk UP from `startId` (trashed pages included — a trashed ancestor's restriction still governs), cycle-safe
   * and bounded. `includeSelf` decides whether the start page counts toward `restrictedIds`. The walk is complete
   * only when it ends at a page with no parent; a cycle, the depth bound, or an unreadable parent end it early.
   */
  async lineage(ws: string, startId: string, includeSelf: boolean): Promise<Lineage> {
    const res = await sql<{ id: string; parentPageId: string | null; depth: number; restricted: boolean }>`
      with recursive anc(id, parent_page_id, depth, path) as (
        select p.id, p.parent_page_id, 0, array[p.id]
        from pages p where p.id = ${startId} and p.workspace_id = ${ws}
        union all
        select q.id, q.parent_page_id, a.depth + 1, a.path || q.id
        from anc a
        join pages q on q.id = a.parent_page_id and q.workspace_id = ${ws}
        where a.depth < ${LIFECYCLE_MAX_DEPTH} and not (q.id = any(a.path))
      )
      select a.id, a.parent_page_id, a.depth,
             exists (select 1 from page_access pa where pa.page_id = a.id) as restricted
      from anc a
      order by a.depth
    `.execute(this.db);
    const rows = res.rows;
    const last = rows[rows.length - 1];
    return {
      chain: rows.map((r) => r.id),
      restrictedIds: rows.filter((r) => r.restricted && (includeSelf || Number(r.depth) > 0)).map((r) => r.id),
      complete: !!last && last.parentPageId === null,
    };
  }

  /** Walk DOWN from `rootId` over every child (trashed included), cycle-safe and bounded. */
  async descendantFacts(ws: string, rootId: string, spaceId: string): Promise<DescendantFacts> {
    const res = await sql<{ restricted: boolean; trashed: boolean; crossSpace: boolean; incomplete: boolean }>`
      with recursive d(id, space_id, deleted_at, depth, path) as (
        select c.id, c.space_id, c.deleted_at, 1, array[${rootId}::uuid, c.id]
        from pages c
        where c.parent_page_id = ${rootId} and c.workspace_id = ${ws} and c.id <> ${rootId}
        union all
        select c.id, c.space_id, c.deleted_at, d.depth + 1, d.path || c.id
        from d
        join pages c on c.parent_page_id = d.id and c.workspace_id = ${ws}
        where d.depth < ${LIFECYCLE_MAX_DEPTH} and not (c.id = any(d.path))
      )
      select
        coalesce(bool_or(exists (select 1 from page_access pa where pa.page_id = d.id)), false) as restricted,
        coalesce(bool_or(d.deleted_at is not null), false) as trashed,
        coalesce(bool_or(d.space_id <> ${spaceId}), false) as cross_space,
        exists (
          select 1 from d d2
          join pages c on c.parent_page_id = d2.id and c.workspace_id = ${ws}
          where d2.depth >= ${LIFECYCLE_MAX_DEPTH} or c.id = any(d2.path)
        ) as incomplete
      from d
    `.execute(this.db);
    const r = res.rows[0];
    const complete = !r?.incomplete;
    return {
      // An incomplete walk may have missed any of these, so each reads as TRUE (fail closed).
      restricted: !complete || !!r?.restricted,
      trashed: !complete || !!r?.trashed,
      crossSpace: !complete || !!r?.crossSpace,
      complete,
    };
  }

  private async targetFacts(
    ws: string,
    page: { id: string; spaceId: string },
    targetParentPageId: string | null,
  ): Promise<LifecycleTarget> {
    if (targetParentPageId === null) {
      return {
        parentPageId: null,
        exists: true,
        spaceId: page.spaceId,
        deletedAt: null,
        restrictedLineageIds: [],
        lineageComplete: true,
        isSelfOrDescendant: false,
        nextPosition: await this.nextPosition(page.spaceId, null),
      };
    }
    const target = await this.pageRow(ws, targetParentPageId);
    if (!target) {
      return {
        parentPageId: targetParentPageId,
        exists: false,
        spaceId: null,
        deletedAt: null,
        restrictedLineageIds: [],
        lineageComplete: false,
        isSelfOrDescendant: false,
        nextPosition: null,
      };
    }
    const lineage = await this.lineage(ws, target.id, true);
    return {
      parentPageId: target.id,
      exists: true,
      spaceId: target.spaceId,
      deletedAt: iso(target.deletedAt),
      restrictedLineageIds: lineage.restrictedIds,
      lineageComplete: lineage.complete,
      // The target's walk up passes through the page ⇒ the target is the page or sits beneath it.
      isSelfOrDescendant: lineage.chain.includes(page.id),
      nextPosition: await this.nextPosition(target.spaceId, target.id),
    };
  }

  /**
   * Mirrors `PageService.nextPagePosition` (page.service.ts) — same live-only filter, same `COLLATE "C"` order —
   * without importing PageModule (it drags CollaborationModule/lib0 into the service bridge's DI graph). A pg
   * spec pins that the result sorts after every live sibling.
   */
  async nextPosition(spaceId: string, parentPageId: string | null): Promise<string> {
    const res = await sql<{ position: string | null }>`
      select position from pages
      where space_id = ${spaceId}
        and deleted_at is null
        and ${parentPageId === null ? sql`parent_page_id is null` : sql`parent_page_id = ${parentPageId}`}
      order by position collate "C" desc
      limit 1
    `.execute(this.db);
    const last = res.rows[0]?.position ?? null;
    return generateJitteredKeyBetween(last, null);
  }
}
