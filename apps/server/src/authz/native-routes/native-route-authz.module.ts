import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HttpAuthzClient } from '../http-authz.client';
import { BreadcrumbsRedactionInterceptor } from './breadcrumbs-redaction.interceptor';

/**
 * CCC authorization integration — NOT upstream Docmost code (#574).
 *
 * Remote-mode authorization on a native upstream route whose controller we may not edit, where the answer is a
 * narrowed response rather than a refusal: `BreadcrumbsRedactionInterceptor` cuts the breadcrumb chain at the first
 * ancestor the caller cannot view (#574). Remote-mode REFUSALS, the native space-member writes of #542 among them, are
 * rows in `authz/remote-refusal/remote-refusal.table.ts` served by the one `RemoteNativeRefusalInterceptor` (#636),
 * never a second interceptor here. A PDP-DECIDED refusal on a native route is neither: the share publish gate (#704,
 * `page#share` on share create / update) answers 403 or 503 per caller and page, while a refusal-table row is an
 * unconditional synchronous 404 for every caller. It lives with the share lifecycle it belongs to
 * (`authz/share-lifecycle/share-publish.interceptor.ts`, registered by ShareLifecycleModule).
 *
 * Mounted from AuthzModule (already in the graph via database.module), so no upstream file changes. AUTHZ_MODE comes
 * from the @Global AuthzModeModule. The PDP client is provided locally rather than imported from AuthzModule (which
 * imports THIS module — a cycle), as PageRestrictionModule does: HttpAuthzClient is stateless and configured from
 * env, so a second instance is equivalent. Interceptors of an imported module run inside AppModule's own (access
 * audit, rate limit) and outside `TransformHttpResponseInterceptor` (appended by main.ts after creation). Wiring
 * pinned by `native-route-authz.module.spec.ts` and `native-route-authz.fitness.spec.ts`.
 */
@Module({
  providers: [HttpAuthzClient, { provide: APP_INTERCEPTOR, useClass: BreadcrumbsRedactionInterceptor }],
})
export class NativeRouteAuthzModule {}
