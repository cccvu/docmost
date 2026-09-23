import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { NotFoundException } from '@nestjs/common';
import { ServicePageLifecycleService } from './service-page-lifecycle.service';
import { PageCycleGuardInstaller } from './page-cycle-guard.installer';
import { PG_URL, uuid, fakeWorkspaceResolver, mkReadModelPg, bootstrapSchema, mkReadModelDb } from './read-model-pg.testkit';

/**
 * Real-Postgres proof of the #485 lifecycle FACTS and the DB cycle guard. The properties that matter are ones a
 * mocked query cannot show: the recursive walks cross TRASHED ancestors, stay bounded and cycle-safe, and report
 * INCOMPLETE (never "unrestricted") when they cannot finish; the trash listing excludes restricted lineages in
 * SQL before the LIMIT; and the trigger refuses a cycle — including two concurrent moves that would each be fine
 * alone. Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG page lifecycle gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'page_lifecycle_pg_spec';
const WS = uuid(100);
const FOREIGN_WS = uuid(200);
const SPACE = uuid(50);
const SPACE_B = uuid(51);
const USER = uuid(900);

d('ServicePageLifecycleService + PageCycleGuardInstaller on real Postgres', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let svc: ServicePageLifecycleService;

  const page = (
    id: string,
    parent: string | null,
    opts: { space?: string; ws?: string; deleted?: string | null; position?: string; title?: string } = {},
  ) => pg`
    insert into pages (id, workspace_id, space_id, parent_page_id, deleted_at, deleted_by_id, position, title)
    values (${id}, ${opts.ws ?? WS}, ${opts.space ?? SPACE}, ${parent}, ${opts.deleted ?? null},
            ${opts.deleted ? USER : null}, ${opts.position ?? null}, ${opts.title ?? null})`;
  const restrict = (id: string) => pg`insert into page_access (page_id, workspace_id) values (${id}, ${WS})`;
  const setParent = (id: string, parent: string | null) => pg`update pages set parent_page_id = ${parent} where id = ${id}`;

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(appPg);
    await pg`
      create table pages (
        id uuid primary key, workspace_id uuid not null, space_id uuid not null, parent_page_id uuid,
        title varchar, icon varchar, position varchar, deleted_at timestamptz, deleted_by_id uuid
      )`;
    await pg`create table page_access (id uuid primary key default gen_random_uuid(), page_id uuid not null, workspace_id uuid not null)`;
    await pg`create table users (id uuid primary key, name varchar)`;
    await pg`insert into users (id, name) values (${USER}, 'Ada Lovelace')`;
    svc = new ServicePageLifecycleService(db as never, fakeWorkspaceResolver(WS));
    await new PageCycleGuardInstaller(db as never, 'remote').install();
  });

  afterEach(async () => {
    await pg`delete from page_access`;
    await pg`delete from pages`;
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  describe('lifecycleState', () => {
    it('reports a restriction inherited through a TRASHED ancestor (trashing reaps the PDP edges, not this)', async () => {
      await page(uuid(1), null, { deleted: '2026-01-01T00:00:00Z' });
      await page(uuid(2), uuid(1), { deleted: '2026-01-01T00:00:00Z' });
      await page(uuid(3), uuid(2));
      await restrict(uuid(1));
      const s = await svc.lifecycleState({ pageId: uuid(3) });
      expect(s.restrictedAncestorIds).toEqual([uuid(1)]);
      expect(s.ancestorsComplete).toBe(true);
      expect(s.selfRestricted).toBe(false);
      expect(s.parent).toEqual({ spaceId: SPACE, deletedAt: '2026-01-01T00:00:00.000Z' });
    });

    it('excludes the page itself from restrictedAncestorIds (selfRestricted carries it)', async () => {
      await page(uuid(1), null);
      await restrict(uuid(1));
      const s = await svc.lifecycleState({ pageId: uuid(1) });
      expect(s.restrictedAncestorIds).toEqual([]);
      expect(s.selfRestricted).toBe(true);
    });

    it('fails CLOSED on a pre-existing cycle: the ancestor walk is reported incomplete', async () => {
      // Built by inserting the loop directly — the guard only blocks UPDATEs of parent_page_id.
      await page(uuid(1), uuid(2));
      await page(uuid(2), uuid(1));
      await page(uuid(3), uuid(1));
      const s = await svc.lifecycleState({ pageId: uuid(3) });
      expect(s.ancestorsComplete).toBe(false);
      const loop = await svc.lifecycleState({ pageId: uuid(1) });
      expect(loop.descendants.complete).toBe(false);
      expect(loop.descendants).toMatchObject({ restricted: true, trashed: true, crossSpace: true });
    });

    it('fails CLOSED on a dangling parent (a parent it cannot read)', async () => {
      await page(uuid(1), uuid(999));
      expect((await svc.lifecycleState({ pageId: uuid(1) })).ancestorsComplete).toBe(false);
    });

    it('reports restricted / trashed / cross-space DESCENDANTS', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await page(uuid(3), uuid(2), { deleted: '2026-01-01T00:00:00Z' });
      await page(uuid(4), uuid(2), { space: SPACE_B });
      await restrict(uuid(4));
      const s = await svc.lifecycleState({ pageId: uuid(1) });
      expect(s.descendants).toEqual({ restricted: true, trashed: true, crossSpace: true, complete: true });
      const leaf = await svc.lifecycleState({ pageId: uuid(3) });
      expect(leaf.descendants).toEqual({ restricted: false, trashed: false, crossSpace: false, complete: true });
    });

    it('target: lineage includes the target itself; a descendant target is flagged as a cycle', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await page(uuid(3), uuid(2));
      await page(uuid(9), null);
      await restrict(uuid(9));
      const toDesc = await svc.lifecycleState({ pageId: uuid(1), targetParentPageId: uuid(3) });
      expect(toDesc.target).toMatchObject({ exists: true, isSelfOrDescendant: true, lineageComplete: true });
      const toSelf = await svc.lifecycleState({ pageId: uuid(1), targetParentPageId: uuid(1) });
      expect(toSelf.target?.isSelfOrDescendant).toBe(true);
      const toRestricted = await svc.lifecycleState({ pageId: uuid(3), targetParentPageId: uuid(9) });
      expect(toRestricted.target).toMatchObject({ restrictedLineageIds: [uuid(9)], isSelfOrDescendant: false });
    });

    it('target: root (null) and a missing / foreign-workspace target', async () => {
      await page(uuid(1), null);
      await page(uuid(7), null, { ws: FOREIGN_WS });
      const root = await svc.lifecycleState({ pageId: uuid(1), targetParentPageId: null });
      expect(root.target).toMatchObject({ parentPageId: null, exists: true, spaceId: SPACE, restrictedLineageIds: [] });
      const foreign = await svc.lifecycleState({ pageId: uuid(1), targetParentPageId: uuid(7) });
      expect(foreign.target).toMatchObject({ exists: false, lineageComplete: false });
    });

    it('target.nextPosition sorts after every LIVE sibling under COLLATE "C"', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1), { position: 'a0' });
      await page(uuid(3), uuid(1), { position: 'az' }); // the max under "C" ('Z' < 'a')
      await page(uuid(4), uuid(1), { position: 'aZ' });
      await page(uuid(6), null);
      const next = (await svc.lifecycleState({ pageId: uuid(6), targetParentPageId: uuid(1) })).target!.nextPosition!;
      for (const p of ['a0', 'aZ', 'az']) expect(Buffer.compare(Buffer.from(next), Buffer.from(p))).toBe(1);
    });

    it('target.nextPosition ignores TRASHED siblings (live-only, like the engine)', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1), { position: 'az', deleted: '2026-01-01T00:00:00Z' });
      await page(uuid(6), null);
      const next = (await svc.lifecycleState({ pageId: uuid(6), targetParentPageId: uuid(1) })).target!.nextPosition!;
      expect(Buffer.compare(Buffer.from(next), Buffer.from('az'))).toBe(-1); // a first-child key, not after 'az'
    });

    it('404s a page outside the workspace', async () => {
      await page(uuid(7), null, { ws: FOREIGN_WS });
      await expect(svc.lifecycleState({ pageId: uuid(7) })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('trash', () => {
    it('lists only the ROOTS of trashed subtrees, newest first, with the trasher’s display name', async () => {
      await page(uuid(1), null, { deleted: '2026-01-01T00:00:01Z', title: 'Root A' });
      await page(uuid(2), uuid(1), { deleted: '2026-01-01T00:00:01Z' }); // not a root: parent trashed
      await page(uuid(3), null);
      await page(uuid(4), uuid(3), { deleted: '2026-01-01T00:00:02Z', title: 'Under live' }); // root: parent live
      await page(uuid(5), null, { deleted: '2026-01-01T00:00:03Z', space: SPACE_B }); // other space
      const out = await svc.trash({ spaceId: SPACE, limit: 10 });
      expect(out.items.map((i) => i.id)).toEqual([uuid(4), uuid(1)]);
      expect(out.items[0]).toMatchObject({ title: 'Under live', deletedBy: 'Ada Lovelace', parentPageId: uuid(3) });
    });

    it('excludes a root whose lineage is restricted (self, or through a trashed or live ancestor) BEFORE the limit', async () => {
      await page(uuid(1), null, { deleted: '2026-01-01T00:00:05Z' });
      await restrict(uuid(1)); // restricted itself
      await page(uuid(2), null);
      await restrict(uuid(2));
      await page(uuid(3), uuid(2), { deleted: '2026-01-01T00:00:04Z' }); // inherits from a live ancestor
      await page(uuid(4), null, { deleted: '2026-01-01T00:00:01Z' }); // the only visible root
      const out = await svc.trash({ spaceId: SPACE, limit: 1 });
      expect(out.items.map((i) => i.id)).toEqual([uuid(4)]);
    });

    it('excludes a root whose lineage walk cannot finish (cycle) — fail closed', async () => {
      await page(uuid(1), uuid(2), { deleted: '2026-01-01T00:00:01Z' });
      await page(uuid(2), uuid(1));
      expect((await svc.trash({ spaceId: SPACE, limit: 10 })).items).toEqual([]);
    });

    it('keyset pages without skipping or repeating ties on (deletedAt ms, id)', async () => {
      for (const n of [1, 2, 3]) await page(uuid(n), null, { deleted: '2026-01-01T00:00:00Z' });
      const first = await svc.trash({ spaceId: SPACE, limit: 1 });
      expect(first.items.map((i) => i.id)).toEqual([uuid(3), uuid(2)]); // limit + 1
      const last = first.items[0];
      const second = await svc.trash({ spaceId: SPACE, limit: 5, before: { deletedAt: last.deletedAt, id: last.id } });
      expect(second.items.map((i) => i.id)).toEqual([uuid(2), uuid(1)]);
    });
  });

  describe('cycle guard trigger', () => {
    it('refuses a page as its own parent and a descendant as a parent; allows a legal move', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await page(uuid(3), uuid(2));
      await page(uuid(4), null);
      await expect(setParent(uuid(1), uuid(1))).rejects.toThrow(/own parent/);
      await expect(setParent(uuid(1), uuid(3))).rejects.toThrow(/cycle/);
      await setParent(uuid(3), uuid(4));
      const [row] = await pg`select parent_page_id from pages where id = ${uuid(3)}`;
      expect(row.parentPageId ?? row.parent_page_id).toBe(uuid(4));
    });

    it('serializes two concurrent moves that together would form a loop — exactly one wins', async () => {
      await page(uuid(1), null);
      await page(uuid(2), null);
      const a = mkReadModelPg(SCHEMA, 1);
      const b = mkReadModelPg(SCHEMA, 1);
      try {
        const results = await Promise.allSettled([
          a.begin(async (t) => {
            const tx = t as unknown as postgres.Sql; // postgres.js types TransactionSql without its call signature
            await tx`update pages set parent_page_id = ${uuid(2)} where id = ${uuid(1)}`;
            await tx`select pg_sleep(0.3)`; // hold the workspace lock while B races
          }),
          (async () => {
            await new Promise((r) => setTimeout(r, 50));
            return b.begin(async (t) => {
              const tx = t as unknown as postgres.Sql;
              await tx`update pages set parent_page_id = ${uuid(1)} where id = ${uuid(2)}`;
            });
          })(),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        const rows = await pg`select id, parent_page_id from pages order by id`;
        const loops = rows.filter((r) => (r.parentPageId ?? r.parent_page_id) !== null);
        expect(loops).toHaveLength(1);
      } finally {
        await a.end({ timeout: 5 });
        await b.end({ timeout: 5 });
      }
    });

    it('is idempotent to re-install', async () => {
      await new PageCycleGuardInstaller(db as never, 'remote').install();
      await page(uuid(1), null);
      await expect(setParent(uuid(1), uuid(1))).rejects.toThrow(/own parent/);
    });
  });
});
