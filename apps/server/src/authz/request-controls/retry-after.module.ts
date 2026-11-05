import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RetryAfterFilter } from './retry-after.filter';

/**
 * CCC request control — NOT upstream Docmost code (wiki-v2#696).
 *
 * Registers `RetryAfterFilter` globally from AuthzModule (already in the graph via database.module), so no upstream
 * file changes — the way ExportAdmissionModule and NativeRouteAuthzModule register their interceptors. Wiring pinned
 * by `retry-after.filter.spec.ts`.
 */
@Module({
  providers: [{ provide: APP_FILTER, useClass: RetryAfterFilter }],
})
export class RetryAfterModule {}
