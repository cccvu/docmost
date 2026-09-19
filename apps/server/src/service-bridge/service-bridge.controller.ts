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
import { ServiceBridgeService } from './service-bridge.service';
import { RequireServiceScope, ServiceAuthGuard } from './service-auth.guard';
import { ServiceScope } from './service-scope';
import { MintSessionDto } from './dto/mint-session.dto';
import { ProvisionUserDto } from './dto/provision-user.dto';
import { ResolveUserDto } from './dto/resolve-user.dto';
import { WorkspaceResolver } from './workspace-resolver';
import { setDocmostAuthCookie } from '../authz/session-cookie/docmost-auth-cookie';

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

  @Post('session')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SessionMint)
  async mintSession(
    @Body() dto: MintSessionDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const authToken = await this.service.mintSession(dto.externalId);
    // Mirror AuthController.setAuthCookie so the caller can relay the Set-Cookie to the browser exactly as it
    // did for native login: in production `__Host-authToken` + Secure + host-only + Path=/ (#310), scoped to
    // the workspace's configured session lifetime. No legacy-cookie eviction here — the mint response is also
    // consumed east-west by the relay, and an extra deletion Set-Cookie would pollute its reconstructed jar.
    setDocmostAuthCookie(res, authToken, this.environmentService);
    return { ok: true };
  }
}
