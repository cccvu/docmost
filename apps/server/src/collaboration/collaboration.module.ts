import { Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuthenticationExtension } from './extensions/authentication.extension';
import { PersistenceExtension } from './extensions/persistence.extension';
import { CollaborationGateway } from './collaboration.gateway';
import { HttpAdapterHost } from '@nestjs/core';
import { CollabWsAdapter } from './adapter/collab-ws.adapter';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { TokenModule } from '../core/auth/token.module';
import { HistoryProcessor } from './processors/history.processor';
import { LoggerExtension } from './extensions/logger.extension';
import { CollaborationHandler } from './collaboration.handler';
import { CollabHistoryService } from './services/collab-history.service';
import { WatcherModule } from '../core/watcher/watcher.module';
import { TransclusionService } from '../core/page/transclusion/transclusion.service';
import { TransclusionModule } from '../core/page/transclusion/transclusion.module';
import { StorageModule } from '../integrations/storage/storage.module';
import { EnvironmentModule } from '../integrations/environment/environment.module';
import { logCollabSocketError } from '../authz/collab-ingress/socket-limit-log'; // CCC seam #227 (wiki-v2 #790)
import { CollabSocketBounds, collabClientTrustProvider, collabSocketBoundsProvider } from '../authz/collab-ingress/socket-bounds'; // CCC seam #227 (wiki-v2 #810)

@Module({
  providers: [
    CollaborationGateway,
    AuthenticationExtension,
    PersistenceExtension,
    LoggerExtension,
    HistoryProcessor,
    CollabHistoryService,
    CollaborationHandler,
    TransclusionService,
    collabSocketBoundsProvider, // CCC (wiki-v2 #810): one CollabSocketBounds per process, injected below and into §3/§213
    collabClientTrustProvider, // CCC (wiki-v2 #810): its client trust, for the public-surface throttler (APP_GUARD)
  ],
  exports: [CollaborationGateway, collabClientTrustProvider], // CCC (wiki-v2 #810): + the bounds' client trust
  imports: [
    TokenModule,
    WatcherModule,
    StorageModule.forRootAsync({
      imports: [EnvironmentModule],
    }),
    TransclusionModule,
  ],
})
export class CollaborationModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CollaborationModule.name);
  private collabWsAdapter: CollabWsAdapter;
  private path = '/collab';

  constructor(
    private readonly collaborationGateway: CollaborationGateway,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly collabSocketBounds: CollabSocketBounds, // CCC (wiki-v2 #810)
  ) {}

  onModuleInit() {
    this.collabWsAdapter = new CollabWsAdapter(this.collabSocketBounds);
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();

    const wss = this.collabWsAdapter.handleUpgrade(this.path, httpServer);

    wss.on('connection', (client: WebSocket, request: IncomingMessage) => {
      this.collaborationGateway.handleConnection(client, request);

      // CCC (wiki-v2 #790, UPSTREAM_MODIFICATIONS #227): a client's ws errors are its own frames past the bounds;
      // logged rate-limited as COLLAB_SOCKET_LIMIT (authz/collab-ingress/socket-limit-log).
      client.on('error', (error) => logCollabSocketError(error));
    });

    wss.on('error', (error) =>
      this.logger.error('WebSocket server error:', error),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.collaborationGateway?.destroy(this.collabWsAdapter);
    this.collabWsAdapter?.destroy();
  }
}
