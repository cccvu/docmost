import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { isUserDisabled } from '../../common/helpers';
import { JwtPayload } from '../../core/auth/dto/jwt-payload';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The liveness predicate for a socket.io (notifications/tree) connection, factored OUT of the upstream
 * `ws.gateway` so the policy lives here in authz/. It mirrors `jwt.strategy.validate` (the `/api/*` guard):
 * after the ACCESS JWT signature/expiry are verified, RE-READ the fork user and the session row so a
 * mid-session revocation takes effect at the next connection instead of riding the token's 30–90d life.
 *
 * Why this exists (#455): before this gate, the notifications socket authenticated on the ACCESS JWT
 * signature ALONE — no `isUserDisabled`, no `user_sessions` check — so a disabled identity (or one whose
 * session was revoked) could keep opening NEW tree/comment sockets with the lingering `__Host-authToken`
 * cookie for the full token lifetime, leaking live page titles / tree moves / renames / comment events.
 * Account disable now sets `deactivatedAt` + revokes `user_sessions` on the shadow user, and this gate
 * makes the notifications plane honor it, closing the residual to the next (re)connection.
 *
 * The collab (Hocuspocus) connect gate uses it too (#537): `AuthenticationExtension.onAuthenticate` passes the
 * COLLAB token's payload, whose `sessionId` is the session of the access token it was minted from
 * (`TokenService.generateCollabToken`). So a signed-out, revoked or expired session stops opening collab
 * documents at the next connect, instead of riding the collab token's 24h life.
 *
 * Returns `true` iff the connection may proceed. As in `jwt.strategy` (#133), every token must carry a
 * `sessionId` (the only access mint, `SessionService.createSessionAndToken`, always sets one, and since #537 the
 * collab mint refuses without one): a token without one is rejected, and a missing/expired/revoked or mismatched
 * session row is rejected. A failed read throws (the caller refuses), never allows. `liveness-parity.spec.ts`
 * pins the three planes in lockstep.
 */
export async function isWsConnectionLive(
  userRepo: UserRepo,
  userSessionRepo: UserSessionRepo,
  payload: Pick<JwtPayload, 'sub' | 'workspaceId' | 'sessionId'>,
): Promise<boolean> {
  const user = await userRepo.findById(payload.sub, payload.workspaceId);
  if (!user || isUserDisabled(user)) {
    return false;
  }
  if (!payload.sessionId) {
    return false;
  }
  const session = await userSessionRepo.findActiveById(payload.sessionId);
  if (
    !session ||
    session.userId !== payload.sub ||
    session.workspaceId !== payload.workspaceId
  ) {
    return false;
  }
  return true;
}
