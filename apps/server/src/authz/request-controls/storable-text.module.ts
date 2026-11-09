import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { StorableTextInterceptor } from './storable-text.interceptor';
import { PgInputErrorFilter } from './pg-input-error.filter';

/**
 * CCC request control — NOT upstream Docmost code (#781, ADR 0036).
 *
 * Registers `StorableTextInterceptor` (a NUL or lone surrogate in a request → 400 `invalid_characters` before the
 * handler) and its backstop `PgInputErrorFilter` (Postgres refusing such a string → the same 400) globally from
 * AuthzModule (already in the graph via database.module), so no upstream file changes — the way RetryAfterModule and
 * NativeFormatModule register theirs. Wiring pinned by `storable-text.spec.ts`.
 */
@Module({
  providers: [
    { provide: APP_INTERCEPTOR, useClass: StorableTextInterceptor },
    { provide: APP_FILTER, useClass: PgInputErrorFilter },
  ],
})
export class StorableTextModule {}
