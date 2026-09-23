import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { BadRequestException } from '@nestjs/common';
import { PageAuthzState, PageAuthzStateService } from './page-authz-state.service';
import { LIFECYCLE_MAX_DEPTH, lineageRestricted, readPageLineage } from './page-lineage';
import { CYCLE_GUARD_MAX_DEPTH } from './page-cycle-guard.installer';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  createReadModelTables,
} from './read-model-pg.testkit';

/**
 * Real-Postgres proof of `POST /api/service/authz/pages/state` (#545): the facts the platform's page projector
 * writes to SpiceDB. What a query spy cannot show is proven here — the walks cross trashed and cross-space rows,
 * stay in the workspace, finish or report INCOMPLETE (never "unrestricted") at cycles, dangling parents and the
 * depth bound; the marker is exactly the #524 rule the PEP applies; the keyset modes cover every page once; and one
 * response never mixes two committed trees. Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job
 * provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG page authz state gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'page_authz_state_pg_spec';
const WS = uuid(100);
const FOREIGN_WS = uuid(200);
const SPACE = uuid(50);
const SPACE_B = uuid(51);

d('PageAuthzStateService on real Postgres', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: PageAuthzStateService;

  const page = (id: string, parent: string | null, opts: { space?: string; ws?: string; trashed?: boolean } = {}) => pg`
    insert into pages (id, workspace_id, space_id, parent_page_id, deleted_at)
    values (${id}, ${opts.ws ?? WS}, ${opts.space ?? SPACE}, ${parent}, ${opts.trashed ? new Date() : null})`;
  const restrict = (id: string) => pg`insert into page_access (page_id, workspace_id) values (${id}, ${WS})`;
  const byId = (rows: PageAuthzState[]) => Object.fromEntries(rows.map((r) => [r.pageId, r]));
  const chain = async (first: number, length: number): Promise<string> => {
    const last = first + length - 1;
    await pg`
      insert into pages (id, space_id, parent_page_id, workspace_id)
      select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${SPACE},
             case when g < ${last} then ('00000000-0000-4000-8000-' || lpad((g + 1)::text, 12, '0'))::uuid end,
             ${WS}
        from generate_series(${first}::int, ${last}::int) g`;
    return uuid(first);
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(appPg);
    await createReadModelTables(pg);
    svc = new PageAuthzStateService(db as never);
  });

  afterEach(async () => {
    await pg`delete from page_access`;
    await pg`delete from pages`;
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  it('aligns its bound with the cycle guard (a tree the guard lets a move build is never read as incomplete)', () => {
    expect(LIFECYCLE_MAX_DEPTH).toBe(CYCLE_GUARD_MAX_DEPTH);
  });

  describe('pageIds mode', () => {
    it('reports placement, own restriction and a restriction inherited through a TRASHED ancestor', async () => {
      await page(uuid(1), null, { trashed: true });
      await page(uuid(2), uuid(1), { trashed: true });
      await page(uuid(3), uuid(2));
      await page(uuid(4), null);
      await restrict(uuid(1));
      const { pages, nextAfter } = await svc.read({ pageIds: [uuid(3), uuid(4), uuid(1)] });
      expect(nextAfter).toBeNull();
      expect(pages.map((p) => p.pageId)).toEqual([uuid(1), uuid(3), uuid(4)]);
      const s = byId(pages);
      expect(s[uuid(1)]).toEqual({
        pageId: uuid(1), exists: true, spaceId: SPACE, parentPageId: null,
        restricted: true, lineageRestricted: true, lineageComplete: true,
      });
      expect(s[uuid(3)]).toEqual({
        pageId: uuid(3), exists: true, spaceId: SPACE, parentPageId: uuid(2),
        restricted: false, lineageRestricted: true, lineageComplete: true,
      });
      expect(s[uuid(4)]).toMatchObject({ restricted: false, lineageRestricted: false, lineageComplete: true });
    });

    it('walks through a CROSS-SPACE parent (a strand left by a move) — the ancestor’s restriction still governs', async () => {
      await page(uuid(1), null, { space: SPACE_B });
      await page(uuid(2), uuid(1));
      await restrict(uuid(1));
      const [s] = (await svc.read({ pageIds: [uuid(2)] })).pages;
      expect(s).toMatchObject({ spaceId: SPACE, parentPageId: uuid(1), lineageRestricted: true, lineageComplete: true });
    });

    it('answers EVERY requested id: a missing page is exists:false, unplaced and locked', async () => {
      const { pages } = await svc.read({ pageIds: [uuid(9), uuid(9)] });
      expect(pages).toEqual([
        {
          pageId: uuid(9), exists: false, spaceId: null, parentPageId: null,
          restricted: false, lineageRestricted: true, lineageComplete: false,
        },
      ]);
    });

    it('fails CLOSED on a cycle, a dangling parent and a parent in ANOTHER workspace', async () => {
      await page(uuid(1), uuid(2));
      await page(uuid(2), uuid(1));
      await page(uuid(3), uuid(1));
      await page(uuid(4), uuid(999));
      await page(uuid(5), null, { ws: FOREIGN_WS });
      await page(uuid(6), uuid(5));
      const s = byId((await svc.read({ pageIds: [uuid(1), uuid(3), uuid(4), uuid(6)] })).pages);
      for (const id of [uuid(1), uuid(3), uuid(4), uuid(6)]) {
        expect(s[id]).toMatchObject({ exists: true, restricted: false, lineageRestricted: true, lineageComplete: false });
      }
    });

    it('is bounded at LIFECYCLE_MAX_DEPTH: a 1025-page chain reaches its root, a 1026-page chain is incomplete', async () => {
      const ok = await chain(5000, LIFECYCLE_MAX_DEPTH + 1);
      const tooDeep = await chain(7000, LIFECYCLE_MAX_DEPTH + 2);
      const s = byId((await svc.read({ pageIds: [ok, tooDeep] })).pages);
      expect(s[ok]).toMatchObject({ lineageRestricted: false, lineageComplete: true });
      expect(s[tooDeep]).toMatchObject({ lineageRestricted: true, lineageComplete: false });
    });

    it('the marker is EXACTLY the #524 rule the PEP applies: lineageRestricted(readPageLineage(includeSelf))', async () => {
      // A mixed forest: restricted roots and mid-tree pages, trashed links, a cross-space strand, a cycle, a dangling
      // parent and a foreign-workspace parent.
      await page(uuid(1), null);
      await page(uuid(2), uuid(1), { trashed: true });
      await page(uuid(3), uuid(2));
      await page(uuid(4), uuid(3), { space: SPACE_B });
      await page(uuid(5), null);
      await page(uuid(6), uuid(5));
      await page(uuid(7), uuid(6), { trashed: true });
      await page(uuid(8), uuid(9));
      await page(uuid(9), uuid(8));
      await page(uuid(10), uuid(999));
      await page(uuid(11), null, { ws: FOREIGN_WS });
      await page(uuid(12), uuid(11));
      await restrict(uuid(2));
      await restrict(uuid(6));
      const ids = Array.from({ length: 12 }, (_, i) => uuid(i + 1));
      const s = byId((await svc.read({ pageIds: ids })).pages);
      for (const id of ids) {
        const l = await readPageLineage(db as never, id, { includeSelf: true });
        expect({ id, marker: s[id].lineageRestricted, complete: s[id].lineageComplete }).toEqual({
          id,
          marker: lineageRestricted(l),
          complete: l.complete,
        });
      }
    });
  });

  describe('subtree mode', () => {
    it('lists the root’s descendants (not the root) through trashed and cross-space rows, paged on id exactly once', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await page(uuid(3), uuid(2), { trashed: true });
      await page(uuid(4), uuid(3), { space: SPACE_B });
      await page(uuid(5), uuid(1));
      await page(uuid(6), null); // not in the subtree
      await restrict(uuid(1));
      const seen: PageAuthzState[] = [];
      let after: string | undefined;
      for (let i = 0; i < 10; i++) {
        const r = await svc.read({ subtreeRootId: uuid(1), limit: 3, after });
        seen.push(...r.pages);
        if (!r.nextAfter) break;
        after = r.nextAfter;
      }
      expect(seen.map((p) => p.pageId)).toEqual([uuid(2), uuid(3), uuid(4), uuid(5)]);
      expect(seen.every((p) => p.lineageRestricted && p.lineageComplete)).toBe(true);
    });

    it('terminates on a cycle through the root and stays in the root’s workspace', async () => {
      await page(uuid(1), uuid(2));
      await page(uuid(2), uuid(1));
      await page(uuid(3), uuid(2));
      await page(uuid(4), uuid(3), { ws: FOREIGN_WS });
      const r = await svc.read({ subtreeRootId: uuid(1), limit: 10 });
      expect(r.pages.map((p) => p.pageId)).toEqual([uuid(2), uuid(3)]);
      expect(r.nextAfter).toBeNull();
    });

    it('an unknown root has no descendants', async () => {
      expect(await svc.read({ subtreeRootId: uuid(77), limit: 10 })).toEqual({ pages: [], nextAfter: null });
    });
  });

  describe('keyset mode (the reconciler’s full scan)', () => {
    it('streams EVERY page, trashed included, exactly once', async () => {
      for (let i = 1; i <= 7; i++) await page(uuid(i), i > 1 ? uuid(i - 1) : null, { trashed: i % 2 === 0 });
      const seen: string[] = [];
      let after: string | undefined;
      for (let i = 0; i < 10; i++) {
        const r = await svc.read({ limit: 2, after });
        seen.push(...r.pages.map((p) => p.pageId));
        if (!r.nextAfter) break;
        after = r.nextAfter;
      }
      expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => uuid(i + 1)));
    });
  });

  it('refuses a request that mixes modes or names none (400, never a guess)', async () => {
    await expect(svc.read({ pageIds: [uuid(1)], limit: 5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.read({ pageIds: [uuid(1)], subtreeRootId: uuid(2) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.read({ subtreeRootId: uuid(2) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.read({})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never tears: under concurrent re-parenting every row’s parent and marker describe the SAME committed tree', async () => {
    const [X, Y, P] = [uuid(1), uuid(2), uuid(3)];
    await page(X, null);
    await page(Y, null);
    await page(P, X);
    await restrict(X);
    const writer = mkReadModelPg(SCHEMA, 1);
    let stop = false;
    const flips = (async () => {
      let n = 0;
      while (!stop) {
        await writer`update pages set parent_page_id = ${n++ % 2 ? X : Y} where id = ${P}`;
      }
      return n;
    })();
    try {
      for (let i = 0; i < 300; i++) {
        const [s] = (await svc.read({ pageIds: [P] })).pages;
        expect({ parent: s.parentPageId, marker: s.lineageRestricted }).toEqual({
          parent: s.parentPageId,
          marker: s.parentPageId === X,
        });
      }
    } finally {
      stop = true;
      expect(await flips).toBeGreaterThan(1);
      await writer.end({ timeout: 5 });
    }
  });
});
