/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * A per-user rate on collab authentication, charged right after the collab JWT verifies and before any user, session,
 * page or PDP read (authentication.extension.ts, seam #213).
 *
 * Hocuspocus 4.7.1 lets a socket whose Auth was refused send Auth again without limit, and every attempt re-runs
 * `onAuthenticate` (several DB reads and a PDP check). Sockets are cheap too: a refused editor that reconnects in a
 * loop pays the same cost on every new socket. So the bucket is per user id (the JWT `sub`), across sockets: burst
 * COLLAB_AUTH_BURST, refill COLLAB_AUTH_REFILL_PER_SECOND. One process-wide Map; a bucket that has refilled to full
 * carries no state, so a sweep (at most once a minute) drops those.
 *
 * An empty bucket throws `{ reason }` with no `message`: Hocuspocus logs `error.message` of a failed hook (4.7.1
 * `Hocuspocus.hooks`), and this is logged once, rate-limited, as `COLLAB_SOCKET_LIMIT` instead. Hocuspocus answers
 * the client with permission-denied carrying the reason, which the editor treats as any other refusal (collab-access.ts:
 * refetch the token once, then the connection-lost state).
 */
import { COLLAB_AUTH_BURST, COLLAB_AUTH_REFILL_PER_SECOND } from './limits';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

export const COLLAB_AUTH_RATE_REASON = 'ccc:collab-auth-rate-limited';

interface Bucket {
  tokens: number;
  at: number;
}

export class CollabAuthRate {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly limitLog: SocketLimitLog = collabSocketLimitLog) {}

  /** Take one authentication for `userId`; false when its bucket is empty. */
  charge(userId: string, now: number = Date.now()): boolean {
    if (now - this.lastSweep >= 60_000) this.sweep(now);
    const bucket = this.buckets.get(userId);
    const tokens = bucket ? refill(bucket, now) : COLLAB_AUTH_BURST;
    if (tokens < 1) {
      this.limitLog.log('auth_rate', { userId });
      return false;
    }
    this.buckets.set(userId, { tokens: tokens - 1, at: now });
    return true;
  }

  /** Buckets currently held (for the specs). */
  get size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [userId, bucket] of this.buckets) {
      if (refill(bucket, now) >= COLLAB_AUTH_BURST) this.buckets.delete(userId);
    }
  }
}

function refill(bucket: Bucket, now: number): number {
  return Math.min(COLLAB_AUTH_BURST, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * COLLAB_AUTH_REFILL_PER_SECOND);
}

const processRate = new CollabAuthRate();

/** Charge one collab authentication to `userId`; throws `{ reason }` (no `message`) when the user is over the rate. */
export function chargeCollabAuth(userId: string): void {
  if (!processRate.charge(String(userId))) throw { reason: COLLAB_AUTH_RATE_REASON };
}

/**
 * The refusal for a collab token that does not verify (authentication.extension.ts, seam #213): `{ reason }` with no
 * `message`, so Hocuspocus logs nothing (it logs `error.message` of a failed hook, once per attempt, and a token that
 * does not verify never reaches the per-user rate). The reason is the one Hocuspocus sends for a refusal that names
 * none (4.7.1 `ClientConnection`: `error.reason ?? "permission-denied"`), so the client sees what it saw before; the
 * editor decides "expired?" from the token it sent, never from the reason (page-editor.tsx, collab-access.ts). How
 * many times one socket may try is bounded by its Auth frames (frame-address.ts).
 */
export const COLLAB_INVALID_TOKEN_REASON = 'permission-denied';
export function invalidCollabTokenRefusal(): { reason: string } {
  return { reason: COLLAB_INVALID_TOKEN_REASON };
}
