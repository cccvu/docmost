import { Controller, Get, UseGuards } from '@nestjs/common';
import { CollaborationGateway } from '../collaboration.gateway';
import { CollabServiceSecretGuard } from '../../authz/collab/service-secret.guard';

/**
 * CCC integration seam (issue #80). GET /collab/stats runs ONLY in the separate CollabAppModule process
 * (collab-main.ts), which the main app's fail-closed PlatformAuthorizationGuard cannot reach. Guard it with
 * the service-secret primitive — parity with authz/collab/collab-disconnect — so the aggregate
 * connection/document counts require the platform's `x-authz-service-secret`. Fails CLOSED: 503 when the
 * secret is unconfigured, 401 on a missing/invalid secret. The guard is env-agnostic and dependency-free,
 * so a class-level @UseGuards is sufficient in the collab process (Nest instantiates it without a provider).
 */
@UseGuards(CollabServiceSecretGuard)
@Controller('collab')
export class CollaborationController {
  constructor(private readonly collaborationGateway: CollaborationGateway) {}

  @Get('stats')
  async getStats() {
    return {
      connections: this.collaborationGateway.getConnectionCount(),
      documents: this.collaborationGateway.getDocumentCount(),
    };
  }
}
