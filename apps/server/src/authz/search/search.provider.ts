import { Provider } from '@nestjs/common';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SearchService } from '../../core/search/search.service';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
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
 */
const KYSELY = KYSELY_MODULE_CONNECTION_TOKEN();

export const searchServiceProvider: Provider = {
  provide: SearchService,
  inject: [AUTHZ_MODE, KYSELY, PageRepo, ShareRepo, SpaceMemberRepo, PagePermissionRepo],
  useFactory: (
    mode: AuthzMode,
    db: KyselyDB,
    pageRepo: PageRepo,
    shareRepo: ShareRepo,
    spaceMemberRepo: SpaceMemberRepo,
    pagePermissionRepo: PagePermissionRepo,
  ): SearchService =>
    mode === 'remote'
      ? new PdpSearchService(db, pageRepo, shareRepo, spaceMemberRepo, pagePermissionRepo)
      : new SearchService(db, pageRepo, shareRepo, spaceMemberRepo, pagePermissionRepo),
};
