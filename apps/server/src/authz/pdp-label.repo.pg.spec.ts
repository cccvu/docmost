import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { LabelRepo, LabelType } from '@docmost/db/repos/label/label.repo';
import { emptyCursorPaginationResult } from '@docmost/db/pagination/cursor-pagination';
import { PdpLabelRepo } from './pdp-label.repo';
import { PdpPagePermissionRepo } from './pdp-page-permission.repo';
import { PdpSpaceMemberRepo } from './pdp-space-member.repo';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
} from '../service-bridge/read-model-pg.testkit';

/**
 * CCC authorization integration test — NOT upstream Docmost code.
 *
 * Real-Postgres proof of the native label lists in remote mode (#615): `POST /api/labels` (the vocabulary / label
 * picker) and `POST /api/labels/pages` go through `PdpLabelRepo`, wired exactly as `labelRepoProvider` wires it
 * (the real `PdpSpaceMemberRepo` + `PdpPagePermissionRepo` over a stubbed platform). What a unit test cannot show
 * is proven here: the candidate SQL (live pages, the PDP space set, the label rounds read deeper only for a label
 * whose first pages are all hidden), the meta computed over authorized rows, the upstream `{ items, meta }` shape
 * byte for byte (parity with the stock repo when everything is viewable), and a same-millisecond keyset edge.
 * Lives in the `docmost-authz-pg` CI lane; self-skips without AUTHZ_TEST_PG_URL.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG label lists', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'pdp_label_repo_pg_spec';
const WS = uuid(100);
const SPACE_A = uuid(1); // the caller's space
const SPACE_B = uuid(2); // a space the caller cannot view
const USER = uuid(900);
const CREATOR = uuid(901);

// Pages (ids order the label rounds' page cursor: uuid(n) sorts by n).
const P_OPEN = uuid(10);
const P_RESTRICTED = uuid(11);
const P_OPEN_2 = uuid(12);
const P_TRASHED = uuid(13);
const P_OTHER_SPACE = uuid(14);

// Labels (ids order the (name, id) keyset only as a tiebreak; names are unique per workspace+type).
const L_ALPHA = uuid(50); // on an open page AND a restricted page
const L_SECRET = uuid(51); // ONLY on a restricted page — the leak this fixes
const L_BETA = uuid(52);
const L_GAMMA = uuid(53); // on two open pages
const L_BIN = uuid(54); // only on a trashed (open) page
const L_ELSEWHERE = uuid(55); // only on a page in a space the caller cannot view

const decode = (cursor: string | null) =>
  cursor ? Object.fromEntries(new URLSearchParams(Buffer.from(cursor, 'base64url').toString('utf8'))) : null;

d('PdpLabelRepo on real Postgres (#615)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let repo: PdpLabelRepo;
  let viewable: Set<string>;
  let userSpaces: string[];
  let filterCalls: string[][];

  const page = (id: string, space: string, updatedAt: string, opts: { trashed?: boolean } = {}) =>
    pg`insert into pages (id, slug_id, title, space_id, workspace_id, creator_id, created_at, updated_at, deleted_at)
       values (${id}, ${'s-' + id.slice(-4)}, ${'Page ' + id.slice(-4)}, ${space}, ${WS}, ${CREATOR},
               ${updatedAt}::timestamptz, ${updatedAt}::timestamptz, ${opts.trashed ? pg`now()` : null})`;
  const label = (id: string, name: string) =>
    pg`insert into labels (id, name, type, workspace_id) values (${id}, ${name}, 'page', ${WS})`;
  const tag = (pageId: string, labelId: string) =>
    pg`insert into page_labels (page_id, label_id) values (${pageId}, ${labelId})`;

  // The stock repo, reading the caller's spaces from a membership subquery that yields exactly the PDP set.
  const stock = () =>
    new LabelRepo(db as any, {
      getUserSpaceIdsQuery: () =>
        db.selectFrom('spaces').select('spaces.id').where('spaces.id', 'in', userSpaces),
    } as any);

  /** `count` live pages in the caller's space, ids uuid(first)…, all carrying `labelId`. */
  const taggedPages = async (labelId: string, first: number, count: number, updatedAt: string) => {
    await pg`
      insert into pages (id, slug_id, title, space_id, workspace_id, creator_id, updated_at)
      select ('00000000-0000-4000-8000-' || lpad((${first}::int + g)::text, 12, '0'))::uuid, 'b' || g, 'b' || g,
             ${SPACE_A}, ${WS}, ${CREATOR}, ${updatedAt}::timestamptz
        from generate_series(0, ${count - 1}::int) g`;
    await pg`
      insert into page_labels (page_id, label_id)
      select ('00000000-0000-4000-8000-' || lpad((${first}::int + g)::text, 12, '0'))::uuid, ${labelId}
        from generate_series(0, ${count - 1}::int) g`;
  };

  const listLabels = (pagination: Record<string, unknown>) =>
    repo.findLabels(WS, USER, LabelType.PAGE, { limit: 20, ...pagination } as any);
  const labelPages = (labelId: string, pagination: Record<string, unknown>, spaceId?: string) =>
    repo.findPagesByLabelId(labelId, USER, { spaceId, pagination: { limit: 20, ...pagination } as any });

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 4);
    await createReadModelTables(pg);
    // The label-side columns/tables these reads join (idempotent: a shared testkit may already add some).
    await pg`alter table pages add column if not exists creator_id uuid`;
    await pg`alter table spaces add column if not exists logo varchar`;
    await pg`
      create table if not exists users (
        id uuid primary key, name varchar, avatar_url varchar, workspace_id uuid
      )`;
    await pg`alter table users add column if not exists avatar_url varchar`;
    await pg`
      create table if not exists labels (
        id uuid primary key default gen_random_uuid(), name varchar not null,
        type varchar not null default 'page', workspace_id uuid not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        unique (workspace_id, type, name)
      )`;
    await pg`
      create table if not exists page_labels (
        id uuid primary key default gen_random_uuid(), page_id uuid not null, label_id uuid not null,
        created_at timestamptz not null default now(), unique (page_id, label_id)
      )`;
    db = mkReadModelDb(appPg);

    // The platform, stubbed at the HTTP-client seam: lookup-resources (the caller's spaces) and filter-resources
    // (page view). Everything above it is the real remote-mode wiring.
    const authz = {
      lookupResources: async () => userSpaces,
      filterResources: async (_s: unknown, permission: string, type: string, ids: string[]) => {
        expect([permission, type]).toEqual(['view', 'page']);
        filterCalls.push(ids);
        return ids.filter((id) => viewable.has(id));
      },
    } as any;
    repo = new PdpLabelRepo(
      db as any,
      new PdpSpaceMemberRepo(db as any, {} as any, {} as any, {} as any, authz),
      new PdpPagePermissionRepo(db as any, {} as any, {} as any, authz),
    );
  });

  beforeEach(async () => {
    viewable = new Set([P_OPEN, P_OPEN_2, P_TRASHED, P_OTHER_SPACE]); // P_RESTRICTED is hidden by the PDP
    userSpaces = [SPACE_A];
    filterCalls = [];
    await pg`insert into spaces (id, name, slug, logo, workspace_id) values
      (${SPACE_A}, 'Space A', 'space-a', null, ${WS}), (${SPACE_B}, 'Space B', 'space-b', null, ${WS})`;
    await pg`insert into users (id, name, avatar_url, workspace_id) values (${CREATOR}, 'Ada', null, ${WS})`;
    await page(P_OPEN, SPACE_A, '2026-01-01T00:00:01Z');
    await page(P_RESTRICTED, SPACE_A, '2026-01-01T00:00:02Z');
    await page(P_OPEN_2, SPACE_A, '2026-01-01T00:00:03Z');
    await page(P_TRASHED, SPACE_A, '2026-01-01T00:00:04Z', { trashed: true });
    await page(P_OTHER_SPACE, SPACE_B, '2026-01-01T00:00:05Z');
    await label(L_ALPHA, 'alpha');
    await label(L_SECRET, 'secret-merger');
    await label(L_BETA, 'beta');
    await label(L_GAMMA, 'gamma');
    await label(L_BIN, 'bin');
    await label(L_ELSEWHERE, 'elsewhere');
    await tag(P_OPEN, L_ALPHA);
    await tag(P_RESTRICTED, L_ALPHA);
    await tag(P_RESTRICTED, L_SECRET);
    await tag(P_OPEN_2, L_BETA);
    await tag(P_OPEN, L_GAMMA);
    await tag(P_OPEN_2, L_GAMMA);
    await tag(P_TRASHED, L_BIN);
    await tag(P_OTHER_SPACE, L_ELSEWHERE);
  });

  afterEach(async () => {
    await pg`delete from page_labels`;
    await pg`delete from labels`;
    await pg`delete from pages`;
    await pg`delete from users`;
    await pg`delete from spaces`;
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  describe('findLabels (POST /api/labels — the vocabulary / label picker)', () => {
    it('lists a label only when a LIVE page carrying it is PDP-viewable in one of the caller\'s spaces', async () => {
      const res = await listLabels({});
      expect(res.items.map((l) => l.name)).toEqual(['alpha', 'beta', 'gamma']);
      // Absent: only on a restricted page (secret-merger), only on a trashed page (bin), only in a space the
      // PDP does not list for the caller (elsewhere) — even though the PDP would say that page is viewable.
      expect(res.meta).toEqual({
        limit: 20,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      });
    });

    it('pages with meta computed over authorized labels; no cursor ever names a hidden label', async () => {
      const first = await listLabels({ limit: 1 });
      expect(first.items.map((l) => l.name)).toEqual(['alpha']);
      expect(first.meta).toMatchObject({ hasNextPage: true, hasPrevPage: false });
      expect(decode(first.meta.nextCursor)).toEqual({ name: 'alpha', id: L_ALPHA });

      const second = await listLabels({ limit: 1, cursor: first.meta.nextCursor });
      expect(second.items.map((l) => l.name)).toEqual(['beta']);
      const third = await listLabels({ limit: 1, cursor: second.meta.nextCursor });
      expect(third.items.map((l) => l.name)).toEqual(['gamma']);
      expect(third.meta).toMatchObject({ hasNextPage: false, nextCursor: null, hasPrevPage: true });
      expect(decode(third.meta.prevCursor)).toEqual({ name: 'gamma', id: L_GAMMA });
    });

    it('control (not vacuous): the stock repo, given the same spaces, lists the hidden-only label', async () => {
      const names = (await stock().findLabels(WS, USER, LabelType.PAGE, { limit: 20 } as any)).items.map(
        (l) => l.name,
      );
      expect(names).toEqual(['alpha', 'beta', 'gamma', 'secret-merger']);
    });

    it('the name query never surfaces a hidden label; a hidden-only match is the canonical empty result', async () => {
      expect((await listLabels({ query: 'ALP' })).items.map((l) => l.name)).toEqual(['alpha']);
      expect(await listLabels({ query: 'secret' })).toEqual(emptyCursorPaginationResult(20));
    });

    it('a label whose first candidate pages are all hidden is read further (round 2) and listed', async () => {
      const deep = uuid(60);
      await label(deep, 'deep');
      await taggedPages(deep, 3000, 151, '2026-01-02T00:00:00Z');
      viewable.add(uuid(3150)); // only its last candidate (highest id) is viewable
      const res = await listLabels({});
      expect(res.items.map((l) => l.name)).toEqual(['alpha', 'beta', 'deep', 'gamma']);
      // Round 1 splits ~512 candidates over the window's 5 labels (102 each) in ONE PDP call; round 2 reads only
      // the one label still undecided — the rest of deep's pages — in a second call.
      expect(filterCalls).toHaveLength(2);
      expect(filterCalls[0]).toHaveLength(3 + 102); // P_OPEN, P_RESTRICTED, P_OPEN_2 + deep's first 102
      expect(filterCalls[1]).toEqual(Array.from({ length: 49 }, (_, i) => uuid(3102 + i)));

      viewable.delete(uuid(3150));
      expect((await listLabels({})).items.map((l) => l.name)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('a label over the per-label cap of hidden candidates is left out alone (logged); later ones stay', async () => {
      const vault = uuid(61);
      const zulu = uuid(62);
      await label(vault, 'vault');
      await label(zulu, 'zulu');
      await taggedPages(vault, 4000, 701, '2026-03-01T00:00:00Z');
      viewable.add(uuid(4700)); // viewable, but past the cap of hidden candidates
      await pg`update pages set updated_at = '2026-02-28T00:00:00Z' where id = ${uuid(4700)}`;
      await tag(P_OPEN, zulu);
      const warn = jest.spyOn((repo as any).logger, 'warn').mockImplementation(() => undefined);
      try {
        const res = await listLabels({});
        expect(res.items.map((l) => l.name)).toEqual(['alpha', 'beta', 'gamma', 'zulu']);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('left out 1 label(s) after 512'));
        // The label's own page list still reaches the viewable page (its walk has its own budget).
        expect((await labelPages(vault, {})).items.map((p) => p.id)).toEqual([uuid(4700)]);
      } finally {
        warn.mockRestore();
      }
    });

    it('a PDP outage (no spaces, nothing viewable) lists nothing', async () => {
      userSpaces = [];
      expect(await listLabels({})).toEqual(emptyCursorPaginationResult(20));
      userSpaces = [SPACE_A];
      viewable = new Set();
      expect(await listLabels({})).toEqual(emptyCursorPaginationResult(20));
    });
  });

  describe('findPagesByLabelId (POST /api/labels/pages)', () => {
    it('returns only PDP-viewable live pages', async () => {
      const res = await labelPages(L_ALPHA, {});
      expect(res.items.map((p) => p.id)).toEqual([P_OPEN]);
      expect(res.meta).toMatchObject({ hasNextPage: false, nextCursor: null });
    });

    it('computes hasNextPage/cursors over viewable pages (updatedAt desc), never from a hidden one', async () => {
      await tag(P_OPEN_2, L_ALPHA);
      // alpha: P_OPEN_2 (t3), P_RESTRICTED (t2, hidden), P_OPEN (t1).
      const first = await labelPages(L_ALPHA, { limit: 1 });
      expect(first.items.map((p) => p.id)).toEqual([P_OPEN_2]);
      expect(first.meta.hasNextPage).toBe(true);
      expect(decode(first.meta.nextCursor)).toEqual({ updatedAt: '2026-01-01T00:00:03.000Z', id: P_OPEN_2 });
      const second = await labelPages(L_ALPHA, { limit: 1, cursor: first.meta.nextCursor });
      expect(second.items.map((p) => p.id)).toEqual([P_OPEN]);
      expect(second.meta).toMatchObject({ hasNextPage: false, nextCursor: null, hasPrevPage: true });
    });

    it('a label only on hidden pages is byte-identical to an unknown label, with or without a cursor', async () => {
      // The controller answers an unknown name with emptyCursorPaginationResult(limit); a hidden-only label must
      // not be distinguishable from it (upstream would say hasPrevPage=true when a cursor was sent).
      const cursor = Buffer.from(`updatedAt=2027-01-01T00:00:00.000Z&id=${uuid(1)}`).toString('base64url');
      expect(await labelPages(L_SECRET, {})).toEqual(emptyCursorPaginationResult(20));
      expect(await labelPages(L_SECRET, { cursor })).toEqual(emptyCursorPaginationResult(20));
    });

    it.each([1.5, null, 250])(
      'a hidden-only label echoes the raw limit (%p) like the unknown-name answer — no existence oracle',
      async (rawLimit) => {
        // The ValidationPipe admits 1.5 and null; the controller's unknown-name branch answers
        // emptyCursorPaginationResult(pagination.limit) with that raw value, so a clamped echo would tell them apart.
        const unknownName = emptyCursorPaginationResult(rawLimit as number);
        expect(await labelPages(L_SECRET, { limit: rawLimit })).toEqual(unknownName);
        userSpaces = []; // the no-space short-circuit answers the same way
        expect(await labelPages(L_SECRET, { limit: rawLimit })).toEqual(unknownName);
      },
    );

    it('honours a caller-named space (the controller authorized it) and still gates each page', async () => {
      expect((await labelPages(L_GAMMA, {}, SPACE_A)).items.map((p) => p.id)).toEqual([P_OPEN_2, P_OPEN]);
      expect((await labelPages(L_ALPHA, {}, SPACE_A)).items.map((p) => p.id)).toEqual([P_OPEN]);
      expect((await labelPages(L_GAMMA, {}, SPACE_B)).items).toEqual([]);
    });

    it('neither skips nor repeats same-millisecond pages across window and page edges', async () => {
      const many = uuid(70);
      await label(many, 'many');
      const n = 140; // > one 128-row candidate window
      await pg`
        insert into pages (id, slug_id, title, space_id, workspace_id, creator_id, updated_at)
        select ('00000000-0000-4000-8000-' || lpad((1000 + g)::text, 12, '0'))::uuid, 's' || g, 't' || g,
               ${SPACE_A}, ${WS}, ${CREATOR},
               '2026-02-01T00:00:00.123Z'::timestamptz + (g || ' microseconds')::interval
          from generate_series(0, ${n - 1}::int) g`;
      await pg`
        insert into page_labels (page_id, label_id)
        select id, ${many} from pages where updated_at >= '2026-02-01T00:00:00Z'`;
      const all = await pg<{ id: string }[]>`select id from pages where updated_at >= '2026-02-01T00:00:00Z'`;
      for (const r of all) viewable.add(r.id);

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await labelPages(many, { limit: 50, cursor });
        seen.push(...res.items.map((p) => p.id));
        if (!res.meta.hasNextPage) break;
        cursor = res.meta.nextCursor as string;
      }
      expect(seen).toHaveLength(n);
      expect(new Set(seen).size).toBe(n);

      // Control (not vacuous): upstream's raw `updated_at` keyset against a millisecond cursor skips most of them.
      const stockSeen: string[] = [];
      cursor = undefined;
      for (let i = 0; i < 10; i++) {
        const res = await stock().findPagesByLabelId(many, USER, { pagination: { limit: 50, cursor } as any });
        stockSeen.push(...res.items.map((p) => p.id));
        if (!res.meta.hasNextPage) break;
        cursor = res.meta.nextCursor as string;
      }
      expect(stockSeen.length).toBeLessThan(n);
    });
  });

  describe('byte-compatible with the stock repo when every candidate is viewable', () => {
    beforeEach(() => {
      viewable = new Set([P_OPEN, P_RESTRICTED, P_OPEN_2, P_TRASHED, P_OTHER_SPACE]);
      userSpaces = [SPACE_A, SPACE_B];
    });

    it('findLabels: same items, meta and cursors on every page', async () => {
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const pagination = { limit: 2, cursor } as any;
        const ours = await repo.findLabels(WS, USER, LabelType.PAGE, pagination);
        expect(ours).toEqual(await stock().findLabels(WS, USER, LabelType.PAGE, pagination));
        if (!ours.meta.hasNextPage) break;
        cursor = ours.meta.nextCursor as string;
      }
      expect(cursor).toBeDefined();
    });

    it('findPagesByLabelId: same items (space, creator, labels), meta and cursors on every page', async () => {
      await tag(P_RESTRICTED, L_GAMMA);
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const opts = { pagination: { limit: 1, cursor } as any };
        const ours = await repo.findPagesByLabelId(L_GAMMA, USER, opts);
        expect(ours).toEqual(await stock().findPagesByLabelId(L_GAMMA, USER, opts));
        expect(Object.keys(ours.items[0]).sort()).toEqual(
          ['createdAt', 'creator', 'icon', 'id', 'labels', 'slugId', 'space', 'spaceId', 'title', 'updatedAt'].sort(),
        );
        if (!ours.meta.hasNextPage) break;
        cursor = ours.meta.nextCursor as string;
      }
    });
  });

  describe('getLabelPageCountForUser (upstream /labels/info usage count)', () => {
    it('counts only viewable live pages in the caller\'s spaces', async () => {
      expect(await repo.getLabelPageCountForUser(L_ALPHA, USER)).toBe(1);
      expect(await repo.getLabelPageCountForUser(L_GAMMA, USER)).toBe(2);
      expect(await repo.getLabelPageCountForUser(L_SECRET, USER)).toBe(0);
      expect(await repo.getLabelPageCountForUser(L_BIN, USER)).toBe(0);
      expect(await repo.getLabelPageCountForUser(L_ELSEWHERE, USER)).toBe(0);
    });
  });
});
