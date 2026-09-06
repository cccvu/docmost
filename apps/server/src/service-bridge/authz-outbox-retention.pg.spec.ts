import * as postgres from 'postgres';
import { Logger } from '@nestjs/common';
import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { AuthzOutboxInstaller } from './authz-outbox.installer';
import { AuthzChangeFeedService, StaleCursorError } from './authz-change-feed.service';

/**
 * Real-Postgres proof of the change feed's RETENTION contract (Group D R2, issues #171 / #174): the hourly
 * `gc()` sweep and the stale-cursor gate that keeps age-based retention from ever silently skipping an
 * un-consumed event. `GC_INTERVAL_MS` is a hardcoded hourly timer, so the sweep is invoked DIRECTLY on the real
 * service (never via `onModuleInit`, which would also start the LISTEN + the timer).
 *
 * Pinned here, on the engine, over the installer's REAL DDL:
 *  - the sweep deletes only rows older than `AUTHZ_OUTBOX_RETENTION_DAYS` (default 7) and advances the
 *    `authz_outbox_gc` high-water mark to the max deleted `(xact_id, id)` TUPLE (not the max id: under commit
 *    reordering the highest bigserial can carry a LOWER transaction id);
 *  - the mark is monotonic: a later sweep that removes only lower tuples never moves it backwards, and a sweep
 *    that removes nothing leaves it untouched;
 *  - the stale check is STRICT `>`: a cursor BELOW the mark throws `StaleCursorError` (409 -> rebaseline), a
 *    cursor AT the mark passes (an idle-at-tail consumer whose last row was reclaimed must NOT spuriously
 *    rebaseline), a cursor ABOVE the mark passes. Both sides are asserted, so a `>` -> `>=` edit (or the
 *    reverse) fails.
 *
 * Runs only when AUTHZ_TEST_PG_URL points at a PostgreSQL 13+ instance; otherwise it self-skips so the
 * Docker-less unit lane stays green. The `docmost-authz-pg` CI job provisions Postgres and sets the URL. The
 * spec owns a private schema (search_path) so it can share one database with the sibling pg specs.
 */
const PG_URL = process.env.AUTHZ_TEST_PG_URL;
const d = PG_URL ? describe : describe.skip;

// Anti-vacuity guard (ALWAYS runs, even without a URL): if the CI lane declares it REQUIRES Postgres
// (AUTHZ_REQUIRE_PG=1, set by the docmost-authz-pg job) but AUTHZ_TEST_PG_URL is unset, this proof would
// silently self-skip and the required gate would go green with ZERO coverage. Fail loudly instead, so a
// regression in the ci.yml env wiring reds the lane rather than passing vacuously.
describe('real-PG retention gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'authz_retention_pg_spec';

/** The same env reading as the service (module-load constant, default 7), so the backdate is always past it. */
const RETENTION_DAYS = (() => {
  const n = Number.parseInt(process.env.AUTHZ_OUTBOX_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
})();

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Tuple {
  xactId: string;
  id: number;
}

/** Tuple compare on (xact_id, id) with BigInt on the xid8 half, as the service does. */
const tupleGt = (a: Tuple, b: Tuple): boolean =>
  BigInt(a.xactId) !== BigInt(b.xactId) ? BigInt(a.xactId) > BigInt(b.xactId) : a.id > b.id;

d('AuthzChangeFeedService retention on real Postgres (gc sweep + stale-cursor mark)', () => {
  const mkPg = (max: number): postgres.Sql =>
    postgres(PG_URL as string, {
      max,
      onnotice: () => {},
      connection: { search_path: SCHEMA },
      types: {
        bigint: {
          to: 20,
          from: [20, 1700],
          serialize: (v: number) => v.toString(),
          parse: (v: string) => Number.parseInt(v),
        },
      },
    });

  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let feed: AuthzChangeFeedService;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  const gc = () => (feed as unknown as { gc(): Promise<void> }).gc();
  const cursorOf = (t: Tuple) => `${t.xactId}.${t.id}`;

  const memberPayload = (n: number) => ({
    space_id: uuid(n),
    user_id: uuid(2),
    group_id: null,
    role: 'reader',
    deleted_at: null,
  });
  const insertRow = (conn: postgres.Sql | postgres.ReservedSql, n: number) =>
    conn`insert into authz_outbox (op, table_name, payload) values ('INSERT', 'space_members', ${pg.json(memberPayload(n))})`;

  const outboxRows = async (): Promise<Tuple[]> => {
    const rows = await pg<
      { xact_id: string; id: number }[]
    >`select xact_id::text as xact_id, id from authz_outbox order by id`;
    return rows.map((r) => ({ xactId: r.xact_id, id: r.id }));
  };
  const mark = async (): Promise<Tuple> => {
    const rows = await pg<
      { xact_id: string; id: number }[]
    >`select xact_id::text as xact_id, id from authz_outbox_gc where singleton = true`;
    expect(rows).toHaveLength(1);
    return { xactId: rows[0].xact_id, id: rows[0].id };
  };
  const backdate = (ids: number[]) =>
    pg`update authz_outbox set created_at = now() - make_interval(days => ${RETENTION_DAYS + 1}) where id = any(${ids}::bigint[])`;

  beforeAll(async () => {
    const bootstrap = postgres(PG_URL as string, {
      max: 1,
      onnotice: () => {},
    });
    await bootstrap`drop schema if exists ${bootstrap(SCHEMA)} cascade`;
    await bootstrap`create schema ${bootstrap(SCHEMA)}`;
    await bootstrap.end({ timeout: 5 });

    pg = mkPg(4);
    appPg = mkPg(2);
    db = new Kysely<any>({
      dialect: new PostgresJSDialect({ postgres: appPg }),
      plugins: [new CamelCasePlugin()],
    });
    feed = new AuthzChangeFeedService(db as any, { getDatabaseURL: () => PG_URL } as any, 'remote' as any);

    // The REAL installer DDL (outbox + xact_id default + gc singleton + triggers) over the minimal base tables
    // its triggers reference; the rows below are written straight into the outbox (the trigger chain itself
    // is proven in authz-outbox-installer.pg.spec.ts).
    await pg`create table users (id uuid primary key)`;
    await pg`create table spaces (id uuid primary key, workspace_id uuid not null, deleted_at timestamptz)`;
    await pg`create table space_members (id uuid primary key default gen_random_uuid(), user_id uuid, group_id uuid, space_id uuid not null, role varchar not null, deleted_at timestamptz)`;
    await pg`create table group_users (id uuid primary key default gen_random_uuid(), user_id uuid not null, group_id uuid not null)`;
    await pg`create table pages (id uuid primary key, space_id uuid not null, parent_page_id uuid, deleted_at timestamptz)`;
    await pg`create table page_access (id uuid primary key default gen_random_uuid(), page_id uuid not null)`;
    await pg`create table page_permissions (id uuid primary key default gen_random_uuid(), page_access_id uuid not null, user_id uuid, group_id uuid, role varchar not null)`;
    const installer = new AuthzOutboxInstaller(db as any, 'remote' as any);
    await (installer as unknown as { install(): Promise<void> }).install();
  });

  afterAll(async () => {
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
  });

  beforeEach(async () => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    await pg`truncate authz_outbox restart identity`;
    await pg`update authz_outbox_gc set xact_id = '0', id = 0`;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('gc() reclaims only rows past the retention window and advances the mark to the max deleted (xact_id, id) tuple, monotonically', async () => {
    // Row 1 (X): the LOWEST transaction id; stays young for now (the monotonicity probe at the end).
    await insertRow(pg, 1);
    // Rows 2 + 3: a commit-reordered pair, so max-by-TUPLE differs from max-by-ID. A opens first and pins the
    // lower xid; B (higher xid) inserts id 2 and commits first; A then inserts id 3 under its lower xid.
    const a = await pg.reserve();
    const b = await pg.reserve();
    try {
      await a`begin`;
      await a`select pg_current_xact_id()`;
      await b`begin`;
      await insertRow(b, 2);
      await b`commit`;
      await insertRow(a, 3);
      await a`commit`;
    } finally {
      a.release();
      b.release();
    }
    // Row 4 (Y): young, must survive every sweep below.
    await insertRow(pg, 4);

    const before = await outboxRows();
    expect(before.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    const [x, r2, r3, y] = before;
    expect(BigInt(r2.xactId)).toBeGreaterThan(BigInt(r3.xactId)); // the reorder is real: id 2 carries the HIGHER xid
    expect(tupleGt(r2, r3)).toBe(true);
    expect(tupleGt(y, r2)).toBe(true);
    expect(tupleGt(r3, x)).toBe(true);

    // Nothing old yet: a sweep is a no-op and the mark stays at zero.
    await gc();
    expect(await mark()).toEqual({ xactId: '0', id: 0 });
    expect(await outboxRows()).toEqual(before);

    // Age rows 2 + 3 past the window and sweep: exactly they are reclaimed, the mark lands on the max TUPLE
    // (r2: higher xid, lower id), NOT the max id (r3).
    await backdate([2, 3]);
    await gc();
    expect((await outboxRows()).map((r) => r.id)).toEqual([1, 4]);
    expect(await mark()).toEqual(r2);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`removed 2 rows older than ${RETENTION_DAYS}d (gc mark -> ${cursorOf(r2)})`),
    );

    // Idle sweep: nothing to delete, the mark is untouched.
    await gc();
    expect(await mark()).toEqual(r2);

    // Monotonic: reclaiming X (the lowest tuple) later must NOT move the mark backwards.
    await backdate([1]);
    await gc();
    expect((await outboxRows()).map((r) => r.id)).toEqual([4]);
    expect(await mark()).toEqual(r2);

    // gc() swallows + logs failures instead of throwing (the timer must not die), so prove none happened.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stale-cursor gate is strict: a cursor BELOW the gc mark throws StaleCursorError, AT and ABOVE it pass', async () => {
    await insertRow(pg, 1);
    await insertRow(pg, 2);
    await insertRow(pg, 3);
    const [r1, r2, r3] = await outboxRows();
    await backdate([1, 2]);
    await gc();
    expect(await mark()).toEqual(r2);
    expect((await outboxRows()).map((r) => r.id)).toEqual([3]);

    // BELOW the mark: the zero cursor, a lower xid, and the same xid with a lower id: all lost an event -> 409.
    for (const below of ['0.0', cursorOf(r1), `${r2.xactId}.${r2.id - 1}`, `${BigInt(r2.xactId) - 1n}.${r2.id + 5}`]) {
      await expect(feed.getChanges(below, 0, 100)).rejects.toBeInstanceOf(StaleCursorError);
    }
    // The 409 carries the current safe head for the rebaseline.
    const err = await feed.getChanges('0.0', 0, 100).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleCursorError);
    expect((err as StaleCursorError).head).toMatch(/^\d+\.\d+$/);

    // AT the mark: the consumer already consumed the reclaimed max row; nothing is lost -> must NOT rebaseline.
    await expect(feed.getChanges(cursorOf(r2), 0, 100)).resolves.toMatchObject({
      nextCursor: expect.stringMatching(/^\d+\.\d+$/),
    });
    // ABOVE the mark: same xid / higher id, a higher xid, and the surviving row's own tuple.
    for (const above of [`${r2.xactId}.${r2.id + 1}`, `${BigInt(r2.xactId) + 1n}.0`, cursorOf(r3)]) {
      await expect(feed.getChanges(above, 0, 100)).resolves.toMatchObject({
        nextCursor: expect.stringMatching(/^\d+\.\d+$/),
      });
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
