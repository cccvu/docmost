import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { HttpException } from '@nestjs/common';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { AuthzOutboxInstaller } from '../../service-bridge/authz-outbox.installer';
import { CYCLE_LOCK_CLASS, PageCycleGuardInstaller } from '../../service-bridge/page-cycle-guard.installer';
import { PageRestrictionGuardInstaller } from '../../service-bridge/page-restriction-guard.installer';
import { ServiceContentService } from '../../service-bridge/service-content.service';
import {
  PG_URL,
  uuid,
  mkReadModelPg,
  bootstrapSchema,
  mkReadModelDb,
  fakeWorkspaceResolver,
} from '../../service-bridge/read-model-pg.testkit';
import { PAGE_ACL_LOCK_CLASS, PageRestrictionService } from './page-restriction.service';

/**
 * #616 Stage 2 on real Postgres: the page-ACL writes as versioned transactions, against the real upstream
 * `PagePermissionRepo`, the real #485/#545 guard triggers (g0 on `page_access`, g1/g2 on `pages`) and the real authz
 * outbox capture trigger.
 *   - the version the ACL read (`service/pages/:id/permissions`) issues is the one the write compares; stale → 412 with
 *     NOTHING changed (rows and outbox); fresh → applied, answering the next read's version; `*` = exists;
 *   - two writes holding the same version race: exactly one applies;
 *   - a write is all-or-nothing (a failure after `page_access` is inserted leaves no restriction and no outbox row);
 *   - lock order: the per-page ACL lock is the only lock no trigger takes, and it is always taken FIRST — a restrict
 *     and a re-parent in the same workspace, interleaved both ways round and stress-raced, never deadlock;
 *   - a lock not got within lock_timeout — the workspace lock inside g0, or the page's ACL lock — is a 503 engine_busy;
 *   - the preview runs the real write (its triggers fire: the outbox sequence moves) and leaves no trace: page_access,
 *     page_permissions, authz_outbox and users rows unchanged, no cache invalidation (so no SpiceDB write and no
 *     revalidation can follow), and it reports exactly the effect the real write then has.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG versioned page ACL gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'page_restriction_versioned_pg_spec';
const WS = uuid(100);
const SPACE = uuid(50);
const ACTOR = uuid(900);
const U1 = uuid(901);
const U2 = uuid(902);
const U3 = uuid(903);
const P = uuid(1);
const Q = uuid(2);
const Y = uuid(3);

type Outcome = string;

d('PageRestrictionService versioned writes on real Postgres (#616)', () => {
  jest.setTimeout(60_000);

  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let side: postgres.Sql;
  let db: Kysely<any>;
  let svc: PageRestrictionService;
  let reads: ServiceContentService;
  let pdp: boolean[];
  /** Runs inside the write's transaction, right before the grants are inserted (after `page_access` is written). */
  let beforeGrants: (() => Promise<void>) | null = null;
  const invalidations: string[] = [];

  const actor = { id: ACTOR } as never;
  const page = (id: string, parent: string | null) =>
    pg`insert into pages (id, workspace_id, space_id, parent_page_id, position) values (${id}, ${WS}, ${SPACE}, ${parent}, 'a0')`;
  const restrictRow = async (pageId: string, grants: Array<[string, string]> = []) => {
    const [{ id }] = await pg<{ id: string }[]>`
      insert into page_access (page_id, workspace_id, space_id, access_level) values (${pageId}, ${WS}, ${SPACE}, 'members')
      returning id`;
    for (const [userId, role] of grants) {
      await pg`insert into page_permissions (page_access_id, user_id, role) values (${id}, ${userId}, ${role})`;
    }
  };
  const version = async (pageId: string) => (await reads.listPagePermissions(pageId)).version;
  /** Every row the ACL write could touch, plus the users table — compared whole. */
  const snapshot = async () => ({
    access: await pg`select id, page_id, space_id from page_access order by id`,
    perms: await pg`select id, page_access_id, user_id, group_id, role from page_permissions order by id`,
    outbox: await pg`select id, table_name, payload from authz_outbox order by id`,
    users: await pg`select id from users order by id`,
  });
  const outboxSeq = async () =>
    Number((await pg<{ v: string }[]>`select last_value::text as v from authz_outbox_id_seq`)[0].v);
  const outcome = (p: Promise<unknown>): Promise<Outcome> =>
    p.then(
      () => 'applied',
      (e) =>
        e instanceof HttpException
          ? `${e.getStatus()}:${(e.getResponse() as { code?: string }).code ?? ''}`
          : `error:${(e as { code?: string }).code ?? (e as Error).message}`,
    );
  const waitForLockWaiter = async () => {
    for (let i = 0; i < 200; i++) {
      const [{ c }] = await pg<{ c: number }[]>`select count(*)::int as c from pg_locks where not granted`;
      if (c > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no session ever waited on a lock');
  };
  const grants = (pageId: string) =>
    pg<{ userId: string | null; role: string }[]>`
      select pp.user_id as "userId", pp.role from page_permissions pp join page_access pa on pa.id = pp.page_access_id
      where pa.page_id = ${pageId} order by pp.user_id`;
  const isRestricted = async (pageId: string) => (await pg`select 1 from page_access where page_id = ${pageId}`).length > 0;

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 2);
    appPg = mkReadModelPg(SCHEMA, 8);
    side = mkReadModelPg(SCHEMA, 3);
    db = mkReadModelDb(appPg);
    await pg`create table users (id uuid primary key, email varchar)`;
    await pg`create table spaces (id uuid primary key, name varchar, slug varchar, workspace_id uuid not null, deleted_at timestamptz)`;
    await pg`
      create table space_members (
        id uuid primary key default gen_random_uuid(), user_id uuid, group_id uuid,
        space_id uuid not null references spaces (id) on delete cascade, role varchar not null, deleted_at timestamptz
      )`;
    await pg`create table group_users (id uuid primary key default gen_random_uuid(), user_id uuid not null, group_id uuid not null)`;
    await pg`
      create table pages (
        id uuid primary key, slug_id varchar, title varchar, position varchar,
        parent_page_id uuid references pages (id) on delete cascade,
        space_id uuid not null references spaces (id) on delete cascade, workspace_id uuid not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
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
        user_id uuid, group_id uuid, role varchar not null, added_by_id uuid,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint page_access_user_unique unique (page_access_id, user_id),
        constraint page_access_group_unique unique (page_access_id, group_id)
      )`;
    await pg`insert into users (id) values (${ACTOR}), (${U1}), (${U2}), (${U3})`;
    await pg`insert into spaces (id, workspace_id) values (${SPACE}, ${WS})`;

    await (new AuthzOutboxInstaller(db as never, 'remote') as unknown as { install(): Promise<void> }).install();
    await new PageCycleGuardInstaller(db as never, 'remote').install();
    await new PageRestrictionGuardInstaller(db as never, 'remote').install();

    const realRepo = new PagePermissionRepo(db as never, {} as never, {} as never);
    const repo = new Proxy(realRepo, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'insertPagePermissions') return typeof value === 'function' ? value.bind(target) : value;
        return async (...args: unknown[]) => {
          if (beforeGrants) {
            const hook = beforeGrants;
            beforeGrants = null;
            await hook();
          }
          return (value as (...a: unknown[]) => Promise<void>).apply(target, args);
        };
      },
    });
    const pageRepo = {
      findById: async (id: string) =>
        db.selectFrom('pages').select(['id', 'spaceId', 'workspaceId', 'parentPageId']).where('id', '=', id).executeTakeFirst(),
    };
    svc = new PageRestrictionService(
      db as never,
      pageRepo as never,
      repo as never,
      { createForUser: async () => ({ cannot: () => false }) } as never,
      'remote',
      { tryCheckBulk: async (_s: unknown, checks: unknown[]) => checks.map((_c, i) => pdp[i] ?? true) } as never,
      { invalidateSpaceRestrictionCache: async (spaceId: string) => void invalidations.push(spaceId) } as never,
    );
    reads = new ServiceContentService(db as never, fakeWorkspaceResolver(WS));
  });

  beforeEach(async () => {
    pdp = [true, true];
    beforeGrants = null;
    invalidations.length = 0;
    await page(P, null);
    await page(Q, null);
    await page(Y, null);
  });

  afterEach(async () => {
    await pg`delete from page_access`;
    await pg`update pages set parent_page_id = null`;
    await pg`delete from pages`;
    await pg`delete from authz_outbox`;
  });

  afterAll(async () => {
    await db?.destroy();
    await side?.end({ timeout: 5 });
    await pg?.end({ timeout: 5 });
  });

  describe('the version the ACL read issues is the one the write compares', () => {
    it('stale → 412 precondition_failed with nothing changed; fresh → applied, answering the next read’s version', async () => {
      await restrictRow(P, [[U1, 'reader']]);
      const v = await version(P);
      const before = await snapshot();
      expect(
        await outcome(svc.addPermission({ pageId: P, role: 'writer', userIds: [U2], expectedVersion: 'f'.repeat(64) } as never, actor)),
      ).toBe('412:precondition_failed');
      expect(await snapshot()).toEqual(before);

      const res = await svc.addPermission({ pageId: P, role: 'writer', userIds: [U2], expectedVersion: v } as never, actor);
      expect(res.version).toBe(await version(P));
      expect(res.version).not.toBe(v);
      expect(res.effect).toEqual({
        restrictedBefore: true,
        restrictedAfter: true,
        added: [{ userId: U2, groupId: null, role: 'writer' }],
        changed: [],
        removed: [],
      });
      expect(await grants(P)).toEqual([
        { userId: U1, role: 'reader' },
        { userId: U2, role: 'writer' },
      ]);
    });

    it.each([
      ['restrict', (v: string) => svc.restrict(Q, actor, { expectedVersion: v })],
      ['unrestrict', (v: string) => svc.unrestrict(P, actor, { expectedVersion: v })],
      ['add', (v: string) => svc.addPermission({ pageId: P, role: 'writer', userIds: [U2], expectedVersion: v } as never, actor)],
      ['remove', (v: string) => svc.removePermission({ pageId: P, userIds: [U1], expectedVersion: v } as never, actor)],
      ['update', (v: string) => svc.updatePermission({ pageId: P, role: 'writer', userId: U1, expectedVersion: v } as never, actor)],
    ])('%s: a stale version changes nothing; the current one (and "*") applies', async (_op, run) => {
      await restrictRow(P, [[U1, 'reader']]);
      const before = await snapshot();
      expect(await outcome(run('f'.repeat(64)))).toBe('412:precondition_failed');
      expect(await snapshot()).toEqual(before);
      const target = _op === 'restrict' ? Q : P;
      expect(await outcome(run(await version(target)))).toBe('applied');
      expect(await snapshot()).not.toEqual(before);
    });

    it('"*" means the page exists: it passes whatever the ACL is', async () => {
      await restrictRow(P, [[U1, 'reader']]);
      await svc.updatePermission({ pageId: P, role: 'writer', userId: U1, expectedVersion: '*' } as never, actor);
      expect(await grants(P)).toEqual([{ userId: U1, role: 'writer' }]);
    });
  });

  describe('atomic compare', () => {
    it('two writes holding the SAME version: B blocked on A’s ACL lock after both read it — A applies, B 412s', async () => {
      await restrictRow(P);
      const v = await version(P);
      let b!: Promise<Outcome>;
      pdp = [true, true];
      beforeGrants = async () => {
        b = outcome(svc.addPermission({ pageId: P, role: 'reader', userIds: [U2], expectedVersion: v } as never, actor));
        await waitForLockWaiter(); // B waits on the per-page ACL lock A holds
      };
      const a = await outcome(svc.addPermission({ pageId: P, role: 'reader', userIds: [U1], expectedVersion: v } as never, actor));
      expect([a, await b]).toEqual(['applied', '412:precondition_failed']);
      expect(await grants(P)).toEqual([{ userId: U1, role: 'reader' }]);
    });

    it('the same race without choreography (Promise.all): never two applies', async () => {
      await restrictRow(P);
      const v = await version(P);
      const results = await Promise.all(
        [U1, U2, U3].map((u) =>
          outcome(svc.addPermission({ pageId: P, role: 'reader', userIds: [u], expectedVersion: v } as never, actor)),
        ),
      );
      expect(results.filter((r) => r === 'applied')).toHaveLength(1);
      expect(results.filter((r) => r === '412:precondition_failed')).toHaveLength(2);
      expect(await grants(P)).toHaveLength(1);
    });

    it('without a version, two concurrent restricts serialize: one applies, one converges (no unique violation)', async () => {
      const results = await Promise.all([svc.restrict(P, actor), svc.restrict(P, actor)]);
      expect(results.map((r) => r.effect.restrictedBefore).sort()).toEqual([false, true]);
      expect(results[0].version).toBe(results[1].version);
      expect((await pg`select 1 from page_access where page_id = ${P}`).length).toBe(1);
      expect(invalidations).toEqual([SPACE]); // once, for the write that committed
    });

    it('a write is all-or-nothing: a failure after page_access is written leaves no restriction and no outbox row', async () => {
      const before = await snapshot();
      beforeGrants = async () => {
        throw new Error('boom after the page_access insert');
      };
      await expect(svc.restrict(P, actor)).rejects.toThrow('boom');
      expect(await snapshot()).toEqual(before);
      expect(invalidations).toEqual([]);
    });
  });

  describe('lock order: the ACL lock first, never after the workspace lock — no deadlock with the guards', () => {
    it('no trigger or function ever takes the ACL lock class (so it can only be taken first, by the ACL write itself)', async () => {
      const rows = await pg`select proname from pg_proc where prosrc like ${'%' + PAGE_ACL_LOCK_CLASS + '%'}`;
      expect(rows).toEqual([]);
      const guards = await pg`select proname from pg_proc where prosrc like ${'%' + CYCLE_LOCK_CLASS + '%'}`;
      expect(guards.length).toBeGreaterThan(0); // the guards do take the workspace lock (anti-vacuity)
    });

    it('a re-parent of the page, started while our restrict holds its ACL lock AND (via g0) the workspace lock, waits — then applies', async () => {
      const events: string[] = [];
      const x = await side.reserve();
      let moving!: Promise<string>;
      try {
        await x`begin`;
        await x.unsafe(`set local lock_timeout = '5s'`);
        beforeGrants = async () => {
          // We hold P's ACL lock and the workspace lock (g0 ran). The move takes FOR NO KEY UPDATE on P, then waits for the
          // workspace lock in g2; our grant insert's foreign-key FOR KEY SHARE on page_access is not blocked by it.
          moving = x`update pages set parent_page_id = ${Q} where id = ${P}`.then(
            () => (events.push('move-done'), 'ok'),
            (e) => (e as { code?: string }).code ?? 'error',
          );
          await waitForLockWaiter();
          events.push('move-waiting');
        };
        const r = await outcome(svc.restrict(P, actor)).then((o) => (events.push('restrict-done'), o));
        expect(r).toBe('applied');
        expect(await moving).toBe('ok'); // P now carries its own restriction, so moving it strips nothing
        await x`commit`;
      } finally {
        await x`rollback`.catch(() => undefined);
        x.release();
      }
      expect(events).toEqual(['move-waiting', 'restrict-done', 'move-done']);
      expect(await isRestricted(P)).toBe(true);
      expect((await pg`select parent_page_id as p from pages where id = ${P}`)[0].p).toBe(Q);
    });

    it('a restrict started while a move in the same workspace holds the workspace lock waits in g0 — then applies, even when that move also re-parents and FK-locks our page', async () => {
      const x = await side.reserve();
      try {
        await x`begin`;
        await x.unsafe(`set local lock_timeout = '5s'`);
        await x`update pages set parent_page_id = ${Q} where id = ${Y}`; // g2 → the workspace lock, held
        const restricting = outcome(svc.restrict(P, actor));
        await waitForLockWaiter(); // our restrict: P's ACL lock held, waiting for the workspace lock inside g0
        // The mover now touches OUR page: a child insert (FOR KEY SHARE on P) and a re-parent of P (FOR NO KEY UPDATE on P).
        // Neither waits for us — our restrict holds no row lock on P, only its ACL lock, which the mover never takes.
        await x`insert into pages (id, workspace_id, space_id, parent_page_id, position) values (${uuid(4)}, ${WS}, ${SPACE}, ${P}, 'a0')`;
        await x`update pages set parent_page_id = ${Y} where id = ${P}`;
        await x`commit`;
        expect(await restricting).toBe('applied');
      } finally {
        await x`rollback`.catch(() => undefined);
        x.release();
      }
      expect(await isRestricted(P)).toBe(true);
      // g0 took page_access.space_id from the page AFTER the lock: the committed state, never a stale one.
      expect((await pg`select space_id as s from page_access where page_id = ${P}`)[0].s).toBe(SPACE);
    });

    it('stress: ACL writes (each through g0 or under the ACL lock) racing re-parents in the same workspace never deadlock or time out', async () => {
      await restrictRow(P, [[U1, 'reader']]);
      const busy: string[] = [];
      const seen = new Set<string>();
      for (let round = 0; round < 8; round++) {
        const results = await Promise.all([
          outcome(svc.addPermission({ pageId: P, role: 'reader', userIds: [U2] } as never, actor)),
          outcome(side`update pages set parent_page_id = ${round % 2 ? Y : null} where id = ${P}`.then(() => undefined)),
          outcome(svc.updatePermission({ pageId: P, role: round % 2 ? 'writer' : 'reader', userId: U1 } as never, actor)),
          outcome(svc.restrict(Q, actor)), // g0: the workspace lock, inside the ACL lock
          outcome(side`update pages set parent_page_id = ${round % 2 ? null : Q} where id = ${Y}`.then(() => undefined)),
          outcome(svc.removePermission({ pageId: P, userIds: [U2] } as never, actor)),
          outcome(svc.unrestrict(Q, actor)),
        ]);
        if (process.env.DEBUG_STRESS) console.log(results.join(' '));
        // Every ACL write really ran (no pre-check short-circuit); a move may be refused by g2 (23514: it would take Y
        // out from under a restricted Q) — that is the guard working, not a lock problem.
        [0, 2, 3, 5, 6].forEach((i) => seen.add(results[i]));
        busy.push(...results.filter((r) => r.startsWith('503') || r.includes('40P01') || r.includes('55P03')));
      }
      expect(busy).toEqual([]);
      expect([...seen]).toEqual(['applied']);
    });
  });

  describe('bounded waits', () => {
    it('the workspace lock held elsewhere past lock_timeout → 503 engine_busy, nothing written', async () => {
      const before = await snapshot();
      const x = await side.reserve();
      try {
        await x`begin`;
        await x`select pg_advisory_xact_lock(${CYCLE_LOCK_CLASS}, hashtext(${WS}::text))`;
        const started = Date.now();
        expect(await outcome(svc.restrict(P, actor))).toBe('503:engine_busy');
        expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      } finally {
        await x`rollback`;
        x.release();
      }
      expect(await snapshot()).toEqual(before);
    });

    it("the page's ACL lock held elsewhere past lock_timeout → 503 engine_busy (the ACL lock wait is bounded too)", async () => {
      await restrictRow(P, [[U1, 'reader']]);
      const before = await snapshot();
      const x = await side.reserve();
      try {
        await x`begin`;
        await x`select pg_advisory_xact_lock(${PAGE_ACL_LOCK_CLASS}, hashtext(${P}::text))`;
        expect(await outcome(svc.removePermission({ pageId: P, userIds: [U1] } as never, actor))).toBe('503:engine_busy');
      } finally {
        await x`rollback`;
        x.release();
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('restriction-preview leaves no trace', () => {
    const cases: Array<[string, () => Promise<void>, Record<string, unknown>, () => Promise<unknown>]> = [
      ['restrict', async () => undefined, { action: 'restrict' }, () => svc.restrict(P, actor)],
      ['unrestrict', async () => restrictRow(P, [[U1, 'reader']]), { action: 'unrestrict' }, () => svc.unrestrict(P, actor)],
      [
        'add',
        async () => restrictRow(P, [[U1, 'reader']]),
        { action: 'add', role: 'writer', userIds: [U1, U2] },
        () => svc.addPermission({ pageId: P, role: 'writer', userIds: [U1, U2] } as never, actor),
      ],
      [
        'remove',
        async () => restrictRow(P, [[U1, 'reader'], [U2, 'writer']]),
        { action: 'remove', userIds: [U2] },
        () => svc.removePermission({ pageId: P, userIds: [U2] } as never, actor),
      ],
      [
        'update',
        async () => restrictRow(P, [[U1, 'reader']]),
        { action: 'update', role: 'writer', userId: U1 },
        () => svc.updatePermission({ pageId: P, role: 'writer', userId: U1 } as never, actor),
      ],
    ];

    it.each(cases)('%s: the real write ran (its triggers fired) and was rolled back; the real write then has the same effect', async (_op, setup, body, real) => {
      await setup();
      const v = await version(P);
      const before = await snapshot();
      const seqBefore = await outboxSeq();
      const preview = await svc.preview({ pageId: P, ...body } as never, actor);
      expect(preview.outcome).toBe('would_apply');
      expect(preview.version).toBe(v); // the CURRENT version
      expect(await snapshot()).toEqual(before); // page_access, page_permissions, authz_outbox, users: untouched
      expect(await outboxSeq()).toBeGreaterThan(seqBefore); // …yet the capture trigger DID run inside the preview
      expect(invalidations).toEqual([]);

      const done = (await real()) as { effect: unknown };
      expect(done.effect).toEqual(preview.effect);
    });

    it('a refused preview (self-grant, stale version) reports the current version and writes nothing', async () => {
      await restrictRow(P, [[U1, 'reader']]);
      const v = await version(P);
      const before = await snapshot();
      await expect(svc.preview({ pageId: P, action: 'add', role: 'writer', userIds: [ACTOR] } as never, actor)).resolves.toEqual({
        outcome: 'refused',
        code: 'self_grant',
        version: v,
        effect: { restrictedBefore: true, restrictedAfter: true, added: [], changed: [], removed: [] },
      });
      await expect(
        svc.preview({ pageId: P, action: 'remove', userIds: [U1], expectedVersion: 'f'.repeat(64) } as never, actor),
      ).resolves.toMatchObject({ outcome: 'refused', code: 'precondition_failed', version: v });
      expect(await snapshot()).toEqual(before);
    });

    it('A3 with requireActorCoverage: an exposed sub-page is refused in the preview exactly as in the write', async () => {
      await page(uuid(5), P); // unrestricted child of P
      await restrictRow(P);
      await expect(
        svc.preview({ pageId: P, action: 'unrestrict', requireActorCoverage: true } as never, actor),
      ).resolves.toMatchObject({ outcome: 'refused', code: 'exposes_subpages' });
      expect(await outcome(svc.unrestrict(P, actor, { requireActorCoverage: true }))).toBe('409:');
      expect(await isRestricted(P)).toBe(true);
    });
  });
});
