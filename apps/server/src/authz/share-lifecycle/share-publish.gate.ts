import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { HttpAuthzClient } from '../http-authz.client';
import { authzUnavailable } from '../authz-unavailable';

/** The PDP permission that lets a principal change a page's publish state (wiki-v2 #704; contract 1.12.0). */
export const SHARE_PUBLISH_PERMISSION = 'share';

export const SHARE_NOT_PERMITTED_MESSAGE = 'Your role does not allow publishing pages to the web';

/** 403: the caller may edit the page but holds no `page#share`. A fixed text naming no page, space or role. */
export function shareNotPermitted(): ForbiddenException {
  return new ForbiddenException({ message: SHARE_NOT_PERMITTED_MESSAGE, code: 'share_not_permitted' });
}

/**
 * CCC share lifecycle — NOT upstream Docmost code (wiki-v2 #704, ADR 0032 amendment).
 *
 * The publish decision. In `AUTHZ_MODE=remote`, changing a page's publish state — creating its share, updating it
 * (`includeSubPages`, `searchIndexing`) or setting its expiry — needs `page#share` on top of the edit check the
 * routes already make. Upstream gates all three on page edit alone, and both native "disable sharing" switches are
 * licence-gated (and the workspace one is refused in remote mode), so without this the console's `share` capability
 * governed nothing. Deleting a share only narrows exposure and stays edit-only.
 *
 * One bulk check for the user over `[page#edit, page#share, space#edit, space#share]`, on the RESOLVED page id (never
 * a raw slug) and on the space its ROW is in now (`page.spaceId`). The space leg is not redundant: the route's own
 * edit check (`PageAccessService.validateCanEdit`) reads the space role on the row's space whenever the page is not
 * locked, and on a page the PDP has not placed yet (new, duplicated, imported, or a cross-space move the relay has
 * not projected) `page#edit`/`page#share` are false or describe the OLD space while that check still lets a space
 * writer through (the #524 lineage walk, for an open lineage). Deciding on the page alone would fail open there.
 *  - `null` or a short answer (the PDP could not answer, or does not know `share` — an authorization service before
 *    contract 1.12.0) → 503 `authzUnavailable()`, retryable, `Retry-After` from RetryAfterFilter (#696);
 *  - `page#edit && !page#share` → 403 `share_not_permitted`;
 *  - `(page#edit || space#edit) && !space#share` → 403 `share_not_permitted`: every way the route's edit check can
 *    pass (the page's own PDP edit, or the space role on the row's space) needs `share` on the space the page is in
 *    NOW;
 *  - anything else (no edit on the page and no edit on its space) → no answer here: the route's own checks refuse
 *    (the space-role fallback needs space edit, #542). A refusal names no page, space or role, and it is only ever
 *    given to a caller who already edits the page or its space, after the page resolved (which the handler's own
 *    403-not-404 already reveals), so the gate adds no existence oracle.
 * Native mode: a no-op (upstream's edit check is the whole rule there).
 *
 * Callers: `SharePublishInterceptor` (the upstream `ShareController.create` / `.update`) and the fork-owned
 * `ShareExpiryController.set`. `share-publish.fitness.spec.ts` pins that every route reaching a share-widening sink
 * is one of them.
 */
@Injectable()
export class SharePublishGate {
  constructor(
    @Inject(AUTHZ_MODE) private readonly mode: AuthzMode,
    private readonly authz: HttpAuthzClient,
  ) {}

  /** Resolves when the publish may proceed to the route's own checks; throws 403 / 503 otherwise (remote only). */
  async requirePublish(userId: string, page: { id: string; spaceId: string }): Promise<void> {
    if (this.mode !== 'remote') return;
    const results = await this.authz.tryCheckBulk({ provider: 'docmost', externalId: userId }, [
      { permission: 'edit', resourceType: 'page', resourceId: page.id },
      { permission: SHARE_PUBLISH_PERMISSION, resourceType: 'page', resourceId: page.id },
      { permission: 'edit', resourceType: 'space', resourceId: page.spaceId },
      { permission: SHARE_PUBLISH_PERMISSION, resourceType: 'space', resourceId: page.spaceId },
    ]);
    if (!results || results.length !== 4) throw authzUnavailable();
    const [pageEdit, pageShare, spaceEdit, spaceShare] = results.map((r) => r === true);
    if (pageEdit && !pageShare) throw shareNotPermitted();
    if ((pageEdit || spaceEdit) && !spaceShare) throw shareNotPermitted();
  }
}
