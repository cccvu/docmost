/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * The `COLLAB_SOCKET_LIMIT` warn line for every collab socket bound (limits.ts), rate-limited per limit (#810): at most
 * COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE lines per limit in each fixed 60 s window, so junk on one limit (a stranger's
 * frame_address or preauth_sockets) never crowds out another limit's lines (auth_rate, user_sync_budget). One attacker
 * can still crowd out other users WITHIN a limit; the `log_suppressed` count keeps the size of it visible. Fields are the
 * limit, numbers, and a user or page id when known: never a document name a client sent, and never content.
 *
 * `RateLimitedWarn` is the generic window, shared with the update guard's own lines (update-guard.ts `log`, keyed by
 * token). A window that suppressed anything arms one unref'd timer for its end, which writes one summary line per key
 * that suppressed, so the last count of a burst is written even if nothing is logged after it. The timer never holds
 * the process open; the counts of a window still open at exit are lost (accepted: no shutdown hook).
 */
import { Logger } from '@nestjs/common';
import { COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE } from './limits';

export const COLLAB_SOCKET_LIMIT_TOKEN = 'COLLAB_SOCKET_LIMIT';

/**
 * Every `limit` a `COLLAB_SOCKET_LIMIT` line may carry, each a window of its own. A string-literal union, so the key set
 * is fixed at compile time and no client value can become a key. `log_suppressed` is the summary line, never a key.
 */
export const SOCKET_LIMITS = [
  'frame_address',
  'socket_documents',
  'socket_auth_frames',
  'outbound_buffer',
  'outbound_stalled',
  'socket_empty',
  'socket_total_bytes',
  'preauth_sockets',
  'preauth_bytes',
  'preauth_total_bytes',
  'preauth_first_auth',
  'preauth_deadline',
  'preauth_close_grace',
  'client_address',
  'client_address_refused',
  'client_address_trust',
  'user_sync_budget',
  'user_awareness_ids',
  'user_client_ids',
  'user_collab_cpu',
  'frame_deadline',
  'page_compacting',
  'load_debt',
  'order_divergence',
  'order_strikes',
  'user_connections',
  'auth_rate',
  'auth_session_rate',
  'invalid_token',
  'auth_refused',
  'ws_error',
] as const;
export type SocketLimit = (typeof SOCKET_LIMITS)[number];
const KNOWN_LIMITS: ReadonlySet<string> = new Set(SOCKET_LIMITS);
/** The one window a value outside SOCKET_LIMITS shares (only a cast can pass one), so the key set stays bounded. */
const UNLISTED = 'unlisted';

export interface SocketLimitLogger {
  warn(message: string): void;
}

const WINDOW_MS = 60_000;

export interface RateLimitedWarnOptions<K extends string> {
  logger: SocketLimitLogger;
  /** Lines per key per window; the rest are counted. */
  perKey: number;
  /** The summary line for `count` suppressed lines of `key`, written when the window ends. */
  summary: (key: K, count: number) => string;
  now?: () => number;
}

/** Fixed 60 s windows, one line quota per key. A line is built only when it is written. */
export class RateLimitedWarn<K extends string> {
  private readonly logger: SocketLimitLogger;
  private readonly perKey: number;
  private readonly summary: (key: K, count: number) => string;
  private readonly now: () => number;
  private windowStart = Number.NEGATIVE_INFINITY;
  private readonly counts = new Map<K, { lines: number; suppressed: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor({ logger, perKey, summary, now = () => Date.now() }: RateLimitedWarnOptions<K>) {
    this.logger = logger;
    this.perKey = perKey;
    this.summary = summary;
    this.now = now;
  }

  warn(key: K, line: () => string): void {
    const now = this.now();
    if (now - this.windowStart >= WINDOW_MS) {
      this.flush();
      this.windowStart = now;
    }
    let count = this.counts.get(key);
    if (!count) this.counts.set(key, (count = { lines: 0, suppressed: 0 }));
    if (count.lines < this.perKey) {
      count.lines++;
      this.logger.warn(line());
      return;
    }
    count.suppressed++;
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
        this.windowStart = Number.NEGATIVE_INFINITY; // the next line opens a fresh window
      }, Math.max(0, this.windowStart + WINDOW_MS - now));
      this.timer.unref?.();
    }
  }

  /** End the window: one summary line per key that suppressed any, then every count is reset. */
  private flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [key, { suppressed }] of this.counts) if (suppressed) this.logger.warn(this.summary(key, suppressed));
    this.counts.clear();
  }
}

export class SocketLimitLog {
  private readonly lines: RateLimitedWarn<SocketLimit | typeof UNLISTED>;

  constructor(logger: SocketLimitLogger = new Logger('CollabSocketLimit'), now?: () => number) {
    this.lines = new RateLimitedWarn({
      logger,
      perKey: COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE,
      summary: (of, count) => `${COLLAB_SOCKET_LIMIT_TOKEN} ${JSON.stringify({ limit: 'log_suppressed', of, count })}`,
      now,
    });
  }

  log(limit: SocketLimit, fields: Record<string, string | number> = {}): void {
    this.lines.warn(KNOWN_LIMITS.has(limit) ? limit : UNLISTED, () => `${COLLAB_SOCKET_LIMIT_TOKEN} ${JSON.stringify({ limit, ...fields })}`);
  }
}

/** The process-wide log every bound writes to. */
export const collabSocketLimitLog = new SocketLimitLog();

/**
 * A collab ws client's `error` event (collaboration.module.ts, seam #227). ws emits it only for what the peer sent: a
 * frame past `maxPayload`, `maxFragments` or `maxBufferedChunks` (limits.ts), or any other protocol violation, so a
 * client controls how often it fires. Logged here, rate-limited, with ws's error code only (never its message or any
 * client bytes); ws closes the socket itself.
 */
export function logCollabSocketError(error: unknown, limitLog: SocketLimitLog = collabSocketLimitLog): void {
  const code = (error as { code?: unknown } | null)?.code;
  limitLog.log('ws_error', { code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'unknown' });
}
