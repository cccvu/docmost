import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { ConflictException } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageService } from '../core/page/services/page.service';
import { PageCycleGuardInstaller } from './page-cycle-guard.installer';
import { AuthzOutboxInstaller } from './authz-outbox.installer';
import {
  PageRestrictionGuardInstaller,
  RESTRICTED_SPACE_MOVE,
  RESTRICTION_STRIP,
} from './page-restriction-guard.installer';
import { toPageGuardConflict } from './page-guard-conflict.interceptor';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from './read-model-pg.testkit';

// PageService imports the collab gateway, whose lib0/hocuspocus ESM graph jest cannot load; the paths driven here
// never touch it (the same stub the collab specs use).
jest.mock('../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

/**
 * Real-Postgres proof of the #493/#545 database guards (g0 on `page_access`, g1/g2 on `pages`), driven through the
 * REAL upstream write paths — `PageService.movePageToSpace` / `movePage` and `PageRepo.restorePage` — rather than
 * hand-written UPDATEs, so an upstream change to how those paths write is caught here. It shows each refusal rolls
 * the whole write back (outbox rows included), the legitimate operations still pass, two connections racing a
 * restrict against a move serialize on the per-workspace lock, and the real driver error maps to the 409.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG page restriction guard gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'page_restriction_guard_pg_spec';
const WS = uuid(100);
const S1 = uuid(50);
const S2 = uuid(51);
const USER = uuid(900);
const POS = 'a0';

d('PageRestrictionGuardInstaller on real Postgres, through the real upstream write paths', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  /** A second session for the races: it holds a transaction open while the code under test runs. */
  let side: postgres.Sql;
  let db: Kysely<any>;
  let pageRepo: PageRepo;
  let permRepo: PagePermissionRepo;
  let pages: PageService;
  let installer: PageRestrictionGuardInstaller;
  /** Pages the (stubbed) PEP reports the mover cannot see — upstream orphans those on a move-to-space. */
  const hidden = new Set<string>();

  const page = (id: string, parent: string | null, opts: { space?: string; trashed?: boolean } = {}) => pg`
    insert into pages (id, workspace_id, space_id, parent_page_id, position, deleted_at, deleted_by_id)
    values (${id}, ${WS}, ${opts.space ?? S1}, ${parent}, ${POS},
            ${opts.trashed ? new Date() : null}, ${opts.trashed ? USER : null})`;
  const restrict = (id: string) =>
    pg`insert into page_access (page_id, workspace_id, space_id, access_level) values (${id}, ${WS}, ${S1}, 'members')`;
  const row = async (id: string) =>
    (await pg<{ spaceId: string; parentPageId: string | null; deletedAt: Date | null }[]>`
      select space_id as "spaceId", parent_page_id as "parentPageId", deleted_at as "deletedAt" from pages where id = ${id}`)[0];
  const accessRows = async () =>
    (await pg<{ pageId: string; spaceId: string }[]>`
      select page_id as "pageId", space_id as "spaceId" from page_access order by page_id`).map((r) => ({ ...r }));
  const outboxCount = async () => (await pg<{ c: number }[]>`select count(*)::int as c from authz_outbox`)[0].c;
  const fresh = (id: string) => pageRepo.findById(id);
  const moveToSpace = async (id: string, space: string) => pages.movePageToSpace(await fresh(id), space, USER);
  const move = async (id: string, parent: string | null) =>
    pages.movePage({ pageId: id, parentPageId: parent, position: POS } as never, await fresh(id));
  /** The constraint a rejected write raised (the REAL postgres.js error), or 'resolved'. */
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'resolved',
      (e) => (e as { constraint_name?: string }).constraint_name ?? `unexpected: ${(e as Error).message}`,
    );
  /** Resolves once some other session is WAITING on an advisory lock — i.e. is parked on the guard's lock. */
  const waitForLockWaiter = async () => {
    for (let i = 0; i < 100; i++) {
      const [{ c }] = await pg<{ c: number }[]>`
        select count(*)::int as c from pg_locks where locktype = 'advisory' and not granted`;
      if (c > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no session ever waited on the guard lock');
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 4);
    side = mkReadModelPg(SCHEMA, 1);
    db = mkReadModelDb(appPg);
    // The Docmost tables these paths (and the outbox capture) touch, with the migrations' RI cascades.
    await pg`create table users (id uuid primary key, email varchar, role varchar, deleted_at timestamptz)`;
    await pg`create table groups (id uuid primary key, name varchar)`;
    await pg`create table spaces (id uuid primary key, name varchar, workspace_id uuid not null, deleted_at timestamptz)`;
    await pg`
      create table space_members (
        id uuid primary key default gen_random_uuid(), user_id uuid, group_id uuid,
        space_id uuid not null references spaces (id) on delete cascade, role varchar not null, deleted_at timestamptz
      )`;
    await pg`
      create table group_users (
        id uuid primary key default gen_random_uuid(), user_id uuid not null, group_id uuid not null
      )`;
    await pg`
      create table pages (
        id uuid primary key, slug_id varchar, title varchar, icon varchar, cover_photo varchar, position varchar,
        parent_page_id uuid references pages (id) on delete cascade, creator_id uuid, last_updated_by_id uuid,
        space_id uuid not null references spaces (id) on delete cascade, workspace_id uuid not null,
        is_locked boolean not null default false, is_base boolean not null default false, contributor_ids uuid[],
        content jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        deleted_at timestamptz, deleted_by_id uuid
      )`;
    await pg`
      create table page_access (
        id uuid primary key default gen_random_uuid(),
        page_id uuid not null unique references pages (id) on delete cascade, workspace_id uuid not null,
        space_id uuid not null references spaces (id) on delete cascade, access_level varchar not null,
        creator_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      )`;
    await pg`
      create table page_permissions (
        id uuid primary key default gen_random_uuid(),
        page_access_id uuid not null references page_access (id) on delete cascade,
        user_id uuid, group_id uuid, role varchar not null
      )`;
    for (const t of ['shares', 'comments', 'page_verifications', 'notifications']) {
      await pg.unsafe(`create table ${t} (id uuid primary key default gen_random_uuid(), page_id uuid, space_id uuid)`);
    }
    await pg`insert into spaces (id, workspace_id) values (${S1}, ${WS}), (${S2}, ${WS})`;

    await (new AuthzOutboxInstaller(db as never, 'remote') as unknown as { install(): Promise<void> }).install();
    await new PageCycleGuardInstaller(db as never, 'remote').install();
    installer = new PageRestrictionGuardInstaller(db as never, 'remote');
    await installer.install();

    const events = { emit: () => true };
    pageRepo = new PageRepo(db as never, {} as never, events as never);
    permRepo = new PagePermissionRepo(db as never, {} as never, {} as never);
    const queue = { add: async () => undefined };
    pages = new PageService(
      pageRepo,
      {
        filterAccessiblePageIds: async ({ pageIds }: { pageIds: string[] }) => pageIds.filter((id) => !hidden.has(id)),
      } as never,
      { updateAttachmentsByPageId: async () => undefined } as never,
      db as never,
      {} as never,
      queue as never,
      queue as never,
      queue as never,
      events as never,
      {} as never,
      { movePageWatchersToSpace: async () => undefined } as never,
      {} as never,
    );
  });

  afterEach(async () => {
    hidden.clear();
    await pg`delete from page_access`;
    await pg`delete from pages`;
    await pg`delete from authz_outbox`;
  });

  afterAll(async () => {
    await db?.destroy();
    await side?.end({ timeout: 5 });
    await pg?.end({ timeout: 5 });
  });

  describe('g1: move-to-space (the engine deletes the moved pages’ restrictions and re-roots the page)', () => {
    it('refuses a RESTRICTED page — and the whole write rolls back, outbox rows included', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await restrict(uuid(1));
      const outboxBefore = await outboxCount();
      expect(await outcome(moveToSpace(uuid(1), S2))).toBe(RESTRICTED_SPACE_MOVE);
      expect(await row(uuid(1))).toMatchObject({ spaceId: S1, parentPageId: null });
      expect(await row(uuid(2))).toMatchObject({ spaceId: S1, parentPageId: uuid(1) });
      expect(await accessRows()).toEqual([{ pageId: uuid(1), spaceId: S1 }]);
      expect(await outboxCount()).toBe(outboxBefore);
    });

    it('refuses a page under a restricted ancestor (a TRASHED one too — trash does not lift a restriction)', async () => {
      await page(uuid(1), null, { trashed: true });
      await page(uuid(2), uuid(1));
      await restrict(uuid(1));
      expect(await outcome(moveToSpace(uuid(2), S2))).toBe(RESTRICTED_SPACE_MOVE);
      expect(await row(uuid(2))).toMatchObject({ spaceId: S1, parentPageId: uuid(1) });
    });

    it('refuses an unrestricted page whose moved subtree contains a restricted page the mover can see', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await page(uuid(3), uuid(2));
      await restrict(uuid(2));
      expect(await outcome(moveToSpace(uuid(1), S2))).toBe(RESTRICTED_SPACE_MOVE);
      for (const id of [uuid(1), uuid(2), uuid(3)]) expect((await row(id)).spaceId).toBe(S1);
      expect(await accessRows()).toEqual([{ pageId: uuid(2), spaceId: S1 }]);
    });

    it('refuses when the page’s lineage cannot be walked (a dangling parent counts as restricted)', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await pg`alter table pages drop constraint pages_parent_page_id_fkey`;
      try {
        await pg`update pages set parent_page_id = ${uuid(999)} where id = ${uuid(1)}`;
        expect(await outcome(moveToSpace(uuid(2), S2))).toBe(RESTRICTED_SPACE_MOVE);
      } finally {
        await pg`delete from pages`;
        await pg`alter table pages add constraint pages_parent_page_id_fkey foreign key (parent_page_id) references pages (id) on delete cascade`;
      }
    });

    it('allows an unrestricted subtree, and one whose hidden restricted child is orphaned in place (it keeps its restriction)', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await page(uuid(3), uuid(1));
      await restrict(uuid(3));
      hidden.add(uuid(3));
      expect(await outcome(moveToSpace(uuid(1), S2))).toBe('resolved');
      expect(await row(uuid(1))).toMatchObject({ spaceId: S2, parentPageId: null });
      expect(await row(uuid(2))).toMatchObject({ spaceId: S2, parentPageId: uuid(1) });
      expect(await row(uuid(3))).toMatchObject({ spaceId: S1, parentPageId: null });
      expect(await accessRows()).toEqual([{ pageId: uuid(3), spaceId: S1 }]);
    });
  });

  describe('g2: a parent change may not take an unrestricted page out from under its last restricted ancestor', () => {
    it('refuses moving it to the root or under an unrestricted page', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await page(uuid(3), null);
      await restrict(uuid(1));
      expect(await outcome(move(uuid(2), null))).toBe(RESTRICTION_STRIP);
      expect(await outcome(move(uuid(2), uuid(3)))).toBe(RESTRICTION_STRIP);
      expect((await row(uuid(2))).parentPageId).toBe(uuid(1));
    });

    it('allows a move within a restricted section, into one, and of a page restricted itself', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await page(uuid(3), null);
      await page(uuid(4), uuid(3));
      await page(uuid(5), null);
      await page(uuid(6), uuid(1));
      await restrict(uuid(1));
      await restrict(uuid(3));
      await restrict(uuid(6));
      expect(await outcome(move(uuid(2), uuid(4)))).toBe('resolved'); // restricted section → another
      expect(await outcome(move(uuid(5), uuid(1)))).toBe('resolved'); // unrestricted → into a section
      expect(await outcome(move(uuid(6), null))).toBe('resolved'); // carries its own restriction
    });

    it('an unfinished walk counts as restricted BEFORE the move and as unrestricted AFTER it', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await page(uuid(3), uuid(2));
      await page(uuid(4), uuid(2));
      await page(uuid(8), null);
      await restrict(uuid(4));
      await restrict(uuid(8));
      // A legacy cycle 1 ↔ 2, built past the guards as a pre-guard row would be.
      await pg`alter table pages disable trigger user`;
      await pg`update pages set parent_page_id = ${uuid(2)} where id = ${uuid(1)}`;
      await pg`alter table pages enable trigger user`;
      expect(await outcome(move(uuid(3), null))).toBe(RESTRICTION_STRIP); // out of the cycle: before = restricted
      expect(await outcome(move(uuid(3), uuid(8)))).toBe('resolved'); // into a restricted section: fine
      expect(await outcome(move(uuid(4), null))).toBe('resolved'); // restricted itself
    });

    it('a restore that would detach an unrestricted page from its trashed RESTRICTED parent is refused (half-restore pinned)', async () => {
      await page(uuid(1), null, { trashed: true });
      await page(uuid(2), uuid(1), { trashed: true });
      await restrict(uuid(1));
      expect(await outcome(pageRepo.restorePage(uuid(2), WS))).toBe(RESTRICTION_STRIP);
      // restorePage is not transactional upstream: its un-trash committed before the refused detach. The page stays
      // under its restricted parent — never declassified — but is live under a trashed parent (follow-up issue).
      expect(await row(uuid(2))).toMatchObject({ parentPageId: uuid(1), deletedAt: null });
    });

    it('a restore detaching from an UNRESTRICTED trashed parent still works', async () => {
      await page(uuid(1), null, { trashed: true });
      await page(uuid(2), uuid(1), { trashed: true });
      expect(await outcome(pageRepo.restorePage(uuid(2), WS))).toBe('resolved');
      expect(await row(uuid(2))).toMatchObject({ parentPageId: null, deletedAt: null });
    });

    it('a write that changes neither space nor parent never takes the lock or walks (a reorder, a rename)', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await restrict(uuid(1));
      const holder = await side.reserve();
      try {
        await holder`begin`;
        await holder`select pg_advisory_xact_lock(485485, hashtext(${WS}::text))`;
        await pg`update pages set parent_page_id = ${uuid(1)}, space_id = ${S1}, title = 'x' where id = ${uuid(2)}`;
      } finally {
        await holder`rollback`;
        holder.release();
      }
    });
  });

  describe('g0 + the per-workspace lock: a restrict and a move serialize', () => {
    it('g0 takes page_access.space_id from the page, never from a stale caller read', async () => {
      await page(uuid(1), null, { space: S2 });
      await permRepo.insertPageAccess({ pageId: uuid(1), workspaceId: WS, spaceId: S1, accessLevel: 'members' } as never);
      expect(await accessRows()).toEqual([{ pageId: uuid(1), spaceId: S2 }]);
    });

    it('restrict committed first ⇒ a racing move-to-space (real upstream path) waits, then is refused', async () => {
      await page(uuid(1), null);
      const x = await side.reserve();
      let moving: Promise<string>;
      try {
        await x`begin`;
        await x`insert into page_access (page_id, workspace_id, space_id, access_level) values (${uuid(1)}, ${WS}, ${S1}, 'members')`;
        moving = outcome(moveToSpace(uuid(1), S2));
        await waitForLockWaiter();
        await x`commit`;
      } finally {
        x.release();
      }
      expect(await moving!).toBe(RESTRICTED_SPACE_MOVE);
      expect(await row(uuid(1))).toMatchObject({ spaceId: S1 });
      expect(await accessRows()).toEqual([{ pageId: uuid(1), spaceId: S1 }]);
    });

    it('move committed first ⇒ a racing restrict (real repo, stale space) waits, then lands in the NEW space', async () => {
      await page(uuid(1), null);
      const x = await side.reserve();
      let restricting: Promise<unknown>;
      try {
        await x`begin`;
        await x`update pages set space_id = ${S2} where id = ${uuid(1)}`;
        restricting = permRepo.insertPageAccess({ pageId: uuid(1), workspaceId: WS, spaceId: S1, accessLevel: 'members' } as never);
        await waitForLockWaiter();
        await x`commit`;
      } finally {
        x.release();
      }
      await restricting!;
      expect(await accessRows()).toEqual([{ pageId: uuid(1), spaceId: S2 }]);
      // …so deleting the OLD space no longer cascades the restriction away (the page lives in S2).
      await pg`delete from spaces where id = ${S1}`;
      try {
        expect(await accessRows()).toEqual([{ pageId: uuid(1), spaceId: S2 }]);
      } finally {
        await pg`insert into spaces (id, workspace_id) values (${S1}, ${WS})`;
      }
    });

    it('the lock is taken even when the page looks unrestricted: an ancestor restricted concurrently is seen', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      const x = await side.reserve();
      let moving: Promise<string>;
      try {
        await x`begin`;
        await x`insert into page_access (page_id, workspace_id, space_id, access_level) values (${uuid(1)}, ${WS}, ${S1}, 'members')`;
        moving = outcome(move(uuid(2), null)); // unrestricted lineage at read time
        await waitForLockWaiter();
        await x`commit`;
      } finally {
        x.release();
      }
      expect(await moving!).toBe(RESTRICTION_STRIP);
      expect((await row(uuid(2))).parentPageId).toBe(uuid(1));
    });
  });

  describe('installer', () => {
    it('is idempotent and runs no DDL when current; a disabled trigger is re-established', async () => {
      expect(await installer.isCurrent()).toBe(true);
      expect(await installer.install()).toBe(false);
      await pg`alter table pages disable trigger ccc_page_restriction_guard`;
      expect(await installer.isCurrent()).toBe(false);
      expect(await installer.install()).toBe(true);
      expect(await installer.isCurrent()).toBe(true);
    });

    it('does nothing outside remote mode', async () => {
      const spy = jest.spyOn(PageRestrictionGuardInstaller.prototype, 'install');
      await new PageRestrictionGuardInstaller(db as never, 'native' as never).onApplicationBootstrap();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('the REAL driver error maps to a 409 with a fixed body (no ids)', () => {
    it.each([
      ['restricted space move', RESTRICTED_SPACE_MOVE],
      ['restriction strip', RESTRICTION_STRIP],
      ['cycle', 'ccc_page_no_cycle'],
    ])('%s', async (_name, constraint) => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      await restrict(uuid(1));
      const write =
        constraint === RESTRICTED_SPACE_MOVE
          ? moveToSpace(uuid(1), S2)
          : constraint === RESTRICTION_STRIP
            ? move(uuid(2), null)
            : move(uuid(1), uuid(2));
      const err = await write.then(() => null, (e) => e);
      const mapped = toPageGuardConflict(err);
      expect(mapped).toBeInstanceOf(ConflictException);
      expect(mapped!.getResponse()).toEqual({ message: expect.any(String), code: constraint });
      expect(JSON.stringify(mapped!.getResponse())).not.toContain(uuid(1));
    });
  });
});
