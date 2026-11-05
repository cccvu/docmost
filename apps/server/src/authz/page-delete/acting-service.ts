import { BadRequestException } from '@nestjs/common';
import { PRINCIPAL_ID_PATTERN } from '../../service-bridge/dto/content-search.dto';

/**
 * CCC authorization integration — NOT upstream Docmost code (#670, #634).
 *
 * The delegated service account a page removal acts for. The platform sets this header on its page-delete relays
 * (trash and permanent, plain and conditional) only for a service principal acting on behalf of a human — an RFC 8693
 * token exchange or the MCP connector — with the service account's principal id; the human is the request's cookie.
 *
 * It only ever NARROWS: the remote routines decide the human first, and then ALSO ask the PDP the same questions about
 * this service account, under the same locks and fence. It never replaces, skips or ORs a human check, so a forged
 * value (anyone can send a header to a native route) can only refuse the sender's own request. Absent = the human
 * alone (an older platform, or no delegation). Read in remote mode only, parsed only here, and never written to an
 * audit row or a log line (`remote-purge.fitness.spec.ts` pins all three).
 */
export const ACTING_SERVICE_HEADER = 'x-ccc-acting-service';

/** The 400 every malformed value gets. Fixed text: it never echoes the value. */
function invalid(): BadRequestException {
  return new BadRequestException({
    message: `${ACTING_SERVICE_HEADER} must be a single service account id`,
    code: 'acting_service_invalid',
  });
}

/**
 * The header's raw value (`req.headers[ACTING_SERVICE_HEADER]`) → the service account id, or `undefined` when absent.
 * Strict, fail closed: an array (a repeated header), a non-string, an empty value, a comma-joined repeat and anything
 * that is not exactly one principal id (`PRINCIPAL_ID_PATTERN`, the service bridge's) are a 400 — never "absent",
 * which would drop the service leg.
 */
export function parseActingService(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes(',')) throw invalid();
  if (!PRINCIPAL_ID_PATTERN.test(raw)) throw invalid();
  return raw;
}
