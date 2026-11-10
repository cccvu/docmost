/**
 * CCC collab integration — NOT upstream Docmost code (#790, ADR 0036).
 *
 * The `COLLAB_SOCKET_LIMIT` warn line for every collab socket bound (limits.ts), rate-limited like the update guard's
 * log: at most COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE lines a minute, process-wide, and one line with the suppressed
 * count when the next window opens. Fields are the limit, numbers, and a user or page id when known: never a
 * document name a client sent, and never content.
 */
import { Logger } from '@nestjs/common';
import { COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE } from './limits';

export const COLLAB_SOCKET_LIMIT_TOKEN = 'COLLAB_SOCKET_LIMIT';

export interface SocketLimitLogger {
  warn(message: string): void;
}

export class SocketLimitLog {
  private window = { start: 0, count: 0, suppressed: 0 };

  constructor(private readonly logger: SocketLimitLogger = new Logger('CollabSocketLimit')) {}

  log(limit: string, fields: Record<string, string | number> = {}): void {
    const now = Date.now();
    if (now - this.window.start >= 60_000) {
      const { suppressed } = this.window;
      this.window = { start: now, count: 0, suppressed: 0 };
      if (suppressed) this.logger.warn(`${COLLAB_SOCKET_LIMIT_TOKEN} ${JSON.stringify({ limit: 'log_suppressed', count: suppressed })}`);
    }
    if (this.window.count++ < COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE) {
      this.logger.warn(`${COLLAB_SOCKET_LIMIT_TOKEN} ${JSON.stringify({ limit, ...fields })}`);
    } else {
      this.window.suppressed++;
    }
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
