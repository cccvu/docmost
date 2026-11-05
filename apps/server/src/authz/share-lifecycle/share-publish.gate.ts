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
 * One bulk check for the user over `[page#edit, page#share]` on the RESOLVED page id (never a raw slug):
 *  - `null` (the PDP could not answer, or does not know `share` — an authorization service before contract 1.12.0)
 *    → 503 `authzUnavailable()`, retryable, `Retry-After` from RetryAfterFilter (#696);
 *  - `edit && !share` → 403 `share_not_permitted`;
 *  - anything else → no answer here: the route's own checks decide (its 403 for a non-editor, its 400 for a
 *    restricted page). Refusing only when edit holds means this never answers before them, so it adds no
 *    existence oracle (edit ⇒ view, #542).
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
  async requirePublish(userId: string, pageId: string): Promise<void> {
    if (this.mode !== 'remote') return;
    const results = await this.authz.tryCheckBulk({ provider: 'docmost', externalId: userId }, [
      { permission: 'edit', resourceType: 'page', resourceId: pageId },
      { permission: SHARE_PUBLISH_PERMISSION, resourceType: 'page', resourceId: pageId },
    ]);
    if (!results || results.length !== 2) throw authzUnavailable();
    const [edit, share] = results;
    if (edit === true && share !== true) throw shareNotPermitted();
  }
}
