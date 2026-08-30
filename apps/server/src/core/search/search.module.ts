import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
// --- CCC authorization integration seam (see /UPSTREAM_MODIFICATIONS.md #5).
// Rebinds SearchService to a PDP-backed subclass so search is filter-then-retrieve (the authorized
// object set gates retrieval before limit/offset). All policy lives in the fork-owned subclass.
import { PdpSearchService } from '../../authz/search/pdp-search.service';

@Module({
  controllers: [SearchController],
  // CCC rebind: the SearchService token resolves to the PDP-backed, filter-then-retrieve subclass.
  providers: [{ provide: SearchService, useClass: PdpSearchService }],
  exports: [SearchService],
})
export class SearchModule {}
