import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Provider } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { AUTHZ_MODE, AuthzMode } from './authz-mode';
import { PlatformAuthzClient } from '../platform-authz.client';
import { PdpSpaceMemberRepo } from '../pdp-space-member.repo';
import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Mode-selected DI providers for the two authorization repos. In `native` mode each token resolves to
 * the STOCK upstream class (Docmost's own authorization — a legitimate control, never allow-all); in
 * `remote` mode to the PDP-backed fork subclass. The two repos move together as ONE atom: a mixed
 * native-page / remote-space state is incoherent and a security hazard, so both key off the same
 * resolved AUTHZ_MODE.
 *
 * Centralizing the selection (and the messy nestjs-kysely connection token / cache / dep plumbing)
 * here shrinks the upstream seam in database.module.ts (#1) to two symbol references.
 */
const KYSELY = KYSELY_MODULE_CONNECTION_TOKEN();

export const spaceMemberRepoProvider: Provider = {
  provide: SpaceMemberRepo,
  inject: [AUTHZ_MODE, KYSELY, GroupRepo, SpaceRepo, CACHE_MANAGER, PlatformAuthzClient],
  useFactory: (
    mode: AuthzMode,
    db: KyselyDB,
    groupRepo: GroupRepo,
    spaceRepo: SpaceRepo,
    cache: Cache,
    authz: PlatformAuthzClient,
  ): SpaceMemberRepo =>
    mode === 'remote'
      ? new PdpSpaceMemberRepo(db, groupRepo, spaceRepo, cache, authz)
      : new SpaceMemberRepo(db, groupRepo, spaceRepo, cache),
};

export const pagePermissionRepoProvider: Provider = {
  provide: PagePermissionRepo,
  inject: [AUTHZ_MODE, KYSELY, GroupRepo, CACHE_MANAGER, PlatformAuthzClient],
  useFactory: (
    mode: AuthzMode,
    db: KyselyDB,
    groupRepo: GroupRepo,
    cache: Cache,
    authz: PlatformAuthzClient,
  ): PagePermissionRepo =>
    mode === 'remote'
      ? new PdpPagePermissionRepo(db, groupRepo, cache, authz)
      : new PagePermissionRepo(db, groupRepo, cache),
};
