import {
  ArgumentsHost,
  Catch,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConversionBudgetExhaustedException } from '../../editor-compat/content-parse/content-parse.service';

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
 * brown-out window, 2–5 s, so retrying clients do not return in step.
 *
 * Also the one 429 the engine raises itself (#642): `ConversionBudgetExhaustedException` carries the seconds until the
 * caller's converter budget is positive again, and that is its `Retry-After` (again, never over a value already set). The body is untouched: the response is then
 * rendered by Nest's own `BaseExceptionFilter`, exactly as without this filter.
 *
 * One exception (wiki-v2#716): the native UNKEYED page create (`POST /api/pages/create`). Its route reads the PDP
 * again AFTER the insert commits (`validateCanViewWithPermissions`), so an uncoded 503 there does not mean nothing was
 * created, and a retry can make a duplicate. That 503 keeps its status but carries NO `Retry-After` and says the page
 * may have been created — the twin of the platform's `/v1` unkeyed-create answer (`withoutRetryAfter`). A CODED 503 on
 * that route (`engine_busy`: no conversion slot was free) is refused before any insert, so it keeps the default.
 *
 * A filter, not an interceptor, so that it also sees a 503 thrown by a guard or by an interceptor registered outside
 * AuthzModule's. HTTP only: in any other context the exception is re-thrown, which is what Nest does there without a
 * filter (gateways never see global filters at all).
 */
export const RETRY_AFTER_MIN_SEC = 2;
export const RETRY_AFTER_MAX_SEC = 5;

/** The native unkeyed create (wiki-v2#716): the one route whose uncoded 503 may follow a committed insert. */
export const UNKEYED_CREATE_ROUTE = { method: 'POST', url: '/api/pages/create' } as const;
export const UNKEYED_CREATE_OUTCOME_UNKNOWN_MESSAGE =
  'the page may have been created; check before creating it again';

/** A 503 that carries a machine `code` (e.g. `engine_busy`): a refusal the throwing code knows changed nothing. */
function isCoded(exception: ServiceUnavailableException): boolean {
  const body = exception.getResponse();
  return (
    !!body &&
    typeof body === 'object' &&
    typeof (body as { code?: unknown }).code === 'string'
  );
}

function isUnkeyedCreate(req: FastifyRequest | undefined): boolean {
  return (
    req?.method === UNKEYED_CREATE_ROUTE.method &&
    req?.routeOptions?.url === UNKEYED_CREATE_ROUTE.url
  );
}

export function defaultRetryAfterSec(
  random: () => number = Math.random,
): number {
  const span = RETRY_AFTER_MAX_SEC - RETRY_AFTER_MIN_SEC + 1;
  return RETRY_AFTER_MIN_SEC + Math.min(span - 1, Math.floor(random() * span));
}

@Catch(ServiceUnavailableException, ConversionBudgetExhaustedException)
export class RetryAfterFilter extends BaseExceptionFilter {
  catch(
    exception: ServiceUnavailableException | ConversionBudgetExhaustedException,
    host: ArgumentsHost,
  ): void {
    if (host.getType() !== 'http') throw exception;
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (
      exception instanceof ServiceUnavailableException &&
      !isCoded(exception) &&
      isUnkeyedCreate(host.switchToHttp().getRequest<FastifyRequest>())
    ) {
      // Outcome unknown: no Retry-After (a blind retry is what it must not invite), and an honest message.
      super.catch(
        new ServiceUnavailableException(UNKEYED_CREATE_OUTCOME_UNKNOWN_MESSAGE),
        host,
      );
      return;
    }
    if (
      typeof reply?.getHeader === 'function' &&
      reply.getHeader('retry-after') === undefined
    ) {
      const seconds =
        exception instanceof ConversionBudgetExhaustedException
          ? exception.retryAfterSeconds
          : defaultRetryAfterSec();
      reply.header('Retry-After', String(seconds));
    }
    super.catch(exception, host);
  }
}
