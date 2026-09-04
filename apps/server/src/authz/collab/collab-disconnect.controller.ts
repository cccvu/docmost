import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { CollabServiceSecretGuard } from './service-secret.guard';

export class ForceDisconnectDto {
  @IsUUID() userId!: string;
  @IsUUID() pageId!: string;
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
  @Post('force-disconnect')
  async forceDisconnect(@Body() dto: ForceDisconnectDto): Promise<{ disconnected: boolean }> {
    const canAccess = await this.pagePermissionRepo.canUserAccessPage(dto.userId, dto.pageId);
    if (canAccess) return { disconnected: false }; // still authorized — the signal was stale/coarse
    this.gateway.forceDisconnectUserFromPage(dto.pageId, dto.userId);
    return { disconnected: true };
  }
}
