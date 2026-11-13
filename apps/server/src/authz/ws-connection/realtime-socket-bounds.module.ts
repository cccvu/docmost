import { Injectable, Module, OnModuleInit, Optional } from '@nestjs/common';
import { TokenModule } from '../../core/auth/token.module';
import { TokenService } from '../../core/auth/services/token.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { WsGateway } from '../../ws/ws.gateway';
import { hardenRealtimeServer, realtimeAccessVerifier } from './realtime-socket-bounds';

/**
 * CCC realtime integration — NOT upstream Docmost code (wiki-v2 #830, ADR 0036).
 *
 * Installs the /socket.io upgrade gate and namespace bounds (realtime-socket-bounds.ts) on the gateway's server. Nest
 * assigns the gateway's `@WebSocketServer()` field while it registers the WebSocket modules, which runs before the
 * `onModuleInit` hooks (and before `listen`), so the server exists here. The gateway is optional: `collab-main` has no
 * WsModule (AuthzModule reaches it through DatabaseModule) and test harnesses may have none, and then this does nothing.
 */
@Injectable()
export class RealtimeSocketBoundsInstaller implements OnModuleInit {
  constructor(
    @Optional() private readonly gateway: WsGateway | undefined,
    private readonly tokenService: TokenService,
    private readonly environmentService: EnvironmentService,
  ) {}

  onModuleInit(): void {
    const io = this.gateway?.server;
    if (!io) return;
    hardenRealtimeServer(io, {
      verifyAccessToken: realtimeAccessVerifier(this.tokenService, this.environmentService),
    });
  }
}

@Module({
  imports: [TokenModule],
  providers: [RealtimeSocketBoundsInstaller],
})
export class RealtimeSocketBoundsModule {}
