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
 * Returns `true` iff the connection may proceed. The `sessionId` check is conditional exactly as in
 * `jwt.strategy`: platform-minted sessions always carry one; a token without a `sessionId` is gated on
 * `isUserDisabled` alone (never fail-open — a missing/expired/revoked session row is rejected).
 */
export async function isWsConnectionLive(
  userRepo: UserRepo,
  userSessionRepo: UserSessionRepo,
  payload: JwtPayload,
): Promise<boolean> {
  const user = await userRepo.findById(payload.sub, payload.workspaceId);
  if (!user || isUserDisabled(user)) {
    return false;
  }
  if (payload.sessionId) {
    const session = await userSessionRepo.findActiveById(payload.sessionId);
    if (
      !session ||
      session.userId !== payload.sub ||
      session.workspaceId !== payload.workspaceId
    ) {
      return false;
    }
  }
  return true;
}
