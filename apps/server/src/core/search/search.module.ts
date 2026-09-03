import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
// --- CCC authorization integration seam (see /UPSTREAM_MODIFICATIONS.md #5).
// Selects SearchService by AUTHZ_MODE: native → stock upstream (retrieve-then-filter, confidentiality-
// safe via the mode-selected PagePermissionRepo); remote → the fork's filter-then-retrieve subclass.
// SearchService is a module-local provider, so the selection must be bound here (a @Global rebind can't
// win over the module-local injection). All policy lives in the fork-owned provider/subclass.
import { searchServiceProvider } from '../../authz/search/search.provider';

@Module({
  controllers: [SearchController],
  providers: [searchServiceProvider],
  exports: [SearchService],
})
export class SearchModule {}
