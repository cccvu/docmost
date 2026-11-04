import { Module } from '@nestjs/common';
import { ShareExpiryController } from './share-expiry.controller';
import { ShareExpiryInstaller } from './share-expiry.installer';
import { ShareExpirySweeper } from './share-expiry.sweeper';

/**
 * CCC share lifecycle — NOT upstream Docmost code (#335, ADR 0032).
 *
 * Public-share expiry: the boot installer of `ccc_share_expiry`, the cleanup sweeper and the expiry API. The
 * read-time gate itself is `PdpShareRepo` (seam #1). Every dep is @Global (Kysely, DatabaseModule's ShareRepo /
 * PageRepo, PageAccessModule, AUTHZ_MODE, AUDIT_SERVICE), so this module imports nothing and is mounted from
 * AuthzModule without an upstream edit or an import cycle (mirrors PublicDiscoveryModule). All three are inert
 * outside `AUTHZ_MODE=remote`: the installer and sweeper skip, the controller answers 404 (RemoteOnlyGuard).
 */
@Module({
  controllers: [ShareExpiryController],
  providers: [ShareExpiryInstaller, ShareExpirySweeper],
})
export class ShareLifecycleModule {}
