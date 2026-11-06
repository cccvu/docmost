import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';

const logger = new Logger('WsEventRecipients');

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Who of a room's connected users may receive a realtime event about a page (`ws.service.ts`
 * `broadcastToAuthorizedUsers`, seam #196). In remote mode `getUserIdsWithPageAccess` is the PDP, and since #716 a PDP
 * that could not answer is a 503 (`authzUnavailable`) instead of `[]`. That is right for every request path, but this
 * one is fire-and-forget: upstream's comment create/update/delete call `emitCommentEvent` without awaiting it, so the
 * 503 would surface as a process-level UnhandledRejection on every restricted-page comment during an outage. So a 503
 * here sends the event to nobody (fail closed: fewer recipients, never more) and logs `WS_EVENT_DROPPED` once.
 * Clients pick the change up on their next fetch.
 *
 * Only a `ServiceUnavailableException` degrades. Anything else is rethrown, as upstream does.
 */
export async function pageEventRecipients(
  pagePermissionRepo: Pick<PagePermissionRepo, 'getUserIdsWithPageAccess'>,
  pageId: string,
  candidateUserIds: string[],
): Promise<string[]> {
  try {
    return await pagePermissionRepo.getUserIdsWithPageAccess(pageId, candidateUserIds);
  } catch (err) {
    if (!(err instanceof ServiceUnavailableException)) throw err;
    logger.warn(
      `WS_EVENT_DROPPED page=${pageId} candidates=${candidateUserIds.length}: the PDP could not decide who may see the page; the realtime event was sent to no one (#716)`,
    );
    return [];
  }
}
