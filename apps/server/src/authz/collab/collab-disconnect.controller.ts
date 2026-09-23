import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { IsUUID } from 'class-validator';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { WsGateway } from '../../ws/ws.gateway';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { CollabServiceSecretGuard } from './service-secret.guard';
import { LiveAccessRevalidator, LiveAccessSummary } from '../live-access/live-access.revalidator';

/** How long `POST /api/collab/revalidate` waits for its pass before answering `{pending:true}`. */
const REVALIDATE_WAIT_MS = 5000;

/** #455 — the whole-identity (all-pages) variant, for account disable. Only a userId: there is no page. */
export class ForceDisconnectUserDto {
  @IsUUID() userId!: string;
}

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The inbound realtime-revocation seams the platform calls. `RemoteOnlyGuard` 404s them unless
 * AUTHZ_MODE=remote (the surface is meaningless without the platform). All authorization lives in authz/;
 * the collab and ws gateways only expose their connections.
 *
 *   - `revalidate` (#501): after projecting a narrowing access change, the platform asks this node to
 *     re-check every live connection against the PDP (the revalidator narrows, never widens). It replaced the
 *     per-page `force-disconnect`, which covered only a user's page-grant removal and re-checked view only.
 *   - `force-disconnect-user` (#455): account disable — close every realtime socket of one user.
 */
@UseGuards(RemoteOnlyGuard, CollabServiceSecretGuard)
@Controller('collab')
export class CollabDisconnectController {
  constructor(
    private readonly gateway: CollaborationGateway,
    // #455: the WsGateway (@Global) is the notifications/tree socket.io server — closing its live sockets
    // for the disabled user is the second half of "cut EVERY realtime plane", alongside the collab kill.
    private readonly wsGateway: WsGateway,
    private readonly liveAccess: LiveAccessRevalidator,
  ) {}

  /**
   * #501 — re-check every live connection on this node now (plus a trailing pass 2 s later), after the
   * platform projected a narrowing change. The body is empty on purpose: the revalidator re-checks ALL live
   * connections, so a caller cannot aim it (and cannot widen anything — it only narrows). Waits up to 5 s for a
   * pass that started after the request, then answers `{pending:true}`; the periodic sweep still covers it.
   */
  @HttpCode(HttpStatus.OK)
  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)
  @Post('revalidate')
  async revalidate(): Promise<LiveAccessSummary | { pending: true }> {
    const pass = this.liveAccess.signal('signal');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ pending: true }>((resolve) => {
      timer = setTimeout(() => resolve({ pending: true }), REVALIDATE_WAIT_MS);
    });
    try {
      return await Promise.race([pass, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      pass.catch(() => undefined); // a failed pass is logged by the revalidator (LIVE_ACCESS_REVALIDATE_FAILED)
    }
  }

  /**
   * #455 — account-disable per-user disconnect: force-close EVERY live REALTIME socket for a user
   * (node-local), across BOTH planes — the collab editor sockets (Hocuspocus) AND the notifications/tree
   * socket.io sockets. Invoked by the platform ONLY after `/api/service/session/revoke` has set the shadow
   * user's `deactivatedAt` — a precise, whole-identity signal — so, UNLIKE `revalidate` above (which
   * re-checks each connection against the PDP), this closes the sockets unconditionally: the residual it targets is a continuously-open socket with no
   * per-message re-auth (a collab editor; a ping-kept-alive notifications feed of titles/renames/comments).
   * Service-secret gated; an erroneous call only forces a transient reconnect that an active user
   * re-authenticates fine. See collaboration.gateway.ts / ws.gateway.ts `forceDisconnectUser` for the
   * single-node (`desired_count=1`) scope.
   */
  @HttpCode(HttpStatus.OK)
  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)
  @Post('force-disconnect-user')
  async forceDisconnectUser(
    @Body() dto: ForceDisconnectUserDto,
  ): Promise<{ disconnected: boolean }> {
    this.gateway.forceDisconnectUser(dto.userId); // collab editor sockets (Hocuspocus)
    this.wsGateway.forceDisconnectUser(dto.userId); // notifications/tree sockets (socket.io)
    return { disconnected: true };
  }
}
