import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HttpAuthzClient } from '../http-authz.client';
import { ShareExpiryController } from './share-expiry.controller';
import { ShareExpiryInstaller } from './share-expiry.installer';
import { ShareExpirySweeper } from './share-expiry.sweeper';
import { SharePublishGate } from './share-publish.gate';
import { SharePublishInterceptor } from './share-publish.interceptor';

/**
 * CCC share lifecycle — NOT upstream Docmost code (#335, #704, ADR 0032).
 *
 * Public-share expiry: the boot installer of `ccc_share_expiry`, the cleanup sweeper and the expiry API. The
 * read-time gate itself is `PdpShareRepo` (seam #1). The publish gate (#704): `SharePublishGate` decides
 * `page#share`, and `SharePublishInterceptor` puts it in front of the upstream share create / update routes; the
 * expiry API calls it directly.
 *
 * Every other dep is @Global (Kysely, DatabaseModule's ShareRepo / PageRepo, PageAccessModule, AUTHZ_MODE,
 * AUDIT_SERVICE), so this module imports nothing and is mounted from AuthzModule without an upstream edit or an
 * import cycle (mirrors PublicDiscoveryModule). The PDP client is provided locally rather than imported from
 * AuthzModule (which imports THIS module — a cycle), as NativeRouteAuthzModule does: HttpAuthzClient is stateless and
 * configured from env, so a second instance is equivalent. All of it is inert outside `AUTHZ_MODE=remote`: the
 * installer and sweeper skip, the expiry controller answers 404 (RemoteOnlyGuard), and the gate and its interceptor
 * pass through. Wiring pinned by `share-publish.fitness.spec.ts`.
 */
@Module({
  controllers: [ShareExpiryController],
  providers: [
    ShareExpiryInstaller,
    ShareExpirySweeper,
    HttpAuthzClient,
    SharePublishGate,
    { provide: APP_INTERCEPTOR, useClass: SharePublishInterceptor },
  ],
})
export class ShareLifecycleModule {}
