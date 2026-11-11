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
 * - the per-session and per-user auth rates (auth-rate.ts), charged in `onAuthenticate`;
 * - the byte budget (socket-bytes.ts): tracked by the ws adapter at the upgrade (seam §226), charged by every
 *   `BoundedCollabSocket` send and its first Authenticated reply, re-sampled by the keepalive;
 * - the client trust (client-trust.ts): the platform's trusted-proxy list, which keys the pre-auth slots per client
 *   address at the upgrade (client-address.ts) and the public-surface throttler (seam #4's APP_GUARD). It starts
 *   fetching in `onModuleInit` (Nest calls it on this factory-built instance) and stops in `onModuleDestroy`.
 * A part split across two instances fails silently (a slot never released, ending in 503s; a cap the early check never
 * sees; a reaper reading an empty registry), so the parts live only here and nothing else builds one
 * (socket-bounds.fitness.spec.ts).
 *
 * Nest builds it once, from `collabSocketBoundsProvider`, registered in CollaborationModule (seam §227), and injects
 * that one instance into the module (which hands it to the ws adapter, §226), the gateway (§3) and the authentication
 * extension (§213). CollaborationModule is a static module, so this is exactly as process-wide as the module-level
 * singletons it replaced, and a spec builds its own. The class is undecorated, so Nest never resolves its options.
 *
 * Only the rate-limited log sink stays module-level (socket-limit-log.ts): sharing it is its purpose (one quota of lines
 * a minute per limit, for every bound, the module's ws_error line and the update guard). The connect's refusals that are not
 * bounds (an invalid token, a 4xx access refusal: auth-refusal.ts) log through this object's sink too.
 */
import type { IncomingMessage } from 'http';
import type { FactoryProvider, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { WebSocketLike } from '@hocuspocus/server';
import { chargeCollabAuth, chargeCollabSessionAuth, CollabAuthRate } from './auth-rate';
import {
  COLLAB_TOKEN_WITHOUT_SESSION,
  invalidCollabTokenRefusal,
  quietCollabAuthRefusals,
  type CollabAuthenticator,
  type CollabAuthRefusal,
} from './auth-refusal';
import { BoundedCollabSocket, type RawCollabSocket } from './bounded-socket';
import { CollabClientTrust, platformEdgeTrustFetch, type EdgeTrustFetch } from './client-trust';
import { admitCollabFrame, type AddressedSocket } from './frame-admission';
import { answerCollabUpgrade, CollabPreAuthSlots, type PreAuthSocket, type PreAuthTransport, type VerifyCallback } from './preauth-slots';
import { CollabSocketDocuments } from './socket-documents';
import { COLLAB_PING_INTERVAL_MS, keepCollabSocketAlive, type PingableSocket } from './socket-keepalive';
import { CollabSocketBytes, type BytesSocket } from './socket-bytes';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';
import { answerCollabPings, type PongSocket } from './socket-pong';
import { admitCollabUserConnection, CollabUserConnections, CollabUserConnectionsExtension } from './user-connections';
import { AUTHZ_MODE, type AuthzMode } from '../mode/authz-mode';

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
  sessionAuthRate?: CollabAuthRate;
  clientTrust?: CollabClientTrust;
  bytes?: CollabSocketBytes;
  /** The platform's edge-trust endpoint (client-trust.ts); absent or null: the trust stays unknown, the share off. */
  fetchEdgeTrust?: EdgeTrustFetch | null;
  pingIntervalMs?: number;
}

export class CollabSocketBounds implements OnModuleInit, OnModuleDestroy {
  readonly limitLog: SocketLimitLog;
  /** The platform's trusted-proxy list: keys the pre-auth slots per client address once it is known. */
  readonly clientTrust: CollabClientTrust;
  readonly preAuth: CollabPreAuthSlots;
  readonly connections: CollabUserConnections;
  readonly documents: CollabSocketDocuments;
  /** The process-wide byte budget across every collab socket's queued outbound and authenticated inbound. */
  readonly bytes: CollabSocketBytes;
  /** The per-user auth rate, charged once the session is live. */
  readonly authRate: CollabAuthRate;
  /** The per-session auth rate, charged before any read. */
  readonly sessionAuthRate: CollabAuthRate;
  /** The gateway's `connected` / `onDisconnect` extension (seam §3), on this object's connections and documents. */
  readonly userConnectionsExtension: CollabUserConnectionsExtension;
  private readonly pingIntervalMs: number;

  constructor(opts: CollabSocketBoundsOptions = {}) {
    this.limitLog = opts.limitLog ?? collabSocketLimitLog;
    this.clientTrust = opts.clientTrust ?? new CollabClientTrust({ fetchTrust: opts.fetchEdgeTrust ?? null, limitLog: this.limitLog });
    this.preAuth = opts.preAuth ?? new CollabPreAuthSlots({ limitLog: this.limitLog, clientKey: (req) => this.clientTrust.keyFor(req) });
    this.connections = opts.connections ?? new CollabUserConnections({ limitLog: this.limitLog });
    this.documents = opts.documents ?? new CollabSocketDocuments();
    this.bytes = opts.bytes ?? new CollabSocketBytes({ limitLog: this.limitLog });
    this.authRate = opts.authRate ?? new CollabAuthRate({ limitLog: this.limitLog });
    this.sessionAuthRate = opts.sessionAuthRate ?? new CollabAuthRate({ limitLog: this.limitLog, limit: 'auth_session_rate' });
    this.pingIntervalMs = opts.pingIntervalMs ?? COLLAB_PING_INTERVAL_MS;
    this.userConnectionsExtension = new CollabUserConnectionsExtension(this.connections, this.documents);
  }

  /**
   * The collab ws server's `verifyClient` (seam §226). An arrow property with exactly two parameters: ws calls the
   * two-argument form with a callback (and answers 401 for the one-argument form), and this answers it synchronously,
   * so ws completes the upgrade and calls the adapter's callback (`holdUpgraded`) in the same call.
   */
  readonly verifyUpgrade = (info: { req: IncomingMessage }, done: VerifyCallback): void => {
    answerCollabUpgrade(this.preAuth, info.req, done);
  };

  /**
   * The ws adapter's upgrade callback (seam §226): the new ws socket takes its slot, counting the TCP socket's bytes and
   * against the client address `verifyUpgrade` keyed `request` by; the byte budget tracks it from now on (#810); and its
   * pings get one pong in flight (#810, socket-pong.ts), before ws reads a frame from it.
   */
  holdUpgraded(ws: PreAuthSocket & BytesSocket & PongSocket, transport: PreAuthTransport, request: IncomingMessage): void {
    this.preAuth.hold(ws, transport, request);
    this.bytes.track(ws, transport);
    answerCollabPings(ws);
  }

  /** Nest, once the module is built: start fetching the platform's trust list (never blocks the boot). */
  onModuleInit(): void {
    this.clientTrust.start();
  }

  /** Nest, at shutdown: stop the trust fetch's timers. */
  onModuleDestroy(): void {
    this.clientTrust.stop();
  }

  /**
   * In `onAuthenticate` when the collab JWT does not verify (seam §213): the refusal to throw, logged `invalid_token` with
   * its kind only (auth-refusal.ts).
   */
  invalidToken(cause: unknown): CollabAuthRefusal {
    return invalidCollabTokenRefusal(cause, this.limitLog);
  }

  /**
   * In `onAuthenticate` right after the JWT verifies, before any read (seam §213): a token naming no session is refused as
   * an invalid token (`no_session`), then the session's auth rate is charged; throws `{ reason }` either way.
   */
  chargeSession(userId: string, sessionId: string | undefined): void {
    if (!sessionId) throw this.invalidToken(COLLAB_TOKEN_WITHOUT_SESSION);
    chargeCollabSessionAuth(userId, sessionId, this.sessionAuthRate);
  }

  /** In `onAuthenticate` once the session is live (seam §213): the per-user auth rate; throws `{ reason }` when spent. */
  chargeUser(userId: string): void {
    chargeCollabAuth(userId, this.authRate);
  }

  /** The authentication extension as the gateway registers it (seam §3): its 4xx refusals quiet (auth-refusal.ts). */
  quietAuthRefusals<P, R>(extension: CollabAuthenticator<P, R>): CollabAuthenticator<P, R> {
    return quietCollabAuthRefusals(extension, this.limitLog);
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
    const connection = connect(new BoundedCollabSocket(client, inner, { preAuth: this.preAuth, bytes: this.bytes, limitLog: this.limitLog }));
    client.on('message', (data: Buffer) => {
      if (admitCollabFrame(client, data, this.limitLog, Date.now, this.preAuth)) forward(connection, data as CollabFrameData);
    });
    keepCollabSocketAlive(client, () => connection.touch(), {
      holdsNoDocument: (ws) => this.documents.holdsNoDocument(ws),
      sample: (ws) => this.bytes.resample(ws),
      intervalMs: this.pingIntervalMs,
      limitLog: this.limitLog,
    });
    return connection;
  }
}

/**
 * The one instance per process (the `trashCleanupProvider` pattern): registered in CollaborationModule, seam §227. In
 * remote mode with PLATFORM_AUTHZ_URL set it fetches the platform's trust list; otherwise (native mode, the standalone
 * smokes) the trust stays unknown and the share off. AUTHZ_MODE is @Global (AuthzModeModule); optional only so a spec
 * can build the provider without it, which is native's answer.
 */
export const collabSocketBoundsProvider: FactoryProvider<CollabSocketBounds> = {
  provide: CollabSocketBounds,
  inject: [{ token: AUTHZ_MODE, optional: true }],
  useFactory: (mode?: AuthzMode): CollabSocketBounds => new CollabSocketBounds({ fetchEdgeTrust: platformEdgeTrustFetch(mode) }),
};

/**
 * The bounds' client trust for consumers outside the collab module (the public-surface throttler, seam #4's APP_GUARD):
 * the same instance, never a second fetch loop. Exported by CollaborationModule (seam §227).
 */
export const collabClientTrustProvider: FactoryProvider<CollabClientTrust> = {
  provide: CollabClientTrust,
  inject: [CollabSocketBounds],
  useFactory: (bounds: CollabSocketBounds): CollabClientTrust => bounds.clientTrust,
};
