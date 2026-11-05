import { ServiceUnavailableException } from '@nestjs/common';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * #696: the PDP could not answer a point decision (a transport error, a timeout, a non-2xx or a malformed answer —
 * every case `HttpAuthzClient.tryCheckBulk` reports as `null`). Retryable, and never a deny-shaped status: a 403 or
 * 404 tells a client it lost access, so it never retries. Still fail closed — a throw grants nothing.
 */
export const AUTHZ_UNAVAILABLE_MESSAGE = 'authorization is temporarily unavailable; retry shortly';

export function authzUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException(AUTHZ_UNAVAILABLE_MESSAGE);
}
