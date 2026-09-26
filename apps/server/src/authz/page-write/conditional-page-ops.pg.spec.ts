import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { HttpException } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../../core/page/services/page.service';
import { AuthzOutboxInstaller } from '../../service-bridge/authz-outbox.installer';
import { CYCLE_LOCK_CLASS, PageCycleGuardInstaller } from '../../service-bridge/page-cycle-guard.installer';
import { PageRestrictionGuardInstaller, RESTRICTED_SPACE_MOVE } from '../../service-bridge/page-restriction-guard.installer';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';

// PageService imports the collab gateway, whose lib0/hocuspocus ESM graph jest cannot load; the paths driven here
// never touch it (the same stub the guard pg spec uses).
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { ConditionalPageOpsController } from './conditional-page-ops.controller';
import { pageEtagOpaque } from './page-etag';

/**
 * #616 on real Postgres: the conditional page operations driven through the REAL upstream write paths (PageRepo /
 * PageService with the new transaction seams) against the real #493/#545 guard triggers and the authz outbox.
 *   - the compare is atomic: two operations holding the SAME version race, exactly one applies, the other 412s
 *     (or converges to `noop` when it asked for what already happened);
 *   - a refusal changes nothing — not the row, not the outbox;
 *   - the row lock is FOR NO KEY UPDATE and does NOT deadlock with the guards' per-workspace advisory lock while a
 *     restrict (g0) or a re-parent + child insert runs concurrently in the same workspace — and FOR UPDATE would;
 *   - a lock we cannot get within lock_timeout is a retryable 503 `engine_busy`;
 *   - the version the platform derives from `/pages/info` (a JSON round trip of the real row) is the one compared;
 *   - under the caller's transaction `forceDelete` queues no attachment job; the controller queues it after commit.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG conditional page operations gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'conditional_page_ops_pg_spec';
const WS = uuid(100);
const S1 = uuid(50);
const S2 = uuid(51);
const USER = uuid(900);
const WORKSPACE = { id: WS } as never;
const ACTOR = { id: USER } as never;

d('ConditionalPageOpsController on real Postgres (#616)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  /** A second session: it holds a transaction open while the operation under test runs. */
  let side: postgres.Sql;
  let db: Kysely<any>;
  let pageRepo: PageRepo;
  let controller: ConditionalPageOpsController;
  /** Runs inside the operation right after the row lock is taken (the stubbed `validateCanEdit`). */
  let afterLock: (() => Promise<void>) | null = null;
  const serviceJobs: string[] = [];
  const controllerJobs: string[] = [];
  const audits: string[] = [];

  const page = (id: string, parent: string | null, opts: { position?: string; trashed?: boolean; title?: string } = {}) => pg`
    insert into pages (id, slug_id, title, workspace_id, space_id, parent_page_id, position, last_updated_by_id,
                       content, updated_at, deleted_at, deleted_by_id)
    values (${id}, ${`slug-${id.slice(-4)}`}, ${opts.title ?? 'Title'}, ${WS}, ${S1}, ${parent}, ${opts.position ?? 'a0000'},
            ${USER}, ${pg.json({ type: 'doc', content: [{ type: 'paragraph', attrs: { z: 1, a: null } }] })},
            '2026-09-26 10:00:00.123456+00', ${opts.trashed ? new Date() : null}, ${opts.trashed ? USER : null})`;
  const row = async (id: string) =>
    (await pg<{ title: string; parentPageId: string | null; position: string; spaceId: string; deletedAt: Date | null }[]>`
      select title, parent_page_id as "parentPageId", position, space_id as "spaceId", deleted_at as "deletedAt"
      from pages where id = ${id}`)[0];
  const outboxCount = async () => (await pg<{ c: number }[]>`select count(*)::int as c from authz_outbox`)[0].c;
  /** The version the platform computes: `/pages/info` is `findById` with content, serialized to JSON by Nest. */
  const platformVersion = async (id: string) =>
    pageEtagOpaque(JSON.parse(JSON.stringify(await pageRepo.findById(id, { includeContent: true, includeLastUpdatedBy: true }))));
  /** Resolves once some session is WAITING on a lock (a row lock or the guard's advisory lock). */
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
          : `error:${(e as { code?: string; constraint_name?: string }).constraint_name ?? (e as { code?: string }).code ?? (e as Error).message}`,
    );

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 6);
    side = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    await pg`create table users (id uuid primary key, email varchar, name varchar, avatar_url varchar, role varchar, deleted_at timestamptz)`;
    await pg`create table groups (id uuid primary key, name varchar)`;
    await pg`create table spaces (id uuid primary key, name varchar, slug varchar, workspace_id uuid not null, deleted_at timestamptz)`;
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
    for (const t of ['shares', 'comments', 'page_verifications', 'notifications']) {
      await pg.unsafe(`create table ${t} (id uuid primary key default gen_random_uuid(), page_id uuid, space_id uuid)`);
    }
    await pg`insert into users (id, name) values (${USER}, 'Actor')`;
    await pg`insert into spaces (id, workspace_id) values (${S1}, ${WS}), (${S2}, ${WS})`;

    await (new AuthzOutboxInstaller(db as never, 'remote') as unknown as { install(): Promise<void> }).install();
    await new PageCycleGuardInstaller(db as never, 'remote').install();
    await new PageRestrictionGuardInstaller(db as never, 'remote').install();

    const events = { emit: () => true };
    pageRepo = new PageRepo(db as never, {} as never, events as never);
    const queue = (name: string) => ({
      add: async (job: string, data: { pageId?: string }) => {
        serviceJobs.push(`${name}:${job}:${data?.pageId ?? ''}`);
      },
    });
    const pages = new PageService(
      pageRepo,
      { filterAccessiblePageIds: async ({ pageIds }: { pageIds: string[] }) => pageIds } as never,
      { updateAttachmentsByPageId: async () => undefined } as never,
      db as never,
      {} as never,
      queue('attachment') as never,
      queue('ai') as never,
      queue('general') as never,
      events as never,
      {} as never,
      { movePageWatchersToSpace: async () => undefined } as never,
      {} as never,
    );
    const allow = { can: () => true, cannot: () => false };
    controller = new ConditionalPageOpsController(
      db as never,
      pageRepo,
      pages,
      {
        validateCanEdit: async () => {
          if (afterLock) {
            const hook = afterLock;
            afterLock = null; // only the operation's own page (a target-parent check must not re-run it)
            await hook();
          }
          return { hasRestriction: false };
        },
      } as never,
      { createForUser: async () => allow } as never,
      { log: (p: { event: string }) => audits.push(p.event) } as never,
      { add: async (_j: string, data: { pageId: string }) => void controllerJobs.push(data.pageId) } as never,
    );
  });

  afterEach(async () => {
    afterLock = null;
    serviceJobs.length = 0;
    controllerJobs.length = 0;
    audits.length = 0;
    await pg`delete from page_access`;
    await pg`delete from pages`;
    await pg`delete from authz_outbox`;
  });

  afterAll(async () => {
    await db?.destroy();
    await side?.end({ timeout: 5 });
    await pg?.end({ timeout: 5 });
  });

  describe('the version the platform issues is the one compared', () => {
    it('a /pages/info JSON round trip of the real row (µs timestamp, unsorted jsonb) matches; a stale one 412s and changes nothing', async () => {
      await page(uuid(1), null, { title: 'Before' });
      const v = await platformVersion(uuid(1));
      const outboxBefore = await outboxCount();
      expect(
        await outcome(controller.conditionalUpdateMeta({ pageId: uuid(1), title: 'After', expectedEtags: ['f'.repeat(64)] } as never, ACTOR, WORKSPACE)),
      ).toBe('412:precondition_failed');
      expect((await row(uuid(1))).title).toBe('Before');
      expect(await outboxCount()).toBe(outboxBefore);
      expect(
        await outcome(controller.conditionalUpdateMeta({ pageId: uuid(1), title: 'After', expectedEtags: [v] } as never, ACTOR, WORKSPACE)),
      ).toBe('applied');
      expect((await row(uuid(1))).title).toBe('After');
      expect(await platformVersion(uuid(1))).not.toBe(v); // the write bumped updatedAt → a new version
    });
  });

  describe('atomic compare: two operations holding the same version race', () => {
    it('two metadata writes, B blocked on A’s row lock after both read the same version: A applies, B 412s', async () => {
      await page(uuid(1), null, { title: 'Before' });
      const v = await platformVersion(uuid(1));
      let b!: Promise<string>;
      afterLock = async () => {
        // Inside A, holding the row: start B with the SAME version and let it block on the row lock.
        b = outcome(controller.conditionalUpdateMeta({ pageId: uuid(1), title: 'B', expectedEtags: [v] } as never, ACTOR, WORKSPACE));
        await waitForLockWaiter();
      };
      const a = await outcome(
        controller.conditionalUpdateMeta({ pageId: uuid(1), title: 'A', expectedEtags: [v] } as never, ACTOR, WORKSPACE),
      );
      expect([a, await b]).toEqual(['applied', '412:precondition_failed']);
      expect((await row(uuid(1))).title).toBe('A');
    });

    it('the same race without choreography (Promise.all): never two applies', async () => {
      await page(uuid(1), null, { title: 'Before' });
      const v = await platformVersion(uuid(1));
      const results = await Promise.all(
        ['A', 'B'].map((t) =>
          outcome(controller.conditionalUpdateMeta({ pageId: uuid(1), title: t, expectedEtags: [v] } as never, ACTOR, WORKSPACE)),
        ),
      );
      expect(results.sort()).toEqual(['412:precondition_failed', 'applied']);
    });

    it('two moves to different positions: exactly one applies, the other 412s', async () => {
      await page(uuid(1), null, { position: 'a0000' });
      const v = await platformVersion(uuid(1));
      const results = await Promise.all(
        ['a0001', 'a0002'].map((position) =>
          outcome(controller.conditionalMove({ pageId: uuid(1), parentPageId: null, position, expectedEtags: [v] } as never, ACTOR, WORKSPACE)),
        ),
      );
      expect(results.sort()).toEqual(['412:precondition_failed', 'applied']);
    });

    it('two trashes of the same version: one applies, the other converges to noop (never 412s on its own change)', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      const v = await platformVersion(uuid(1));
      const results = await Promise.all(
        [0, 1].map(() => outcome(controller.conditionalDelete({ pageId: uuid(1), expectedEtags: [v] } as never, ACTOR, WORKSPACE))),
      );
      expect(results.sort()).toEqual(['applied', 'noop']);
      expect((await row(uuid(1))).deletedAt).not.toBeNull();
      expect((await row(uuid(2))).deletedAt).not.toBeNull(); // the upstream walk ran inside the transaction
      expect(audits).toEqual(['page.trashed']);
    });
  });

  describe('no deadlock with the guards: the row lock is FOR NO KEY UPDATE', () => {
    /**
     * Run `stmts` in a side transaction and leave it OPEN (bounded: a statement blocked by our row lock fails at 1s,
     * which fails the operation and so the test); the returned function commits it after `ms`.
     */
    const sideWrite = async (stmts: (x: postgres.ReservedSql) => Promise<unknown>, events: string[]) => {
      const x = await side.reserve();
      await x`begin`;
      await x.unsafe(`set local lock_timeout = '1s'`);
      try {
        await stmts(x);
      } catch (e) {
        events.push(`side-blocked:${(e as { code?: string }).code}`);
        await x`rollback`;
        x.release();
        throw e;
      }
      events.push('side-wrote');
      return (ms: number) =>
        new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            events.push('side-commit');
            x`commit`.then(
              () => (x.release(), resolve()),
              (e) => (x.release(), reject(e)),
            );
          }, ms);
        });
    };

    it('a concurrent RESTRICT of the page (g0: advisory lock, then FOR KEY SHARE) proceeds under our lock; our re-parent waits for it', async () => {
      await page(uuid(1), null);
      await page(uuid(2), null);
      await page(uuid(3), uuid(1));
      const events: string[] = [];
      let sideDone!: Promise<void>;
      afterLock = async () => {
        // g0 takes the workspace lock and then FOR KEY SHARE on page 3 — compatible with our FOR NO KEY UPDATE.
        const commitAfter = await sideWrite(
          (x) => x`insert into page_access (page_id, workspace_id, space_id, access_level) values (${uuid(3)}, ${WS}, ${S1}, 'members')`,
          events,
        );
        sideDone = commitAfter(300);
      };
      const result = await outcome(
        controller.conditionalMove({ pageId: uuid(3), parentPageId: uuid(2), position: 'a0000', expectedEtags: ['*'] } as never, ACTOR, WORKSPACE),
      ).then((o) => (events.push('op-done'), o));
      await sideDone;
      // The restrict landed while we held the row; our re-parent (g1/g2 need the same advisory lock) waited for its
      // commit and then applied — page 3 now carries its own restriction, so moving it strips nothing.
      expect(result).toBe('applied');
      expect(events).toEqual(['side-wrote', 'side-commit', 'op-done']);
      expect((await row(uuid(3))).parentPageId).toBe(uuid(2));
    });

    it('a concurrent re-parent elsewhere + a child INSERT under our page proceeds; our move waits for it', async () => {
      await page(uuid(1), null);
      await page(uuid(2), null);
      await page(uuid(4), null);
      await page(uuid(5), null);
      const events: string[] = [];
      let sideDone!: Promise<void>;
      afterLock = async () => {
        const commitAfter = await sideWrite(async (x) => {
          await x`update pages set parent_page_id = ${uuid(5)} where id = ${uuid(4)}`; // takes the workspace lock
          // FOR KEY SHARE on our page (the parent foreign key) — compatible with our FOR NO KEY UPDATE.
          await x`insert into pages (id, workspace_id, space_id, parent_page_id, position) values (${uuid(6)}, ${WS}, ${S1}, ${uuid(1)}, 'a0000')`;
        }, events);
        sideDone = commitAfter(300);
      };
      const result = await outcome(
        controller.conditionalMove({ pageId: uuid(1), parentPageId: uuid(2), position: 'a0000', expectedEtags: ['*'] } as never, ACTOR, WORKSPACE),
      ).then((o) => (events.push('op-done'), o));
      await sideDone;
      expect(result).toBe('applied');
      expect(events).toEqual(['side-wrote', 'side-commit', 'op-done']);
      expect((await row(uuid(6))).parentPageId).toBe(uuid(1));
    });

    it('contrast (why NOT FOR UPDATE): the same interleaving with FOR UPDATE deadlocks', async () => {
      await page(uuid(1), null);
      await page(uuid(2), null);
      const a = await side.reserve();
      const b = await appPg.reserve();
      try {
        await a`begin`;
        await a`select id from pages where id = ${uuid(1)} for update`;
        await b`begin`;
        // g0: the workspace advisory lock, then FOR KEY SHARE on page 1 — blocked by A's FOR UPDATE.
        const restricting = b`insert into page_access (page_id, workspace_id, space_id, access_level)
                              values (${uuid(1)}, ${WS}, ${S1}, 'members')`.then(
          () => 'ok',
          (e) => (e as { code?: string }).code ?? 'error',
        );
        await new Promise((r) => setTimeout(r, 200));
        // A now needs the advisory lock B holds (g2 on a real parent change) → one of them is the deadlock victim.
        const moving = a`update pages set parent_page_id = ${uuid(2)} where id = ${uuid(1)}`.then(
          () => 'ok',
          (e) => (e as { code?: string }).code ?? 'error',
        );
        expect([await moving, await restricting].sort()).toEqual(['40P01', 'ok']);
      } finally {
        await a`rollback`.catch(() => undefined);
        await b`rollback`.catch(() => undefined);
        a.release();
        b.release();
      }
    });
  });

  describe('bounded waits', () => {
    it('a row lock held elsewhere past lock_timeout → 503 engine_busy, nothing changed', async () => {
      await page(uuid(1), null, { title: 'Before' });
      const x = await side.reserve();
      try {
        await x`begin`;
        await x`select id from pages where id = ${uuid(1)} for no key update`;
        const started = Date.now();
        expect(
          await outcome(controller.conditionalUpdateMeta({ pageId: uuid(1), title: 'After', expectedEtags: ['*'] } as never, ACTOR, WORKSPACE)),
        ).toBe('503:engine_busy');
        expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      } finally {
        await x`rollback`;
        x.release();
      }
      expect((await row(uuid(1))).title).toBe('Before');
    });

    it('the workspace advisory lock held elsewhere (inside the guard trigger) → 503 engine_busy, the move rolled back', async () => {
      await page(uuid(1), null);
      await page(uuid(2), null);
      const x = await side.reserve();
      try {
        await x`begin`;
        await x`select pg_advisory_xact_lock(${CYCLE_LOCK_CLASS}, hashtext(${WS}::text))`;
        expect(
          await outcome(
            controller.conditionalMove({ pageId: uuid(1), parentPageId: uuid(2), position: 'a0000', expectedEtags: ['*'] } as never, ACTOR, WORKSPACE),
          ),
        ).toBe('503:engine_busy');
      } finally {
        await x`rollback`;
        x.release();
      }
      expect((await row(uuid(1))).parentPageId).toBeNull();
    });
  });

  describe('the upstream paths under the caller transaction', () => {
    it('permanent delete: forceDelete queues NO job inside the transaction; the controller queues each after commit', async () => {
      await page(uuid(1), null, { trashed: true });
      await page(uuid(2), uuid(1), { trashed: true });
      const v = await platformVersion(uuid(1));
      expect(
        await outcome(controller.conditionalDelete({ pageId: uuid(1), permanentlyDelete: true, expectedEtags: [v] } as never, ACTOR, WORKSPACE)),
      ).toBe('applied');
      expect(await row(uuid(1))).toBeUndefined();
      expect(await row(uuid(2))).toBeUndefined();
      expect(serviceJobs.filter((j) => j.startsWith('attachment:'))).toEqual([]);
      expect(controllerJobs.sort()).toEqual([uuid(1), uuid(2)].sort());
      expect(audits).toEqual(['page.deleted']);
    });

    it('permanent delete with a stale version: nothing deleted, nothing queued', async () => {
      await page(uuid(1), null, { trashed: true });
      expect(
        await outcome(
          controller.conditionalDelete({ pageId: uuid(1), permanentlyDelete: true, expectedEtags: ['f'.repeat(64)] } as never, ACTOR, WORKSPACE),
        ),
      ).toBe('412:precondition_failed');
      expect(await row(uuid(1))).toBeDefined();
      expect(controllerJobs).toEqual([]);
    });

    it('move-to-space: applied inside the transaction; a guard refusal (restricted page) rolls the whole write back', async () => {
      await page(uuid(1), null);
      await page(uuid(2), uuid(1));
      expect(
        await outcome(controller.conditionalMoveToSpace({ pageId: uuid(1), spaceId: S2, expectedEtags: ['*'] } as never, ACTOR, WORKSPACE)),
      ).toBe('applied');
      expect(await row(uuid(1))).toMatchObject({ spaceId: S2, parentPageId: null });
      expect(await row(uuid(2))).toMatchObject({ spaceId: S2, parentPageId: uuid(1) });
      expect(audits).toEqual(['page.moved_to_space']);

      await page(uuid(3), null);
      await pg`insert into page_access (page_id, workspace_id, space_id, access_level) values (${uuid(3)}, ${WS}, ${S1}, 'members')`;
      const outboxBefore = await outboxCount();
      expect(
        await outcome(controller.conditionalMoveToSpace({ pageId: uuid(3), spaceId: S2, expectedEtags: ['*'] } as never, ACTOR, WORKSPACE)),
      ).toBe(`error:${RESTRICTED_SPACE_MOVE}`);
      expect(await row(uuid(3))).toMatchObject({ spaceId: S1 });
      expect(await outboxCount()).toBe(outboxBefore);
    });

    it('a slug resolves to the page and the retry of an applied move converges', async () => {
      await page(uuid(1), null);
      await page(uuid(2), null);
      const slug = `slug-${uuid(1).slice(-4)}`;
      const v = await platformVersion(uuid(1));
      const move = { pageId: slug, parentPageId: uuid(2), position: 'a0005', expectedEtags: [v] };
      expect(await outcome(controller.conditionalMove(move as never, ACTOR, WORKSPACE))).toBe('applied');
      expect(await outcome(controller.conditionalMove(move as never, ACTOR, WORKSPACE))).toBe('noop');
      expect(await row(uuid(1))).toMatchObject({ parentPageId: uuid(2), position: 'a0005' });
    });
  });
});
