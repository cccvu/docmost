import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';

const logger = new Logger('WsSpaceRooms');

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The space ids whose socket.io rooms a new notifications/tree connection joins (`ws.gateway.ts` `handleConnection`,
 * seam #161). In remote mode `getUserSpaceIds` is the PDP's reverse index, and since #716 a PDP that could not answer
 * is a 503 (`authzUnavailable`) instead of `[]`. Every request path wants that 503, but the connect is the one place
 * that must not throw: the gateway's catch emits `Unauthorized` and disconnects, and the client never reconnects on
 * its own, so realtime would stay dead for the session. So a 503 here degrades to no space rooms (today's answer
 * during an outage: the socket still joins its user and workspace rooms) and logs `WS_SPACE_ROOMS_DEGRADED`.
 * The degrade still grants nothing: fewer rooms is less fan-out, never more.
 *
 * Only a `ServiceUnavailableException` degrades. Anything else (a bug, a database error in native mode) is rethrown
 * and the gateway refuses the connection, as upstream does. Known limit: a socket that connected during the outage
 * stays out of its space rooms until the page reloads, long after the PDP recovers.
 */
export async function spaceIdsForConnect(spaceMemberRepo: SpaceMemberRepo, userId: string): Promise<string[]> {
  try {
    return await spaceMemberRepo.getUserSpaceIds(userId);
  } catch (err) {
    if (!(err instanceof ServiceUnavailableException)) throw err;
    logger.warn(
      `WS_SPACE_ROOMS_DEGRADED user=${userId}: the PDP could not list the user's spaces; the socket joins no space rooms until it reconnects (#716)`,
    );
    return [];
  }
}
