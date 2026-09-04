import * as postgres from 'postgres';
import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { AuthzChangeFeedService } from './authz-change-feed.service';

/**
 * Real-Postgres two-connection proof of the R2 commit-safe watermark (Group D, issue #171) — the security
 * invariant a synthetic in-memory fixture CANNOT prove. Reproduces the ACTUAL transactional-outbox commit-
 * ordering race on a live engine: a transaction with a LOW xid but a LATE (higher) bigserial, racing a
 * concurrent transaction with a HIGH xid but an EARLY (lower) bigserial that commits first. A naive
 * `id > cursor` feed would advance past the early-committing higher id and SKIP the late-committing lower one
 * (a lost revocation = P0 fail-open). The real `AuthzChangeFeedService` — gated by
 * `xact_id < pg_snapshot_xmin(pg_current_snapshot())` and cursored by `(xact_id, id)` — must instead WITHHOLD
 * the early row until the older transaction settles, then deliver BOTH in transaction-id order with no skip.
 * Also proves the rollback case (an aborted row is never delivered and never blocks the frontier) and, by
 * construction, that `xid8` ordering + the xmin gate behave as the plan's proof assumes on the real engine.
 *
 * Runs only when AUTHZ_TEST_PG_URL points at a PostgreSQL 13+ instance (a throwaway `postgres:18` container or
 * the local compose PG); otherwise it self-skips so the Docker-less unit lane stays green. The dedicated
 * `docmost-authz-pg` CI job provisions Postgres and sets the URL so this gate always runs there.
 */
const PG_URL = process.env.AUTHZ_TEST_PG_URL;
const d = PG_URL ? describe : describe.skip;

// Anti-vacuity guard (ALWAYS runs, even without a URL): if the CI lane declares it REQUIRES Postgres
// (AUTHZ_REQUIRE_PG=1, set by the docmost-authz-pg job) but AUTHZ_TEST_PG_URL is unset, the commit-safety
// proof would silently self-skip and the required gate would go green with ZERO coverage. Fail loudly instead,
// so a regression in the ci.yml env wiring reds the lane rather than passing vacuously.
describe('real-PG commit-safety gate', () => {
  it('is not vacuous — runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

d('AuthzChangeFeedService — real-Postgres commit-safety (Group D R2)', () => {
  // Mirror the production Kysely config so id parses to number and xid8 stays a string (see database.module).
  const mkPg = (max: number): postgres.Sql =>
    postgres(PG_URL as string, {
      max,
      onnotice: () => {},
      types: {
        bigint: {
          to: 20,
          from: [20, 1700],
          serialize: (v: number) => v.toString(),
          parse: (v: string) => Number.parseInt(v),
        },
      },
    });

  let admin: postgres.Sql;
  let feedPg: postgres.Sql;
  let db: Kysely<any>;
  let feed: AuthzChangeFeedService;
  let a: postgres.ReservedSql;
  let b: postgres.ReservedSql;

  const insertMember = (conn: postgres.Sql | postgres.ReservedSql, space: string) =>
    conn`
      insert into authz_outbox (op, table_name, payload)
      values ('INSERT', 'space_members', ${JSON.stringify({ space_id: space, user_id: 'u', group_id: null, role: 'reader' })}::jsonb)
    `;

  beforeAll(async () => {
    admin = mkPg(4);
    feedPg = mkPg(2);
    db = new Kysely<any>({
      dialect: new PostgresJSDialect({ postgres: feedPg }),
      plugins: [new CamelCasePlugin()],
    });
    feed = new AuthzChangeFeedService(db as any, { getDatabaseURL: () => PG_URL } as any, 'remote' as any);

    // The installer DDL subset the feed needs: the outbox with the xact_id (xid8, pg_current_xact_id default)
    // column + the (xact_id, id) index + the gc high-water table. Inserting into authz_outbox directly fires
    // the same xact_id DEFAULT the AFTER trigger relies on, so this exercises the real capture path.
    await admin`drop table if exists authz_outbox`;
    await admin`drop table if exists authz_outbox_gc`;
    await admin`
      create table authz_outbox (
        id         bigserial primary key,
        op         text        not null,
        table_name text        not null,
        payload    jsonb       not null,
        created_at timestamptz not null default now(),
        xact_id    xid8        not null default pg_current_xact_id()
      )
    `;
    await admin`create index on authz_outbox (xact_id, id)`;
    await admin`
      create table authz_outbox_gc (
        singleton boolean primary key default true,
        xact_id   xid8    not null default '0',
        id        bigint  not null default 0
      )
    `;
    await admin`insert into authz_outbox_gc (singleton) values (true) on conflict do nothing`;
  });

  afterAll(async () => {
    await db?.destroy?.();
    await admin?.end?.({ timeout: 5 });
    await feedPg?.end?.({ timeout: 5 });
  });

  beforeEach(async () => {
    await admin`truncate authz_outbox restart identity`;
    await admin`update authz_outbox_gc set xact_id = '0', id = 0`;
    a = await admin.reserve();
    b = await admin.reserve();
  });

  afterEach(async () => {
    try {
      await a`rollback`;
    } catch {
      /* no open txn */
    }
    try {
      await b`rollback`;
    } catch {
      /* no open txn */
    }
    a.release();
    b.release();
  });

  it('reorder race: a lower bigserial that commits LATE is never skipped (gap-free)', async () => {
    // A: open a txn and pin a LOW xid (pg_current_xact_id assigns one) WITHOUT writing a row yet.
    await a`begin`;
    await a`select pg_current_xact_id()`;
    // B: a later txn (HIGHER xid) writes its outbox row FIRST (bigserial id = 1) and commits.
    await b`begin`;
    await insertMember(b, 'sB');
    await b`commit`;
    // A: now writes its outbox row (bigserial id = 2) under its already-assigned LOWER xid, still in-flight.
    await insertMember(a, 'sA');

    // While A is in-flight, the xmin gate must WITHHOLD B (its xid > xmin = A's xid); A's row is uncommitted.
    const during = await feed.getChanges('0.0', 0, 100);
    expect(during.events).toHaveLength(0);
    expect(during.nextCursor).toBe('0.0'); // cursor cannot advance past the unsettled reorder

    await a`commit`;

    // After A settles: BOTH delivered, ordered by (xact_id, id) => A (lower xid) THEN B (higher xid, lower id).
    // A naive id-cursor would have shipped B (id 1) during the in-flight poll and skipped A (id 2) forever.
    const after = await feed.getChanges('0.0', 0, 100);
    expect(after.events.map((e: any) => e.spaceId)).toEqual(['sA', 'sB']);
    // Consumed exactly once: re-polling from the returned cursor yields nothing more.
    const tail = await feed.getChanges(after.nextCursor, 0, 100);
    expect(tail.events).toHaveLength(0);
  });

  it('rollback: an aborted row is never delivered and never blocks the frontier', async () => {
    await a`begin`;
    await a`select pg_current_xact_id()`; // A: low xid
    await b`begin`;
    await insertMember(b, 'sB'); // B: high xid, id = 1, committed
    await b`commit`;
    await insertMember(a, 'sA'); // A: low xid, id = 2 — will be aborted
    await a`rollback`;

    const res = await feed.getChanges('0.0', 0, 100);
    expect(res.events.map((e: any) => e.spaceId)).toEqual(['sB']); // only B; A's dead row is never served
  });

  it('a settled row is delivered, its jsonb payload is parsed, and the opaque cursor round-trips', async () => {
    await insertMember(admin, 'sX'); // auto-committed, settled immediately
    const res = await feed.getChanges('0.0', 0, 100);
    // Proves the jsonb payload is parsed off the wire (postgres.js returns jsonb as a snake_case string, so
    // the feed JSON.parses it and the mapper reads the stored snake_case keys).
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ type: 'SpaceMemberChanged', spaceId: 'sX', role: 'reader' });
    expect(res.nextCursor).toMatch(/^\d+\.\d+$/); // "<xact_id>.<id>"
    const tail = await feed.getChanges(res.nextCursor, 0, 100);
    expect(tail.events).toHaveLength(0);
  });
});
