import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { HttpException, Logger } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { EventName } from '../../common/events/event.contants';
import { PageService } from '../../core/page/services/page.service';
import { AuthzOutboxInstaller } from '../../service-bridge/authz-outbox.installer';
import { PageCycleGuardInstaller } from '../../service-bridge/page-cycle-guard.installer';
import { PageRestrictionGuardInstaller, RESTRICTION_STRIP } from '../../service-bridge/page-restriction-guard.installer';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';

// PageService imports the collab gateway, whose lib0/hocuspocus ESM graph jest cannot load; the paths driven here
// never touch it (the same stub the trash and purge pg specs use).
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { RemoteRestoreService } from './remote-restore.service';
import { RemoteTrashService } from './remote-trash.service';
import { RESTORE_RESTRICTION_STRIP_MESSAGE } from './page-delete-errors';

/**
 * #556 on real Postgres: the remote restore decided under `FOR NO KEY UPDATE` locks against the REAL upstream
 * `PageRepo.restorePage` (seam #172: one transaction, the decided set), the real #493/#545 guard triggers and the authz
 * outbox. The platform is a fake modelling what the routine relies on: its relay has projected the outbox up to a
 * cursor, and its `page#edit` comes from what it has projected — a page it has not placed has no edit, a restricted page
 * and its subtree have none, unless the person holds a direct page grant. What these prove:
 *  - only the pages trashed TOGETHER with the root come back; a sub-page trashed on its own earlier stays in the trash;
 *  - a live page is a no-op that writes nothing (no un-trash of its trashed descendants);
 *  - a refused detach (g2) rolls the WHOLE restore back: 409 with the restore wording, no row, outbox row or event;
 *  - the batch identity is the exact stamp: same time AND same actor, a null actor matching a null actor;
 *  - a batch page the person (or the delegated service account) cannot edit → 403, nothing restored;
 *  - races, interleaved deterministically by polling `pg_locks`: a restore waits for a concurrent trash of the parent
 *    and then detaches; a restore against a move-to-space holding the guard lock deadlocks → 503 engine_busy, nothing
 *    changed.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG remote restore gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'remote_restore_pg_spec';
const WS = uuid(100);
const S1 = uuid(50);
const S2 = uuid(51);
const USER = uuid(900);
const OTHER = uuid(901);
const SA = uuid(950);
const ACTOR = { id: USER } as never;
/** Two trash stamps: one earlier, separate trash, and the trash that took the page being restored. */
const EARLIER = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-02-01T00:00:00.000Z');

const pos = (p: string): [bigint, bigint] => {
  const [x, i] = p.split('.');
  return [BigInt(x), BigInt(i)];
};
const atOrPast = (a: string, b: string) => {
  const [ax, ai] = pos(a);
  const [bx, bi] = pos(b);
  return ax !== bx ? ax > bx : ai >= bi;
};

d('RemoteRestoreService on real Postgres (#556)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let side: postgres.Sql;
  let db: Kysely<any>;
  let pageRepo: PageRepo;
  let restore: RemoteRestoreService;
  let trash: RemoteTrashService;
  const audits: string[] = [];
  const emitted: { name: string; payload: unknown }[] = [];

  /** The fake platform: a relay cursor, the pages it has placed, the projected locks and grants, and what it was asked. */
  const platform = {
    cursor: '0.0',
    placed: new Set<string>(),
    locked: new Set<string>(),
    /** Pages the person holds a direct edit grant on (it reaches through a restriction, never down the tree). */
    granted: new Set<string>(),
    saCannotEdit: new Set<string>(),
    asked: [] as string[],
    askedSa: [] as string[],
    settles: [] as string[],
    /** Runs at the first human decision of whichever routine asks first — i.e. while it holds its locks — once. */
    atDecide: null as null | (() => Promise<void>),
  };
  const authz = {
    settleProjection: async (position: string, _waitMs: number) => {
      platform.settles.push(position);
      return atOrPast(platform.cursor, position)
        ? ({ status: 'confirmed' } as const)
        : ({ status: 'pending', reason: 'timeout' } as const);
    },
    tryCheckBulk: async (subject: { subjectType?: string }, checks: { resourceId: string }[]) => {
      const sa = subject.subjectType === 'service';
      if (!sa && platform.atDecide) {
        const hook = platform.atDecide;
        platform.atDecide = null;
        await hook();
      }
      (sa ? platform.askedSa : platform.asked).push(...checks.map((c) => c.resourceId));
      return checks.map(
        (c) =>
          platform.placed.has(c.resourceId) &&
          (!platform.locked.has(c.resourceId) || (!sa && platform.granted.has(c.resourceId))) &&
          !(sa && platform.saCannotEdit.has(c.resourceId)),
      );
    },
  };
  /** The relay catches up: everything committed is projected and placed. */
  const project = async () => {
    const [{ p }] = await pg<{ p: string | null }[]>`
      select xact_id::text || '.' || id::text as p from authz_outbox order by xact_id desc, id desc limit 1`;
    platform.cursor = p ?? '0.0';
    platform.placed = new Set((await pg<{ id: string }[]>`select id from pages`).map((r) => r.id));
    const rows = await pg<{ id: string }[]>`
      with recursive l(id) as (select page_id from page_access
                               union select p.id from pages p join l on p.parent_page_id = l.id)
      select id from l`;
    platform.locked = new Set(rows.map((r) => r.id));
  };

  /** A page; `trashed` stamps it as one trash call would: [time, actor]. */
  const page = (id: string, parent: string | null, trashed?: [Date, string | null]) => pg`
    insert into pages (id, slug_id, title, workspace_id, space_id, parent_page_id, position, last_updated_by_id,
                       content, updated_at, deleted_at, deleted_by_id)
    values (${id}, ${`slug-${id.slice(-4)}`}, 'Title', ${WS}, ${S1}, ${parent}, 'a0000', ${USER},
            ${pg.json({ type: 'doc', content: [] })}, '2026-09-26 10:00:00.123456+00',
            ${trashed ? trashed[0] : null}, ${trashed ? trashed[1] : null})`;
  const restrict = (id: string) =>
    pg`insert into page_access (page_id, workspace_id, space_id, access_level) values (${id}, ${WS}, ${S1}, 'members')`;
  /** id → 'live' | 'trashed' and its parent. */
  const state = async (...ids: string[]) =>
    Object.fromEntries(
      (
        await pg<{ id: string; deletedAt: Date | null; parentPageId: string | null }[]>`
          select id, deleted_at as "deletedAt", parent_page_id as "parentPageId" from pages where id in ${pg(ids)}`
      ).map((r) => [r.id, `${r.deletedAt ? 'trashed' : 'live'} under ${r.parentPageId ?? 'root'}`]),
    );
  const outboxCount = async () => (await pg<{ c: number }[]>`select count(*)::int as c from authz_outbox`)[0].c;
  /** Resolves once some other session waits on a lock (`advisory` = only the guards' per-workspace lock counts). */
  const waitForLockWaiter = async (locktype?: 'advisory') => {
    for (let i = 0; i < 250; i++) {
      const [{ c }] = locktype
        ? await pg<{ c: number }[]>`select count(*)::int as c from pg_locks where not granted and locktype = 'advisory'`
        : await pg<{ c: number }[]>`select count(*)::int as c from pg_locks where not granted`;
      if (c > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no session ever waited on a lock');
  };
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      (r) => (r as { outcome: string }).outcome,
      (e) =>
        e instanceof HttpException
          ? `${e.getStatus()}:${(e.getResponse() as { code?: string }).code ?? ''}`
          : `error:${(e as { code?: string }).code ?? (e as Error).message}`,
    );
  const restoredEvents = () => emitted.filter((e) => e.name === EventName.PAGE_RESTORED);

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
    await pg`create table shares (id uuid primary key default gen_random_uuid(), page_id uuid, space_id uuid)`;
    await pg`insert into users (id, name) values (${USER}, 'Actor')`;
    await pg`insert into spaces (id, workspace_id) values (${S1}, ${WS}), (${S2}, ${WS})`;

    await (new AuthzOutboxInstaller(db as never, 'remote') as unknown as { install(): Promise<void> }).install();
    await new PageCycleGuardInstaller(db as never, 'remote').install();
    await new PageRestrictionGuardInstaller(db as never, 'remote').install();

    const events = { emit: (name: string, payload: unknown) => (emitted.push({ name, payload }), true) };
    pageRepo = new PageRepo(db as never, {} as never, events as never);
    const audit = { log: (p: { event: string }) => void audits.push(p.event) } as never;
    const allowSpaceEdit = { createForUser: async () => ({ can: () => true, cannot: () => false }) };
    const rootCheck = { validateCanEdit: async () => ({ hasRestriction: false }) }; // upstream's root check: allowed
    restore = new RemoteRestoreService(db as never, pageRepo, allowSpaceEdit as never, rootCheck as never, authz as never, audit);
    const queue = { add: async () => undefined };
    const pages = new PageService(
      pageRepo,
      { filterAccessiblePageIds: async ({ pageIds }: { pageIds: string[] }) => pageIds } as never,
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
    trash = new RemoteTrashService(db as never, pageRepo, pages, rootCheck as never, authz as never, audit);
  });

  afterEach(async () => {
    platform.atDecide = null;
    platform.asked.length = 0;
    platform.askedSa.length = 0;
    platform.settles.length = 0;
    platform.granted.clear();
    platform.saCannotEdit.clear();
    audits.length = 0;
    emitted.length = 0;
    jest.restoreAllMocks();
    await pg`delete from page_access`;
    await pg`delete from pages`;
    await pg`delete from authz_outbox`;
  });

  afterAll(async () => {
    await db?.destroy();
    await side?.end({ timeout: 5 });
    await pg?.end({ timeout: 5 });
  });

  describe('what comes back', () => {
    it('only the pages trashed WITH the root: a sub-page trashed on its own earlier stays in the trash (a trash root now)', async () => {
      // 1 → 2 → 3. Page 3 was trashed first, by someone else; then 1 was trashed, which took 2 with it.
      await page(uuid(1), null, [LATER, USER]);
      await page(uuid(2), uuid(1), [LATER, USER]);
      await page(uuid(3), uuid(2), [EARLIER, OTHER]);
      await project();
      expect(await outcome(restore.restore(ACTOR, uuid(1), WS))).toBe('applied');
      expect(await state(uuid(1), uuid(2), uuid(3))).toEqual({
        [uuid(1)]: 'live under root',
        [uuid(2)]: `live under ${uuid(1)}`,
        [uuid(3)]: `trashed under ${uuid(2)}`, // its parent is live now: it is listed in the trash as its own root
      });
      expect([...platform.asked].sort()).toEqual([uuid(1), uuid(2)]);
      expect(audits).toEqual(['page.restored']);
      expect(restoredEvents()).toHaveLength(1);
      expect([...(restoredEvents()[0].payload as { pageIds: string[] }).pageIds].sort()).toEqual([uuid(1), uuid(2)]);
    });

    it('a LIVE page is a no-op: its trashed descendants stay trashed; nothing asked, written, audited or announced', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1), [EARLIER, OTHER]);
      await project();
      const outboxBefore = await outboxCount();
      expect(await outcome(restore.restore(ACTOR, uuid(1), WS))).toBe('noop');
      expect(await state(uuid(1), uuid(2))).toEqual({ [uuid(1)]: 'live under root', [uuid(2)]: `trashed under ${uuid(1)}` });
      expect(platform.asked).toEqual([]);
      expect(audits).toEqual([]);
      expect(restoredEvents()).toEqual([]);
      expect(await outboxCount()).toBe(outboxBefore);
    });

    it('a page whose trashed parent is unrestricted comes back at the root of its space', async () => {
      await page(uuid(1), null, [EARLIER, OTHER]);
      await page(uuid(2), uuid(1), [LATER, USER]);
      await project();
      expect(await outcome(restore.restore(ACTOR, uuid(2), WS))).toBe('applied');
      expect(await state(uuid(1), uuid(2))).toEqual({ [uuid(1)]: 'trashed under root', [uuid(2)]: 'live under root' });
    });

    it('the batch is the EXACT stamp: same time with another actor, or another time, is not in it; a null actor matches a null actor', async () => {
      await page(uuid(1), null, [LATER, USER]);
      await page(uuid(2), uuid(1), [LATER, OTHER]); // same millisecond, another actor
      await page(uuid(3), uuid(1), [EARLIER, USER]); // same actor, another trash
      await page(uuid(4), null, [LATER, null]); // the actor's user row was removed (deleted_by_id set null)
      await page(uuid(5), uuid(4), [LATER, null]);
      await project();
      expect(await outcome(restore.restore(ACTOR, uuid(1), WS))).toBe('applied');
      expect(await outcome(restore.restore(ACTOR, uuid(4), WS))).toBe('applied');
      expect(await state(uuid(1), uuid(2), uuid(3), uuid(4), uuid(5))).toEqual({
        [uuid(1)]: 'live under root',
        [uuid(2)]: `trashed under ${uuid(1)}`,
        [uuid(3)]: `trashed under ${uuid(1)}`,
        [uuid(4)]: 'live under root',
        [uuid(5)]: `live under ${uuid(4)}`,
      });
    });
  });

  describe('all or nothing', () => {
    it('g2: restoring an unrestricted page out of its trashed RESTRICTED parent → 409 with the restore wording; NOTHING changes', async () => {
      await page(uuid(1), null, [LATER, USER]);
      await page(uuid(2), uuid(1), [LATER, USER]);
      await page(uuid(3), uuid(2), [LATER, USER]);
      await restrict(uuid(1));
      await project();
      platform.granted.add(uuid(2)).add(uuid(3)); // direct grants: the person may edit them, so the PDP allows
      const outboxBefore = await outboxCount();
      const err = await restore.restore(ACTOR, uuid(2), WS).then(
        () => null,
        (e) => e as HttpException,
      );
      expect([err?.getStatus(), err?.getResponse()]).toEqual([
        409,
        { message: RESTORE_RESTRICTION_STRIP_MESSAGE, code: RESTRICTION_STRIP },
      ]);
      expect(await state(uuid(2), uuid(3))).toEqual({
        [uuid(2)]: `trashed under ${uuid(1)}`,
        [uuid(3)]: `trashed under ${uuid(2)}`,
      });
      expect(await outboxCount()).toBe(outboxBefore);
      expect(restoredEvents()).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('a batch page the person cannot edit (restricted, projected) → 403 restore_needs_edit after one fence; nothing restored', async () => {
      await page(uuid(1), null, [LATER, USER]);
      await page(uuid(2), uuid(1), [LATER, USER]);
      await restrict(uuid(2));
      await project();
      expect(await outcome(restore.restore(ACTOR, uuid(1), WS))).toBe('403:restore_needs_edit');
      expect(platform.settles).toHaveLength(1);
      expect(await state(uuid(1), uuid(2))).toEqual({ [uuid(1)]: 'trashed under root', [uuid(2)]: `trashed under ${uuid(1)}` });
      expect(audits).toEqual([]);
      expect(restoredEvents()).toEqual([]);
    });

    it('the delegated service account cannot edit one batch page → 403; the human was decided first', async () => {
      await page(uuid(1), null, [LATER, USER]);
      await page(uuid(2), uuid(1), [LATER, USER]);
      await project();
      platform.saCannotEdit.add(uuid(2));
      expect(await outcome(restore.restore(ACTOR, uuid(1), WS, SA))).toBe('403:restore_needs_edit');
      expect([...platform.askedSa].sort()).toEqual([uuid(1), uuid(1), uuid(2), uuid(2)]); // both attempts
      expect(await state(uuid(1))).toEqual({ [uuid(1)]: 'trashed under root' });
      // And with no service leg the same restore goes through.
      expect(await outcome(restore.restore(ACTOR, uuid(1), WS))).toBe('applied');
    });

    it('a subtree row locked elsewhere past lock_timeout → 503 engine_busy, nothing restored', async () => {
      await page(uuid(1), null, [LATER, USER]);
      await page(uuid(2), uuid(1), [LATER, USER]);
      await project();
      const x = await side.reserve();
      try {
        await x`begin`;
        await x`select id from pages where id = ${uuid(2)} for update`;
        expect(await outcome(restore.restore(ACTOR, uuid(1), WS))).toBe('503:engine_busy');
      } finally {
        await x`rollback`;
        x.release();
      }
      expect(await state(uuid(1), uuid(2))).toEqual({ [uuid(1)]: 'trashed under root', [uuid(2)]: `trashed under ${uuid(1)}` });
    });
  });

  describe('races, interleaved by pg_locks', () => {
    it('a restore WAITS for a concurrent trash of the parent, then sees the parent trashed and detaches', async () => {
      // 1 (live) → 2 (trashed on its own). Trashing 1 locks 2 too (its lock covers trashed rows), and leaves it as is.
      await page(uuid(1), null);
      await page(uuid(2), uuid(1), [EARLIER, OTHER]);
      await project();
      const order: string[] = [];
      let restoring!: Promise<string>;
      platform.atDecide = async () => {
        // The trash holds its locks; the restore's lock on page 2 waits for them.
        restoring = outcome(restore.restore(ACTOR, uuid(2), WS)).then((r) => (order.push('restore-done'), r));
        await waitForLockWaiter();
        order.push('restore-waiting');
      };
      const trashed = await outcome(trash.trash(ACTOR, uuid(1), WS)).then((r) => (order.push('trash-done'), r));
      expect(trashed).toBe('applied');
      expect(await restoring).toBe('applied');
      expect(order).toEqual(['restore-waiting', 'trash-done', 'restore-done']);
      // Read after the trash committed: the parent is trashed, so the restored page is re-rooted (never live under it).
      expect(await state(uuid(1), uuid(2))).toEqual({ [uuid(1)]: 'trashed under root', [uuid(2)]: 'live under root' });
    });

    it('a restore against a move-to-space holding the guard lock deadlocks → 503 engine_busy (40P01), nothing changed', async () => {
      // 1 (trashed, unrestricted) → 2 (trashed on its own) → 3 (live: created during that trash); 9 elsewhere.
      await page(uuid(1), null, [EARLIER, OTHER]);
      await page(uuid(2), uuid(1), [LATER, USER]);
      await page(uuid(3), uuid(2));
      await page(uuid(9), null);
      await project();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const x = await side.reserve();
      let moved!: Promise<string>;
      try {
        await x`begin`;
        await x.unsafe(`set local lock_timeout = '10s'`);
        // A move-to-space's first row: g1 takes the per-workspace guard lock and holds it to the commit.
        await x`update pages set space_id = ${S2} where id = ${uuid(9)}`;
        // The restore locks 2 and 3, then its detach's g2 waits for the guard lock.
        const restoring = outcome(restore.restore(ACTOR, uuid(2), WS));
        await waitForLockWaiter('advisory');
        // The move's next row is one the restore holds: a cycle. The restore waited first, so it is the victim.
        moved = x`update pages set space_id = ${S2} where id = ${uuid(3)}`.then(
          () => 'moved',
          (e) => `error:${(e as { code?: string }).code}`,
        );
        expect(await restoring).toBe('503:engine_busy');
        expect(await moved).toBe('moved');
        await x`commit`;
      } catch (e) {
        await x`rollback`.catch(() => undefined);
        throw e;
      } finally {
        x.release();
      }
      expect(warn.mock.calls.some(([m]) => String(m).startsWith('REMOTE_RESTORE_BUSY code=40P01'))).toBe(true);
      expect(await state(uuid(2))).toEqual({ [uuid(2)]: `trashed under ${uuid(1)}` });
      expect(audits).toEqual([]);
      expect(restoredEvents()).toEqual([]);
    });
  });
});
