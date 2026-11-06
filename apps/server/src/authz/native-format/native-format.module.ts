import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { NativeFormatInterceptor } from './native-format.interceptor';

/**
 * CCC request control — NOT upstream Docmost code (#716).
 *
 * Registers `NativeFormatInterceptor` globally from AuthzModule (already in the graph via database.module), so no
 * upstream file changes, the way ExportAdmissionModule registers its interceptor. AUTHZ_MODE comes from the @Global
 * AuthzModeModule. Wiring pinned by `native-format.interceptor.spec.ts`.
 */
@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: NativeFormatInterceptor }],
})
export class NativeFormatModule {}
