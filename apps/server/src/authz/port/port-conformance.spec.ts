import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PdpSpaceMemberRepo } from '../pdp-space-member.repo';
import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import type { SpaceAuthzPort } from './space-authz.port';
import type { PageAuthzPort } from './page-authz.port';

/**
 * Type-level conformance: BOTH adapters — native (the stock upstream repo) and remote (the PDP-backed
 * fork subclass) — satisfy the authorization ports. If a future refactor (or an upstream bump) drifts a
 * method signature, this file fails to COMPILE, so the port stays honest — without editing the upstream
 * repos (an `implements` clause there would itself be an upstream change we don't want).
 */
describe('authorization port conformance (compile-time)', () => {
  it('stock + PDP repos satisfy SpaceAuthzPort / PageAuthzPort', () => {
    const _space: SpaceAuthzPort = null as unknown as SpaceMemberRepo;
    const _pdpSpace: SpaceAuthzPort = null as unknown as PdpSpaceMemberRepo;
    const _page: PageAuthzPort = null as unknown as PagePermissionRepo;
    const _pdpPage: PageAuthzPort = null as unknown as PdpPagePermissionRepo;
    void _space;
    void _pdpSpace;
    void _page;
    void _pdpPage;
    expect(true).toBe(true);
  });
});
