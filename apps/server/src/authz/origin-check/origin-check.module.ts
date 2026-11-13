import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ForkOriginCheckGuard } from './origin-check.guard';

/**
 * CCC request control — NOT upstream Docmost code (wiki-v2 #655).
 *
 * Registers `ForkOriginCheckGuard` globally from AuthzModule (already in the graph via database.module), so no
 * upstream file changes — the way RetryAfterModule and StorableTextModule register theirs. Wiring pinned by
 * `origin-check.wiring.spec.ts`; that it runs before a controller's own guard, by `origin-check.http.spec.ts`.
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: ForkOriginCheckGuard }],
})
export class OriginCheckModule {}
