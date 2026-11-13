/**
 * The `FORK_ORIGIN_CHECK_REFUSED` warn line — NOT upstream Docmost code (wiki-v2 #655).
 *
 * The engine has no request access log in any environment, and the origin check runs before every interceptor that
 * writes an audit row, so without this line a refusal was visible only in the refused browser. One line per refusal,
 * rate-limited per surface (30 a minute, the rest counted into one `log_suppressed` summary), so a real cross-site
 * attempt the WAF passed and a misconfiguration that refuses every browser write (a Host or APP_URL change) both show
 * on the server.
 *
 * Fields are fixed enums only: the surface (`http` | `socket`), the HTTP method, and which browser signals were
 * present (`Sec-Fetch-Site` as one of its four values, else `other` or `absent`; `Origin` and `Referer` as `present`,
 * `null` or `absent`). Never a header value, a host, a path, a user or a cookie.
 */
import { Logger } from '@nestjs/common';
import { RateLimitedWarn } from '../collab-ingress/socket-limit-log';

export const FORK_ORIGIN_CHECK_REFUSED_TOKEN = 'FORK_ORIGIN_CHECK_REFUSED';

export type OriginCheckSurface = 'http' | 'socket';

/** Lines per surface a minute; the rest are counted into one summary line. */
const ORIGIN_CHECK_LOGS_PER_MINUTE = 30;
const FETCH_SITES = new Set(['same-origin', 'same-site', 'cross-site', 'none']);
const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Where the lines go (the specs spy on it). */
export const originCheckLogSink: { warn(line: string): void } = {
  warn: (line) => defaultLogger.warn(line),
};
const defaultLogger = new Logger('ForkOriginCheck');

let lines = newLines();
function newLines(): RateLimitedWarn<OriginCheckSurface> {
  return new RateLimitedWarn<OriginCheckSurface>({
    logger: { warn: (line) => originCheckLogSink.warn(line) },
    perKey: ORIGIN_CHECK_LOGS_PER_MINUTE,
    summary: (surface, count) => `${FORK_ORIGIN_CHECK_REFUSED_TOKEN} ${JSON.stringify({ surface, reason: 'log_suppressed', count })}`,
  });
}

/** The specs: a fresh rate-limit window. */
export function resetOriginCheckLogForTests(): void {
  lines = newLines();
}

function fetchSiteShape(value: unknown): string {
  if (value === undefined) return 'absent';
  return typeof value === 'string' && FETCH_SITES.has(value) ? value : 'other';
}

function presence(value: unknown): 'present' | 'null' | 'absent' {
  if (value === undefined) return 'absent';
  return value === 'null' ? 'null' : 'present';
}

/** Log one refusal. `headers` is the raw request (or handshake) header map; only the shape of three is read. */
export function logOriginCheckRefused(
  surface: OriginCheckSurface,
  headers: Record<string, unknown>,
  method?: string,
): void {
  lines.warn(surface, () => {
    const fields: Record<string, string> = { surface };
    if (surface === 'http') {
      const m = (method ?? '').toUpperCase();
      fields.method = METHODS.has(m) ? m : 'other';
    }
    fields.secFetchSite = fetchSiteShape(headers['sec-fetch-site']);
    fields.origin = presence(headers['origin']);
    fields.referer = presence(headers['referer']);
    return `${FORK_ORIGIN_CHECK_REFUSED_TOKEN} ${JSON.stringify(fields)}`;
  });
}
