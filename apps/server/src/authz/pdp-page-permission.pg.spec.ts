import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { ForbiddenException } from '@nestjs/common';
import { PdpPagePermissionRepo } from './pdp-page-permission.repo';
import { PageAccessService } from '../core/page/page-access/page-access.service';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
} from '../service-bridge/read-model-pg.testkit';

/**
 * Real-Postgres proof of the #524 lineage check in `PdpPagePermissionRepo.canUserEditPage`. When the PDP has no
 * placement for a page (trashed: its #space/#parent edges are reaped; new, restored or re-parented: not projected
 * yet) it answers view=false AND locked=false, and upstream would fall back to the space role. The repo then walks
 * the page's own rows, and only an unrestricted, completely walked lineage may fall back. What a query spy cannot
 * show is proven here against real tables: the walk crosses TRASHED ancestors, sees a restriction added after the
 * trash (no cache), stays bounded and cycle-safe, never leaves the page's workspace, and reads every walk it cannot
 * finish as restricted. The PDP is a stub. Lives in the `docmost-authz-pg` CI lane (collects
 * `src/(service-bridge|authz)/**.pg.spec.ts`); self-skips without AUTHZ_TEST_PG_URL.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG page lineage gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'pdp_page_permission_pg_spec';
const WS = uuid(100);
const FOREIGN_WS = uuid(200);
const SPACE = uuid(1);
const UNPLACED = [false, false, false]; // view, edit, locked — what the PDP says about a page it cannot place
const DENY = { hasAnyRestriction: true, canAccess: false, canEdit: false };
const PASS = { hasAnyRestriction: false, canAccess: false, canEdit: false };

d('PdpPagePermissionRepo lineage check on real Postgres (#524)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let repo: PdpPagePermissionRepo;
  let access: PageAccessService;
  let pdp: boolean[] | null;
  const user = { id: uuid(900) } as any;

  const page = (
    id: string,
    parent: string | null,
    opts: { trashed?: boolean; ws?: string } = {},
  ) =>
    pg`insert into pages (id, space_id, parent_page_id, workspace_id, deleted_at)
       values (${id}, ${SPACE}, ${parent}, ${opts.ws ?? WS}, ${opts.trashed ? pg`now()` : null})`;
  const restrict = (id: string) =>
    pg`insert into page_access (page_id, workspace_id) values (${id}, ${WS})`;
  const check = (id: string) => repo.canUserEditPage(user.id, id);
  const asPage = (id: string) => ({ id, spaceId: SPACE }) as any;

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 4);
    await createReadModelTables(pg);
    db = mkReadModelDb(appPg);
    repo = new PdpPagePermissionRepo(
      db as any,
      {} as any,
      {} as any,
      {
        tryCheckBulk: async () => pdp,
      } as any,
    );
    // A space writer: CASL allows everything, so only the page decision can refuse.
    access = new PageAccessService(
      repo,
      {
        createForUser: async () => ({ can: () => true, cannot: () => false }),
      } as any,
      {} as any,
    );
  });

  afterEach(async () => {
    await pg`delete from page_access`;
    await pg`delete from pages`;
  });

  beforeEach(() => {
    pdp = [...UNPLACED];
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  it('the #524 repro: a trashed page under a LIVE restricted parent is restricted with no access', async () => {
    const [R, C] = [uuid(10), uuid(11)];
    await page(R, null);
    await restrict(R);
    await page(C, R, { trashed: true });
    expect(await check(C)).toEqual(DENY);
    await expect(
      access.validateCanViewWithPermissions(asPage(C), user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      access.validateCanEdit(asPage(C), user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a writer trashing an OPEN ancestor: every page under the restricted one denies, the open root passes', async () => {
    const [P, R, C, G] = [uuid(20), uuid(21), uuid(22), uuid(23)];
    await page(P, null, { trashed: true });
    await page(R, P, { trashed: true });
    await restrict(R);
    await page(C, R, { trashed: true });
    await page(G, C, { trashed: true });
    expect(await check(C)).toEqual(DENY);
    expect(await check(G)).toEqual(DENY);
    expect(await check(R)).toEqual(DENY);
    // The open trash root keeps upstream's behaviour: restoring it brings the whole subtree back intact.
    expect(await check(P)).toEqual(PASS);
  });

  it('sees a restriction added AFTER the trash (read fresh, never cached)', async () => {
    const [P, C] = [uuid(30), uuid(31)];
    await page(P, null);
    await page(C, P, { trashed: true });
    expect(await check(C)).toEqual(PASS);
    await restrict(P);
    expect(await check(C)).toEqual(DENY);
  });

  it('a LIVE page the PDP has not placed yet (a restore or create in flight) in a restricted section denies', async () => {
    // The red-team race: trash then restore an open ancestor, and every restricted-section descendant is live but
    // unprojected until the relay reaches it. Trashed or not makes no difference to the rule.
    const [R, C] = [uuid(40), uuid(41)];
    await page(R, null);
    await restrict(R);
    await page(C, R);
    expect(await check(C)).toEqual(DENY);
    await expect(
      access.validateCanEdit(asPage(C), user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a page restricted ITSELF but not projected yet denies', async () => {
    const C = uuid(50);
    await page(C, null);
    await restrict(C);
    expect(await check(C)).toEqual(DENY);
  });

  it('control: an unrestricted lineage passes through, trashed or live, at the root or nested', async () => {
    const [P, C, ROOT, LIVE] = [uuid(60), uuid(61), uuid(62), uuid(63)];
    await page(P, null);
    await page(C, P, { trashed: true });
    await page(ROOT, null, { trashed: true });
    await page(LIVE, P);
    for (const id of [C, ROOT, LIVE]) expect(await check(id)).toEqual(PASS);
    await expect(access.validateCanEdit(asPage(C), user)).resolves.toEqual({
      hasRestriction: false,
    });
  });

  it('a pre-existing parent cycle ends the walk early and denies (no trigger here to stop it)', async () => {
    const [A, B, C] = [uuid(70), uuid(71), uuid(72)];
    await page(A, null);
    await page(B, A);
    await page(C, B, { trashed: true });
    await pg`update pages set parent_page_id = ${C} where id = ${A}`;
    expect(await check(C)).toEqual(DENY);
  });

  it('is bounded at 256 steps: a 257-page chain is walked to its root, a 258-page chain denies', async () => {
    const chain = async (first: number, length: number) => {
      const last = first + length - 1;
      await pg`
        insert into pages (id, space_id, parent_page_id, workspace_id, deleted_at)
        select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${SPACE},
               case when g < ${last} then ('00000000-0000-4000-8000-' || lpad((g + 1)::text, 12, '0'))::uuid end,
               ${WS}, now()
          from generate_series(${first}::int, ${last}::int) g`;
      return uuid(first);
    };
    expect(await check(await chain(5000, 257))).toEqual(PASS);
    expect(await check(await chain(6000, 258))).toEqual(DENY);
  });

  it('a parent it cannot read (dangling) or in ANOTHER workspace ends the walk early and denies', async () => {
    const [DANGLING, FOREIGN_PARENT, C] = [uuid(80), uuid(81), uuid(82)];
    await page(DANGLING, uuid(89), { trashed: true });
    await page(FOREIGN_PARENT, null, { ws: FOREIGN_WS });
    await page(C, FOREIGN_PARENT, { trashed: true });
    expect(await check(DANGLING)).toEqual(DENY);
    expect(await check(C)).toEqual(DENY);
  });

  it('a page with no row denies', async () => {
    expect(await check(uuid(99))).toEqual(DENY);
  });

  it('control: a PDP answer that shows or locks the page is trusted as-is', async () => {
    const [R, C] = [uuid(90), uuid(91)];
    await page(R, null);
    await restrict(R);
    await page(C, R, { trashed: true });
    pdp = [true, true, false];
    expect(await check(C)).toEqual({
      hasAnyRestriction: false,
      canAccess: true,
      canEdit: true,
    });
    pdp = [false, false, true];
    expect(await check(C)).toEqual(DENY);
  });
});
