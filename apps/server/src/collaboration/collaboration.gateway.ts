import { Hocuspocus } from '@hocuspocus/server';
import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { AuthenticationExtension } from './extensions/authentication.extension';
import { PersistenceExtension } from './extensions/persistence.extension';
import { Injectable } from '@nestjs/common';
import { EnvironmentService } from '../integrations/environment/environment.service';
import {
  createRetryStrategy,
  parseRedisUrl,
  RedisConfig,
} from '../common/helpers';
import { LoggerExtension } from './extensions/logger.extension';
import {
  RedisSyncExtension,
  SerializedHTTPRequest,
} from './extensions/redis-sync';
import { WsSocketWrapper } from './extensions/redis-sync/ws-socket-wrapper';
import RedisClient from 'ioredis';
import { pack, unpack } from 'msgpackr';
import { nanoid } from 'nanoid';
import * as os from 'node:os';
import { CollabWsAdapter } from './adapter/collab-ws.adapter';
import {
  CollaborationHandler,
  CollabEventHandlers,
} from './collaboration.handler';
// CCC seam (UPSTREAM_MODIFICATIONS.md #3f): the account-disable force-disconnect predicate lives in authz/
// (importless, so it is unit-testable outside the lib0 ESM graph); this method is a thin delegate.
import { disconnectUserConnections } from '../authz/collab/disconnect-user-connections';

@Injectable()
export class CollaborationGateway {
  private readonly hocuspocus: Hocuspocus;
  private redisConfig: RedisConfig;
  // @ts-ignore
  private readonly redisSync: RedisSyncExtension<CollabEventHandlers> | null =
    null;
  private readonly withRedis: boolean;

  constructor(
    private authenticationExtension: AuthenticationExtension,
    private persistenceExtension: PersistenceExtension,
    private loggerExtension: LoggerExtension,
    private environmentService: EnvironmentService,
    private collabEventsService: CollaborationHandler,
  ) {
    this.redisConfig = parseRedisUrl(this.environmentService.getRedisUrl());
    this.withRedis = !this.environmentService.isCollabDisableRedis();

    this.hocuspocus = new Hocuspocus({
      debounce: 10000,
      maxDebounce: 45000,
      // #345: MUST stay true. On the last client disconnect, Hocuspocus only runs a pending debounced store
      // immediately when this is true (`executeNow` in its onClose); with `false` it does neither flush nor
      // unload and waits out the 10s/45s timer, so a restart in that window (rolling deploy / scale-in /
      // crash) loses the person's unsaved edits. `true` also drains graceful shutdown correctly
      // (closeConnections → onClose → executeNow → store → unload). Unload still only fires AFTER the store
      // completes (Hocuspocus `shouldUnloadDocument` gates on pending/executing/saveMutex), so the settle's
      // "not resident ⇒ row authoritative" invariant holds, and RedisSync releases the doc lock on unload as
      // designed. See UPSTREAM_MODIFICATIONS.md. (Upstream default is true; Docmost had set it to false.)
      unloadImmediately: true,
      extensions: [
        this.authenticationExtension,
        this.persistenceExtension,
        this.loggerExtension,
      ],
    });

    if (this.withRedis) {
      // @ts-ignore
      this.redisSync = new RedisSyncExtension({
        redis: new RedisClient({
          host: this.redisConfig.host,
          port: this.redisConfig.port,
          password: this.redisConfig.password,
          db: this.redisConfig.db,
          family: this.redisConfig.family,
          tls: this.redisConfig.tls, // #267: TLS for a rediss:// URL (undefined otherwise)
          retryStrategy: createRetryStrategy(),
        }),
        serverId: `collab-${os?.hostname()}-${nanoid(10)}`,
        prefix: 'collab',
        pack,
        unpack,
        // @ts-ignore
        customEvents: this.collabEventsService.getHandlers(this.hocuspocus),
      });
      this.hocuspocus.configuration.extensions.push(this.redisSync);
      // @ts-ignore
      this.redisSync.onConfigure({ instance: this.hocuspocus });
    }
  }

  private serializeRequest(request: IncomingMessage): SerializedHTTPRequest {
    return {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: {
        'sec-websocket-key': request.headers['sec-websocket-key'] ?? '',
        'sec-websocket-protocol':
          request.headers['sec-websocket-protocol'] ?? '',
      },
      socket: { remoteAddress: request.socket?.remoteAddress ?? '' },
    };
  }

  handleConnection(client: WebSocket, request: IncomingMessage): any {
    if (this.redisSync) {
      const serializedHTTPRequest = this.serializeRequest(request);
      const socketId = serializedHTTPRequest.headers['sec-websocket-key'];

      // Create wrapper socket that only receives events via emit()
      // This prevents double-handling since Hocuspocus won't listen to raw WebSocket events
      const wrappedSocket = new WsSocketWrapper(client);

      // Route through RedisSync extension (this calls handleConnection internally)
      this.redisSync.onSocketOpen(wrappedSocket as any, serializedHTTPRequest);

      // Forward raw WebSocket messages to the extension
      client.on('message', (data: ArrayBuffer) => {
        this.redisSync!.onSocketMessage(
          wrappedSocket as any,
          serializedHTTPRequest,
          data,
        );
      });

      // Forward close events
      client.on('close', (code: number, reason: Buffer) => {
        this.redisSync!.onSocketClose(socketId, code, reason.buffer as ArrayBuffer);
      });

      // Forward pong events for keepalive
      client.on('pong', (data: Buffer) => {
        wrappedSocket.emit('pong', data);
      });
    } else {
      // Fallback to direct Hocuspocus connection
      this.hocuspocus.handleConnection(client, request);
    }
  }

  getConnectionCount() {
    return this.hocuspocus.getConnectionsCount();
  }

  getDocumentCount() {
    return this.hocuspocus.getDocumentsCount();
  }

  handleYjsEvent<TName extends keyof CollabEventHandlers>(
    eventName: TName,
    documentName: string,
    payload: Parameters<CollabEventHandlers[TName]>[1],
  ) {
    // Custom collaboration events are registered ONLY on the RedisSync extension, so with
    // COLLAB_DISABLE_REDIS (single-node standalone) `handleEvent` is unreachable and this returns
    // `undefined`. That is tolerable for best-effort events (forceDisconnect) and for the #282 seams,
    // whose callers already treat `undefined` as fail-closed (503). It is NOT tolerable for
    // `updatePageContent`: `PageService.update` ignores its (void) result, so a REST/`/v1` content write
    // would return a false 200 while persisting NOTHING (#344). Standalone interactive editing is
    // unaffected — live sockets use the direct Hocuspocus path, not this method — so fail the one write
    // we cannot perform, loudly, rather than remove a supported mode.
    if (!this.redisSync && eventName === 'updatePageContent') {
      throw new Error(
        "cannot route 'updatePageContent': RedisSync is disabled (COLLAB_DISABLE_REDIS); content writes require Redis.",
      );
    }
    return this.redisSync?.handleEvent(eventName, documentName, payload);
  }

  /**
   * CCC integration seam (UPSTREAM_MODIFICATIONS.md): force-disconnect a user's live sessions on a
   * page, routed to the doc-owning node via RedisSync. Thin pass-through — the caller (authz/) owns
   * the authorization decision (a PDP re-check) before invoking this.
   */
  forceDisconnectUserFromPage(pageId: string, userId: string) {
    return this.handleYjsEvent('forceDisconnect', `page.${pageId}`, { userId });
  }

  /**
   * CCC integration seam (UPSTREAM_MODIFICATIONS.md): force-disconnect a user's LIVE collab sockets across
   * EVERY document, for #455 account-disable. The per-page `forceDisconnectUserFromPage` above needs a
   * pageId and routes to one doc-owning node; account disable has no single page and must reach all of the
   * user's open editors at once.
   *
   * NODE-LOCAL by design: iterate THIS node's resident documents and close every connection whose
   * authenticated user matches. It does NOT route through RedisSync, so it works with
   * `COLLAB_DISABLE_REDIS` too, and — because the fork runs a SINGLE collab node (ECS `desired_count=1`,
   * the fork process hosts Hocuspocus in-process) — it closes ALL of the user's sockets. A multi-node
   * collab deployment would additionally need an all-nodes RedisSync broadcast (a documented follow-up);
   * that is out of scope while `desired_count=1`.
   *
   * Safe to run even for an already-active user (it just closes their live sockets), but the caller only
   * invokes it AFTER `deactivateShadowUser` has set `deactivatedAt`, so every reconnect then re-runs
   * `onAuthenticate` → `isUserDisabled` → rejected, and the socket cannot come back.
   *
   * The matching/closing loop is the CCC `disconnectUserConnections` helper (authz/), so the enforcement
   * predicate is unit-tested there without loading this file's lib0 ESM graph.
   */
  forceDisconnectUser(userId: string): void {
    disconnectUserConnections(this.hocuspocus.documents.values(), userId);
  }

  /**
   * CCC integration seam (UPSTREAM_MODIFICATIONS.md): settle a page's live collaborative document by
   * running its pending debounced store NOW, routed to the doc-owning node via RedisSync. Thin
   * pass-through — the handler carries no policy and the caller (authz/) owns the authorization.
   * Returns `undefined` when RedisSync is disabled (COLLAB_DISABLE_REDIS), which the caller treats as
   * "not flushed".
   */
  flushPageContent(
    pageId: string,
    payload?: Parameters<CollabEventHandlers['flushPageContent']>[1],
  ) {
    return this.handleYjsEvent('flushPageContent', `page.${pageId}`, payload);
  }

  /**
   * CCC integration seam (UPSTREAM_MODIFICATIONS.md): a compare-and-swap content write (#282) — apply the
   * content only if the live document still hashes to `expectedContentHash`. Thin pass-through; the handler
   * carries no policy and the caller (authz/) owns the authorization. Returns `undefined` when RedisSync is
   * disabled (COLLAB_DISABLE_REDIS), which the caller treats as "not applied".
   */
  conditionalUpdatePageContent(
    pageId: string,
    payload: Parameters<CollabEventHandlers['conditionalUpdatePageContent']>[1],
  ) {
    return this.handleYjsEvent(
      'conditionalUpdatePageContent',
      `page.${pageId}`,
      payload,
    );
  }

  openDirectConnection(documentName: string, context?: any) {
    return this.hocuspocus.openDirectConnection(documentName, context);
  }

  /*
   *Can be used before calling openDirectConnection directly
   */
  async lockDocument(documentName: string) {
    return this.redisSync.lockDocument(documentName);
  }

  /*
   *Releases a document lock and stops the interval that maintains it.
   */
  async releaseLock(documentName: string) {
    return this.redisSync.releaseLock(documentName);
  }

  async destroy(collabWsAdapter: CollabWsAdapter): Promise<void> {
    // eslint-disable-next-line no-async-promise-executor
    await new Promise(async (resolve) => {
      try {
        // Wait for all documents to unload
        this.hocuspocus.configuration.extensions.push({
          async afterUnloadDocument({ instance }) {
            if (instance.getDocumentsCount() === 0) resolve('');
          },
        });

        collabWsAdapter?.close();

        if (this.hocuspocus.getDocumentsCount() === 0) resolve('');
        this.hocuspocus.closeConnections();
      } catch (error) {
        console.error(error);
      }
    });

    await this.hocuspocus.hooks('onDestroy', { instance: this.hocuspocus });
  }
}
