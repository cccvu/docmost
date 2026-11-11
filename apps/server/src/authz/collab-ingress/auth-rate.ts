/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * A per-user rate on collab authentication, charged right after the collab JWT verifies and before any user, session,
 * page or PDP read (authentication.extension.ts, seam #213).
 *
 * Hocuspocus 4.7.1 lets a socket whose Auth was refused send Auth again without limit, and every attempt re-runs
 * `onAuthenticate` (several DB reads and a PDP check). Sockets are cheap too: a refused editor that reconnects in a
 * loop pays the same cost on every new socket. So the bucket is per user id (the JWT `sub`), across sockets: burst
 * COLLAB_AUTH_BURST, refill COLLAB_AUTH_REFILL_PER_SECOND. One Map per process (the instance `CollabSocketBounds`
 * owns); a bucket that has refilled to full carries no state, so a sweep (at most once a minute) drops those.
 *
 * An empty bucket is refused with COLLAB_AUTH_RATE_REASON (auth-refusal.ts: no `message`, so Hocuspocus logs
 * nothing), logged once, rate-limited, as `COLLAB_SOCKET_LIMIT {"limit":"auth_rate"}`.
 */
import { COLLAB_AUTH_RATE_REASON, collabAuthRefusal } from './auth-refusal';
import { COLLAB_AUTH_BURST, COLLAB_AUTH_REFILL_PER_SECOND } from './limits';
import { collabSocketLimitLog, type SocketLimitLog } from './socket-limit-log';

interface Bucket {
  tokens: number;
  at: number;
}

export interface CollabAuthRateOptions {
  limitLog?: SocketLimitLog;
}

export class CollabAuthRate {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;
  private readonly limitLog: SocketLimitLog;

  constructor({ limitLog = collabSocketLimitLog }: CollabAuthRateOptions = {}) {
    this.limitLog = limitLog;
  }

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

/**
 * Charge one collab authentication to `userId` in `rate` (through `CollabSocketBounds.chargeAuth`); throws `{ reason }`
 * (no `message`) when the user is over the rate.
 */
export function chargeCollabAuth(userId: string, rate: CollabAuthRate): void {
  if (!rate.charge(String(userId))) throw collabAuthRefusal(COLLAB_AUTH_RATE_REASON);
}
