import { FactoryProvider } from '@nestjs/common';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SearchService } from '../../core/search/search.service';
import { PdpSpaceMemberRepo } from '../pdp-space-member.repo';
import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import { PdpSearchService } from '../search/pdp-search.service';
import { AUTHZ_MODE } from './authz-mode';
import {
  pagePermissionRepoProvider,
  spaceMemberRepoProvider,
} from './repo-providers';
import { searchServiceProvider } from '../search/search.provider';

// Constructor bodies of the repos/search are side-effect-free (empty or a field assign), so opaque stubs
// are enough to exercise the selection factory and assert which concrete class is produced.
const stub = {} as any;

/**
 * The mode-selection is the security-critical hinge: `native` MUST produce Docmost's own repos (a
 * legitimate control — the PDP subclass is a strict subclass, so we assert it is NOT the subclass), and
 * `remote` MUST produce the PDP-backed subclass. A factory bug here (wrong branch, swapped classes) is
 * exactly the accidental-allow-all / silent-downgrade class of defect the plan calls out — so it is
 * pinned by a test.
 */
describe('mode-selected DI providers', () => {
  it('all three name AUTHZ_MODE as their first injected dependency', () => {
    for (const p of [
      spaceMemberRepoProvider,
      pagePermissionRepoProvider,
      searchServiceProvider,
    ]) {
      expect((p as FactoryProvider).inject?.[0]).toBe(AUTHZ_MODE);
    }
  });

  describe('spaceMemberRepoProvider', () => {
    const f = (spaceMemberRepoProvider as FactoryProvider).useFactory;
    it('native → stock SpaceMemberRepo (Docmost own authz), never the PDP subclass', () => {
      const inst = f('native', stub, stub, stub, stub, stub);
      expect(inst).toBeInstanceOf(SpaceMemberRepo);
      expect(inst).not.toBeInstanceOf(PdpSpaceMemberRepo);
    });
    it('remote → PdpSpaceMemberRepo', () => {
      expect(f('remote', stub, stub, stub, stub, stub)).toBeInstanceOf(
        PdpSpaceMemberRepo,
      );
    });
  });

  describe('pagePermissionRepoProvider', () => {
    const f = (pagePermissionRepoProvider as FactoryProvider).useFactory;
    it('native → stock PagePermissionRepo, never the PDP subclass', () => {
      const inst = f('native', stub, stub, stub, stub);
      expect(inst).toBeInstanceOf(PagePermissionRepo);
      expect(inst).not.toBeInstanceOf(PdpPagePermissionRepo);
    });
    it('remote → PdpPagePermissionRepo', () => {
      expect(f('remote', stub, stub, stub, stub)).toBeInstanceOf(
        PdpPagePermissionRepo,
      );
    });
  });

  describe('searchServiceProvider', () => {
    const f = (searchServiceProvider as FactoryProvider).useFactory;
    it('native → stock SearchService, never the PDP subclass', () => {
      const inst = f('native', stub, stub, stub, stub, stub);
      expect(inst).toBeInstanceOf(SearchService);
      expect(inst).not.toBeInstanceOf(PdpSearchService);
    });
    it('remote → PdpSearchService', () => {
      expect(f('remote', stub, stub, stub, stub, stub)).toBeInstanceOf(
        PdpSearchService,
      );
    });
  });
});
