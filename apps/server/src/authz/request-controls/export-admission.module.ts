import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ExportAdmissionInterceptor } from './export-admission.interceptor';

/**
 * CCC request control — NOT upstream Docmost code (#699).
 *
 * Registers `ExportAdmissionInterceptor` globally from AuthzModule (already in the graph via database.module), so no
 * upstream file changes, the way NativeRouteAuthzModule registers its interceptor. Interceptors of an imported module
 * run inside AppModule's own (access audit, per-principal rate limit), so the access audit records an admission 503.
 * Wiring pinned by `export-admission.wiring.spec.ts`.
 */
@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: ExportAdmissionInterceptor }],
})
export class ExportAdmissionModule {}
