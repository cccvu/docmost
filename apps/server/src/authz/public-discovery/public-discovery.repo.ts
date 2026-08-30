import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Read-only enumeration of pages that are EXPLICITLY public and discoverable, for the anonymous
 * front page. A row is listed iff ALL of these hold — the set-based twin of the three gates the
 * anonymous read path already enforces (share.controller `@Public` handlers → share.service):
 *   1. a `shares` row exists and is not soft-deleted,
 *   2. the owner opted the page into public discovery (`search_indexing = true`; default false),
 *   3. sharing is not disabled at the workspace OR the space (share.service.isSharingAllowed),
 *   4. neither the page nor any ancestor is restricted (page-permission.repo.hasRestrictedAncestor),
 *   5. the page itself is not soft-deleted.
 * All filtering happens IN SQL so cursor pagination stays exact (no authorized-k-under-truncation),
 * and the whole query is hard-scoped to a single tenant by `workspaceId`.
 */
export interface PublicPageListRow {
  id: string; // share row id — cursor key only; not exposed in the API response
  shareKey: string;
  pageId: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceName: string | null;
  spaceSlug: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PublicDiscoveryRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  listPublicPages(opts: { workspaceId: string; perPage: number; cursor?: string }) {
    return executeWithCursorPagination(this.buildListQuery(opts.workspaceId), {
      perPage: opts.perPage,
      cursor: opts.cursor,
      fields: [
        { expression: 'updatedAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        updatedAt: new Date(cursor.updatedAt),
        id: cursor.id,
      }),
    });
  }

  /**
   * The authorization-filtered SELECT (without pagination/order), exposed so the security predicates
   * can be asserted offline via `.compile()`. Every WHERE here is load-bearing — see the class docs.
   */
  buildListQuery(workspaceId: string) {
    return this.db
      // `lockedPages` = every page that is restricted OR has a restricted ancestor, computed as the
      // DOWNWARD closure of the `page_access` restriction markers (a page is locked iff it, or an
      // ancestor, carries a marker). Scoped to the tenant via the base set's workspace filter.
      .withRecursive('lockedPages', (qb) =>
        qb
          .selectFrom('pageAccess')
          .innerJoin('pages as rp', 'rp.id', 'pageAccess.pageId')
          .select('rp.id as id')
          .where('rp.workspaceId', '=', workspaceId)
          .unionAll((eb) =>
            eb
              .selectFrom('pages as cp')
              .innerJoin('lockedPages', 'lockedPages.id', 'cp.parentPageId')
              .select('cp.id as id'),
          ),
      )
      .selectFrom('shares')
      .innerJoin('pages', 'pages.id', 'shares.pageId')
      .innerJoin('spaces', 'spaces.id', 'shares.spaceId')
      .innerJoin('workspaces', 'workspaces.id', 'shares.workspaceId')
      .select([
        'shares.id as id',
        'shares.key as shareKey',
        'shares.pageId as pageId',
        'shares.createdAt as createdAt',
        'shares.updatedAt as updatedAt',
        'pages.slugId as slugId',
        'pages.title as title',
        'pages.icon as icon',
        'spaces.name as spaceName',
        'spaces.slug as spaceSlug',
      ])
      .where('shares.workspaceId', '=', workspaceId)
      .where('shares.deletedAt', 'is', null)
      .where('shares.searchIndexing', '=', true)
      .where('pages.deletedAt', 'is', null)
      // sharing must not be disabled at the workspace or the space (isSharingAllowed, in SQL)
      .where(
        sql<boolean>`coalesce((workspaces.settings -> 'sharing' ->> 'disabled')::boolean, false) = false`,
      )
      .where(
        sql<boolean>`coalesce((spaces.settings -> 'sharing' ->> 'disabled')::boolean, false) = false`,
      )
      // exclude any page that is restricted or under a restricted ancestor
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('lockedPages')
              .select(sql`1`.as('one'))
              .whereRef('lockedPages.id', '=', 'shares.pageId'),
          ),
        ),
      );
  }
}
