import { FactoryProvider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { emptyCursorPaginationResult } from '@docmost/db/pagination/cursor-pagination';
import { DatabaseModule } from '../database/database.module';
import { PdpShareRepo } from './pdp-share.repo';
import { AUTHZ_MODE, AuthzMode } from './mode/authz-mode';
import { pagePermissionRepoProvider, shareRepoProvider, spaceMemberRepoProvider } from './mode/repo-providers';
import { HttpAuthzClient } from './http-authz.client';
import { PdpPagePermissionRepo } from './pdp-page-permission.repo';
import { PdpSpaceMemberRepo } from './pdp-space-member.repo';
import { shareIsLiveSql } from './share-lifecycle/share-expiry.sql';
import { spyKysely } from '../service-bridge/kysely-spy.testkit';

/**
 * CCC authorization integration test — NOT upstream Docmost code.
 *
 * The wiring of `PdpShareRepo` (#660, #335): it is what the `ShareRepo` token resolves to in remote mode (and only
 * there), it gates through the SAME mode's PDP repos, and every upstream `ShareRepo` method is classified so an
 * upstream bump that adds a share read goes red until someone decides how it treats expiry and the PDP. The SQL
 * (filter-before-pagination, expiry at read time, the re-share cleanup) is proven on Postgres in
 * pdp-share.repo.pg.spec.ts and share-lifecycle/share-lifecycle.pg.spec.ts.
 */

describe('ShareRepo surface pin — every share read is classified for the PDP and for expiry', () => {
  // Overridden: the user-scoped list (PDP gate) and every read/insert that could return or reuse an expired share.
  const OVERRIDDEN = ['getShares', 'findById', 'findByPageId', 'insertShare'];
  // Safe to inherit, each for a stated reason. A new upstream method lands in neither list and turns this red.
  const SAFE_INHERITED: Record<string, string> = {
    constructor: 'no query',
    updateShare: 'a write by id; every caller resolves the share through findById first (404 when expired)',
    deleteShare: 'removes a share; an expired one only goes sooner (the sweeper would delete it)',
    deleteBySpaceId: 'removes shares; cannot expose one',
    deleteByWorkspaceId: 'removes shares; cannot expose one',
    withPage: 'a select expression, composed only into reads that are themselves classified',
    withSpace: 'a select expression (its mirror userRole is UX only), composed into classified reads',
    withUserSpaceRole: 'a select expression used by withSpace',
    withCreator: 'a select expression, composed only into classified reads',
    withSharedPage: 'a select expression used by findById (overridden)',
  };

  it('the upstream surface is exactly the classified set', () => {
    expect(Object.getOwnPropertyNames(ShareRepo.prototype).sort()).toEqual(
      [...OVERRIDDEN, ...Object.keys(SAFE_INHERITED)].sort(),
    );
  });

  it.each(OVERRIDDEN)('PdpShareRepo overrides %s', (method) => {
    expect(Object.getOwnPropertyNames(PdpShareRepo.prototype)).toContain(method);
  });

  it('PdpShareRepo is a strict subclass (every consumer of the token keeps the upstream contract)', () => {
    expect(PdpShareRepo.prototype).toBeInstanceOf(ShareRepo);
  });
});

describe('shareRepoProvider — the share repo moves with AUTHZ_MODE', () => {
  const p = shareRepoProvider as FactoryProvider;
  const stub = {} as any;

  it('names AUTHZ_MODE first and resolves the (mode-selected) space and page repos it gates through', () => {
    expect(p.provide).toBe(ShareRepo);
    expect(p.inject?.[0]).toBe(AUTHZ_MODE);
    expect(p.inject).toEqual(expect.arrayContaining([SpaceMemberRepo, PagePermissionRepo]));
  });

  it('native → stock ShareRepo, never the PDP subclass', () => {
    const inst = p.useFactory('native', stub, stub, stub);
    expect(inst).toBeInstanceOf(ShareRepo);
    expect(inst).not.toBeInstanceOf(PdpShareRepo);
  });

  it('remote → PdpShareRepo', () => {
    expect(p.useFactory('remote', stub, stub, stub)).toBeInstanceOf(PdpShareRepo);
  });

  const resolve = async (mode: AuthzMode) =>
    (
      await Test.createTestingModule({
        providers: [
          { provide: AUTHZ_MODE, useValue: mode },
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: stub },
          { provide: GroupRepo, useValue: stub },
          { provide: SpaceRepo, useValue: stub },
          { provide: CACHE_MANAGER, useValue: stub },
          { provide: HttpAuthzClient, useValue: stub },
          spaceMemberRepoProvider,
          pagePermissionRepoProvider,
          shareRepoProvider,
        ],
      }).compile()
    ).get(ShareRepo) as any;

  it('remote (DI): PdpShareRepo gates through PdpPagePermissionRepo, spaces from PdpSpaceMemberRepo', async () => {
    const repo = await resolve('remote');
    expect(repo).toBeInstanceOf(PdpShareRepo);
    expect(repo.pagePermissions).toBeInstanceOf(PdpPagePermissionRepo);
    expect(repo.spaceMembers).toBeInstanceOf(PdpSpaceMemberRepo);
  });

  it('native (DI): the stock ShareRepo', async () => {
    const repo = await resolve('native');
    expect(repo).toBeInstanceOf(ShareRepo);
    expect(repo).not.toBeInstanceOf(PdpShareRepo);
  });

  it('seam #1: DatabaseModule binds the ShareRepo token to the mode-selected provider (never the stock class)', () => {
    const providers: unknown[] = Reflect.getMetadata('providers', DatabaseModule);
    const exported: unknown[] = Reflect.getMetadata('exports', DatabaseModule);
    expect(providers).toContain(shareRepoProvider);
    expect(providers).not.toContain(ShareRepo);
    expect(exported).toContain(ShareRepo); // every consumer (ShareService, search, workspace/space services) resolves it
    const tokens = providers.map((x: any) => (x && typeof x === 'object' && 'provide' in x ? x.provide : x));
    expect(tokens.filter((t) => t === ShareRepo)).toHaveLength(1);
  });
});

describe('PdpShareRepo.getShares — short-circuits before any candidate read or PDP page call', () => {
  const build = (caller: { workspace_id: string | null } | undefined, spaces: string[]) => {
    const spy = spyKysely(() => (caller ? [caller] : []));
    const spaceMembers = { getUserSpaceIds: jest.fn(async () => spaces) };
    const pagePermissions = { filterAccessiblePageIds: jest.fn() };
    const repo = new PdpShareRepo(spy.db, spaceMembers as any, pagePermissions as any);
    return { repo, spy, spaceMembers, pagePermissions };
  };

  it.each([25, 1.5, null])('no PDP-viewable space (outage or none) ⇒ the canonical empty result (limit %p)', async (limit) => {
    const { repo, spy, pagePermissions } = build({ workspace_id: 'w1' }, []);
    expect(await repo.getShares('u1', { limit, cursor: 'x' } as any)).toEqual(
      emptyCursorPaginationResult(limit as number),
    );
    expect(pagePermissions.filterAccessiblePageIds).not.toHaveBeenCalled();
    // Only the caller's own workspace was read: no candidate share query ran.
    expect(spy.calls.map((c) => c.sql)).toEqual([expect.stringMatching(/from users u where u\.id = \$1/)]);
  });

  it('a caller with no user row ⇒ empty, and the PDP space lookup is never asked', async () => {
    const { repo, spaceMembers, pagePermissions } = build(undefined, ['s1']);
    expect(await repo.getShares('ghost', { limit: 20 } as any)).toEqual(emptyCursorPaginationResult(20));
    expect(spaceMembers.getUserSpaceIds).not.toHaveBeenCalled();
    expect(pagePermissions.filterAccessiblePageIds).not.toHaveBeenCalled();
  });
});

describe('shareIsLiveSql — the one expiry predicate', () => {
  const offline = new Kysely<any>({
    dialect: new PostgresDialect({ pool: {} as any }),
    plugins: [new CamelCasePlugin()],
  });
  const compiled = (alias: string) =>
    offline.selectFrom('shares as s').select(shareIsLiveSql(alias).as('live')).compile().sql.replace(/\s+/g, ' ');

  it('is a strict comparison against the database clock: row expiry (null = Never) else created_at + 90 days', () => {
    const q = compiled('s');
    expect(q).toContain(
      "coalesce( (select coalesce(cse.expires_at, 'infinity'::timestamptz) from ccc_share_expiry cse where cse.share_id = s.id), s.created_at + make_interval(days => 90) ) > now()",
    );
  });

  it.each(['s; drop table shares', 'S', '1s', 's.id', ''])('refuses a non-identifier alias %p', (alias) => {
    expect(() => shareIsLiveSql(alias)).toThrow(/invalid alias/);
  });
});
