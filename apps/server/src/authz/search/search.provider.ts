import { Provider } from '@nestjs/common';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SearchService } from '../../core/search/search.service';
import { ShareService } from '../../core/share/share.service';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { HttpAuthzClient } from '../http-authz.client';
import { PdpSearchService } from './pdp-search.service';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Mode-selected DI provider for the SearchService token. In `native` mode it resolves to the STOCK
 * upstream `SearchService` (retrieve-then-filter — confidentiality-safe, since restricted pages never
 * survive the post-filter through the mode-selected `PagePermissionRepo`); in `remote` mode to the
 * fork's `PdpSearchService` (filter-then-retrieve, fixing authorized-k-under-truncation). SearchService
 * is a MODULE-LOCAL provider, so the selection must be bound in search.module.ts (a @Global rebind
 * cannot win over the module-local injection) — see UPSTREAM_MODIFICATIONS.md #5.
 *
 * The remote subclass also gets its own `HttpAuthzClient` for the SERVICE leg of an on-behalf-of search (#615).
 * The client is stateless (env-configured, like the one PageRestrictionModule provides for itself), and injecting
 * it would need an export from the upstream-owned DatabaseModule — so it is constructed here, in fork code.
 *
 * `ShareService` (from the ShareModule that search.module.ts imports, #660) gives the remote subclass the
 * public share-search gate: sharing enabled and the space not archived. Native mode keeps stock upstream.
 */
const KYSELY = KYSELY_MODULE_CONNECTION_TOKEN();

export const searchServiceProvider: Provider = {
  provide: SearchService,
  inject: [AUTHZ_MODE, KYSELY, PageRepo, ShareRepo, SpaceMemberRepo, PagePermissionRepo, ShareService],
  useFactory: (
    mode: AuthzMode,
    db: KyselyDB,
    pageRepo: PageRepo,
    shareRepo: ShareRepo,
    spaceMemberRepo: SpaceMemberRepo,
    pagePermissionRepo: PagePermissionRepo,
    shareService: ShareService,
  ): SearchService =>
    mode === 'remote'
      ? new PdpSearchService(
          db,
          pageRepo,
          shareRepo,
          spaceMemberRepo,
          pagePermissionRepo,
          new HttpAuthzClient(),
          shareService,
        )
      : new SearchService(db, pageRepo, shareRepo, spaceMemberRepo, pagePermissionRepo),
};
