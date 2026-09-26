import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ServiceContentService } from './service-content.service';
import {
  PG_URL,
  uuid,
  fakeWorkspaceResolver,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
  createKnowledgeTables,
} from './read-model-pg.testkit';

/**
 * Real-Postgres proof of the #615 knowledge reads on the service bridge: the new page-list filters (label, editor,
 * created range, top level, descendants, links), the position sort, the creator/editor projection, the ancestor
 * walk, the label list, the activity feed and the viewer-comment policy.
 *
 * Every one of these is a PRIVILEGED DATA PLANE over the platform's authorized id set, so the property that matters
 * most — and that a query spy cannot show — is that the ENGINE returns nothing outside `ids` + live + workspace:
 * a descendant walk never passes through an unauthorized or trashed page, a label only on pages outside `ids` is
 * never named and never counted, and an activity event on a page outside `ids` (or in another workspace) never
 * appears. Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG content knowledge-read gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'service_content_knowledge_pg_spec';
const WS = uuid(100);
const FOREIGN_WS = uuid(200);
const SPACE = uuid(50);
const SPACE_B = uuid(51);

// Users: two in the workspace, one in another workspace (its name must never be projected).
const ALICE = uuid(300);
const BOB = uuid(301);
const MALLORY = uuid(302);

// ---- Tree fixture (list filters, descendants, links, position sort, ancestors). ----
//   R ─┬─ A ── A1 ── A1X ── A1XY        (depth 1..4 below R)
//      ├─ B (NOT authorized) ── B1       (B1 is authorized, but only reachable through B)
//      ├─ T (trashed) ── T1              (T1 is live + authorized, but only reachable through T)
//      ├─ C, D (null positions), E ('Zz'), F (another workspace)
//   Z (top level, SPACE_B)   X ⇄ Y (a parent cycle)   G (dangling parent)
const R = uuid(1);
const A = uuid(2);
const A1 = uuid(3);
const A1X = uuid(4);
const A1XY = uuid(5);
const B = uuid(6);
const B1 = uuid(7);
const T = uuid(8);
const T1 = uuid(9);
const C = uuid(10);
const D = uuid(11);
const E = uuid(12);
const F = uuid(13);
const Z = uuid(14);
const X = uuid(20);
const Y = uuid(21);
const G = uuid(22);
const MISSING = uuid(999);

/** Every tree page the platform "authorized" — everything except B. Out-of-workspace F is supplied on purpose. */
const TREE_IDS = [R, A, A1, A1X, A1XY, B1, T, T1, C, D, E, F, Z, X, Y, G];

// ---- Activity fixture (its own pages, so the feed's expectations stay independent of the tree). ----
const PA = uuid(401); // live, authorized, created in the window
const PB = uuid(402); // live, NOT authorized
const PT = uuid(403); // trashed, authorized
const PC = uuid(404); // live, authorized, currently in SPACE_B
const PF = uuid(405); // another workspace, supplied
const ACTIVITY_IDS = [PA, PT, PC, PF];

const H1 = uuid(501);
const H_OLD = uuid(502);
const H4 = uuid(503);
const H5 = uuid(504);
const H_B = uuid(505);
const H_FOREIGN = uuid(506);
const C1 = uuid(511);
const C_DELETED = uuid(512);
const C_B = uuid(513);
const C4 = uuid(514);
const F1 = uuid(521);
const F_DELETED = uuid(522);
const F_NOPAGE = uuid(523);
const E1 = uuid(531);
const E2 = uuid(532);
const E_B = uuid(533);
const E_FOREIGN = uuid(534);
const E_UNLISTED = uuid(535);
const E_BAD_META = uuid(536);
const E_MISMATCH = uuid(537);
const E8 = uuid(538);

d('ServiceContentService #615 knowledge reads on real Postgres', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: ServiceContentService;

  /** `micros` is added in SQL: postgres.js drops sub-ms precision from a bound ISO string (see the content spec). */
  const at = (iso: string, micros = 0) => pg`(${iso}::timestamptz + (${micros} * interval '1 microsecond'))`;

  const page = (
    id: string,
    o: {
      parent?: string | null;
      ws?: string;
      space?: string;
      trashed?: boolean;
      title?: string;
      position?: string | null;
      creator?: string | null;
      editor?: string | null;
      created?: string;
    } = {},
  ) => pg`
    insert into pages (id, slug_id, title, icon, position, space_id, parent_page_id, workspace_id,
                       creator_id, last_updated_by_id, created_at, updated_at, deleted_at)
    values (${id}, ${'slug-' + id.slice(-3)}, ${o.title ?? 'page ' + id.slice(-3)}, null, ${o.position ?? null},
            ${o.space ?? SPACE}, ${o.parent ?? null}, ${o.ws ?? WS}, ${o.creator ?? null}, ${o.editor ?? null},
            ${o.created ?? '2026-01-01T00:00:00Z'}::timestamptz, ${o.created ?? '2026-01-01T00:00:00Z'}::timestamptz,
            ${o.trashed ? pg`now()` : null})`;

  const label = async (name: string, pages: string[], o: { ws?: string; type?: string } = {}) => {
    const [row] = await pg<{ id: string }[]>`
      insert into labels (name, type, workspace_id) values (${name}, ${o.type ?? 'page'}, ${o.ws ?? WS}) returning id`;
    for (const p of pages) await pg`insert into page_labels (page_id, label_id) values (${p}, ${row.id})`;
  };
  const link = (source: string, target: string, ws = WS) =>
    pg`insert into backlinks (source_page_id, target_page_id, workspace_id) values (${source}, ${target}, ${ws})`;

  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const list = async (dto: Record<string, unknown>) =>
    ids((await svc.listPagesByIds({ ids: TREE_IDS, limit: 100, ...dto } as any)).items);

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 4);
    appPg = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
    await createKnowledgeTables(pg);
    svc = new ServiceContentService(db as any, fakeWorkspaceResolver(WS));

    await pg`insert into users (id, name, workspace_id) values
      (${ALICE}, 'Alice', ${WS}), (${BOB}, 'Bob', ${WS}), (${MALLORY}, 'Mallory', ${FOREIGN_WS})`;

    // Tree.
    await page(R, { position: 'a0' });
    await page(A, { parent: R, position: 'a1', creator: ALICE, editor: BOB, created: '2026-03-01T00:00:00Z' });
    await page(A1, { parent: A });
    await page(A1X, { parent: A1 });
    await page(A1XY, { parent: A1X });
    await page(B, { parent: R, position: 'a2' });
    await page(B1, { parent: B });
    await page(T, { parent: R, position: 'a3', trashed: true });
    await page(T1, { parent: T });
    await page(C, { parent: R, position: null, creator: MALLORY, editor: ALICE });
    await page(D, { parent: R, position: null });
    await page(E, { parent: R, position: 'Zz' }); // 'Z' < 'a' in byte order, after it case-insensitively
    await page(F, { parent: R, ws: FOREIGN_WS });
    await page(Z, { space: SPACE_B, position: 'b0' });
    await page(X, { parent: Y });
    await page(Y, { parent: X });
    await page(G, { parent: MISSING });

    // Labels: 'road-map' is also on B (unauthorized) and T (trashed); 'secret' is ONLY on B; a same-named label of
    // another workspace and one of another type are attached to authorized pages and must never be counted.
    await label('road-map', [A, B, T]);
    await label('alpha', [A, C]);
    await label('a-z', [A]); // '-' < '0' in byte order; ignored by linguistic collations
    await label('a0', [A]);
    await label('a_b', [A]);
    await label('secret', [B]);
    await label('zeta', [Z]);
    await label('road-map', [C], { ws: FOREIGN_WS });
    await label('road-map', [D], { type: 'space' });

    // Links: A → C, D → C, B → C (B unauthorized), T → C (T trashed), Z → C recorded in ANOTHER workspace, A → D.
    await link(A, C);
    await link(D, C);
    await link(B, C);
    await link(T, C);
    await link(Z, C, FOREIGN_WS);
    await link(A, D);

    // Spaces for the viewer-comment policy.
    const space = (id: string, settings: unknown, o: { ws?: string; archived?: boolean } = {}) => pg`
      insert into spaces (id, name, slug, workspace_id, settings, deleted_at)
      values (${id}, ${'s' + id.slice(-3)}, ${'s' + id.slice(-3)}, ${o.ws ?? WS},
              ${settings === null ? null : pg.json(settings as any)}, ${o.archived ? pg`now()` : null})`;
    await space(uuid(60), { comments: { allowViewerComments: true }, sharing: { disabled: false } });
    await space(uuid(61), null);
    await space(uuid(62), { comments: { allowViewerComments: false } });
    await space(uuid(63), { comments: { allowViewerComments: true } }, { ws: FOREIGN_WS });
    await space(uuid(64), { comments: { allowViewerComments: true } }, { archived: true });
    await space(uuid(65), { sharing: { disabled: true } });

    // ---- Activity fixture ----
    await page(PA, { title: 'Alpha', creator: ALICE, created: '2026-06-02T00:00:00Z' });
    await page(PB, { title: 'Hidden', creator: ALICE, created: '2026-06-02T12:00:00Z' });
    await page(PT, { title: 'Gone', trashed: true });
    await page(PC, { title: 'Moved', space: SPACE_B });
    await page(PF, { title: 'Foreign', ws: FOREIGN_WS, created: '2026-06-02T00:00:00Z' });

    const hist = (id: string, pageId: string, by: string | null, ts: ReturnType<typeof at>, ws = WS) => pg`
      insert into page_history (id, page_id, last_updated_by_id, space_id, workspace_id, created_at)
      values (${id}, ${pageId}, ${by}, ${SPACE}, ${ws}, ${ts})`;
    await hist(H1, PA, BOB, at('2026-06-03T00:00:00Z'));
    await hist(H_OLD, PA, BOB, at('2026-05-01T00:00:00Z')); // before the window
    await hist(H4, PA, ALICE, at('2026-06-08T00:00:00Z', 100)); // the same-ms tie group ↓
    await hist(H5, PA, ALICE, at('2026-06-08T00:00:00Z', 50));
    await hist(H_B, PB, BOB, at('2026-06-03T00:00:00Z')); // unauthorized page
    await hist(H_FOREIGN, PA, BOB, at('2026-06-03T00:00:00Z'), FOREIGN_WS); // a row of another workspace

    const comment = (id: string, pageId: string, by: string, ts: ReturnType<typeof at>, deleted = false) => pg`
      insert into comments (id, page_id, creator_id, workspace_id, created_at, deleted_at)
      values (${id}, ${pageId}, ${by}, ${WS}, ${ts}, ${deleted ? pg`now()` : null})`;
    await comment(C1, PA, ALICE, at('2026-06-04T00:00:00Z'));
    await comment(C_DELETED, PA, ALICE, at('2026-06-04T01:00:00Z'), true);
    await comment(C_B, PB, ALICE, at('2026-06-04T00:00:00Z'));
    await comment(C4, PC, MALLORY, at('2026-06-08T00:00:00Z', 900)); // actor of another workspace → no name

    const file = (id: string, pageId: string | null, ts: ReturnType<typeof at>, deleted = false) => pg`
      insert into attachments (id, page_id, creator_id, workspace_id, created_at, deleted_at)
      values (${id}, ${pageId}, ${BOB}, ${WS}, ${ts}, ${deleted ? pg`now()` : null})`;
    await file(F1, PA, at('2026-06-05T00:00:00Z'));
    await file(F_DELETED, PA, at('2026-06-05T01:00:00Z'), true);
    await file(F_NOPAGE, null, at('2026-06-05T02:00:00Z'));

    const audit = (
      id: string,
      event: string,
      resourceType: string,
      resourceId: string,
      ts: ReturnType<typeof at>,
      o: { actor?: string | null; ws?: string; metadata?: unknown } = {},
    ) => pg`
      insert into audit (id, workspace_id, actor_id, event, resource_type, resource_id, metadata, created_at)
      values (${id}, ${o.ws ?? WS}, ${o.actor ?? null}, ${event}, ${resourceType}, ${resourceId},
              ${o.metadata === undefined ? null : pg.json(o.metadata as any)}, ${ts})`;
    await audit(E1, 'page.trashed', 'page', PT, at('2026-06-06T00:00:00Z'), { actor: ALICE });
    await audit(E2, 'comment.resolved', 'comment', C1, at('2026-06-07T00:00:00Z'), { metadata: { pageId: PA } });
    await audit(E_B, 'page.restored', 'page', PB, at('2026-06-06T00:00:00Z'), { actor: ALICE });
    await audit(E_FOREIGN, 'page.trashed', 'page', PA, at('2026-06-06T00:00:00Z'), { ws: FOREIGN_WS });
    await audit(E_UNLISTED, 'page.viewed', 'page', PA, at('2026-06-06T00:00:00Z'));
    await audit(E_BAD_META, 'comment.deleted', 'comment', C1, at('2026-06-06T00:00:00Z'), { metadata: { pageId: 'not-a-uuid' } });
    await audit(E_MISMATCH, 'page.moved_to_space', 'comment', PA, at('2026-06-06T00:00:00Z'));
    await audit(E8, 'page.moved_to_space', 'page', PC, at('2026-06-08T00:00:00Z'), { actor: BOB });
  });

  afterAll(async () => {
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
    await appPg?.end?.({ timeout: 5 });
  });

  describe('page list: new filters only ever narrow the authorized, live, in-workspace set', () => {
    it('topLevel=true is the live top-level pages in ids; false is the rest', async () => {
      expect((await list({ topLevel: true })).sort()).toEqual([R, Z].sort());
      const nested = await list({ topLevel: false });
      expect(nested).not.toContain(R);
      expect(nested).not.toContain(Z);
      expect(nested).not.toContain(T); // trashed
      expect(nested).not.toContain(F); // another workspace
      expect(nested).not.toContain(B); // not authorized
      expect(nested).toEqual(expect.arrayContaining([A, A1, B1, C, D, E, X, Y, G]));
    });

    it('topLevel with parentPageId is a 400', async () => {
      await expect(list({ topLevel: true, parentPageId: R })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lastUpdatedById and the created range narrow pages', async () => {
      expect(await list({ lastUpdatedById: BOB })).toEqual([A]);
      expect(await list({ createdSince: '2026-02-01T00:00:00Z', createdUntil: '2026-04-01T00:00:00Z' })).toEqual([A]);
      await expect(list({ createdSince: '2026' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('labelName matches only this workspace’s PAGE label (normalized), on authorized live pages', async () => {
      // 'Road Map' normalizes to 'road-map'. B (unauthorized) and T (trashed) carry it; C carries a same-named label
      // of ANOTHER workspace, D one of another type — none of them may match.
      expect(await list({ labelName: 'Road Map' })).toEqual([A]);
      expect(await list({ labelName: 'secret' })).toEqual([]);
    });

    it('linksTo = incoming links, linkedFrom = outgoing, both pinned to ids + live + the workspace', async () => {
      // Pages linking TO C: A and D. B is not authorized, T is trashed, Z's link row is in another workspace.
      expect((await list({ linksTo: C })).sort()).toEqual([A, D].sort());
      expect((await list({ linkedFrom: A })).sort()).toEqual([C, D].sort());
      expect(await list({ linkedFrom: A, ids: [C] })).toEqual([C]);
      await expect(list({ linksTo: C, linkedFrom: A })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('page list: descendantOf walks only through authorized live pages, depth-bounded, root excluded', () => {
    it('default depth 3: never through the unauthorized B or the trashed T, never the root, never another workspace', async () => {
      const got = (await list({ descendantOf: R })).sort();
      expect(got).toEqual([A, A1, A1X, C, D, E].sort());
      // B1 and T1 are authorized and live, but their only path runs through B / T: no hidden-level inference.
      expect(got).not.toContain(B1);
      expect(got).not.toContain(T1);
      expect(got).not.toContain(A1XY); // depth 4
      expect(got).not.toContain(R);
    });

    it('maxDepth bounds the walk (1 = children, 10 reaches depth 4)', async () => {
      expect((await list({ descendantOf: R, maxDepth: 1 })).sort()).toEqual([A, C, D, E].sort());
      expect(await list({ descendantOf: R, maxDepth: 10 })).toContain(A1XY);
      expect((await list({ descendantOf: A, maxDepth: 2 })).sort()).toEqual([A1, A1X].sort());
    });

    it('a descendant outside ids is dropped AND stops the walk below it', async () => {
      const got = await svc.listPagesByIds({ ids: [R, A, A1X], descendantOf: R, limit: 100 } as any);
      expect(ids(got.items)).toEqual([A]); // A1 is not in ids, so A1X under it is unreachable
    });

    it('a parent cycle terminates and never returns the root', async () => {
      expect(await list({ descendantOf: X, maxDepth: 10 })).toEqual([Y]);
    });

    it('composes with the other filters and the keyset (only rows of the walk)', async () => {
      expect(await list({ descendantOf: R, maxDepth: 10, titleContains: 'page 005' })).toEqual([A1XY]);
      expect(await list({ descendantOf: R, titleContains: 'page 005' })).toEqual([]); // depth 4 > the default 3
      expect(await list({ descendantOf: R, lastUpdatedById: BOB })).toEqual([A]);
    });

    it('is exclusive with parentPageId / topLevel / links, and maxDepth needs it (400s)', async () => {
      for (const extra of [{ parentPageId: R }, { topLevel: true }, { linksTo: C }, { linkedFrom: A }]) {
        await expect(list({ descendantOf: R, ...extra })).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(list({ maxDepth: 2 })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('page list: position sort (sibling order, byte order, null last) + keyset', () => {
    const sort = (direction: 'asc' | 'desc') => ({ parentPageId: R, sort: { field: 'position', direction } });

    it('asc = byte order with null positions last, id-tiebroken', async () => {
      // E 'Zz' < A 'a1' in byte order; C and D have no position ('~') and tie-break by id.
      expect(await list(sort('asc'))).toEqual([E, A, C, D]);
      expect(await list(sort('desc'))).toEqual([D, C, A, E]);
    });

    it('walks with no skip and no duplicate across the null-position tie (cursor value = position ?? "~")', async () => {
      for (const direction of ['asc', 'desc'] as const) {
        const seen: string[] = [];
        let before: { value: string; id: string } | undefined;
        for (let guard = 0; guard < 10; guard++) {
          const res = await svc.listPagesByIds({ ids: TREE_IDS, limit: 1, before, ...sort(direction) } as any);
          const kept = res.items.slice(0, 1);
          seen.push(...ids(kept));
          if (res.items.length <= 1) break;
          before = { value: kept[0].position ?? '~', id: kept[0].id };
        }
        expect(seen).toEqual(direction === 'asc' ? [E, A, C, D] : [D, C, A, E]);
      }
    });

    it('is pages-only (a spaces position sort is a 400)', async () => {
      await expect(
        svc.listSpacesByIds({ ids: [uuid(60)], limit: 10, sort: { field: 'position', direction: 'asc' } } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('page list: creator / last-editor projection', () => {
    it('projects both ids and names, and never a name from another workspace', async () => {
      const res = await svc.listPagesByIds({ ids: [A, C, D], limit: 10, sort: { field: 'title', direction: 'asc' } } as any);
      const byId = Object.fromEntries(res.items.map((p) => [p.id, p]));
      expect(byId[A]).toMatchObject({ creatorId: ALICE, creatorName: 'Alice', lastUpdatedById: BOB, lastUpdatedByName: 'Bob' });
      expect(byId[C]).toMatchObject({ creatorId: MALLORY, creatorName: null, lastUpdatedById: ALICE, lastUpdatedByName: 'Alice' });
      expect(byId[D]).toMatchObject({ creatorId: null, creatorName: null, lastUpdatedById: null, lastUpdatedByName: null });
    });
  });

  describe('ancestors', () => {
    it('nearest first, never the page itself, complete at a root', async () => {
      expect(await svc.pageAncestors({ pageId: A1X })).toEqual({ ancestorIds: [A1, A, R], complete: true });
      expect(await svc.pageAncestors({ pageId: R })).toEqual({ ancestorIds: [], complete: true });
    });

    it('reports an unfinished walk (a cycle, a dangling parent) as incomplete and never repeats a page', async () => {
      expect(await svc.pageAncestors({ pageId: X })).toEqual({ ancestorIds: [Y], complete: false });
      expect(await svc.pageAncestors({ pageId: G })).toEqual({ ancestorIds: [], complete: false });
    });

    it('404s a trashed, foreign or missing page', async () => {
      for (const pageId of [T, F, MISSING]) {
        await expect(svc.pageAncestors({ pageId })).rejects.toBeInstanceOf(NotFoundException);
      }
    });
  });

  describe('labels/list', () => {
    const labels = (dto: Record<string, unknown>) =>
      svc.listLabels({ ids: TREE_IDS, limit: 100, ...dto } as any).then((r) => r.items);

    it('names only labels on authorized live pages, counted over those pages only, in byte order', async () => {
      // 'secret' sits only on B (not authorized) → absent. 'road-map' is also on B and T → counted once (A). The
      // other workspace's and the other type's 'road-map' add nothing.
      expect(await labels({})).toEqual([
        { name: 'a-z', pageCount: 1 },
        { name: 'a0', pageCount: 1 },
        { name: 'a_b', pageCount: 1 },
        { name: 'alpha', pageCount: 2 },
        { name: 'road-map', pageCount: 1 },
        { name: 'zeta', pageCount: 1 },
      ]);
    });

    it('ids = [] lists nothing', async () => {
      expect(await labels({ ids: [] })).toEqual([]);
    });

    it('counts shrink with ids, and spaceId narrows to pages in that space', async () => {
      expect(await labels({ ids: [C] })).toEqual([{ name: 'alpha', pageCount: 1 }]);
      expect((await labels({ spaceId: SPACE_B })).map((l) => l.name)).toEqual(['zeta']);
    });

    it('nameContains is a literal, case-insensitive substring (% and _ are not wildcards)', async () => {
      expect((await labels({ nameContains: 'MAP' })).map((l) => l.name)).toEqual(['road-map']);
      expect((await labels({ nameContains: '_' })).map((l) => l.name)).toEqual(['a_b']);
      expect(await labels({ nameContains: '%' })).toEqual([]);
    });

    it('keyset by name walks every label once (limit+1 probe)', async () => {
      const seen: string[] = [];
      let before: { name: string } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await labels({ limit: 2, before });
        seen.push(...page.slice(0, 2).map((l) => l.name));
        if (page.length <= 2) break;
        before = { name: page[1].name };
      }
      expect(seen).toEqual(['a-z', 'a0', 'a_b', 'alpha', 'road-map', 'zeta']);
    });
  });

  describe('activity/list', () => {
    const SINCE = '2026-06-01T00:00:00Z';
    const feed = (dto: Record<string, unknown> = {}) =>
      svc.listActivity({ ids: ACTIVITY_IDS, since: SINCE, limit: 100, ...dto } as any).then((r) => r.items);
    const ALL = [`h:${H5}`, `h:${H4}`, `e:${E8}`, `c:${C4}`, `e:${E2}`, `e:${E1}`, `a:${F1}`, `c:${C1}`, `h:${H1}`, `p:${PA}`];

    it('unions every source over ONLY the authorized pages in the workspace, newest first, ties by key', async () => {
      const items = await feed();
      // H5/H4/E8/C4 share one truncated millisecond → key desc ("C" collation): h > e > c, then by id.
      expect(items.map((i) => i.key)).toEqual(ALL);
      // Never: PB (not authorized), PF (another workspace), H_FOREIGN / E_FOREIGN (rows of another workspace),
      // a deleted comment or attachment, a page-less attachment, an unlisted audit event, a malformed or mismatched
      // audit row, or anything before the window.
      const keys = items.map((i) => i.key).join(' ');
      for (const hidden of [PB, PF, H_B, H_FOREIGN, H_OLD, C_B, C_DELETED, F_DELETED, F_NOPAGE, E_B, E_FOREIGN, E_UNLISTED, E_BAD_META, E_MISMATCH]) {
        expect(keys).not.toContain(hidden);
      }
    });

    it('projects each source’s fields; a trashed page keeps its events without a title; a foreign actor has no name', async () => {
      const byKey = Object.fromEntries((await feed()).map((i) => [i.key, i]));
      expect(byKey[`p:${PA}`]).toEqual({
        key: `p:${PA}`, type: 'page.created', occurredAt: '2026-06-02T00:00:00.000Z', actorId: ALICE, actorName: 'Alice',
        pageId: PA, spaceId: SPACE, pageTitle: 'Alpha', commentId: null, versionId: null,
      });
      expect(byKey[`h:${H1}`]).toMatchObject({ type: 'page.updated', actorId: BOB, actorName: 'Bob', versionId: H1, commentId: null });
      expect(byKey[`c:${C1}`]).toMatchObject({ type: 'comment.created', commentId: C1, pageId: PA });
      expect(byKey[`a:${F1}`]).toMatchObject({ type: 'attachment.uploaded', actorId: BOB, pageId: PA });
      expect(byKey[`e:${E1}`]).toMatchObject({ type: 'page.trashed', pageId: PT, pageTitle: null, actorName: 'Alice' });
      expect(byKey[`e:${E2}`]).toMatchObject({ type: 'comment.resolved', pageId: PA, commentId: C1, actorId: null, actorName: null });
      expect(byKey[`c:${C4}`]).toMatchObject({ actorId: MALLORY, actorName: null });
      // The page's CURRENT space.
      expect(byKey[`e:${E8}`]).toMatchObject({ type: 'page.moved_to_space', pageId: PC, spaceId: SPACE_B, pageTitle: 'Moved' });
    });

    it('walks the keyset across sources and through the same-ms tie with no skip and no duplicate', async () => {
      for (const limit of [1, 2, 3]) {
        const seen: string[] = [];
        let before: { occurredAt: string; key: string } | undefined;
        for (let guard = 0; guard < 20; guard++) {
          const page = await feed({ limit, before });
          const kept = page.slice(0, limit);
          seen.push(...kept.map((i) => i.key));
          if (page.length <= limit) break;
          const last = kept[kept.length - 1];
          before = { occurredAt: last.occurredAt, key: last.key };
        }
        expect(seen).toEqual(ALL);
      }
    });

    it('filters: types, actorId, spaceId (current space), pageId, the [since, until) window, ids', async () => {
      const keys = async (dto: Record<string, unknown>) => (await feed(dto)).map((i) => i.key);
      expect(await keys({ types: ['comment.created', 'comment.resolved'] })).toEqual([`c:${C4}`, `e:${E2}`, `c:${C1}`]);
      expect(await keys({ types: ['page.trashed'] })).toEqual([`e:${E1}`]);
      expect(await keys({ actorId: BOB })).toEqual([`e:${E8}`, `a:${F1}`, `h:${H1}`]);
      expect(await keys({ spaceId: SPACE_B })).toEqual([`e:${E8}`, `c:${C4}`]);
      expect(await keys({ pageId: PC })).toEqual([`e:${E8}`, `c:${C4}`]);
      expect(await keys({ pageId: PB })).toEqual([]); // a page outside ids is never read, even when named
      expect(await keys({ since: '2026-06-04T00:00:00Z', until: '2026-06-07T00:00:00Z' })).toEqual([`e:${E1}`, `a:${F1}`, `c:${C1}`]);
      expect(await keys({ ids: [PC] })).toEqual([`e:${E8}`, `c:${C4}`]);
      expect(await keys({ ids: [] })).toEqual([]);
    });

    it('a malformed instant is a 400, never a 500 at the cast', async () => {
      await expect(feed({ since: '2026' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(feed({ until: '2026' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(feed({ before: { occurredAt: '2026', key: `p:${PA}` } })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('spaces/comment-policy', () => {
    it('reads settings.comments.allowViewerComments (absent = false), in the workspace only', async () => {
      expect(await svc.spaceCommentPolicy({ spaceId: uuid(60) })).toEqual({ allowViewerComments: true });
      expect(await svc.spaceCommentPolicy({ spaceId: uuid(61) })).toEqual({ allowViewerComments: false });
      expect(await svc.spaceCommentPolicy({ spaceId: uuid(62) })).toEqual({ allowViewerComments: false });
      expect(await svc.spaceCommentPolicy({ spaceId: uuid(65) })).toEqual({ allowViewerComments: false });
      expect(await svc.spaceCommentPolicy({ spaceId: uuid(64) })).toEqual({ allowViewerComments: true }); // archived
      await expect(svc.spaceCommentPolicy({ spaceId: uuid(63) })).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.spaceCommentPolicy({ spaceId: MISSING })).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
