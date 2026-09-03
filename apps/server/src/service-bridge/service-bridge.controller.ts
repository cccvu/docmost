import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { ServiceBridgeService } from './service-bridge.service';
import { RequireServiceScope, ServiceAuthGuard } from './service-auth.guard';
import { ServiceScope } from './service-scope';
import { MintSessionDto } from './dto/mint-session.dto';
import { ProvisionUserDto } from './dto/provision-user.dto';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * The east-west service API the platform (or any implementer of the documented contract) calls: shadow
 * user provisioning + session brokerage. Guarded by the scoped ServiceAuthGuard (least privilege,
 * fail-closed, constant-time, rate-limited). Not for browsers — service-to-service only.
 */
@Controller('service')
@UseGuards(ServiceAuthGuard)
export class ServiceBridgeController {
  constructor(
    private readonly service: ServiceBridgeService,
    private readonly environmentService: EnvironmentService,
  ) {}

  @Post('users')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.UsersProvision)
  async provisionUser(@Body() dto: ProvisionUserDto) {
    const userId = await this.service.provisionShadowUser(dto);
    return { userId, workspaceId: dto.workspaceId };
  }

  @Post('session')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.SessionMint)
  async mintSession(
    @Body() dto: MintSessionDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const authToken = await this.service.mintSession(dto.userId, dto.workspaceId);
    // Mirror AuthController.setAuthCookie so the caller can relay the Set-Cookie to the browser exactly
    // as it did for native login. httpOnly + Secure(in prod) + SameSite=lax; scoped to the workspace's
    // configured session lifetime.
    res.setCookie('authToken', authToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });
    return { ok: true };
  }
}
