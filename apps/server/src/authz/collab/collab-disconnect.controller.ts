import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { IsUUID } from 'class-validator';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { CollabServiceSecretGuard } from './service-secret.guard';

export class ForceDisconnectDto {
  @IsUUID() userId!: string;
  @IsUUID() pageId!: string;
}

/** #455 — the whole-identity (all-pages) variant, for account disable. Only a userId: there is no page. */
export class ForceDisconnectUserDto {
  @IsUUID() userId!: string;
}

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The inbound seam for mid-session collab revocation: the platform (which owns the SpiceDB view of
 * access) signals that a user's access to a page may have been revoked. We RE-CHECK the decision here
 * through the rebound PDP-backed repo (fail-safe: never disconnect a user who still has access), then
 * route a force-disconnect to the doc-owning collab node via the gateway. All authorization lives
 * here in authz/; the collab seams (gateway pass-through + handler) carry no policy. `RemoteOnlyGuard`
 * 404s this route unless AUTHZ_MODE=remote (the surface is meaningless without the platform).
 */
@UseGuards(RemoteOnlyGuard, CollabServiceSecretGuard)
@Controller('collab')
export class CollabDisconnectController {
  constructor(
    private readonly gateway: CollaborationGateway,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  @HttpCode(HttpStatus.OK)
  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)
  @Post('force-disconnect')
  async forceDisconnect(@Body() dto: ForceDisconnectDto): Promise<{ disconnected: boolean }> {
    const canAccess = await this.pagePermissionRepo.canUserAccessPage(dto.userId, dto.pageId);
    if (canAccess) return { disconnected: false }; // still authorized — the signal was stale/coarse
    this.gateway.forceDisconnectUserFromPage(dto.pageId, dto.userId);
    return { disconnected: true };
  }

  /**
   * #455 — account-disable per-user disconnect: force-close EVERY live collab socket for a user across all
   * documents (node-local). Invoked by the platform ONLY after `/api/service/session/revoke` has set the
   * shadow user's `deactivatedAt` — a precise, whole-identity signal — so, UNLIKE the per-page
   * `forceDisconnect` above (whose PagePermissionChanged signal can be coarse and therefore re-checks page
   * access), this closes the sockets unconditionally: the residual it targets is a continuously-open editor
   * with no per-message re-auth. Service-secret gated; an erroneous call only forces a transient reconnect
   * that an active user re-authenticates fine. See collaboration.gateway.ts `forceDisconnectUser` for the
   * single-node scope.
   */
  @HttpCode(HttpStatus.OK)
  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)
  @Post('force-disconnect-user')
  async forceDisconnectUser(
    @Body() dto: ForceDisconnectUserDto,
  ): Promise<{ disconnected: boolean }> {
    this.gateway.forceDisconnectUser(dto.userId);
    return { disconnected: true };
  }
}
