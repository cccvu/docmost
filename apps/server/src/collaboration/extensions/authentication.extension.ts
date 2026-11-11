import { Extension, onAuthenticatePayload } from '@hocuspocus/server';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../../core/auth/services/token.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { findHighestUserSpaceRole } from '@docmost/db/repos/space/utils';
import { SpaceRole } from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { getPageId } from '../collaboration.util';
import { JwtCollabPayload, JwtType } from '../../core/auth/dto/jwt-payload';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { isWsConnectionLive } from '../../authz/ws-connection/ws-connection-live';
import { CollabSocketBounds } from '../../authz/collab-ingress/socket-bounds';

@Injectable()
export class AuthenticationExtension implements Extension {
  private readonly logger = new Logger(AuthenticationExtension.name);

  constructor(
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly userSessionRepo: UserSessionRepo,
    private readonly collabSocketBounds: CollabSocketBounds, // CCC (wiki-v2 #810): the process's collab socket bounds
  ) {}

  async onAuthenticate(data: onAuthenticatePayload) {
    const { documentName, token } = data;
    const pageId = getPageId(documentName);

    let jwtPayload: JwtCollabPayload;

    try {
      jwtPayload = await this.tokenService.verifyJwt(token, JwtType.COLLAB);
    } catch (error) {
      // CCC (wiki-v2 #790, #810, UPSTREAM_MODIFICATIONS #213): no `message`, so Hocuspocus logs nothing per bad token;
      // logged rate-limited as `invalid_token` with its kind only.
      throw this.collabSocketBounds.invalidToken(error);
    }

    const userId = jwtPayload.sub;
    const workspaceId = jwtPayload.workspaceId;

    // CCC (wiki-v2 #790, #810, UPSTREAM_MODIFICATIONS #213): before any read, a token naming no session is refused, the
    // token's session is charged its auth rate (a revoked session's leaked token drains only its own), and the per-user
    // connection cap is checked.
    this.collabSocketBounds.chargeSession(userId, jwtPayload.sessionId);
    this.collabSocketBounds.admitUser(userId);

    const user = await this.userRepo.findById(userId, workspaceId);

    if (!user) {
      throw new UnauthorizedException();
    }

    if (isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    // CCC (wiki-v2 #537, UPSTREAM_MODIFICATIONS #213): the token's session must still be live, the same rule as
    // /api and the notifications socket. A failed read throws, which refuses the connection.
    if (
      !(await isWsConnectionLive(
        this.userRepo,
        this.userSessionRepo,
        jwtPayload,
      ))
    ) {
      throw new UnauthorizedException();
    }

    // CCC (wiki-v2 #810, UPSTREAM_MODIFICATIONS #213): the per-user auth rate, charged only once the session is live.
    this.collabSocketBounds.chargeUser(userId);

    const page = await this.pageRepo.findById(pageId);
    if (!page) {
      this.logger.debug(`Page not found: ${pageId}`);
      throw new NotFoundException('Page not found');
    }

    const userSpaceRoles = await this.spaceMemberRepo.getUserSpaceRoles(
      user.id,
      page.spaceId,
    );

    const userSpaceRole = findHighestUserSpaceRole(userSpaceRoles);

    if (!userSpaceRole) {
      this.logger.warn(`User not authorized to access page: ${pageId}`);
      throw new UnauthorizedException();
    }

    // Check page-level permissions
    const { hasAnyRestriction, canAccess, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction) {
      if (!canAccess) {
        this.logger.warn(
          `User ${user.id} denied page-level access to page: ${pageId}`,
        );
        throw new UnauthorizedException();
      }

      if (!canEdit) {
        data.connectionConfig.readOnly = true;
        this.logger.debug(
          `User ${user.id} granted readonly access to restricted page: ${pageId}`,
        );
      }
    } else {
      // No restrictions - use space-level permissions
      if (userSpaceRole === SpaceRole.READER) {
        data.connectionConfig.readOnly = true;
        this.logger.debug(`User granted readonly access to page: ${pageId}`);
      }
    }

    if (page.deletedAt) {
      data.connectionConfig.readOnly = true;
    }

    this.logger.debug(`Authenticated user ${user.id} on page ${pageId}`);

    return {
      user,
    };
  }
}
