import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipTransform } from '../common/decorators/skip-transform.decorator';
import { FastifyReply } from 'fastify';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { RemoteOnlyGuard } from '../authz/mode/remote-only.guard';
import { ServiceBridgeService, ShadowUserLookup } from './service-bridge.service';
import { RequireServiceScope, ServiceAuthGuard } from './service-auth.guard';
import { ServiceScope } from './service-scope';
import { MintSessionDto } from './dto/mint-session.dto';
import { SessionExternalIdDto } from './dto/session-external-id.dto';
import { RevokeOtherSessionsDto } from './dto/revoke-other-sessions.dto';
import { RevokeOtherSessionsResult, SessionRevokeOthersService } from './session-revoke-others.service';
import { ProvisionUserDto } from './dto/provision-user.dto';
import { ResolveUserDto } from './dto/resolve-user.dto';
import { LookupUsersDto } from './dto/lookup-users.dto';
import { WorkspaceResolver } from './workspace-resolver';
import { setDocmostAuthCookie } from '../authz/session-cookie/docmost-auth-cookie';
import { mintFreshness } from '../authz/step-up/session-freshness';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * The east-west service API the platform (or any implementer of the documented contract) calls: shadow
 * user provisioning + session brokerage. `RemoteOnlyGuard` 404s the whole surface unless AUTHZ_MODE=remote
 * (ordered FIRST, so native never even consults the secret); the scoped ServiceAuthGuard then enforces
 * least privilege (fail-closed, constant-time, rate-limited). Not for browsers — service-to-service only.
 */
@Controller('service')
@UseGuards(RemoteOnlyGuard, ServiceAuthGuard)
export class ServiceBridgeController {
  constructor(
    private readonly service: ServiceBridgeService,
    private readonly environmentService: EnvironmentService,
    private readonly workspaces: WorkspaceResolver,
    private readonly revokeOthers: SessionRevokeOthersService,
  ) {}

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post('users')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.UsersProvision)
  async provisionUser(@Body() dto: ProvisionUserDto) {
    // The fork resolves the workspace itself; it returns the resolved { userId, workspaceId } so the
    // caller never has to know (or supply) a Docmost workspace id.
    return this.service.provisionShadowUser(dto);
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post('users/resolve')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.UsersResolve)
  async resolveUser(@Body() dto: ResolveUserDto): Promise<{ userId: string; workspaceId: string }> {
    // Read-only existence + workspace lookup for a Docmost-native user the platform has no mapping for.
    const workspaceId = await this.workspaces.resolveUserWorkspaceId(dto.userId);
    return { userId: dto.userId, workspaceId };
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post('users/lookup')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.UsersResolve)
  async lookupUsers(@Body() dto: LookupUsersDto): Promise<{ items: ShadowUserLookup[] }> {
    // #486: read-only, never provisions — one entry per requested id, in order; `userId` null when there is no
    // shadow user. The platform uses it to reach a page grant whose holder it has no cached mapping for.
    return { items: await this.service.lookupShadowUserIds(dto.externalIds) };
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post('session')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SessionMint)
  async mintSession(
    @Body() dto: MintSessionDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    // #713: the step-up freshness is validated BEFORE anything is minted, so a 400 leaves no session behind.
    const freshness = mintFreshness(dto.authTime, dto.freshUntil);
    const authToken = await this.service.mintSession(dto.externalId, dto.clientIp, freshness);
    // Mirror AuthController.setAuthCookie so the caller can relay the Set-Cookie to the browser exactly as it
    // did for native login: over https `__Host-authToken` + Secure + host-only + Path=/ (#310), scoped to
    // the workspace's configured session lifetime. No legacy-cookie eviction here — the mint response is also
    // consumed east-west by the relay, and an extra deletion Set-Cookie would pollute its reconstructed jar.
    setDocmostAuthCookie(res, authToken, this.environmentService);
    return { ok: true };
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post('session/revoke')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SessionRevoke)
  async revokeSession(
    @Body() dto: SessionExternalIdDto,
  ): Promise<{
    userId: string | null;
    deactivated: boolean;
    sessionsRevoked: number;
  }> {
    // #455: deactivate the shadow user (deactivatedAt + revoke live user_sessions) so the disabled
    // identity's `/api/*` is cut on the next request, no NEW collab connection can authenticate, and re-mint
    // is refused. The resolved fork `userId` is returned so the caller can force-close ALREADY-OPEN collab
    // sockets via `POST /api/collab/force-disconnect-user` (that endpoint lives in the ESM-isolated
    // CollabDisconnectModule — the collab/lib0 graph must NOT enter this module's jest-loadable import
    // chain). `userId` is null for a never-provisioned identity (a benign no-op).
    return this.service.deactivateShadowUser(dto.externalId);
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post('session/revoke-others')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SessionRevokeOthers)
  async revokeOtherSessions(@Body() dto: RevokeOtherSessionsDto): Promise<RevokeOtherSessionsResult> {
    // wiki-v2 #818: sign the identity out of every wiki session except the one `keepToken` proves (passkey
    // removal). Never deactivates. The fork verifies the token itself; anything it cannot verify keeps nothing.
    // The caller then force-closes the user's open sockets via `POST /api/collab/force-disconnect-user`; the
    // kept session's tabs reconnect, the others are refused at connect.
    return this.revokeOthers.revokeOtherSessions(dto.externalId, dto.keepToken);
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post('session/restore')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SessionRestore)
  async restoreSession(
    @Body() dto: SessionExternalIdDto,
  ): Promise<{ reactivated: boolean }> {
    // #455: clear `deactivatedAt` on re-enable so the identity can sign in + edit again (the mint path
    // would otherwise refuse a still-deactivated shadow user forever).
    const result = await this.service.reactivateShadowUser(dto.externalId);
    return { reactivated: result.reactivated };
  }
}
