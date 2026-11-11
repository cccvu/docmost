/**
 * CCC collab integration — NOT upstream Docmost code (#790, #810, ADR 0036).
 *
 * The process's collab socket bounds, as ONE object. Its parts share state across seams that never call each other:
 * - the pre-auth slots (preauth-slots.ts): taken by the ws adapter at the upgrade (seam §226), released by the
 *   `BoundedCollabSocket` the gateway hands Hocuspocus (seam §3);
 * - the per-user connections (user-connections.ts): checked in `onAuthenticate` (seam §213), held and released by the
 *   gateway's `connected` / `onDisconnect` extension (seam §3);
 * - the socket documents (socket-documents.ts): written by that same extension, read by the keepalive's empty-socket
 *   reaper (socket-keepalive.ts) the gateway starts for every socket;
 * - the per-user auth rate (auth-rate.ts), charged in `onAuthenticate`.
 * A part split across two instances fails silently (a slot never released, ending in 503s; a cap the early check never
 * sees; a reaper reading an empty registry), so the parts live only here and nothing else builds one
 * (socket-bounds.fitness.spec.ts).
 *
 * Nest builds it once, from `collabSocketBoundsProvider`, registered in CollaborationModule (seam §227), and injects
 * that one instance into the module (which hands it to the ws adapter, §226), the gateway (§3) and the authentication
 * extension (§213). CollaborationModule is a static module, so this is exactly as process-wide as the module-level
 * singletons it replaced, and a spec builds its own. The class is undecorated, so Nest never resolves its options.
 *
 * Only the rate-limited log sink stays module-level (socket-limit-log.ts): sharing it is its purpose (one budget of
 * lines a minute for every bound, the module's ws_error line and the update guard).
 */
import type { IncomingMessage } from 'http';
import type { FactoryProvider } from '@nestjs/common';
import type { WebSocketLike } from '@hocuspocus/server';
import { chargeCollabAuth, CollabAuthRate } from './auth-rate';
import { BoundedCollabSocket, type RawCollabSocket } from './bounded-socket';
import { admitCollabFrame, type AddressedSocket } from './frame-admission';
import { answerCollabUpgrade, CollabPreAuthSlots, type PreAuthSocket, type PreAuthTransport, type VerifyCallback } from './preauth-slots';
import { CollabSocketDocuments } from './socket-documents';
import { COLLAB_PING_INTERVAL_MS, keepCollabSocketAlive, type PingableSocket } from './socket-keepalive';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';
import { admitCollabUserConnection, CollabUserConnections, CollabUserConnectionsExtension } from './user-connections';

/** The ws client socket `open` wires: what the bounded socket, the frame check and the keepalive read. */
export type CollabClientSocket = RawCollabSocket &
  PingableSocket &
  AddressedSocket & {
    on(event: 'message', listener: (data: Buffer) => void): unknown;
  };

/** What ws delivers for a message: a Buffer (upstream's RedisSync path types it as an ArrayBuffer). */
export type CollabFrameData = Buffer & ArrayBuffer;

/** Parts and timings a spec may override; production uses every default. */
export interface CollabSocketBoundsOptions {
  limitLog?: SocketLimitLog;
  preAuth?: CollabPreAuthSlots;
  connections?: CollabUserConnections;
  documents?: CollabSocketDocuments;
  authRate?: CollabAuthRate;
  pingIntervalMs?: number;
}

export class CollabSocketBounds {
  readonly limitLog: SocketLimitLog;
  readonly preAuth: CollabPreAuthSlots;
  readonly connections: CollabUserConnections;
  readonly documents: CollabSocketDocuments;
  readonly authRate: CollabAuthRate;
  /** The gateway's `connected` / `onDisconnect` extension (seam §3), on this object's connections and documents. */
  readonly userConnectionsExtension: CollabUserConnectionsExtension;
  private readonly pingIntervalMs: number;

  constructor(opts: CollabSocketBoundsOptions = {}) {
    this.limitLog = opts.limitLog ?? collabSocketLimitLog;
    this.preAuth = opts.preAuth ?? new CollabPreAuthSlots({ limitLog: this.limitLog });
    this.connections = opts.connections ?? new CollabUserConnections({ limitLog: this.limitLog });
    this.documents = opts.documents ?? new CollabSocketDocuments();
    this.authRate = opts.authRate ?? new CollabAuthRate({ limitLog: this.limitLog });
    this.pingIntervalMs = opts.pingIntervalMs ?? COLLAB_PING_INTERVAL_MS;
    this.userConnectionsExtension = new CollabUserConnectionsExtension(this.connections, this.documents);
  }

  /**
   * The collab ws server's `verifyClient` (seam §226). An arrow property with exactly two parameters: ws calls the
   * two-argument form with a callback (and answers 401 for the one-argument form), and this answers it synchronously,
   * so ws completes the upgrade and calls the adapter's callback (`holdUpgraded`) in the same call.
   */
  readonly verifyUpgrade = (_info: { req: IncomingMessage }, done: VerifyCallback): void => {
    answerCollabUpgrade(this.preAuth, done);
  };

  /** The ws adapter's upgrade callback (seam §226): the new ws socket takes its slot, counting the TCP socket's bytes. */
  holdUpgraded(ws: PreAuthSocket, transport: PreAuthTransport): void {
    this.preAuth.hold(ws, transport);
  }

  /** In `onAuthenticate` before any read (seam §213): the per-user auth rate; throws `{ reason }` when it is spent. */
  chargeAuth(userId: string): void {
    chargeCollabAuth(userId, this.authRate);
  }

  /** In `onAuthenticate` before any read (seam §213): throws `{ reason }` when the user already holds the cap. */
  admitUser(userId: string): void {
    admitCollabUserConnection(userId, this.connections);
  }

  /**
   * Open one collab ws socket on either gateway path (seam §3): `connect` gets the outbound-bounded socket (which ends
   * the pre-auth slot on the first Authenticated reply), every inbound frame passes the frame check before `forward`
   * sees it (its first Auth frame moves the slot's deadline: preauth-slots.ts), and the keepalive pings it, touches the connection on each pong and reaps it once it holds no document.
   * The 'message' listener is registered here, synchronously, inside ws's 'connection' emit, so no frame is missed.
   */
  open<C extends { touch(): void }>(
    client: CollabClientSocket,
    inner: WebSocketLike,
    connect: (socket: BoundedCollabSocket) => C,
    forward: (connection: C, data: CollabFrameData) => void,
  ): C {
    const connection = connect(new BoundedCollabSocket(client, inner, { preAuth: this.preAuth, limitLog: this.limitLog }));
    client.on('message', (data: Buffer) => {
      if (admitCollabFrame(client, data, this.limitLog, Date.now, this.preAuth)) forward(connection, data as CollabFrameData);
    });
    keepCollabSocketAlive(client, () => connection.touch(), {
      holdsNoDocument: (ws) => this.documents.holdsNoDocument(ws),
      intervalMs: this.pingIntervalMs,
      limitLog: this.limitLog,
    });
    return connection;
  }
}

/** The one instance per process (the `trashCleanupProvider` pattern): registered in CollaborationModule, seam §227. */
export const collabSocketBoundsProvider: FactoryProvider<CollabSocketBounds> = {
  provide: CollabSocketBounds,
  useFactory: (): CollabSocketBounds => new CollabSocketBounds(),
};
