import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TokenService } from '../core/auth/services/token.service';
import { JwtPayload, JwtType } from '../core/auth/dto/jwt-payload';
import { OnModuleDestroy } from '@nestjs/common';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { WsService } from './ws.service';
import { getSpaceRoomName, getUserRoomName } from './ws.utils';
import { BaseRealtimeBridge } from './base-realtime.bridge';
import * as cookie from 'cookie';
import { EnvironmentService } from '../integrations/environment/environment.service';
// CCC seam (UPSTREAM_MODIFICATIONS.md #310): the socket.io handshake authenticates with the session cookie,
// so it must read the resolved name (`__Host-authToken` over https), never the shadowable un-prefixed one.
import { readDocmostAuthCookie } from '../authz/session-cookie/docmost-auth-cookie';
// CCC seam (UPSTREAM_MODIFICATIONS.md, #455): re-check user-disabled + session liveness at connect, so a
// revoked/disabled identity cannot keep opening notifications sockets on the lingering authToken cookie.
import { isWsConnectionLive } from '../authz/ws-connection/ws-connection-live';

@WebSocketGateway({
  cors: { origin: '*' },
  transports: ['websocket'],
})
export class WsGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  constructor(
    private tokenService: TokenService,
    private spaceMemberRepo: SpaceMemberRepo,
    private wsService: WsService,
    private baseRealtime: BaseRealtimeBridge,
    private environmentService: EnvironmentService,
    // #455: @Global DatabaseModule repos, used only by the CCC liveness seam below (policy in authz/).
    private userRepo: UserRepo,
    private userSessionRepo: UserSessionRepo,
  ) {}

  afterInit(server: Server): void {
    this.wsService.setServer(server);
    this.baseRealtime.setServer(server);
  }

  async handleConnection(client: Socket, ...args: any[]): Promise<void> {
    try {
      const cookies = cookie.parse(client.handshake.headers.cookie);
      const token: JwtPayload = await this.tokenService.verifyJwt(
        readDocmostAuthCookie(cookies, this.environmentService),
        JwtType.ACCESS,
      );

      // CCC seam (#455): the JWT is only signature-valid — re-check the identity is still live (not
      // disabled, session not revoked) exactly as jwt.strategy does for `/api/*`, so account disable /
      // session revocation cuts the notifications plane too. Throws → the catch below `disconnect()`s.
      if (
        !(await isWsConnectionLive(this.userRepo, this.userSessionRepo, token))
      ) {
        throw new Error('connection not live');
      }

      const userId = token.sub;
      const workspaceId = token.workspaceId;

      client.data.userId = userId;
      client.data.workspaceId = workspaceId;

      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);

      const userRoom = getUserRoomName(userId);
      const workspaceRoom = `workspace-${workspaceId}`;
      const spaceRooms = userSpaceIds.map((id) => getSpaceRoomName(id));

      client.join([userRoom, workspaceRoom, ...spaceRooms]);
    } catch (err) {
      client.emit('Unauthorized');
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    await this.baseRealtime.handleDisconnect(client);
  }

  @SubscribeMessage('message')
  async handleMessage(client: Socket, data: any): Promise<void> {
    if (this.wsService.isTreeEvent(data)) {
      await this.wsService.handleTreeEvent(client, data);
      return;
    }
    if (this.baseRealtime.isBaseEvent(data)) {
      await this.baseRealtime.handleInbound(client, data);
      return;
    }
  }

  /*
  @SubscribeMessage('join-room')
  handleJoinRoom(client: Socket, @MessageBody() roomName: string): void {
    // if room is a space, check if user has permissions
    //client.join(roomName);
  }

  @SubscribeMessage('leave-room')
  handleLeaveRoom(client: Socket, @MessageBody() roomName: string): void {
    client.leave(roomName);
  }
 */

  onModuleDestroy() {
    if (this.server) {
      this.server.close();
    }
  }
}
