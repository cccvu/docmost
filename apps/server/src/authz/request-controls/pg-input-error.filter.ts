import { ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { PostgresError } from 'postgres';
import { InvalidCharactersException } from './storable-text';

/**
 * CCC request control — NOT upstream Docmost code (#781, ADR 0036).
 *
 * The backstop behind `StorableTextInterceptor`. Postgres refusing the request's own text is the caller's input, not
 * an engine fault, so it is answered 400 `invalid_characters` instead of a 500 (which the platform renders "may have
 * been applied"):
 *   - 22P05 `untranslatable_character`: U+0000 in jsonb ("\u0000 cannot be converted to text");
 *   - 22021 `character_not_in_repertoire`: U+0000 in text/varchar ("invalid byte sequence for encoding UTF8: 0x00");
 *   - 22P02 `invalid_text_representation`, ONLY when it is about json or Unicode (a lone surrogate in jsonb: "invalid
 *     input syntax for type json", "Unicode low surrogate must follow a high surrogate").
 * The interceptor refuses every such string it can see before the handler. What reaches this filter is a string the
 * handler decoded itself — a comment's `content` is a JSON string the service parses, so `"\\u0000"` in it becomes NUL
 * only there — or one from a multipart field. Such a write is a single statement that Postgres refused, so nothing of
 * it applied.
 *
 * Everything else falls through to Nest's own handling, unchanged (`BaseExceptionFilter`): a 22P02 about a uuid, an
 * integer or an enum (a malformed id: upstream answers it 500 and this issue does not change that), and every other
 * SQLSTATE. `PostgresError` reaches the filter unwrapped: Kysely's PostgresJSDialect rethrows the driver's error as is
 * (pinned against a real Postgres by `pg-input-error.pg.spec.ts`).
 *
 * Global, from AuthzModule (StorableTextModule), like RetryAfterFilter. The two `@Catch` lists do not overlap
 * (`PostgresError` is no HttpException), and Nest hands an exception to the first filter whose list matches it, so
 * their order does not matter. HTTP only: in any other context the error is re-thrown, which is what Nest does there
 * without a filter.
 */
const UNSTORABLE_CODES: ReadonlySet<string> = new Set(['22P05', '22021']);
const JSON_OR_UNICODE = /\bjsonb?\b|unicode|surrogate/i;

/** A Postgres refusal of a NUL or a lone surrogate in the request's own text. */
export function isUnstorableInputError(e: unknown): boolean {
  if (!(e instanceof PostgresError)) return false;
  if (UNSTORABLE_CODES.has(e.code)) return true;
  return e.code === '22P02' && (JSON_OR_UNICODE.test(e.message ?? '') || JSON_OR_UNICODE.test(e.detail ?? ''));
}

@Catch(PostgresError)
export class PgInputErrorFilter extends BaseExceptionFilter {
  private readonly log = new Logger('PgInputError');

  catch(exception: PostgresError, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    if (!isUnstorableInputError(exception)) {
      super.catch(exception, host);
      return;
    }
    const route = host.switchToHttp().getRequest<{ routeOptions?: { url?: string } }>()?.routeOptions?.url ?? '-';
    // The SQLSTATE only: the message and detail can quote the value.
    this.log.warn(`PG_INPUT_REFUSED route=${route} sqlstate=${exception.code}: 400 invalid_characters`);
    super.catch(new InvalidCharactersException(), host);
  }
}
