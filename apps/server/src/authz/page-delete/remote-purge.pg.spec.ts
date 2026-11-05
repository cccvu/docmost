import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { HttpException } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../../core/page/services/page.service';
import { AuthzOutboxInstaller } from '../../service-bridge/authz-outbox.installer';
import { PageCycleGuardInstaller } from '../../service-bridge/page-cycle-guard.installer';
import { PageRestrictionGuardInstaller } from '../../service-bridge/page-restriction-guard.installer';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';

// PageService imports the collab gateway, whose lib0/hocuspocus ESM graph jest cannot load; the paths driven here
// never touch it (the same stub the conditional-ops pg spec uses).
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { RemotePurgeService } from './remote-purge.service';
import { pageEtagOpaque } from '../page-write/page-etag';

/**
 * #636 W6 on real Postgres: the remote purge decided under locks, after a settle fence, against the REAL upstream
 * `PageService.forceDelete`, the real #493/#545 guard triggers and the authz outbox. The platform is a fake that models
 * exactly what the fence relies on: its relay has projected the outbox up to a cursor, `settle(P)` is `confirmed`
 * only once that cursor is at or past `P`, and its `page#edit` answers come from what it has projected (a restricted
 * page and everything under it has no edit). What these prove:
 *  - (b) a restrict on a descendant that starts while the purge holds its locks waits for the purge (and then finds
 *    its page gone); a move of a subtree page and a move INTO the subtree wait the same way;
 *  - (b, reverse) a restrict committed BEFORE the purge but not yet projected: the fence refuses (503) and nothing is
 *    asked or deleted; once projected, the decision refuses (403);
 *  - (c) a child insert under a locked page waits and is never purged unchecked; a child committed (and restricted)
 *    while the purge waited for its lock is re-walked, locked and decided;
 *  - the deleted set must BE the locked set, or the whole purge rolls back;
 *  - a lock held elsewhere past lock_timeout is a 503 `engine_busy` with nothing changed.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG remote purge gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'remote_purge_pg_spec';
const WS = uuid(100);
const S1 = uuid(50);
const S2 = uuid(51);
const USER = uuid(900);
const SA = uuid(950);
const ACTOR = { id: USER } as never;

/** "<xact_id>.<id>" → comparable pair (the platform's `comparePositions`). */
const pos = (p: string): [bigint, bigint] => {
  const [x, i] = p.split('.');
  return [BigInt(x), BigInt(i)];
};
const atOrPast = (a: string, b: string) => {
  const [ax, ai] = pos(a);
  const [bx, bi] = pos(b);
  return ax !== bx ? ax > bx : ai >= bi;
};

d('RemotePurgeService on real Postgres (#636 W6)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  /** A second session: it holds a transaction open while the purge under test runs. */
  let side: postgres.Sql;
  let db: Kysely<any>;
  let pageRepo: PageRepo;
  let pages: PageService;
  let purge: RemotePurgeService;
  const jobs: string[] = [];
  const audits: string[] = [];

  /** The fake platform: a relay cursor, the page locks it has projected, and every id it was asked about. */
  const platform = {
    cursor: '0.0',
    locked: new Set<string>(),
    asked: [] as string[],
    /** `<subject>:<space>` pairs asked for `space#administer`, and the spaces each subject does NOT administer. */
    askedSpaces: [] as string[],
    notAdmin: new Map<string, Set<string>>(),
    /** Pages the service account cannot edit (on top of the projected locks). */
    saCannotEdit: new Set<string>(),
    settles: [] as string[],
    /** Runs inside the purge at the fence — i.e. while it holds every subtree lock — once. */
    atFence: null as null | (() => Promise<void>),
  };
  const authz = {
    settleProjection: async (position: string, _waitMs: number) => {
      platform.settles.push(position);
      if (platform.atFence) {
        const hook = platform.atFence;
        platform.atFence = null;
        await hook();
      }
      return atOrPast(platform.cursor, position)
        ? ({ status: 'confirmed' } as const)
        : ({ status: 'pending', reason: 'timeout' } as const);
    },
    tryCheckBulk: async (
      subject: { externalId?: string; principalId?: string; subjectType?: string },
      checks: { resourceType: string; resourceId: string }[],
    ) => {
      const who = subject.subjectType === 'service' ? `sa:${subject.principalId}` : 'human';
      if (checks[0]?.resourceType === 'space') {
        platform.askedSpaces.push(...checks.map((c) => `${who}:${c.resourceId}`));
        return checks.map((c) => !platform.notAdmin.get(who)?.has(c.resourceId));
      }
      if (who === 'human') platform.asked.push(...checks.map((c) => c.resourceId));
      return checks.map(
        (c) => !platform.locked.has(c.resourceId) && !(who !== 'human' && platform.saCannotEdit.has(c.resourceId)),
      );
    },
  };
  /** The relay catches up: everything committed is projected (a restricted page locks its whole subtree). */
  const project = async () => {
    const [{ p }] = await pg<{ p: string | null }[]>`
      select xact_id::text || '.' || id::text as p from authz_outbox order by xact_id desc, id desc limit 1`;
    platform.cursor = p ?? '0.0';
    const rows = await pg<{ id: string }[]>`
      with recursive l(id) as (select page_id from page_access
                               union select p.id from pages p join l on p.parent_page_id = l.id)
      select id from l`;
    platform.locked = new Set(rows.map((r) => r.id));
  };

  const page = (id: string, parent: string | null, opts: { trashed?: boolean } = {}) => pg`
    insert into pages (id, slug_id, title, workspace_id, space_id, parent_page_id, position, last_updated_by_id,
                       content, updated_at, deleted_at, deleted_by_id)
    values (${id}, ${`slug-${id.slice(-4)}`}, 'Title', ${WS}, ${S1}, ${parent}, 'a0000', ${USER},
            ${pg.json({ type: 'doc', content: [] })}, '2026-09-26 10:00:00.123456+00',
            ${opts.trashed ? new Date() : null}, ${opts.trashed ? USER : null})`;
  const restrictSql = (x: postgres.Sql | postgres.ReservedSql, id: string) =>
    x`insert into page_access (page_id, workspace_id, space_id, access_level) values (${id}, ${WS}, ${S1}, 'members')`;
  const exists = async (...ids: string[]) =>
    (await pg<{ id: string }[]>`select id from pages where id in ${pg(ids)} order by id`).map((r) => r.id);
  /** Resolves once some session is WAITING on a lock (bounded poll of pg_locks). */
  const waitForLockWaiter = async () => {
    for (let i = 0; i < 150; i++) {
      const [{ c }] = await pg<{ c: number }[]>`select count(*)::int as c from pg_locks where not granted`;
      if (c > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no session ever waited on a lock');
  };
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'applied',
      (e) =>
        e instanceof HttpException
          ? `${e.getStatus()}:${(e.getResponse() as { code?: string }).code ?? ''}`
          : `error:${(e as { code?: string }).code ?? (e as Error).message}`,
    );
  /** Run `stmts` in a side transaction that stays OPEN; the returned functions commit or roll it back. */
  const openSide = async (stmts: (x: postgres.ReservedSql) => Promise<unknown>) => {
    const x = await side.reserve();
    await x`begin`;
    await x.unsafe(`set local lock_timeout = '10s'`);
    await stmts(x);
    return {
      commit: async () => {
        await x`commit`;
        x.release();
      },
    };
  };
  /** Start `stmts` in a side transaction and commit it; resolves to 'committed' or the SQLSTATE it failed with. */
  const sideTx = (stmts: (x: postgres.ReservedSql) => Promise<unknown>): Promise<string> =>
    side.reserve().then(async (x) => {
      try {
        await x`begin`;
        await x.unsafe(`set local lock_timeout = '10s'`);
        await stmts(x);
        await x`commit`;
        return 'committed';
      } catch (e) {
        await x`rollback`.catch(() => undefined);
        return (e as { code?: string }).code ?? 'error';
      } finally {
        x.release();
      }
    });

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 6);
    side = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    await pg`create table users (id uuid primary key, email varchar, name varchar, avatar_url varchar, role varchar, deleted_at timestamptz)`;
    await pg`create table groups (id uuid primary key, name varchar)`;
    await pg`create table spaces (id uuid primary key, name varchar, slug varchar, workspace_id uuid not null,
                                  updated_at timestamptz not null default now(), deleted_at timestamptz)`;
    await pg`
      create table space_members (
        id uuid primary key default gen_random_uuid(), user_id uuid, group_id uuid,
        space_id uuid not null references spaces (id) on delete cascade, role varchar not null, deleted_at timestamptz
      )`;
    await pg`create table group_users (id uuid primary key default gen_random_uuid(), user_id uuid not null, group_id uuid not null)`;
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
    await pg`insert into users (id, name) values (${USER}, 'Actor')`;
    await pg`insert into spaces (id, workspace_id) values (${S1}, ${WS}), (${S2}, ${WS})`;

    await (new AuthzOutboxInstaller(db as never, 'remote') as unknown as { install(): Promise<void> }).install();
    await new PageCycleGuardInstaller(db as never, 'remote').install();
    await new PageRestrictionGuardInstaller(db as never, 'remote').install();

    const events = { emit: () => true };
    pageRepo = new PageRepo(db as never, {} as never, events as never);
    const queue = (name: string) => ({
      add: async (job: string, data: { pageId?: string }) => void jobs.push(`${name}:${job}:${data?.pageId ?? ''}`),
    });
    pages = new PageService(
      pageRepo,
      { filterAccessiblePageIds: async ({ pageIds }: { pageIds: string[] }) => pageIds } as never,
      { updateAttachmentsByPageId: async () => undefined } as never,
      db as never,
      {} as never,
      queue('service-attachment') as never,
      queue('ai') as never,
      queue('general') as never,
      events as never,
      {} as never,
      { movePageWatchersToSpace: async () => undefined } as never,
      {} as never,
    );
    const allow = { can: () => true, cannot: () => false };
    purge = new RemotePurgeService(
      db as never,
      pageRepo,
      pages,
      { createForUser: async () => allow } as never,
      authz as never,
      { log: (p: { event: string }) => void audits.push(p.event) } as never,
      { add: async (_j: string, data: { pageId: string }) => void jobs.push(`purge:${data.pageId}`) } as never,
    );
  });

  beforeEach(async () => {
    // The tree: 1 → {2 → {4 (trashed)}, 3}; 9 is outside it.
    await page(uuid(1), null);
    await page(uuid(2), uuid(1));
    await page(uuid(3), uuid(1));
    await page(uuid(4), uuid(2), { trashed: true });
    await page(uuid(9), null);
    await project();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    platform.atFence = null;
    platform.asked.length = 0;
    platform.askedSpaces.length = 0;
    platform.notAdmin.clear();
    platform.saCannotEdit.clear();
    platform.settles.length = 0;
    jobs.length = 0;
    audits.length = 0;
    await pg`delete from page_access`;
    await pg`delete from pages`;
    await pg`update spaces set deleted_at = null`;
    await pg`delete from authz_outbox`;
  });

  afterAll(async () => {
    await db?.destroy();
    await side?.end({ timeout: 5 });
    await pg?.end({ timeout: 5 });
  });

  const SUBTREE = [uuid(1), uuid(2), uuid(3), uuid(4)];

  describe('the decision covers the whole subtree', () => {
    it('every page editable → the whole subtree (the trashed page included) is purged; jobs and the audit after the commit', async () => {
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('applied');
      expect(await exists(...SUBTREE, uuid(9))).toEqual([uuid(9)]);
      expect([...platform.asked].sort()).toEqual([...SUBTREE].sort());
      expect(jobs.filter((j) => j.startsWith('service-attachment'))).toEqual([]); // none from inside the transaction
      expect(jobs.filter((j) => j.startsWith('purge:')).sort()).toEqual(SUBTREE.map((id) => `purge:${id}`).sort());
      expect(audits).toEqual(['page.deleted']);
    });

    it('a projected restriction on a descendant → 403 purge_needs_edit, nothing deleted, nothing queued', async () => {
      await restrictSql(pg, uuid(2));
      await project();
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('403:purge_needs_edit');
      expect(await exists(...SUBTREE)).toEqual([...SUBTREE].sort());
      expect(jobs).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('a stale ETag → 412, nothing deleted; the current one (or `*`) applies', async () => {
      const current = pageEtagOpaque(
        JSON.parse(JSON.stringify(await pageRepo.findById(uuid(1), { includeContent: true, includeLastUpdatedBy: true }))),
      );
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS, ['f'.repeat(64)]))).toBe('412:precondition_failed');
      expect(await exists(uuid(1))).toEqual([uuid(1)]);
      expect(platform.settles).toEqual([]); // refused before the fence
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS, [current]))).toBe('applied');
      expect(await exists(uuid(1))).toEqual([]);
    });
  });

  describe('(b) a concurrent access change on a subtree page', () => {
    it('a restrict that starts while the purge holds its locks waits for the purge, then finds its page gone', async () => {
      const order: string[] = [];
      let restrict!: Promise<string>;
      platform.atFence = async () => {
        restrict = sideTx((x) => restrictSql(x, uuid(3))).then((r) => (order.push('restrict-done'), r));
        await waitForLockWaiter(); // blocked on our FOR UPDATE (g0's foreign key: FOR KEY SHARE on page 3)
        order.push('restrict-waiting');
      };
      const result = await outcome(purge.purge(ACTOR, uuid(1), WS)).then((o) => (order.push('purge-done'), o));
      expect(result).toBe('applied');
      expect(await restrict).toBe('23503'); // the page it waited for was purged: the foreign key refuses it
      expect(order).toEqual(['restrict-waiting', 'purge-done', 'restrict-done']);
      expect(await pg`select 1 from page_access`).toHaveLength(0);
    });

    it('a move OF a subtree page, and a move of an outside page INTO the subtree, wait for the purge the same way', async () => {
      for (const [label, stmt] of [
        ['re-parent a subtree page', (x: postgres.ReservedSql) => x`update pages set parent_page_id = ${uuid(9)} where id = ${uuid(3)}`],
        ['move an outside page in', (x: postgres.ReservedSql) => x`update pages set parent_page_id = ${uuid(2)} where id = ${uuid(9)}`],
      ] as const) {
        const order: string[] = [];
        let move!: Promise<string>;
        platform.atFence = async () => {
          move = sideTx(stmt).then((r) => (order.push('move-done'), r));
          await waitForLockWaiter();
        };
        const result = await outcome(purge.purge(ACTOR, uuid(1), WS)).then((o) => (order.push('purge-done'), o));
        expect([label, result]).toEqual([label, 'applied']);
        await move;
        expect([label, order]).toEqual([label, ['purge-done', 'move-done']]);
        // Page 9 survives either way: it was never in the subtree the purge decided and locked.
        expect([label, await exists(uuid(9))]).toEqual([label, [uuid(9)]]);
        await pg`delete from pages`;
        for (const [id, parent] of [[1, null], [2, 1], [3, 1], [4, 2], [9, null]] as const) {
          await page(uuid(id), parent === null ? null : uuid(parent));
        }
        await project();
      }
    });

    it('a restrict that commits while the purge WAITS for its lock is behind the fence: unprojected → 503, nothing asked or deleted', async () => {
      // The side has restricted page 2 (g0: FOR KEY SHARE on it) but not committed; the purge's FOR UPDATE waits for it.
      const tx = await openSide((x) => restrictSql(x, uuid(2)));
      const running = outcome(purge.purge(ACTOR, uuid(1), WS));
      await waitForLockWaiter();
      await tx.commit(); // the relay has NOT projected it: a fence read before the locks would miss it
      expect(await running).toBe('503:purge_unconfirmed');
      expect(platform.asked).toEqual([]);
      expect(await exists(...SUBTREE)).toEqual([...SUBTREE].sort());
    });

    it('reverse order: a restrict committed BEFORE the purge but not yet projected → the fence refuses (503); projected → 403', async () => {
      await restrictSql(pg, uuid(4)); // committed; the relay has not projected it
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('503:purge_unconfirmed');
      expect(platform.asked).toEqual([]); // never decided on the stale PDP
      expect(await exists(...SUBTREE)).toEqual([...SUBTREE].sort());
      expect(jobs).toEqual([]);
      // The fence was read AFTER the restrict's commit: the platform was asked to settle past it.
      const [{ p }] = await pg<{ p: string }[]>`
        select xact_id::text || '.' || id::text as p from authz_outbox order by xact_id desc, id desc limit 1`;
      expect(atOrPast(platform.settles[0], p)).toBe(true);

      await project();
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('403:purge_needs_edit');
      expect(await exists(...SUBTREE)).toEqual([...SUBTREE].sort());
    });
  });

  describe('(c) a concurrent child insert', () => {
    it('an insert under a locked page waits for the purge, then fails: it is never purged unchecked', async () => {
      let insert!: Promise<string>;
      platform.atFence = async () => {
        insert = sideTx((x) => x`
          insert into pages (id, workspace_id, space_id, parent_page_id, position) values (${uuid(5)}, ${WS}, ${S1}, ${uuid(2)}, 'a0000')`);
        await waitForLockWaiter(); // the parent foreign key: FOR KEY SHARE on page 2, blocked by our FOR UPDATE
      };
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('applied');
      expect(await insert).toBe('23503');
      expect(platform.asked).not.toContain(uuid(5));
      expect(await exists(uuid(5))).toEqual([]);
    });

    it('a child committed — and restricted — while the purge waited for its lock is re-walked, locked and decided (403)', async () => {
      // The side holds FOR KEY SHARE on page 2 (its new child's foreign key) and has restricted the child: uncommitted.
      const tx = await openSide(async (x) => {
        await x`insert into pages (id, workspace_id, space_id, parent_page_id, position) values (${uuid(5)}, ${WS}, ${S1}, ${uuid(2)}, 'a0000')`;
        await restrictSql(x, uuid(5));
      });
      platform.atFence = project; // the relay catches up while the purge holds its locks
      const running = outcome(purge.purge(ACTOR, uuid(1), WS));
      await waitForLockWaiter(); // our FOR UPDATE on page 2 waits for the side
      await tx.commit();
      expect(await running).toBe('403:purge_needs_edit');
      expect(platform.asked).toContain(uuid(5)); // the first walk could not see it; the re-walk under the locks did
      expect(await exists(...SUBTREE, uuid(5))).toEqual([...SUBTREE, uuid(5)].sort());
    });

    it('the same child, unrestricted, is decided and purged with the rest', async () => {
      const tx = await openSide((x) => x`
        insert into pages (id, workspace_id, space_id, parent_page_id, position) values (${uuid(5)}, ${WS}, ${S1}, ${uuid(2)}, 'a0000')`);
      platform.atFence = project;
      const running = outcome(purge.purge(ACTOR, uuid(1), WS));
      await waitForLockWaiter();
      await tx.commit();
      expect(await running).toBe('applied');
      expect([...platform.asked].sort()).toEqual([...SUBTREE, uuid(5)].sort());
      expect(await exists(...SUBTREE, uuid(5))).toEqual([]);
    });
  });

  describe('#618: space admin on EVERY space of the subtree, by the PDP', () => {
    it('a descendant left in another space the human does not administer → upstream’s 403, nothing deleted', async () => {
      await pg`update pages set space_id = ${S2} where id = ${uuid(3)}`; // a page a move-to-space skipped
      platform.notAdmin.set('human', new Set([S2]));
      await project();
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('403:');
      expect([...platform.askedSpaces].sort()).toEqual([`human:${S1}`, `human:${S2}`].sort());
      expect(platform.asked).toEqual([]); // edit is never asked once space admin is refused
      expect(await exists(...SUBTREE)).toEqual([...SUBTREE].sort());
      expect(jobs).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('control: admin of both spaces → the cross-space subtree is purged', async () => {
      await pg`update pages set space_id = ${S2} where id = ${uuid(3)}`;
      await project();
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('applied');
      expect(await exists(...SUBTREE)).toEqual([]);
    });
  });

  describe('#589: an archived space is frozen against a purge', () => {
    it('the root’s space archived → 409 space_archived before any lock or settle; nothing deleted', async () => {
      await pg`update spaces set deleted_at = now() where id = ${S1}`;
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('409:space_archived');
      expect(platform.settles).toEqual([]);
      expect(await exists(...SUBTREE)).toEqual([...SUBTREE].sort());
    });

    it('a descendant’s space archived → 409 under the locks; nothing deleted', async () => {
      await pg`update pages set space_id = ${S2} where id = ${uuid(3)}`;
      await pg`update spaces set deleted_at = now() where id = ${S2}`;
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('409:space_archived');
      expect(platform.settles).toEqual([]);
      expect(platform.asked).toEqual([]);
      expect(await exists(...SUBTREE)).toEqual([...SUBTREE].sort());
    });

    it('an archive that starts while the purge holds its FOR SHARE lock waits for the purge', async () => {
      const order: string[] = [];
      let archive!: Promise<string>;
      platform.atFence = async () => {
        archive = sideTx((x) => x`update spaces set deleted_at = now() where id = ${S1}`).then(
          (r) => (order.push('archive-done'), r),
        );
        await waitForLockWaiter(); // blocked on our FOR SHARE on the space row
        order.push('archive-waiting');
      };
      const result = await outcome(purge.purge(ACTOR, uuid(1), WS)).then((o) => (order.push('purge-done'), o));
      expect(result).toBe('applied');
      expect(await archive).toBe('committed');
      expect(order).toEqual(['archive-waiting', 'purge-done', 'archive-done']);
    });

    it('control: a page insert into the space is NOT blocked by the FOR SHARE (it takes only KEY SHARE)', async () => {
      let insert!: string;
      platform.atFence = async () => {
        insert = await sideTx((x) => x`
          insert into pages (id, workspace_id, space_id, parent_page_id, position) values (${uuid(20)}, ${WS}, ${S1}, ${uuid(9)}, 'a0000')`);
      };
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('applied');
      expect(insert).toBe('committed');
    });
  });

  describe('#670: the delegated service account, decided under the same locks', () => {
    it('the service account cannot edit one descendant → 403 purge_needs_edit, nothing deleted; the human was decided first', async () => {
      platform.saCannotEdit.add(uuid(3));
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS, undefined, SA))).toBe('403:purge_needs_edit');
      expect(platform.asked.sort()).toEqual([...SUBTREE].sort());
      expect(platform.askedSpaces).toEqual([`human:${S1}`, `sa:${SA}:${S1}`]);
      expect(await exists(...SUBTREE)).toEqual([...SUBTREE].sort());
    });

    it('the service account does not administer the space → 403, nothing deleted', async () => {
      platform.notAdmin.set(`sa:${SA}`, new Set([S1]));
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS, undefined, SA))).toBe('403:');
      expect(await exists(...SUBTREE)).toEqual([...SUBTREE].sort());
    });

    it('anti-bypass: a human the PDP refuses is never decided for the service account', async () => {
      await restrictSql(pg, uuid(2));
      await project();
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS, undefined, SA))).toBe('403:purge_needs_edit');
      expect(platform.askedSpaces.filter((a) => a.startsWith('sa:'))).toEqual([]);
    });

    it('both allowed → purged', async () => {
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS, undefined, SA))).toBe('applied');
      expect(await exists(...SUBTREE)).toEqual([]);
    });
  });

  describe('fail closed, nothing changed', () => {
    it('the deleted set is not the locked set → 409 and the whole purge rolls back', async () => {
      const real = pages.forceDelete.bind(pages);
      jest.spyOn(pages, 'forceDelete').mockImplementationOnce(async (...args: Parameters<PageService['forceDelete']>) => [
        ...(await real(...args)),
        uuid(77),
      ]);
      expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('409:purge_subtree_changed');
      expect(await exists(...SUBTREE)).toEqual([...SUBTREE].sort());
      expect(jobs).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('a subtree row locked elsewhere past lock_timeout → 503 engine_busy, nothing deleted', async () => {
      const x = await side.reserve();
      try {
        await x`begin`;
        await x`select id from pages where id = ${uuid(4)} for key share`; // only FOR UPDATE conflicts with this
        const started = Date.now();
        expect(await outcome(purge.purge(ACTOR, uuid(1), WS))).toBe('503:engine_busy');
        expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      } finally {
        await x`rollback`;
        x.release();
      }
      expect(await exists(...SUBTREE)).toEqual([...SUBTREE].sort());
      expect(platform.settles).toEqual([]);
    });
  });
});
