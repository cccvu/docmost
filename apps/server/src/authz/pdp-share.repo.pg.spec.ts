import * as postgres from 'postgres';
import { Kysely, sql } from 'kysely';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { emptyCursorPaginationResult } from '@docmost/db/pagination/cursor-pagination';
import { PdpShareRepo } from './pdp-share.repo';
import { PdpPagePermissionRepo } from './pdp-page-permission.repo';
import { PdpSpaceMemberRepo } from './pdp-space-member.repo';
import { LABEL_SCAN } from './pdp-label.repo';
import { ShareExpiryInstaller } from './share-lifecycle/share-expiry.installer';
import { createShareTables } from './share-lifecycle/share-pg.testkit';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../service-bridge/read-model-pg.testkit';

/**
 * CCC authorization integration test — NOT upstream Docmost code.
 *
 * Real-Postgres proof of `PdpShareRepo` (#660, #335), wired as `shareRepoProvider` wires it (the real
 * `PdpSpaceMemberRepo` + `PdpPagePermissionRepo` over a stubbed platform) and with the real `ccc_share_expiry`
 * table from `ShareExpiryInstaller`:
 *  - the shares list is filter-then-retrieve: PDP-hidden pages never appear and never shape the meta or a cursor,
 *    the cursor is stable across many windows (same-millisecond rows included), the workspace is pinned, trashed
 *    pages and expired shares are excluded, and a PDP outage is an empty list;
 *  - expiry is enforced at READ time with no sweeper running: findById / findByPageId / getShares refuse an
 *    expired share (default, explicit, the exact boundary instant), "Never" and renewals stay live, and an error
 *    evaluating expiry throws instead of returning the share;
 *  - a re-share after expiry deletes the dead row in the same transaction and yields one fresh share.
 * Lives in the `docmost-authz-pg` CI lane; self-skips without AUTHZ_TEST_PG_URL.
 */
/** Clear every row the spec writes (the expiry table only when it exists). Inline in the spec, not the testkit: the
 *  sink-scan fitness specs (remote-refusal, remote-purge) inventory every non-spec `delete from` in src/. */
const clearShareRows = async (pg: postgres.Sql): Promise<void> => {
  const exp = await pg<{ present: boolean }[]>`select to_regclass('ccc_share_expiry') is not null as present`;
  if (exp[0]?.present) await pg`delete from ccc_share_expiry`;
  await pg`delete from shares`;
  await pg`delete from pages`;
  await pg`delete from group_users`;
  await pg`delete from space_members`;
  await pg`delete from users`;
  await pg`delete from spaces`;
  await pg`delete from workspaces`;
};

const d = PG_URL ? describe : describe.skip;

describe('real-PG PdpShareRepo', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'pdp_share_repo_pg_spec';
const WS = uuid(100);
const WS_OTHER = uuid(101);
const SPACE_A = uuid(1); // the caller's space
const SPACE_B = uuid(2); // a space the PDP does not list for the caller
const SPACE_X = uuid(3); // a space in ANOTHER workspace (the PDP wrongly lists it: the workspace pin must hold)
const USER = uuid(900);
const CREATOR = uuid(901);

const decode = (cursor: string | null) =>
  cursor ? Object.fromEntries(new URLSearchParams(Buffer.from(cursor, 'base64url').toString('utf8'))) : null;

d('PdpShareRepo on real Postgres (#660, #335)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let repo: PdpShareRepo;
  let viewable: Set<string>;
  let userSpaces: string[];
  let filterCalls: string[][];
  let pageOutage: boolean;

  const page = (id: string, space: string, opts: { ws?: string; trashed?: boolean } = {}) =>
    pg`insert into pages (id, slug_id, title, space_id, workspace_id, creator_id, deleted_at)
       values (${id}, ${'s-' + id.slice(-4)}, ${'Page ' + id.slice(-4)}, ${space}, ${opts.ws ?? WS}, ${CREATOR},
               ${opts.trashed ? pg`now()` : null})`;
  /** A share; `createdAgo` in days before now(); `expiry`: absent = no row (default), 'never', or an interval. */
  const share = async (
    id: string,
    pageId: string,
    opts: { space?: string; ws?: string; updatedAt?: string; createdAgo?: number; expiry?: 'never' | string } = {},
  ) => {
    await pg`
      insert into shares (id, key, page_id, space_id, workspace_id, creator_id, created_at, updated_at)
      values (${id}, ${'k' + id.slice(-6)}, ${pageId}, ${opts.space ?? SPACE_A}, ${opts.ws ?? WS}, ${CREATOR},
              now() - make_interval(days => ${opts.createdAgo ?? 0}),
              ${opts.updatedAt ?? '2026-01-01T00:00:00Z'}::timestamptz)`;
    if (opts.expiry === 'never') await pg`insert into ccc_share_expiry (share_id, expires_at) values (${id}, null)`;
    else if (opts.expiry)
      await pg`insert into ccc_share_expiry (share_id, expires_at) values (${id}, now() + ${opts.expiry}::interval)`;
  };

  const list = (pagination: Record<string, unknown> = {}) => repo.getShares(USER, { limit: 20, ...pagination } as any);

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 4);
    await createShareTables(pg);
    db = mkReadModelDb(appPg);
    expect((await new ShareExpiryInstaller(db as any, 'remote').install()).created).toBe(true);

    // The platform, stubbed at the HTTP-client seam: lookup-resources (the caller's spaces) and filter-resources
    // (page view). An outage is what HttpAuthzClient returns on any failure: an empty set.
    const authz = {
      lookupResources: async () => userSpaces,
      filterResources: async (_s: unknown, permission: string, type: string, ids: string[]) => {
        expect([permission, type]).toEqual(['view', 'page']);
        filterCalls.push(ids);
        return pageOutage ? [] : ids.filter((id) => viewable.has(id));
      },
    } as any;
    repo = new PdpShareRepo(
      db as any,
      new PdpSpaceMemberRepo(db as any, {} as any, {} as any, {} as any, authz),
      new PdpPagePermissionRepo(db as any, {} as any, {} as any, authz),
    );
  });

  beforeEach(async () => {
    viewable = new Set();
    userSpaces = [SPACE_A];
    filterCalls = [];
    pageOutage = false;
    await pg`insert into workspaces (id, name) values (${WS}, 'W'), (${WS_OTHER}, 'Other')`;
    await pg`insert into spaces (id, name, slug, workspace_id) values
      (${SPACE_A}, 'Space A', 'space-a', ${WS}), (${SPACE_B}, 'Space B', 'space-b', ${WS}),
      (${SPACE_X}, 'Space X', 'space-x', ${WS_OTHER})`;
    await pg`insert into users (id, name, workspace_id) values (${USER}, 'Caller', ${WS}), (${CREATOR}, 'Ada', ${WS})`;
  });

  afterEach(async () => {
    await clearShareRows(pg);
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  describe('getShares (POST /api/shares) — filter-then-retrieve', () => {
    it('lists only shares of PDP-viewable live pages in the caller\'s PDP spaces and workspace', async () => {
      const open = uuid(10), restricted = uuid(11), trashed = uuid(12), otherSpace = uuid(13), foreign = uuid(14);
      const expired = uuid(15), never = uuid(16), renewed = uuid(17);
      await page(open, SPACE_A);
      await page(restricted, SPACE_A);
      await page(trashed, SPACE_A, { trashed: true });
      await page(otherSpace, SPACE_B);
      await page(foreign, SPACE_X, { ws: WS_OTHER });
      await page(expired, SPACE_A);
      await page(never, SPACE_A);
      await page(renewed, SPACE_A);
      await share(uuid(210), open, { updatedAt: '2026-01-01T00:00:08Z' });
      await share(uuid(211), restricted, { updatedAt: '2026-01-01T00:00:07Z' });
      await share(uuid(212), trashed, { updatedAt: '2026-01-01T00:00:06Z' });
      await share(uuid(213), otherSpace, { space: SPACE_B, updatedAt: '2026-01-01T00:00:05Z' });
      await share(uuid(214), foreign, { space: SPACE_X, ws: WS_OTHER, updatedAt: '2026-01-01T00:00:04Z' });
      await share(uuid(215), expired, { createdAgo: 91, updatedAt: '2026-01-01T00:00:03Z' });
      await share(uuid(216), never, { createdAgo: 1000, expiry: 'never', updatedAt: '2026-01-01T00:00:02Z' });
      await share(uuid(217), renewed, { createdAgo: 400, expiry: '30 days', updatedAt: '2026-01-01T00:00:01Z' });
      // The PDP would let the caller see every page but the restricted one — and wrongly lists the foreign space.
      viewable = new Set([open, trashed, otherSpace, foreign, expired, never, renewed]);
      userSpaces = [SPACE_A, SPACE_X];

      const res = await list();
      expect(res.items.map((s) => s.id)).toEqual([uuid(210), uuid(216), uuid(217)]);
      expect(res.meta).toEqual({ limit: 20, hasNextPage: false, hasPrevPage: false, nextCursor: null, prevCursor: null });
      // The PDP was asked only about candidates that survived the SQL filters (no trashed/expired/foreign/other-space).
      expect(filterCalls.flat().sort()).toEqual([open, restricted, never, renewed].sort());
    });

    it('a PDP deny is filtered BEFORE pagination: full pages, and meta/cursors only from authorized rows', async () => {
      // 12 shares, newest first r0…r11; only r2, r5, r9, r11 are on viewable pages.
      const ids = Array.from({ length: 12 }, (_, i) => i);
      for (const i of ids) {
        await page(uuid(300 + i), SPACE_A);
        await share(uuid(400 + i), uuid(300 + i), { updatedAt: `2026-01-01T00:00:${String(59 - i).padStart(2, '0')}Z` });
      }
      viewable = new Set([2, 5, 9, 11].map((i) => uuid(300 + i)));

      const first = await list({ limit: 2 });
      expect(first.items.map((s) => s.id)).toEqual([uuid(402), uuid(405)]);
      expect(first.meta).toMatchObject({ limit: 2, hasNextPage: true, hasPrevPage: false });
      expect(decode(first.meta.nextCursor)).toEqual({ updatedAt: '2026-01-01T00:00:54.000Z', id: uuid(405) });

      const second = await list({ limit: 2, cursor: first.meta.nextCursor });
      expect(second.items.map((s) => s.id)).toEqual([uuid(409), uuid(411)]);
      expect(second.meta).toMatchObject({ hasNextPage: false, hasPrevPage: true, nextCursor: null });
      expect(decode(second.meta.prevCursor)).toEqual({ updatedAt: '2026-01-01T00:00:50.000Z', id: uuid(409) });

      // Backwards from the second page returns the first page's rows (upstream's beforeCursor contract).
      const back = await list({ limit: 2, beforeCursor: second.meta.prevCursor });
      expect(back.items.map((s) => s.id)).toEqual([uuid(402), uuid(405)]);
    });

    it('the cursor is stable across many windows, same-millisecond rows included (no skip, no duplicate)', async () => {
      // 3 windows' worth of shares, all with the SAME updated_at (microseconds differ); every third is viewable.
      const n = LABEL_SCAN.PAGE_WINDOW * 3;
      await pg`
        insert into pages (id, slug_id, title, space_id, workspace_id, creator_id)
        select ('00000000-0000-4000-8000-' || lpad((1000 + g)::text, 12, '0'))::uuid, 'b' || g, 'b' || g,
               ${SPACE_A}, ${WS}, ${CREATOR}
          from generate_series(0, ${n - 1}::int) g`;
      await pg`
        insert into shares (id, key, page_id, space_id, workspace_id, creator_id, updated_at)
        select ('00000000-0000-4000-8000-' || lpad((5000 + g)::text, 12, '0'))::uuid, 'key' || g,
               ('00000000-0000-4000-8000-' || lpad((1000 + g)::text, 12, '0'))::uuid, ${SPACE_A}, ${WS}, ${CREATOR},
               '2026-01-01T00:00:00.123Z'::timestamptz + make_interval(secs => (g % 7) * 0.000001)
          from generate_series(0, ${n - 1}::int) g`;
      const expected: string[] = [];
      for (let g = 0; g < n; g++) if (g % 3 === 0) {
        viewable.add(uuid(1000 + g));
        expected.push(uuid(5000 + g));
      }
      expected.sort().reverse(); // same millisecond ⇒ id desc

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const res = await list({ limit: 25, cursor });
        seen.push(...res.items.map((s) => s.id));
        for (const s of res.items) expect(viewable.has(s.pageId)).toBe(true);
        if (!res.meta.hasNextPage) break;
        cursor = res.meta.nextCursor as string;
      }
      expect(seen).toEqual(expected);
    });

    it('PDP outage (empty space set or empty page allow-set) ⇒ the canonical empty result, never the mirror', async () => {
      await page(uuid(10), SPACE_A);
      await share(uuid(210), uuid(10));
      viewable = new Set([uuid(10)]);
      await pg`insert into space_members (user_id, space_id, role) values (${USER}, ${SPACE_A}, 'admin')`;
      expect((await list()).items).toHaveLength(1);

      userSpaces = [];
      expect(await list({ cursor: 'eA' })).toEqual(emptyCursorPaginationResult(20));
      userSpaces = [SPACE_A];
      pageOutage = true;
      expect(await list()).toEqual(emptyCursorPaginationResult(20));
    });

    it('keeps upstream\'s item shape byte for byte (parity with the stock repo when everything is viewable)', async () => {
      await page(uuid(10), SPACE_A);
      await page(uuid(11), SPACE_A);
      await share(uuid(210), uuid(10), { updatedAt: '2026-01-01T00:00:02Z' });
      await share(uuid(211), uuid(11), { updatedAt: '2026-01-01T00:00:01Z' });
      await pg`insert into space_members (user_id, space_id, role) values (${USER}, ${SPACE_A}, 'writer')`;
      viewable = new Set([uuid(10), uuid(11)]);
      const stock = new ShareRepo(db as any, {
        getUserSpaceIdsQuery: () => db.selectFrom('spaces').select('spaces.id').where('spaces.id', 'in', userSpaces),
      } as any);
      const ours = await list();
      expect(ours).toEqual(await stock.getShares(USER, { limit: 20 } as any));
      expect(ours.items[0]).toMatchObject({
        page: { id: uuid(10), title: 'Page 0010' },
        space: { id: SPACE_A, userRole: 'writer' }, // the mirror role: UX only, kept
        creator: { id: CREATOR, name: 'Ada' },
      });
    });
  });

  describe('expiry at READ time (no sweeper runs in this spec)', () => {
    beforeEach(async () => {
      await page(uuid(10), SPACE_A);
    });

    it.each([
      ['default, created 89 days ago', { createdAgo: 89 }, true],
      ['default, created 91 days ago', { createdAgo: 91 }, false],
      ['explicit Never on a 1000-day-old share', { createdAgo: 1000, expiry: 'never' }, true],
      ['explicit future (a renewal) on a 400-day-old share', { createdAgo: 400, expiry: '1 hour' }, true],
      ['explicit past, though created today', { createdAgo: 0, expiry: '-1 second' }, false],
    ] as const)('%s → live=%p on findById (uuid and key), findByPageId and the list', async (_n, opts, live) => {
      const id = uuid(210);
      await share(id, uuid(10), opts as any);
      viewable = new Set([uuid(10)]);
      expect((await repo.findById(id))?.id).toBe(live ? id : undefined);
      expect((await repo.findById('k' + id.slice(-6)))?.id).toBe(live ? id : undefined);
      expect((await repo.findById(id, { includeCreator: true, includeSharedPage: true }))?.id).toBe(
        live ? id : undefined,
      );
      expect((await repo.findByPageId(uuid(10)))?.id).toBe(live ? id : undefined);
      expect((await list()).items.map((s) => s.id)).toEqual(live ? [id] : []);
      // Nothing was cleaned up behind the reads: the dead row is still there, refused anyway.
      expect((await pg`select 1 from shares where id = ${id}`).length).toBe(1);
    });

    it('the exact boundary instant is already expired; one microsecond later is live (the database clock)', async () => {
      const id = uuid(210);
      await share(id, uuid(10));
      await db.transaction().execute(async (trx) => {
        // now() is fixed for the transaction, so "expires_at = now()" is the exact boundary.
        await sql`insert into ccc_share_expiry (share_id, expires_at) values (${id}, now())`.execute(trx);
        expect(await repo.findById(id, { trx: trx as any })).toBeUndefined();
        await sql`update ccc_share_expiry set expires_at = now() + interval '1 microsecond' where share_id = ${id}`.execute(trx);
        expect((await repo.findById(id, { trx: trx as any }))?.id).toBe(id);
        throw Object.assign(new Error('rollback'), { rollback: true });
      }).catch((e) => {
        if (!e.rollback) throw e;
      });
    });

    it('findByPageId skips a dead row and returns the page\'s live share', async () => {
      await share(uuid(210), uuid(10), { createdAgo: 200 }); // expired by default
      await share(uuid(211), uuid(10), { createdAgo: 1 });
      expect((await repo.findByPageId(uuid(10)))?.id).toBe(uuid(211));
      expect(((await repo.findByPageId(uuid(10), { includeCreator: true })) as any)?.creator).toMatchObject({ id: CREATOR });
    });

    it('fails CLOSED: an error evaluating expiry throws — never returns the share', async () => {
      const id = uuid(210);
      await share(id, uuid(10), { expiry: 'never' });
      viewable = new Set([uuid(10)]);
      expect((await repo.findById(id))?.id).toBe(id);
      await pg`alter table ccc_share_expiry rename to ccc_share_expiry_gone`;
      try {
        await expect(repo.findById(id)).rejects.toThrow(/ccc_share_expiry/);
        await expect(repo.findByPageId(uuid(10))).rejects.toThrow(/ccc_share_expiry/);
        await expect(list()).rejects.toThrow(/ccc_share_expiry/);
        await expect(
          repo.insertShare({ key: 'fresh', pageId: uuid(10), spaceId: SPACE_A, workspaceId: WS, creatorId: CREATOR }),
        ).rejects.toThrow(/ccc_share_expiry/);
      } finally {
        await pg`alter table ccc_share_expiry_gone rename to ccc_share_expiry`;
      }
      expect((await pg`select 1 from shares where key = 'fresh'`).length).toBe(0); // the failed insert wrote nothing
    });
  });

  describe('insertShare — a re-share after expiry is a fresh share, never the dead row or a duplicate', () => {
    beforeEach(async () => {
      await page(uuid(10), SPACE_A);
      await page(uuid(11), SPACE_A);
    });

    it('deletes the page\'s expired rows (and their expiry rows) in the insert\'s transaction; leaves live ones', async () => {
      await share(uuid(210), uuid(10), { createdAgo: 200 }); // dead by default
      await share(uuid(211), uuid(10), { expiry: '-1 minute' }); // dead explicitly
      await share(uuid(212), uuid(11), { createdAgo: 200 }); // dead, but another page's: not this insert's business
      // The createShare flow: no live share for the page → insert.
      expect(await repo.findByPageId(uuid(10))).toBeUndefined();
      const fresh = await repo.insertShare({
        key: 'freshkey', pageId: uuid(10), spaceId: SPACE_A, workspaceId: WS, creatorId: CREATOR,
      });
      expect(fresh.id).not.toBe(uuid(210));
      const rows = await pg`select id from shares where page_id = ${uuid(10)}`;
      expect(rows.map((r) => r.id)).toEqual([fresh.id]);
      expect((await pg`select 1 from ccc_share_expiry where share_id in (${uuid(210)}, ${uuid(211)})`).length).toBe(0);
      expect((await pg`select 1 from shares where id = ${uuid(212)}`).length).toBe(1);
      expect((await repo.findByPageId(uuid(10)))?.id).toBe(fresh.id);
      expect((await repo.findById(fresh.id))?.id).toBe(fresh.id); // the fresh share's default is created_at + 90d
    });

    it('a LIVE share of the page is never deleted by the insert', async () => {
      await share(uuid(210), uuid(10), { createdAgo: 1 });
      await repo.insertShare({ key: 'second', pageId: uuid(10), spaceId: SPACE_A, workspaceId: WS, creatorId: CREATOR });
      expect((await pg`select 1 from shares where id = ${uuid(210)}`).length).toBe(1);
    });

    it('cleanup and insert are ONE transaction: the caller\'s rollback restores the dead row', async () => {
      await share(uuid(210), uuid(10), { createdAgo: 200 });
      await db.transaction().execute(async (trx) => {
        await repo.insertShare({ key: 'rolled', pageId: uuid(10), spaceId: SPACE_A, workspaceId: WS, creatorId: CREATOR }, trx as any);
        throw Object.assign(new Error('rollback'), { rollback: true });
      }).catch((e) => {
        if (!e.rollback) throw e;
      });
      expect((await pg`select id from shares where page_id = ${uuid(10)}`).map((r) => r.id)).toEqual([uuid(210)]);
    });
  });
});
