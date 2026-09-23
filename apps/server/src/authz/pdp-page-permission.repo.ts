import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { HttpAuthzClient } from './http-authz.client';
import { lineageRestricted, readPageLineage } from '../service-bridge/page-lineage';

/** The decision upstream must trust as a DENY: restricted, so it never falls back to the space role. */
const restrictedNoAccess = () => ({ hasAnyRestriction: true, canAccess: false, canEdit: false });

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * PDP-backed PagePermissionRepo: page view/edit DECISIONS come from the platform (SpiceDB). Page
 * restrictions ARE mirrored now (platform projects page_access → `page:#restricted` and
 * page_permissions → `#viewer`/`#editor`), so `hasAnyRestriction` reflects the schema's `locked`
 * permission (page or an ancestor is restricted). Non-overridden methods delegate to upstream.
 *
 * One input comes from the fork's own rows (#524): for a page the PDP has not placed (trashed, so its #space and
 * #parent edges are reaped; or new, restored or re-parented and not projected yet), `locked` cannot see a
 * restriction the page only inherits, so canUserEditPage walks `pages`/`page_access` before it lets upstream fall
 * back to the space role. That read can only turn an answer into a denial, never widen one.
 */
@Injectable()
export class PdpPagePermissionRepo extends PagePermissionRepo {
  private readonly logger = new Logger(PdpPagePermissionRepo.name);

  constructor(
    // Its own name: the base class keeps its `db` private. Read only by the #524 lineage walk, which can only deny.
    @InjectKysely() private readonly lineageDb: KyselyDB,
    groupRepo: GroupRepo,
    @Inject(CACHE_MANAGER) cacheManager: Cache,
    private readonly authz: HttpAuthzClient,
  ) {
    super(lineageDb, groupRepo, cacheManager);
  }

  private subject(userId: string) {
    return { provider: 'docmost', externalId: userId } as const;
  }

  override async canUserAccessPage(userId: string, pageId: string): Promise<boolean> {
    return this.authz.check(this.subject(userId), 'view', 'page', pageId);
  }

  override async canUserEditPage(
    userId: string,
    pageId: string,
  ): Promise<{ hasAnyRestriction: boolean; canAccess: boolean; canEdit: boolean }> {
    // `locked` (schema: restricted + parent->locked) tells upstream whether to trust the PDP's page
    // decision (restricted page) or fall back to space CASL (unrestricted). The PDP's view/edit
    // already fold restriction in, so canAccess/canEdit are correct either way.
    const results = await this.authz.tryCheckBulk(this.subject(userId), [
      { permission: 'view', resourceType: 'page', resourceId: pageId },
      { permission: 'edit', resourceType: 'page', resourceId: pageId },
      { permission: 'locked', resourceType: 'page', resourceId: pageId },
    ]);
    // #492 FAIL CLOSED on an UNKNOWN restriction state. `locked=false` RELAXES access (upstream then falls back
    // to the space role, which comes from a SEPARATE call that may well have succeeded), so reading a failed
    // batch as all-false would open a restricted page to every space member during a PDP error. Unknown ⇒
    // restricted with no access: upstream then trusts this decision and denies.
    if (!results) return restrictedNoAccess();
    const [canAccess, canEdit, locked] = results;
    // #524 FAIL CLOSED on a page the PDP has not PLACED. Trashing reaps a page's #space/#parent edges, and a page that
    // is new, restored or re-parented has none until the relay projects it. The PDP then answers view=false AND
    // locked=false: `locked` (restricted + parent->locked) cannot see a restriction the page only INHERITS through
    // the missing #parent. That `locked=false` RELAXES access exactly as in #492 — upstream falls back to the space
    // role, so every space member could read the page (by id or slug) and every writer edit, restore or move it; a
    // restore under a trashed ancestor, or a move to the root, then declassifies it for good. So before that
    // fallback, ask the fork's own rows: only a lineage walked to its root with no restriction on it (the page itself
    // included, trashed ancestors included) may fall back. Anything else is restricted with no access, for everyone
    // — as a placed page in a restricted section already is (grants do not cascade). An unrestricted page keeps
    // upstream's behaviour, which the `/v1` restore and its read-back rely on.
    if (!canAccess && !locked && (await this.lineageDenies(pageId))) return restrictedNoAccess();
    return { hasAnyRestriction: locked, canAccess, canEdit };
  }

  /** #524: may upstream NOT fall back to the space role for this page? True for a restricted lineage, one the walk
   *  could not finish (a cycle, the depth bound, a parent it cannot read) or begin (no row), and a failed read. */
  private async lineageDenies(pageId: string): Promise<boolean> {
    try {
      const lineage = await readPageLineage(this.lineageDb, pageId, { includeSelf: true });
      if (lineage.chain.length > 0 && !lineage.complete) {
        this.logger.warn(
          `PAGE_LINEAGE_INCOMPLETE page=${pageId}: its ancestor walk stopped early (a cycle, the depth bound or an unreadable parent); denied (#524)`,
        );
      }
      return lineageRestricted(lineage);
    } catch (err) {
      this.logger.error(
        `PAGE_LINEAGE_READ_FAILED page=${pageId}: could not read its restriction lineage; denied (#524): ${(err as Error).message}`,
      );
      return true;
    }
  }

  override async filterAccessiblePageIds(opts: {
    pageIds: string[];
    userId: string;
    spaceId?: string;
  }): Promise<string[]> {
    if (opts.pageIds.length === 0) return [];
    return this.authz.filterResources(this.subject(opts.userId), 'view', 'page', opts.pageIds);
  }

  /**
   * Sidebar / tree listing: the viewable subset of `pageIds` WITH their edit capability — from the
   * PDP, not the local mirror (closes the sidebar leakage vector). Two checks per page (view, edit),
   * chunked under the platform's 256-check bulk cap; a page is included only if view passes.
   */
  override async filterAccessiblePageIdsWithPermissions(
    pageIds: string[],
    userId: string,
  ): Promise<Array<{ id: string; canEdit: boolean }>> {
    if (pageIds.length === 0) return [];
    const subject = this.subject(userId);
    const out: Array<{ id: string; canEdit: boolean }> = [];
    const CHUNK = 128; // 2 checks/page ≤ the platform's 256-item bulk cap
    for (let i = 0; i < pageIds.length; i += CHUNK) {
      const batch = pageIds.slice(i, i + CHUNK);
      const checks = batch.flatMap((id) => [
        { permission: 'view', resourceType: 'page', resourceId: id },
        { permission: 'edit', resourceType: 'page', resourceId: id },
      ]);
      const results = await this.authz.checkBulk(subject, checks);
      batch.forEach((id, j) => {
        if (results[j * 2]) out.push({ id, canEdit: !!results[j * 2 + 1] });
      });
    }
    return out;
  }

  /**
   * Reverse index (recipient filter): of `userIds`, which may VIEW the page — from the PDP, not the
   * local mirror. Powers comment/mention/update/verification notification fan-out.
   */
  override async getUserIdsWithPageAccess(pageId: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    return this.authz.filterSubjects('view', 'page', pageId, userIds);
  }
}
