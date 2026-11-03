import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HttpAuthzClient } from '../http-authz.client';
import { BreadcrumbsRedactionInterceptor } from './breadcrumbs-redaction.interceptor';
import { SpaceMemberMutationInterceptor } from './space-member-mutation.interceptor';

/**
 * CCC authorization integration — NOT upstream Docmost code (#542, #574).
 *
 * Remote-mode authorization on native upstream routes whose controllers we may not edit:
 *  - `SpaceMemberMutationInterceptor` refuses the native space-member add/remove/change-role (#542);
 *  - `BreadcrumbsRedactionInterceptor` cuts the breadcrumb chain at the first ancestor the caller cannot view (#574).
 *
 * Mounted from AuthzModule (already in the graph via database.module), so no upstream file changes. Their other deps
 * come from @Global modules: AUTHZ_MODE (AuthzModeModule) and PlatformAuditClient (PlatformAuditModule). The PDP
 * client is provided locally rather than imported from AuthzModule (which imports THIS module — a cycle), as
 * PageRestrictionModule does: HttpAuthzClient is stateless and configured from env, so a second instance is
 * equivalent. Interceptors of an imported module run inside AppModule's own (access audit, rate limit) and outside
 * `TransformHttpResponseInterceptor` (appended by main.ts after creation). Wiring pinned by
 * `native-route-authz.module.spec.ts` and `native-route-authz.fitness.spec.ts`.
 */
@Module({
  providers: [
    HttpAuthzClient,
    { provide: APP_INTERCEPTOR, useClass: SpaceMemberMutationInterceptor },
    { provide: APP_INTERCEPTOR, useClass: BreadcrumbsRedactionInterceptor },
  ],
})
export class NativeRouteAuthzModule {}
