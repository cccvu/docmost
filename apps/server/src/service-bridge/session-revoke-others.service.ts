import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { TokenService } from '../core/auth/services/token.service';
import { JwtType } from '../core/auth/dto/jwt-payload';
import { shadowEmailFor } from './shadow-user';
import { WorkspaceResolver } from './workspace-resolver';

/** The answer of `POST /api/service/session/revoke-others`. */
export interface RevokeOtherSessionsResult {
  /** The shadow user's fork id, for `/api/collab/force-disconnect-user`; null when there is no shadow user. */
  userId: string | null;
  /** How many live sessions this call revoked. */
  revoked: number;
  /** True only when `keepToken` named a live session of this user, which was left alone. */
  kept: boolean;
}

/**
 * CCC service-bridge — NOT upstream Docmost code (wiki-v2 #818).
 *
 * Signs a platform identity out of every wiki session but the caller's own, without deactivating it: the
 * platform calls this when a person removes a passkey, then force-disconnects the user's realtime sockets. The
 * caller's own tabs reconnect on their still-live session; any other session's reconnect is refused
 * (`isWsConnectionLive`).
 *
 * The fork never trusts the caller about which session to keep. `keepToken` is kept only when the fork's own
 * verification says it is an access token it signed, unexpired, for THIS shadow user in this workspace, naming a
 * live session of that user (the same session check `jwt.strategy` makes). Anything else — no token, a bad
 * signature, an expired token, another user's token, a revoked session — keeps nothing and revokes them all.
 * That direction is safe: the worst outcome is that the person signs in again.
 *
 * The UPDATE has the predicate of `UserSessionRepo.revokeAllExceptCurrent` / `revokeByUserId`, run here so the
 * count can be read (those upstream methods return void and stay unedited). `deactivatedAt` is never touched.
 */
@Injectable()
export class SessionRevokeOthersService {
  private readonly logger = new Logger(SessionRevokeOthersService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly userSessionRepo: UserSessionRepo,
    private readonly tokenService: TokenService,
    private readonly workspaces: WorkspaceResolver,
  ) {}

  async revokeOtherSessions(
    externalId: string,
    keepToken?: string,
  ): Promise<RevokeOtherSessionsResult> {
    const workspaceId = await this.workspaces.resolveDefaultWorkspaceId();
    const user = await this.userRepo.findByEmail(
      shadowEmailFor(externalId),
      workspaceId,
    );
    if (!user) return { userId: null, revoked: 0, kept: false };

    const keepSessionId = keepToken
      ? await this.verifiedKeepSession(keepToken, user.id, workspaceId)
      : null;

    let update = this.db
      .updateTable('userSessions')
      .set({ revokedAt: new Date() })
      .where('userId', '=', user.id)
      .where('workspaceId', '=', workspaceId)
      .where('revokedAt', 'is', null);
    if (keepSessionId) update = update.where('id', '!=', keepSessionId);
    const result = await update.executeTakeFirst();

    const revoked = Number(result?.numUpdatedRows ?? 0n);
    const kept = keepSessionId !== null;
    this.logger.log(
      `revoked other sessions of shadow user ${user.id} (revoked=${revoked} kept=${kept})`,
    );
    return { userId: user.id, revoked, kept };
  }

  /**
   * The id of the live session `keepToken` names, or null when the token does not prove one for this user. Only
   * the token checks map to null; a database failure propagates, so the call fails without revoking anything.
   */
  private async verifiedKeepSession(
    keepToken: string,
    userId: string,
    workspaceId: string,
  ): Promise<string | null> {
    let payload: Record<string, unknown>;
    try {
      // The APP_SECRET signature, `exp`, and `type === access`.
      payload = await this.tokenService.verifyJwt(keepToken, JwtType.ACCESS);
    } catch {
      return null;
    }
    const sessionId = payload?.sessionId;
    if (
      payload?.sub !== userId ||
      payload?.workspaceId !== workspaceId ||
      typeof sessionId !== 'string' ||
      !sessionId
    ) {
      return null;
    }
    const session = await this.userSessionRepo.findActiveById(sessionId);
    if (
      !session ||
      session.userId !== userId ||
      session.workspaceId !== workspaceId
    )
      return null;
    return sessionId;
  }
}
