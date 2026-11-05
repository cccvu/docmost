import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { HttpException } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { EventName } from '../../common/events/event.contants';
import { PageService } from '../../core/page/services/page.service';
import { AuthzOutboxInstaller } from '../../service-bridge/authz-outbox.installer';
import { PageCycleGuardInstaller } from '../../service-bridge/page-cycle-guard.installer';
import { PageRestrictionGuardInstaller } from '../../service-bridge/page-restriction-guard.installer';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';

// PageService imports the collab gateway, whose lib0/hocuspocus ESM graph jest cannot load; the paths driven here
// never touch it (the same stub the purge pg spec uses).
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { RemoteTrashService } from './remote-trash.service';

/**
 * #661 / #634 / #670 on real Postgres: the remote trash decided under `FOR NO KEY UPDATE` locks against the REAL
 * upstream `PageRepo.removePage` (seam #172's decided set), the real #493/#545 guard triggers and the authz outbox. The
 * platform is a fake modelling what the routine relies on: its relay has projected the outbox up to a cursor, and its
 * `page#edit` comes from what it has projected — a page it has not placed yet has no edit, a restricted page and its
 * subtree have none. What these prove:
 *  - a restricted descendant → 403 with nothing trashed; an unprojected new child → fenced, then trashed;
 *  - F2: a concurrent restore of a trashed descendant WAITS for the trash, and nothing undecided is trashed;
 *  - F5: a restrict during the trash is NOT blocked (FOR NO KEY UPDATE, never FOR UPDATE);
 *  - a child inserted during the trash is not trashed undecided (the decided set, never a re-walk);
 *  - seam #172's side effects cover exactly the rows trashed: their share links revoked, one `page.soft_deleted`;
 *  - the delegated service account is decided under the same locks; a lock past lock_timeout is a 503.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG remote trash gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'remote_trash_pg_spec';
const WS = uuid(100);
const S1 = uuid(50);
const USER = uuid(900);
const OTHER = uuid(901);
const SA = uuid(950);
const ACTOR = { id: USER } as never;
const EARLIER = new Date('2026-01-01T00:00:00.000Z');

const pos = (p: string): [bigint, bigint] => {
  const [x, i] = p.split('.');
  return [BigInt(x), BigInt(i)];
};
const atOrPast = (a: string, b: string) => {
  const [ax, ai] = pos(a);
  const [bx, bi] = pos(b);
  return ax !== bx ? ax > bx : ai >= bi;
};

d('RemoteTrashService on real Postgres (#661)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let side: postgres.Sql;
  let db: Kysely<any>;
  let pageRepo: PageRepo;
  let trash: RemoteTrashService;
  const audits: string[] = [];
  const emitted: { name: string; payload: unknown }[] = [];

  /** The fake platform: a relay cursor, the pages it has placed, the projected locks, and what it was asked. */
  const platform = {
    cursor: '0.0',
    placed: new Set<string>(),
    locked: new Set<string>(),
    saCannotEdit: new Set<string>(),
    asked: [] as string[],
    askedSa: [] as string[],
    settles: [] as string[],
    /** Runs inside the trash at its first human decision — i.e. while it holds every subtree lock — once. */
    atDecide: null as null | (() => Promise<void>),
    /** Runs when the platform is asked to settle (outside the trash's transaction). */
    atSettle: null as null | (() => Promise<void>),
  };
  const authz = {
    settleProjection: async (position: string, _waitMs: number) => {
      platform.settles.push(position);
      if (platform.atSettle) await platform.atSettle();
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
          !platform.locked.has(c.resourceId) &&
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

  const page = (id: string, parent: string | null, opts: { trashed?: boolean } = {}) => pg`
    insert into pages (id, slug_id, title, workspace_id, space_id, parent_page_id, position, last_updated_by_id,
                       content, updated_at, deleted_at, deleted_by_id)
    values (${id}, ${`slug-${id.slice(-4)}`}, 'Title', ${WS}, ${S1}, ${parent}, 'a0000', ${USER},
            ${pg.json({ type: 'doc', content: [] })}, '2026-09-26 10:00:00.123456+00',
            ${opts.trashed ? EARLIER : null}, ${opts.trashed ? OTHER : null})`;
  const restrictSql = (x: postgres.Sql | postgres.ReservedSql, id: string) =>
    x`insert into page_access (page_id, workspace_id, space_id, access_level) values (${id}, ${WS}, ${S1}, 'members')`;
  const insertChild = (x: postgres.Sql | postgres.ReservedSql, id: string, parent: string) =>
    x`insert into pages (id, workspace_id, space_id, parent_page_id, position) values (${id}, ${WS}, ${S1}, ${parent}, 'a0000')`;
  /** id → [trashed?, deleted_by] for each id. */
  const state = async (...ids: string[]) =>
    Object.fromEntries(
      (
        await pg<{ id: string; deletedAt: Date | null; deletedById: string | null }[]>`
          select id, deleted_at as "deletedAt", deleted_by_id as "deletedById" from pages where id in ${pg(ids)}`
      ).map((r) => [r.id, r.deletedAt ? `trashed-by:${r.deletedById}` : 'live']),
    );
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
      (r) => (r as { outcome: string }).outcome,
      (e) =>
        e instanceof HttpException
          ? `${e.getStatus()}:${(e.getResponse() as { code?: string }).code ?? ''}`
          : `error:${(e as { code?: string }).code ?? (e as Error).message}`,
    );
  /** Start `stmts` in a side transaction and commit it; resolves to 'committed' or the SQLSTATE it failed with. */
  const sideTx = (stmts: (x: postgres.ReservedSql) => Promise<unknown>, lockTimeout = '10s'): Promise<string> =>
    side.reserve().then(async (x) => {
      try {
        await x`begin`;
        await x.unsafe(`set local lock_timeout = '${lockTimeout}'`);
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
    await pg`create table shares (id uuid primary key default gen_random_uuid(), page_id uuid, space_id uuid)`;
    await pg`insert into users (id, name) values (${USER}, 'Actor')`;
    await pg`insert into spaces (id, workspace_id) values (${S1}, ${WS})`;

    await (new AuthzOutboxInstaller(db as never, 'remote') as unknown as { install(): Promise<void> }).install();
    await new PageCycleGuardInstaller(db as never, 'remote').install();
    await new PageRestrictionGuardInstaller(db as never, 'remote').install();

    const events = { emit: (name: string, payload: unknown) => (emitted.push({ name, payload }), true) };
    pageRepo = new PageRepo(db as never, {} as never, events as never);
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
    trash = new RemoteTrashService(
      db as never,
      pageRepo,
      pages,
      { validateCanEdit: async () => ({ hasRestriction: false }) } as never, // upstream's root check: allowed
      authz as never,
      { log: (p: { event: string }) => void audits.push(p.event) } as never,
    );
  });

  beforeEach(async () => {
    // The tree: 1 → {2 → {4 (trashed earlier by someone else)}, 3}; 9 is outside it.
    await page(uuid(1), null);
    await page(uuid(2), uuid(1));
    await page(uuid(3), uuid(1));
    await page(uuid(4), uuid(2), { trashed: true });
    await page(uuid(9), null);
    await project();
  });

  afterEach(async () => {
    platform.atDecide = null;
    platform.atSettle = null;
    platform.asked.length = 0;
    platform.askedSa.length = 0;
    platform.settles.length = 0;
    platform.saCannotEdit.clear();
    audits.length = 0;
    emitted.length = 0;
    await pg`delete from shares`;
    await pg`delete from page_access`;
    await pg`delete from pages`;
    await pg`delete from authz_outbox`;
  });

  afterAll(async () => {
    await db?.destroy();
    await side?.end({ timeout: 5 });
    await pg?.end({ timeout: 5 });
  });

  const LIVE = [uuid(1), uuid(2), uuid(3)];

  describe('the decision covers every page trashed', () => {
    it('every live page editable → exactly the live subtree is trashed; the already-trashed page is untouched; one audit', async () => {
      expect(await outcome(trash.trash(ACTOR, uuid(1), WS))).toBe('applied');
      expect(await state(...LIVE, uuid(4), uuid(9))).toEqual({
        [uuid(1)]: `trashed-by:${USER}`,
        [uuid(2)]: `trashed-by:${USER}`,
        [uuid(3)]: `trashed-by:${USER}`,
        [uuid(4)]: `trashed-by:${OTHER}`, // not re-stamped
        [uuid(9)]: 'live',
      });
      expect([...platform.asked].sort()).toEqual(LIVE);
      expect(platform.settles).toEqual([]); // an allow is never fenced
      expect(audits).toEqual(['page.trashed']);
    });

    it('a projected restriction on a descendant → 403 trash_needs_edit after one fence; nothing trashed, no audit', async () => {
      await restrictSql(pg, uuid(3));
      await project();
      expect(await outcome(trash.trash(ACTOR, uuid(1), WS))).toBe('403:trash_needs_edit');
      expect(platform.settles).toHaveLength(1);
      expect(await state(...LIVE)).toEqual(Object.fromEntries(LIVE.map((id) => [id, 'live'])));
      expect(audits).toEqual([]);
    });

    it('an unprojected new child: denied, fenced (the relay catches up), rerun → trashed with the rest', async () => {
      await insertChild(pg, uuid(5), uuid(2)); // committed; the platform has not placed it
      platform.atSettle = project;
      expect(await outcome(trash.trash(ACTOR, uuid(1), WS))).toBe('applied');
      expect(platform.settles).toHaveLength(1);
      expect(await state(...LIVE, uuid(5))).toEqual(Object.fromEntries([...LIVE, uuid(5)].map((id) => [id, `trashed-by:${USER}`])));
    });

    it('the same child while the relay cannot catch up → 503 trash_unconfirmed, nothing trashed', async () => {
      await insertChild(pg, uuid(5), uuid(2));
      await restrictSql(pg, uuid(9)); // an outbox row past the cursor (outside the subtree)
      expect(await outcome(trash.trash(ACTOR, uuid(1), WS))).toBe('503:trash_unconfirmed');
      expect(await state(...LIVE, uuid(5))).toEqual(Object.fromEntries([...LIVE, uuid(5)].map((id) => [id, 'live'])));
    });

    it('seam #172: the trashed rows lose their share links and are announced once; a page left live keeps its link', async () => {
      const share = (id: string) => pg`insert into shares (page_id, space_id) values (${id}, ${S1})`;
      for (const id of [uuid(1), uuid(3), uuid(9)]) await share(id);
      platform.atDecide = async () => {
        // Inserted (with its link) after the live walk: undecided, so it must stay live AND keep its link.
        await sideTx(async (x) => {
          await insertChild(x, uuid(5), uuid(2));
          await x`insert into shares (page_id, space_id) values (${uuid(5)}, ${S1})`;
        }, '3s');
      };
      expect(await outcome(trash.trash(ACTOR, uuid(1), WS))).toBe('applied');
      const left = await pg<{ pageId: string }[]>`select page_id as "pageId" from shares order by page_id`;
      expect(left.map((r) => r.pageId)).toEqual([uuid(5), uuid(9)].sort());
      const softDeleted = emitted.filter((e) => e.name === EventName.PAGE_SOFT_DELETED);
      expect(softDeleted).toHaveLength(1);
      const payload = softDeleted[0].payload as { pageIds: string[]; workspaceId: string };
      expect([...payload.pageIds].sort()).toEqual(LIVE);
      expect(payload.workspaceId).toBe(WS);
    });

    it('a refused trash revokes no link and announces nothing', async () => {
      await pg`insert into shares (page_id, space_id) values (${uuid(1)}, ${S1})`;
      await restrictSql(pg, uuid(3));
      await project();
      expect(await outcome(trash.trash(ACTOR, uuid(1), WS))).toBe('403:trash_needs_edit');
      expect(await pg`select 1 from shares where page_id = ${uuid(1)}`).toHaveLength(1);
      expect(emitted.filter((e) => e.name === EventName.PAGE_SOFT_DELETED)).toEqual([]);
    });

    it('an already-trashed target → noop: nothing asked, nothing written, no audit', async () => {
      expect(await outcome(trash.trash(ACTOR, uuid(4), WS))).toBe('noop');
      expect(platform.asked).toEqual([]);
      expect(await state(uuid(4))).toEqual({ [uuid(4)]: `trashed-by:${OTHER}` });
      expect(audits).toEqual([]);
    });
  });

  describe('concurrency under the FOR NO KEY UPDATE locks', () => {
    it('F2: a concurrent restore of a trashed descendant WAITS for the trash; nothing undecided is trashed', async () => {
      const order: string[] = [];
      let restore!: Promise<string>;
      platform.atDecide = async () => {
        restore = pageRepo
          .restorePage(uuid(4), WS)
          .then(() => 'restored', (e) => `error:${(e as { code?: string }).code}`)
          .then((r) => (order.push('restore-done'), r));
        await waitForLockWaiter(); // the restore's UPDATE of page 4 waits on our row lock
        order.push('restore-waiting');
      };
      const result = await outcome(trash.trash(ACTOR, uuid(1), WS)).then((o) => (order.push('trash-done'), o));
      expect(result).toBe('applied');
      expect(await restore).toBe('restored');
      expect(order).toEqual(['restore-waiting', 'trash-done', 'restore-done']);
      expect(platform.asked).not.toContain(uuid(4));
      // The trash trashed exactly what it decided; the restore, ordered after it, brought page 4 back.
      expect(await state(...LIVE, uuid(4))).toEqual({
        [uuid(1)]: `trashed-by:${USER}`,
        [uuid(2)]: `trashed-by:${USER}`,
        [uuid(3)]: `trashed-by:${USER}`,
        [uuid(4)]: 'live',
      });
    });

    it('F5: a restrict on a subtree page (and on an outside page) during the trash is NOT blocked', async () => {
      const results: string[] = [];
      platform.atDecide = async () => {
        // Awaited while the trash holds its locks: under FOR UPDATE these would wait out the 3s lock_timeout.
        results.push(await sideTx((x) => restrictSql(x, uuid(3)), '3s'));
        results.push(await sideTx((x) => restrictSql(x, uuid(9)), '3s'));
      };
      expect(await outcome(trash.trash(ACTOR, uuid(1), WS))).toBe('applied');
      expect(results).toEqual(['committed', 'committed']);
    });

    it('a child inserted during the trash (after the live walk) is not trashed undecided: it stays live', async () => {
      let inserted!: string;
      platform.atDecide = async () => {
        inserted = await sideTx((x) => insertChild(x, uuid(5), uuid(2)), '3s'); // FOR KEY SHARE on page 2: not blocked
      };
      expect(await outcome(trash.trash(ACTOR, uuid(1), WS))).toBe('applied');
      expect(inserted).toBe('committed');
      expect(platform.asked).not.toContain(uuid(5));
      expect(await state(uuid(2), uuid(5))).toEqual({ [uuid(2)]: `trashed-by:${USER}`, [uuid(5)]: 'live' });
    });

    it('a subtree row locked elsewhere past lock_timeout → 503 engine_busy, nothing trashed', async () => {
      const x = await side.reserve();
      try {
        await x`begin`;
        await x`select id from pages where id = ${uuid(4)} for update`;
        expect(await outcome(trash.trash(ACTOR, uuid(1), WS))).toBe('503:engine_busy');
      } finally {
        await x`rollback`;
        x.release();
      }
      expect(await state(...LIVE)).toEqual(Object.fromEntries(LIVE.map((id) => [id, 'live'])));
    });
  });

  describe('#670: the delegated service account, decided under the same locks', () => {
    it('it cannot edit one descendant → 403 trash_needs_edit, nothing trashed; the human was decided first', async () => {
      platform.saCannotEdit.add(uuid(3));
      expect(await outcome(trash.trash(ACTOR, uuid(1), WS, undefined, SA))).toBe('403:trash_needs_edit');
      expect([...platform.askedSa].sort()).toEqual([...LIVE, ...LIVE].sort()); // both attempts
      expect(await state(...LIVE)).toEqual(Object.fromEntries(LIVE.map((id) => [id, 'live'])));
    });

    it('anti-bypass: a human the PDP refuses is never decided for the service account', async () => {
      await restrictSql(pg, uuid(3));
      await project();
      expect(await outcome(trash.trash(ACTOR, uuid(1), WS, undefined, SA))).toBe('403:trash_needs_edit');
      expect(platform.askedSa).toEqual([]);
    });

    it('both allowed → trashed', async () => {
      expect(await outcome(trash.trash(ACTOR, uuid(1), WS, undefined, SA))).toBe('applied');
      expect([...platform.askedSa].sort()).toEqual(LIVE);
    });
  });
});
