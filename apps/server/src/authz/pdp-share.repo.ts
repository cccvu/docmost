import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { InferResult, sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx, executeTx } from '@docmost/db/utils';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { InsertableShare, Share } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import {
  emptyCursorPaginationResult,
  executeWithCursorPagination,
} from '@docmost/db/pagination/cursor-pagination';
import { CURSOR_KEY, LABEL_SCAN, authorizedKeysetPage, clampLimit, scanBudget } from './pdp-label.repo';
import { shareIsLiveSql } from './share-lifecycle/share-expiry.sql';
import { boundWaits } from '../service-bridge/resource-version';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * PDP-backed, expiry-enforcing ShareRepo (remote mode only; native keeps the stock repo). Two jobs:
 *
 * 1. The shares list (`POST /api/shares`, #660) is filter-then-retrieve. Upstream lists every share in a space the
 *    caller belongs to per the LOCAL `space_members` mirror, with no page check, so it listed the title of a page
 *    restricted after it was shared. Here the candidate spaces come from the PDP (`getUserSpaceIds` →
 *    lookup-resources), `shares.workspace_id` is pinned to the caller's workspace, trashed pages and expired shares
 *    are excluded in SQL, and every candidate window is gated through the PDP page view
 *    (`filterAccessiblePageIds`) BEFORE pagination (`authorizedKeysetPage`, the label lists' walk — same limits,
 *    same canonical empty result, cursors only from authorized rows). A PDP outage yields an empty space set or an
 *    empty allowed set: an empty list, never the mirror's. The `{ items, meta }` shape is upstream's; the mirror
 *    `space.userRole` stays because it is UX only (it disables "Delete share"; the server re-validates).
 *
 * 2. Public share EXPIRY (#335, ADR 0032) is enforced at READ time, here, through the existing DI seam #1 — so the
 *    sweeper is cleanup only. Every by-id/by-page read answers `undefined` for an expired share (`shareIsLiveSql`,
 *    against the database's `now()`), which is "Share not found" on every path that goes through the token:
 *    `/shares/info`, `/shares/tree`, update/delete, the expiry API, upstream share-search, and — through
 *    `ShareService.getShareForPage`'s re-read of the resolved share — page-info, SEO, `/for-page`, transclusion
 *    and `files/public`. An error evaluating expiry THROWS (the request fails, no content), never returns the share.
 *    `insertShare` deletes the page's expired rows in the same transaction before inserting, so a re-share after
 *    expiry is a fresh share and never a duplicate row the `limit 1` CTE in `getShareForPage` could pick.
 *
 * 3. ONE live share per page (#335 review). Upstream `createShare` is check-then-insert with no unique constraint, so
 *    two concurrent publishes of one page could both insert: unpublish or an expiry change then acts on one row and
 *    the page stays public through the other. `insertShare` takes the per-page lock
 *    `pg_advisory_xact_lock(SHARE_PUBLISH_LOCK_CLASS, hashtext(pageId))` FIRST, re-checks for a live share under it
 *    and returns that share instead of inserting — upstream's own idempotent answer when a share exists. Waits are
 *    bounded (`boundWaits`) when it owns the transaction; a timeout reaches `createShare`'s catch, which answers
 *    upstream's 400 "Failed to share page" (retryable; the lock is held for one short transaction).
 *
 * The surface is pinned in pdp-share.repo.spec.ts: every `ShareRepo` method is classified, so an upstream bump that
 * adds a share read goes red until someone decides how it handles expiry and the PDP.
 *
 * NOTE (upstream-bump drift): the list's field set mirrors `ShareRepo.baseFields` (private upstream) as of Docmost
 * v0.95.0. Its sort compares `date_trunc('milliseconds', updated_at)` (the cursor carries a millisecond Date and the
 * walk crosses a keyset edge every window — see PdpLabelRepo).
 */
/**
 * The two-int4 advisory lock class of the per-page publish lock (`insertShare`). Distinct from the other CCC classes
 * (485485 cycle/restriction guards, 616616 page ACL); the single-bigint install keys live in a separate key space.
 */
export const SHARE_PUBLISH_LOCK_CLASS = 335335;

@Injectable()
export class PdpShareRepo extends ShareRepo {
  private readonly logger = new Logger(PdpShareRepo.name);

  // The parent keeps its deps `private` — hold our own distinctly-named references.
  constructor(
    @InjectKysely() private readonly database: KyselyDB,
    private readonly spaceMembers: SpaceMemberRepo,
    private readonly pagePermissions: PagePermissionRepo,
  ) {
    super(database, spaceMembers);
  }

  /** The upstream read, then the expiry veto (in the caller's transaction, after its lock when it asked for one). */
  override async findById(
    shareId: string,
    opts?: {
      includeSharedPage?: boolean;
      includeCreator?: boolean;
      withLock?: boolean;
      trx?: KyselyTransaction;
    },
  ): Promise<Share> {
    const share = await super.findById(shareId, opts);
    if (!share) return share;
    return (await this.isLive(share.id, opts?.trx)) ? share : undefined;
  }

  /** The page's LIVE share (an expired row not yet swept is skipped, never returned and never reused). */
  override async findByPageId(
    pageId: string,
    opts?: {
      includeCreator?: boolean;
      withLock?: boolean;
      trx?: KyselyTransaction;
    },
  ): Promise<Share> {
    const res = await sql<{ id: string }>`
      select s.id from shares s
      where s.page_id = ${pageId} and ${shareIsLiveSql('s')}
      order by s.created_at, s.id
      limit 1
    `.execute(dbOrTx(this.database, opts?.trx));
    const id = res.rows[0]?.id;
    if (!id) return undefined;
    return this.findById(id, { includeCreator: opts?.includeCreator, withLock: opts?.withLock, trx: opts?.trx });
  }

  /**
   * Under the per-page publish lock: remove the page's expired (not yet swept) share rows, then return the page's
   * live share if one exists (a concurrent publish won), else insert — one transaction.
   */
  override async insertShare(insertableShare: InsertableShare, trx?: KyselyTransaction): Promise<Share> {
    return executeTx(
      this.database,
      async (tx) => {
        const pageId = insertableShare.pageId as string | undefined;
        if (pageId) {
          // Bound the waits only on our own transaction (SET LOCAL would outlive this call in a caller's).
          if (!trx) await boundWaits(tx);
          await sql`
            select pg_advisory_xact_lock(${sql.lit(SHARE_PUBLISH_LOCK_CLASS)}, hashtext(${pageId}::text))
          `.execute(tx);
          await sql`
            delete from shares s
            where s.page_id = ${pageId} and not ${shareIsLiveSql('s')}
          `.execute(tx);
          const live = await this.findByPageId(pageId, { trx: tx });
          if (live) return live;
        }
        return super.insertShare(insertableShare, tx);
      },
      trx,
    );
  }

  override async getShares(userId: string, pagination: PaginationOptions) {
    const perPage = clampLimit(pagination.limit);
    // `getShares` carries no workspace: the caller's own row pins it (a user belongs to exactly one workspace).
    const caller = await sql<{ workspaceId: string | null }>`
      select u.workspace_id from users u where u.id = ${userId}
    `.execute(this.database);
    const workspaceId = caller.rows[0]?.workspaceId ?? null;
    const spaceIds = workspaceId ? await this.spaceMembers.getUserSpaceIds(userId) : [];

    const query = this.database
      .selectFrom('shares')
      .select([
        'shares.id',
        'shares.key',
        'shares.pageId',
        'shares.includeSubPages',
        'shares.searchIndexing',
        'shares.creatorId',
        'shares.spaceId',
        'shares.workspaceId',
        'shares.createdAt',
        'shares.updatedAt',
        'shares.deletedAt',
      ])
      .select((eb) => this.withPage(eb))
      .select((eb) => this.withSpace(eb, userId))
      .select((eb) => this.withCreator(eb))
      .where('shares.workspaceId', '=', workspaceId)
      .where(sql<boolean>`shares.space_id = any(${spaceIds}::uuid[])`)
      .where(
        sql<boolean>`exists (
          select 1 from pages p
          where p.id = shares.page_id and p.deleted_at is null and p.workspace_id = shares.workspace_id
        )`,
      )
      .where(shareIsLiveSql('shares'));

    type Row = InferResult<typeof query>[number];
    // The caller's raw limit, never the clamped perPage (AuthorizedKeysetPageOpts.metaLimit).
    if (!workspaceId || spaceIds.length === 0) return emptyCursorPaginationResult<Row>(pagination.limit);
    return authorizedKeysetPage<Row>({
      perPage,
      metaLimit: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      window: LABEL_SCAN.PAGE_WINDOW,
      budget: scanBudget(perPage + 1),
      fetchWindow: (b) =>
        executeWithCursorPagination(query, {
          perPage: b.perPage,
          cursor: b.cursor,
          beforeCursor: b.beforeCursor,
          cursorPerRow: CURSOR_KEY,
          fields: [
            {
              expression: sql<Date>`date_trunc('milliseconds', shares.updated_at)`,
              direction: 'desc',
              key: 'updatedAt',
            },
            { expression: 'shares.id', direction: 'desc', key: 'id' },
          ],
          parseCursor: (cursor) => ({
            updatedAt: new Date(cursor.updatedAt),
            id: cursor.id,
          }),
        }),
      gate: async (rows) => {
        const viewable = new Set(
          await this.pagePermissions.filterAccessiblePageIds({
            pageIds: [...new Set(rows.map((r) => r.pageId).filter((id): id is string => !!id))],
            userId,
          }),
        );
        return {
          allowed: new Set(rows.filter((r) => r.pageId && viewable.has(r.pageId)).map((r) => r.id)),
          cost: rows.length,
          undecided: new Set<string>(),
        };
      },
      onTruncated: (info) =>
        this.logger.warn(
          `filter-then-retrieve hit the candidate scan budget (${info.budget}, spent ${info.spent}) before ` +
            `collecting ${info.need} authorized shares (collected ${info.collected}, userId=${userId}); the ` +
            `result may be incomplete when the caller cannot see most candidates`,
        ),
    });
  }

  /** Is the share (by uuid) live now? Throws when expiry cannot be evaluated — the caller then fails closed. */
  private async isLive(shareId: string, trx?: KyselyTransaction): Promise<boolean> {
    const res = await sql<{ live: boolean }>`
      select ${shareIsLiveSql('s')} as live from shares s where s.id = ${shareId}
    `.execute(dbOrTx(this.database, trx));
    return res.rows[0]?.live === true;
  }
}
