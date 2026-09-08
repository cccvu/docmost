import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { NotFoundException } from '@nestjs/common';
import { ServiceContentService } from './service-content.service';
import {
  PG_URL,
  uuid,
  fakeWorkspaceResolver,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
} from './read-model-pg.testkit';

/**
 * Real-Postgres proof of the `/v1` filter-then-retrieve read model (issue #174 remainder, items 1 + 2). The
 * unit spec (`service-content.service.spec.ts`) only string-matches the compiled SQL via the Kysely spy, so
 * two correctness properties it CANNOT prove are pinned here on the engine:
 *
 *  - F1, the keyset ordering: `date_trunc('milliseconds', updated_at)` is applied symmetrically in the WHERE
 *    tuple AND the ORDER BY, with an `id::text` tiebreak, so rows sharing a truncated millisecond page
 *    without duplicate or skip regardless of their sub-millisecond `updated_at` (the issue-122 class). A row
 *    whose RAW timestamp is LATER but truncates to the same millisecond sorts purely by `id::text` and lands
 *    on the correct page.
 *  - F2, the confidentiality invariant: this is a privileged DATA plane that trusts the platform's authorized
 *    id set, so its ONLY tenant/liveness guards are `workspace_id = <default>` and `deleted_at is null`. A
 *    supplied id that is out-of-workspace or soft-deleted MUST still be excluded by the ENGINE, not merely
 *    named in the SQL text.
 *
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG content read-model gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'service_content_pg_spec';
const DEFAULT_WS = uuid(100);
const FOREIGN_WS = uuid(200);
const SPACE = uuid(50);
const SPACE_B = uuid(51);

d('ServiceContentService on real Postgres (keyset ordering + confidentiality)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: ServiceContentService;

  // `micros` is added as a SQL interval, NOT baked into the ISO string: postgres.js coerces a bound ISO
  // string to a millisecond-precision Date before sending (dropping sub-ms), so sub-millisecond fixtures
  // MUST be constructed in SQL. This is what lets the keyset test carry two rows that share a truncated
  // millisecond but differ in raw sub-ms precision.
  const insertPage = (
    id: string,
    baseIso: string,
    opts: { workspaceId?: string; spaceId?: string; deleted?: boolean; title?: string | null; micros?: number } = {},
  ) => {
    const ts = pg`(${baseIso}::timestamptz + (${opts.micros ?? 0} * interval '1 microsecond'))`;
    // `title: null` is explicit (for the coalesce-null sort fixtures); undefined → a generated default.
    const title = opts.title === undefined ? 'page ' + id.slice(-3) : opts.title;
    return pg`
      insert into pages (id, slug_id, title, icon, position, space_id, parent_page_id, workspace_id, created_at, updated_at, deleted_at)
      values (${id}, ${'slug-' + id.slice(-3)}, ${title}, null, null,
              ${opts.spaceId ?? SPACE}, null, ${opts.workspaceId ?? DEFAULT_WS},
              ${ts}, ${ts}, ${opts.deleted ? pg`now()` : null})`;
  };

  // Same sub-millisecond fixture discipline as insertPage (postgres.js drops sub-ms from a bound ISO string).
  const insertSpace = (
    id: string,
    baseIso: string,
    opts: { workspaceId?: string; deleted?: boolean; micros?: number } = {},
  ) => {
    const ts = pg`(${baseIso}::timestamptz + (${opts.micros ?? 0} * interval '1 microsecond'))`;
    return pg`
      insert into spaces (id, name, slug, description, visibility, is_personal, workspace_id, created_at, updated_at, deleted_at)
      values (${id}, ${'space ' + id.slice(-3)}, ${'sslug-' + id.slice(-3)}, ${'desc ' + id.slice(-3)},
              'private', false, ${opts.workspaceId ?? DEFAULT_WS},
              ${ts}, ${ts}, ${opts.deleted ? pg`now()` : null})`;
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
    svc = new ServiceContentService(db as any, fakeWorkspaceResolver(DEFAULT_WS));

    // ---- F1 keyset fixtures: three pages, two of which share a truncated millisecond. ----
    // P1 (uuid 1): the SMALLER id::text, but the LATER raw sub-ms timestamp (.000900).
    // P2 (uuid 2): the LARGER id::text, the EARLIER raw sub-ms timestamp (.000100). Same truncated ms as P1.
    // P3 (uuid 3): one full second later, a clean ms boundary above the tie.
    await insertPage(uuid(1), '2026-01-01T00:00:00Z', { title: 'tie-lo', micros: 900 });
    await insertPage(uuid(2), '2026-01-01T00:00:00Z', { title: 'tie-hi', micros: 100 });
    await insertPage(uuid(3), '2026-01-01T00:00:01Z', { title: 'later', micros: 0 });

    // ---- F2 content-confidentiality fixtures (ids supplied but must be excluded). ----
    await insertPage(uuid(10), '2026-02-01T00:00:00.000Z', { workspaceId: FOREIGN_WS }); // wrong tenant
    await insertPage(uuid(11), '2026-02-01T00:00:00.000Z', { deleted: true }); // soft-deleted
    await insertPage(uuid(12), '2026-02-01T00:00:00.000Z'); // visible

    await insertSpace(uuid(60), '2026-02-01T00:00:00.000Z', { workspaceId: FOREIGN_WS }); // wrong tenant
    await insertSpace(uuid(61), '2026-02-01T00:00:00.000Z', { deleted: true }); // soft-deleted
    await insertSpace(uuid(62), '2026-02-01T00:00:00.000Z'); // visible

    // page_access grants for uuid(12): one in the default workspace (returned), one cross-tenant (excluded).
    await pg`insert into page_access (id, page_id, workspace_id) values (${uuid(70)}, ${uuid(12)}, ${DEFAULT_WS})`;
    await pg`insert into page_access (id, page_id, workspace_id) values (${uuid(71)}, ${uuid(12)}, ${FOREIGN_WS})`;
    await pg`insert into page_permissions (id, page_access_id, user_id, group_id, role) values (${uuid(72)}, ${uuid(70)}, ${uuid(80)}, null, 'reader')`;
    await pg`insert into page_permissions (id, page_access_id, user_id, group_id, role) values (${uuid(73)}, ${uuid(71)}, ${uuid(81)}, null, 'writer')`;

    // spaceId-narrowing fixture: a page in a DIFFERENT space (same tenant, live), supplied in ids but excluded
    // by the pages-only `space_id = <dto.spaceId>` filter.
    await insertPage(uuid(4), '2026-03-01T00:00:00Z', { spaceId: SPACE_B });

    // spaces keyset-tie fixtures, mirroring the pages fixtures so listSpacesByIds is tie/paging-proven too:
    // uuid(63) smaller id::text but later raw sub-ms; uuid(64) larger id::text, earlier raw sub-ms (same
    // truncated ms); uuid(65) one full second later.
    await insertSpace(uuid(63), '2026-04-01T00:00:00Z', { micros: 900 });
    await insertSpace(uuid(64), '2026-04-01T00:00:00Z', { micros: 100 });
    await insertSpace(uuid(65), '2026-04-01T00:00:01Z', { micros: 0 });

    // ---- sort-pushdown fixtures (C12): title sort must coalesce a null title and id-tiebreak duplicates.
    // All share one updated_at so the DEFAULT sort is a pure id::text tiebreak, isolating the title-sort effect.
    await insertPage(uuid(90), '2026-05-01T00:00:00Z', { title: null });
    await insertPage(uuid(91), '2026-05-01T00:00:00Z', { title: 'apple' });
    await insertPage(uuid(92), '2026-05-01T00:00:00Z', { title: 'banana' });
    await insertPage(uuid(93), '2026-05-01T00:00:00Z', { title: 'banana' });
    await insertPage(uuid(94), '2026-05-01T00:00:00Z', { title: 'cherry' });
  });

  afterAll(async () => {
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
    await appPg?.end?.({ timeout: 5 });
  });

  // ---- F1: keyset ordering + millisecond truncation ----
  describe('keyset read model (millisecond truncation, issue-122 class)', () => {
    const ids = [uuid(1), uuid(2), uuid(3)];

    it('orders by truncated-ms desc then id::text desc, so a later-raw same-ms row sorts purely by id::text', async () => {
      const page = await svc.listPagesByIds({ ids, limit: 10 } as any);
      // P3 (clean +1s) first; then the TIE at .000 resolves by id::text desc: uuid(2) before uuid(1) even
      // though uuid(1)'s raw timestamp (.000900) is LATER than uuid(2)'s (.000100). Only ms-truncation in the
      // ORDER BY makes this hold; ordering by raw updated_at would put uuid(1) ahead of uuid(2).
      expect(page.items.map((p) => p.id)).toEqual([uuid(3), uuid(2), uuid(1)]);
      // The over-the-wire timestamp is millisecond precision (both tie rows collapse to the same instant).
      expect(page.items[1].updatedAt).toBe(page.items[2].updatedAt);
    });

    it('pages across the shared-millisecond boundary with no duplicate and no skip (limit+1 hasMore probe)', async () => {
      const first = await svc.listPagesByIds({ ids, limit: 2 } as any);
      // limit+1: three candidates come back so the platform can detect hasMore.
      expect(first.items).toHaveLength(3);
      const taken = first.items.slice(0, 2);
      expect(taken.map((p) => p.id)).toEqual([uuid(3), uuid(2)]);

      // Build the next cursor exactly as the platform does: from the last KEPT row's returned (ms) timestamp.
      const cursor = { updatedAt: taken[1].updatedAt, id: taken[1].id };
      const second = await svc.listPagesByIds({ ids, limit: 2, before: cursor } as any);

      // uuid(1) shares uuid(2)'s truncated ms but has a smaller id::text, so it belongs on page 2: it must
      // NOT be skipped (the regression a raw-timestamp comparison would introduce) and uuid(2)/uuid(3) must
      // NOT reappear (no duplicate).
      expect(second.items.map((p) => p.id)).toEqual([uuid(1)]);
      const seen = [...taken, ...second.items].map((p) => p.id);
      expect(new Set(seen).size).toBe(seen.length); // no id observed twice across the two pages
    });

    it('listPagesByIds narrows to dto.spaceId, excluding an out-of-space id even when it is supplied', async () => {
      // uuid(1) is in SPACE, uuid(4) is in SPACE_B; both are supplied, both pass the tenant/liveness guards,
      // so ONLY the `space_id = ${dto.spaceId}` filter keeps uuid(4) out. Dropping that filter reddens this.
      const res = await svc.listPagesByIds({ ids: [uuid(1), uuid(4)], spaceId: SPACE, limit: 100 } as any);
      expect(res.items.map((p) => p.id)).toEqual([uuid(1)]);
    });

    it('listSpacesByIds applies the same truncated-ms ordering and cross-boundary paging as pages', async () => {
      const sids = [uuid(63), uuid(64), uuid(65)];
      const first = await svc.listSpacesByIds({ ids: sids, limit: 2 } as any);
      expect(first.items).toHaveLength(3); // limit+1
      const taken = first.items.slice(0, 2);
      // uuid(65) (+1s) first; the tie at .000 resolves by id::text desc: uuid(64) before uuid(63).
      expect(taken.map((s) => s.id)).toEqual([uuid(65), uuid(64)]);

      const cursor = { updatedAt: taken[1].updatedAt, id: taken[1].id };
      const second = await svc.listSpacesByIds({ ids: sids, limit: 2, before: cursor } as any);
      // uuid(63) shares uuid(64)'s truncated ms but a smaller id::text, so it belongs on page 2 (no skip);
      // uuid(64)/uuid(65) do not reappear (no duplicate).
      expect(second.items.map((s) => s.id)).toEqual([uuid(63)]);
      const seen = [...taken, ...second.items].map((s) => s.id);
      expect(new Set(seen).size).toBe(seen.length);
    });
  });

  // ---- C12: generalized sort keyset (title / createdAt) + filter pushdown, executed on the engine ----
  describe('sort pushdown keyset (title / createdAt) walks with no skip or duplicate', () => {
    const titleIds = [uuid(90), uuid(91), uuid(92), uuid(93), uuid(94)];

    it('title asc coalesces a null title to first and tiebreaks duplicate titles by id::text', async () => {
      const res = await svc.listPagesByIds({
        ids: titleIds,
        sort: { field: 'title', direction: 'asc' },
        limit: 100,
      } as any);
      // '' (null-coalesced) < apple < banana < banana (id tiebreak 92 before 93) < cherry.
      expect(res.items.map((p) => p.id)).toEqual([uuid(90), uuid(91), uuid(92), uuid(93), uuid(94)]);
    });

    it('title asc pages across the duplicate-title boundary with no skip and no duplicate', async () => {
      const sort = { field: 'title' as const, direction: 'asc' as const };
      const seen: string[] = [];
      // Walk the whole set two at a time, building the cursor exactly as the platform will: value = title ?? ''.
      let cursor: { value: string; id: string } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await svc.listPagesByIds({ ids: titleIds, sort, limit: 2, before: cursor } as any);
        const kept = page.items.slice(0, 2);
        seen.push(...kept.map((p) => p.id));
        if (page.items.length <= 2) break; // no limit+1 overflow → this was the last page
        const last = kept[kept.length - 1];
        cursor = { value: last.title ?? '', id: last.id };
      }
      expect(seen).toEqual([uuid(90), uuid(91), uuid(92), uuid(93), uuid(94)]); // in order, once each
      expect(new Set(seen).size).toBe(seen.length); // no id observed twice across pages
    });

    it('createdAt desc orders by created_at (ms-truncated, id-tiebroken)', async () => {
      const res = await svc.listPagesByIds({
        ids: [uuid(1), uuid(2), uuid(3)],
        sort: { field: 'createdAt', direction: 'desc' },
        limit: 100,
      } as any);
      // created_at == updated_at in these fixtures, so the same [+1s first, then id-tiebreak on the tie] order.
      expect(res.items.map((p) => p.id)).toEqual([uuid(3), uuid(2), uuid(1)]);
    });

    it('a page filter (titleContains) narrows the set on the engine (ilike substring)', async () => {
      const res = await svc.listPagesByIds({ ids: titleIds, titleContains: 'ban', limit: 100 } as any);
      expect(res.items.map((p) => p.id).sort()).toEqual([uuid(92), uuid(93)]);
    });
  });

  // ---- F2: confidentiality invariant, executed on the engine ----
  describe('confidentiality (supplied ids that are out-of-tenant or soft-deleted are excluded)', () => {
    it('listPagesByIds excludes a cross-workspace and a soft-deleted id even when both are supplied', async () => {
      const res = await svc.listPagesByIds({ ids: [uuid(10), uuid(11), uuid(12)], limit: 100 } as any);
      expect(res.items.map((p) => p.id)).toEqual([uuid(12)]);
    });

    it('listSpacesByIds excludes a cross-workspace and a soft-deleted id even when both are supplied', async () => {
      const res = await svc.listSpacesByIds({ ids: [uuid(60), uuid(61), uuid(62)], limit: 100 } as any);
      expect(res.items.map((s) => s.id)).toEqual([uuid(62)]);
    });

    it('getSpace returns the visible space and 404s the cross-workspace and soft-deleted ones', async () => {
      await expect(svc.getSpace(uuid(62))).resolves.toMatchObject({ id: uuid(62) });
      await expect(svc.getSpace(uuid(60))).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.getSpace(uuid(61))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('resolvePageSpace 404s a cross-workspace or soft-deleted page, and includeDeleted lifts only the soft-delete guard', async () => {
      await expect(svc.resolvePageSpace({ pageId: uuid(12) } as any)).resolves.toEqual({ pageId: uuid(12), spaceId: SPACE });
      await expect(svc.resolvePageSpace({ pageId: uuid(10) } as any)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.resolvePageSpace({ pageId: uuid(11) } as any)).rejects.toBeInstanceOf(NotFoundException);
      // includeDeleted resolves the soft-deleted page's space, but the workspace guard still 404s a foreign page.
      await expect(svc.resolvePageSpace({ pageId: uuid(11), includeDeleted: true } as any)).resolves.toEqual({
        pageId: uuid(11),
        spaceId: SPACE,
      });
      await expect(svc.resolvePageSpace({ pageId: uuid(10), includeDeleted: true } as any)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listPagePermissions returns only same-workspace grants (a cross-workspace page_access on the same page id is excluded)', async () => {
      const res = await svc.listPagePermissions(uuid(12));
      expect(res.items.map((r) => r.id)).toEqual([uuid(72)]);
      expect(res.items[0]).toMatchObject({ userId: uuid(80), role: 'reader' });
    });
  });
});
