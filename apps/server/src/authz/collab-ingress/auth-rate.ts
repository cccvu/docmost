/**
 * CCC collab integration — NOT upstream Docmost code (#790, #810, ADR 0036).
 *
 * The rates on collab authentication (authentication.extension.ts, seam #213), two token buckets of the same shape
 * (burst COLLAB_AUTH_BURST, refill COLLAB_AUTH_REFILL_PER_SECOND), charged at two points of the connect:
 * - **per session** (`chargeCollabSessionAuth`, keyed by the JWT's `sub` and `sessionId`), right after the collab JWT
 *   verifies and before any user, session, page or PDP read. A token naming no session is refused before it, as an
 *   invalid token (#537 never mints one);
 * - **per user** (`chargeCollabAuth`, keyed by `sub`), only once the token's session is known to be live (after
 *   `isWsConnectionLive`), before the page and PDP reads.
 *
 * Hocuspocus 4.7.1 lets a socket whose Auth was refused send Auth again (bounded per socket by frame-admission.ts), and
 * sockets are cheap: a refused editor that reconnects in a loop pays the same cost on every new socket. So the buckets
 * are per session and per user, across sockets. Keying the pre-read bucket by session (#810 S3) means a validly signed
 * token whose session was revoked or signed out (a leaked one, kept 24 h) drains only its own bucket, never the user's,
 * so it cannot keep the user's live sessions refused; the user's bucket still bounds what all their live sessions
 * together can make the server read (one a second after the burst), which ADR 0036's per-account bounds rely on.
 *
 * One Map per bucket kind per process (the instances `CollabSocketBounds` owns); a bucket that has refilled to full
 * carries no state, so a sweep (at most once a minute) drops those.
 *
 * An empty bucket is refused with COLLAB_AUTH_RATE_REASON (auth-refusal.ts: no `message`, so Hocuspocus logs nothing;
 * the editor waits it out with its try-later backoff), logged once, rate-limited, as
 * `COLLAB_SOCKET_LIMIT {"limit":"auth_session_rate"}` or `{"limit":"auth_rate"}`, with the user id (never a session id).
 */
import { COLLAB_AUTH_RATE_REASON, collabAuthRefusal } from './auth-refusal';
import { COLLAB_AUTH_BURST, COLLAB_AUTH_REFILL_PER_SECOND } from './limits';
import { collabSocketLimitLog, type SocketLimit, type SocketLimitLog } from './socket-limit-log';

interface Bucket {
  tokens: number;
  at: number;
}

export interface CollabAuthRateOptions {
  limitLog?: SocketLimitLog;
  /** The `COLLAB_SOCKET_LIMIT` limit an empty bucket is logged as: `auth_rate` (per user) or `auth_session_rate`. */
  limit?: Extract<SocketLimit, 'auth_rate' | 'auth_session_rate'>;
}

export class CollabAuthRate {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;
  private readonly limitLog: SocketLimitLog;
  private readonly limit: SocketLimit;

  constructor({ limitLog = collabSocketLimitLog, limit = 'auth_rate' }: CollabAuthRateOptions = {}) {
    this.limitLog = limitLog;
    this.limit = limit;
  }

  /**
   * Take one authentication from `key`'s bucket; false (logged with `userId`) when it is empty. `userId` defaults to the
   * key, which is the user id for the per-user bucket.
   */
  charge(key: string, now: number = Date.now(), userId: string = key): boolean {
    if (now - this.lastSweep >= 60_000) this.sweep(now);
    const bucket = this.buckets.get(key);
    const tokens = bucket ? refill(bucket, now) : COLLAB_AUTH_BURST;
    if (tokens < 1) {
      this.limitLog.log(this.limit, { userId });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
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
 * Charge one collab authentication to `userId` in the per-user `rate` (through `CollabSocketBounds.chargeUser`, once the
 * session is live); throws `{ reason }` (no `message`) when the user is over the rate.
 */
export function chargeCollabAuth(userId: string, rate: CollabAuthRate): void {
  if (!rate.charge(String(userId))) throw collabAuthRefusal(COLLAB_AUTH_RATE_REASON);
}

/**
 * Charge one collab authentication to the session `sessionId` of `userId` in the per-session `rate` (through
 * `CollabSocketBounds.chargeSession`, before any read); throws `{ reason }` (no `message`) when that session is over the
 * rate. The caller refuses a token without a session first.
 */
export function chargeCollabSessionAuth(userId: string, sessionId: string, rate: CollabAuthRate): void {
  const user = String(userId);
  if (!rate.charge(`${user}\u0000${String(sessionId)}`, Date.now(), user)) throw collabAuthRefusal(COLLAB_AUTH_RATE_REASON);
}
