import {
  ArgumentsHost,
  Catch,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { FastifyReply } from 'fastify';

/**
 * CCC request control — NOT upstream Docmost code (wiki-v2#696).
 *
 * Every 503 the engine answers says when to come back. A 503 here is always a CCC refusal for now (no upstream file
 * throws one): the PDP could not answer (`authzUnavailable`), a search could not be authorized or was shed, a guarded
 * write could not take its lock (`engineBusy`), no conversion slot was free (`ContentParseBusyException`), … — all of
 * them retryable, and all of them used to leave without a `Retry-After`. The platform prefers the engine's own value
 * when it relays one, so this is also what a `/v1` caller is told.
 *
 * Rules: a `Retry-After` already on the reply is kept (export admission sets its own 30 s); otherwise the jittered PDP
 * brown-out window, 2–5 s, so retrying clients do not return in step. The body is untouched: the response is then
 * rendered by Nest's own `BaseExceptionFilter`, exactly as without this filter.
 *
 * A filter, not an interceptor, so that it also sees a 503 thrown by a guard or by an interceptor registered outside
 * AuthzModule's. HTTP only: in any other context the exception is re-thrown, which is what Nest does there without a
 * filter (gateways never see global filters at all).
 */
export const RETRY_AFTER_MIN_SEC = 2;
export const RETRY_AFTER_MAX_SEC = 5;

export function defaultRetryAfterSec(
  random: () => number = Math.random,
): number {
  const span = RETRY_AFTER_MAX_SEC - RETRY_AFTER_MIN_SEC + 1;
  return RETRY_AFTER_MIN_SEC + Math.min(span - 1, Math.floor(random() * span));
}

@Catch(ServiceUnavailableException)
export class RetryAfterFilter extends BaseExceptionFilter {
  catch(exception: ServiceUnavailableException, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (
      typeof reply?.getHeader === 'function' &&
      reply.getHeader('retry-after') === undefined
    ) {
      reply.header('Retry-After', String(defaultRetryAfterSec()));
    }
    super.catch(exception, host);
  }
}
