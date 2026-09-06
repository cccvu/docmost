import * as postgres from 'postgres';
import { Logger } from '@nestjs/common';
import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { AuthzOutboxInstaller } from './authz-outbox.installer';
import { AuthzChangeFeedService } from './authz-change-feed.service';
import { AuthzChangeEvent, isExpectedSkip } from './authz-change-event';

/**
 * Real-Postgres proof of the fork-owned outbox INSTALLER (Group D, issues #171 / #174). Three things a spy
 * Kysely cannot prove on a live engine:
 *
 *  1. LEGACY UPGRADE (a DR restore from a pre-R2 snapshot, or a fresh volume seeded by the retired platform
 *     installer): the pre-R2 `authz_outbox` has NO `xact_id` column and rows present. The installer must add the
 *     column, backfill the settled sentinel `'3'::xid8`, then set NOT NULL (validated over the pre-existing
 *     rows) without error, and the gc high-water table + `(xact_id, id)` index must exist afterwards. A wrong
 *     backfill order crash-loops the first boot after such a restore.
 *  2. IDEMPOTENCE on a fresh schema: `install()` twice (once through the public `onApplicationBootstrap` path)
 *     yields the SAME object inventory, no duplicate triggers, no error.
 *  3. THE TRIGGER CHAIN (G1): real `install()` over real base tables, then INSERT / UPDATE / DELETE on every
 *     authz table, asserting (a) exactly the expected outbox rows appear (column-scoped `pages` / `spaces`
 *     triggers fire ONLY on the structural columns; NO trigger on `users`), (b) every payload is a jsonb OBJECT
 *     (never a double-encoded string scalar, the fixture defect that let incident #181 pass), and (c) each row
 *     maps through the REAL `AuthzChangeFeedService` under the PRODUCTION Kysely configuration (CamelCasePlugin
 *     + the bigint parser of database.module.ts) into the expected typed `AuthzChangeEvent`, with the feed's
 *     `AUTHZ_CHANGE_EVENT_DROPPED` detector never firing.
 *
 * Runs only when AUTHZ_TEST_PG_URL points at a PostgreSQL 13+ instance (a throwaway `postgres:18` container or
 * the local compose PG); otherwise it self-skips so the Docker-less unit lane stays green. The dedicated
 * `docmost-authz-pg` CI job provisions Postgres and sets the URL so this gate always runs there. The spec owns a
 * private schema (search_path) so it can share one database with the sibling pg specs under parallel workers.
 */
const PG_URL = process.env.AUTHZ_TEST_PG_URL;
const d = PG_URL ? describe : describe.skip;

// Anti-vacuity guard (ALWAYS runs, even without a URL): if the CI lane declares it REQUIRES Postgres
// (AUTHZ_REQUIRE_PG=1, set by the docmost-authz-pg job) but AUTHZ_TEST_PG_URL is unset, this proof would
// silently self-skip and the required gate would go green with ZERO coverage. Fail loudly instead, so a
// regression in the ci.yml env wiring reds the lane rather than passing vacuously.
describe('real-PG installer gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') {
      expect(PG_URL).toBeTruthy();
    }
  });
});

const SCHEMA = 'authz_installer_pg_spec';

/** Deterministic, readable UUIDs for fixtures. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('AuthzOutboxInstaller on real Postgres (legacy upgrade, idempotence, trigger chain)', () => {
  // Mirror the production Kysely config (database.module.ts): int8/numeric parse to number, xid8 stays a
  // string, CamelCasePlugin on the result keys. The `connection.search_path` pins every unqualified name
  // (the installer's DDL, the feed's reads, the trigger function's `page_access` lookup) to this spec's schema.
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

  const ENV = ['AUTHZ_OUTBOX_INSTALL_MAX_ATTEMPTS', 'AUTHZ_OUTBOX_INSTALL_RETRY_MS'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let installer: AuthzOutboxInstaller;
  let feed: AuthzChangeFeedService;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  const install = () => (installer as unknown as { install(): Promise<void> }).install();

  /** The minimal Docmost base tables the capture triggers reference (types + RI cascades as in the migrations;
   *  `gen_random_uuid()` stands in for Docmost's `gen_uuid_v7()`). `title`/`name`/`content` exist so a
   *  non-structural edit can be shown to produce NO outbox row. */
  const createBaseTables = async () => {
    await pg`create table users (id uuid primary key, email varchar not null, role varchar, deleted_at timestamptz)`;
    await pg`create table groups (id uuid primary key, name varchar not null)`;
    await pg`
      create table spaces (
        id uuid primary key, name varchar, workspace_id uuid not null, deleted_at timestamptz
      )`;
    await pg`
      create table space_members (
        id uuid primary key default gen_random_uuid(),
        user_id uuid references users (id) on delete cascade,
        group_id uuid references groups (id) on delete cascade,
        space_id uuid not null references spaces (id) on delete cascade,
        role varchar not null,
        deleted_at timestamptz
      )`;
    await pg`
      create table group_users (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users (id) on delete cascade,
        group_id uuid not null references groups (id) on delete cascade
      )`;
    await pg`
      create table pages (
        id uuid primary key,
        title varchar,
        content jsonb,
        parent_page_id uuid references pages (id) on delete cascade,
        space_id uuid not null references spaces (id) on delete cascade,
        workspace_id uuid not null,
        deleted_at timestamptz
      )`;
    await pg`
      create table page_access (
        id uuid primary key default gen_random_uuid(),
        page_id uuid not null unique references pages (id) on delete cascade,
        workspace_id uuid not null,
        space_id uuid not null references spaces (id) on delete cascade,
        access_level varchar not null
      )`;
    await pg`
      create table page_permissions (
        id uuid primary key default gen_random_uuid(),
        page_access_id uuid not null references page_access (id) on delete cascade,
        user_id uuid references users (id) on delete cascade,
        group_id uuid references groups (id) on delete cascade,
        role varchar not null
      )`;
  };

  /** The installer-owned object inventory in this schema: triggers (with their full definitions, so the
   *  column scoping is pinned), outbox indexes, outbox columns, the capture function. */
  const inventory = async () => {
    const triggers = await pg<{ rel: string; tgname: string; def: string }[]>`
      select c.relname as rel, t.tgname, pg_get_triggerdef(t.oid) as def
      from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and not t.tgisinternal and t.tgname like 'authz_outbox_%'
      order by c.relname, t.tgname`;
    const indexes = await pg<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where schemaname = current_schema() and tablename in ('authz_outbox', 'authz_outbox_gc')
      order by indexname`;
    const columns = await pg<
      {
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`
      select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema = current_schema() and table_name = 'authz_outbox'
      order by ordinal_position`;
    const fn = await pg<{ c: number }[]>`
      select count(*)::int as c from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = current_schema() and p.proname = 'authz_outbox_capture'`;
    const gc = await pg<{ c: number }[]>`select count(*)::int as c from authz_outbox_gc where singleton = true`;
    return {
      triggers: triggers.map((t) => ({ ...t })),
      indexes: indexes.map((i) => ({ ...i })),
      columns: columns.map((c) => ({ ...c })),
      captureFunctions: fn[0].c,
      gcSingletons: gc[0].c,
    };
  };

  beforeAll(async () => {
    ENV.forEach((k) => (savedEnv[k] = process.env[k]));
    // The public boot path retries 30 x 2 s on failure; make a failure fail FAST here (read at construction).
    process.env.AUTHZ_OUTBOX_INSTALL_MAX_ATTEMPTS = '1';
    process.env.AUTHZ_OUTBOX_INSTALL_RETRY_MS = '0';

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
    installer = new AuthzOutboxInstaller(db as any, 'remote' as any);
    feed = new AuthzChangeFeedService(db as any, { getDatabaseURL: () => PG_URL } as any, 'remote' as any);
  });

  afterAll(async () => {
    ENV.forEach((k) => (savedEnv[k] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[k])));
    await db?.destroy?.();
    await pg?.end?.({ timeout: 5 });
  });

  beforeEach(async () => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    await pg`
      drop table if exists authz_outbox, authz_outbox_gc, page_permissions, page_access, group_users,
        space_members, pages, spaces, groups, users cascade`;
    await pg`drop function if exists authz_outbox_capture() cascade`;
    await createBaseTables();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('upgrades a LEGACY outbox (no xact_id, rows present): backfills the sentinel, sets NOT NULL, creates the gc table + index, no error', async () => {
    // The pre-R2 shape the retired platform installer created (issue #174 comment): no xact_id column.
    await pg`
      create table authz_outbox (
        id           bigserial primary key,
        op           text        not null,
        table_name   text        not null,
        payload      jsonb       not null,
        created_at   timestamptz not null default now(),
        processed_at timestamptz,
        error        text,
        attempts     integer     not null default 0
      )`;
    // Real jsonb OBJECTS (postgres.js `json()`), exactly what the capture trigger's jsonb_build_object stores.
    await pg`
      insert into authz_outbox (op, table_name, payload) values
        ('INSERT', 'space_members', ${pg.json({ space_id: uuid(1), user_id: uuid(2), group_id: null, role: 'reader', deleted_at: null })}),
        ('DELETE', 'space_members', ${pg.json({ space_id: uuid(1), user_id: uuid(2), group_id: null, role: 'reader', deleted_at: null })})`;
    const shapes = await pg<{ t: string }[]>`select jsonb_typeof(payload) as t from authz_outbox`;
    expect(shapes.map((s) => s.t)).toEqual(['object', 'object']);

    await expect(install()).resolves.toBeUndefined();

    const col = await pg<{ is_nullable: string; column_default: string }[]>`
      select is_nullable, column_default from information_schema.columns
      where table_schema = current_schema() and table_name = 'authz_outbox' and column_name = 'xact_id'`;
    expect(col).toHaveLength(1);
    expect(col[0].is_nullable).toBe('NO');
    expect(col[0].column_default).toBe('pg_current_xact_id()');
    const rows = await pg<
      { xact_id: string; id: number }[]
    >`select xact_id::text as xact_id, id from authz_outbox order by id`;
    expect(rows.map((r) => r.xact_id)).toEqual(['3', '3']); // every pre-existing row backfilled to the settled sentinel
    const idx = await pg<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = current_schema() and tablename = 'authz_outbox' order by 1`;
    expect(idx.map((i) => i.indexname)).toEqual([
      'authz_outbox_created_at_idx',
      'authz_outbox_pkey',
      'authz_outbox_unprocessed_idx',
      'authz_outbox_xact_idx',
    ]);
    const gc = await pg<
      { xact_id: string; id: number }[]
    >`select xact_id::text as xact_id, id from authz_outbox_gc where singleton = true`;
    expect(gc.map((g) => ({ ...g }))).toEqual([{ xact_id: '0', id: 0 }]); // the gc high-water singleton, at zero

    // A post-upgrade insert draws a REAL transaction id from the new DEFAULT (above the sentinel).
    await pg`insert into authz_outbox (op, table_name, payload) values ('INSERT', 'spaces', ${pg.json({ id: uuid(9), workspace_id: uuid(8), deleted_at: null })})`;
    const fresh = await pg<
      { xact_id: string }[]
    >`select xact_id::text as xact_id from authz_outbox order by id desc limit 1`;
    expect(BigInt(fresh[0].xact_id)).toBeGreaterThan(3n);

    // The backfilled legacy rows are BELOW every live xmin, so the real feed serves them (in order) after the upgrade.
    const res = await feed.getChanges('0.0', 0, 100);
    expect(res.events.slice(0, 2)).toEqual([
      {
        seq: 1,
        type: 'SpaceMemberChanged',
        spaceId: uuid(1),
        userId: uuid(2),
        groupId: null,
        role: 'reader',
        removed: false,
      },
      {
        seq: 2,
        type: 'SpaceMemberChanged',
        spaceId: uuid(1),
        userId: uuid(2),
        groupId: null,
        role: 'reader',
        removed: true,
      },
    ]);
  });

  it('is idempotent on a fresh schema: install() then the public onApplicationBootstrap path yield the same inventory, one trigger per table, no error', async () => {
    await install();
    const first = await inventory();
    await expect(installer.onApplicationBootstrap()).resolves.toBeUndefined(); // remote mode: runs install() again
    const second = await inventory();

    expect(second).toEqual(first);
    expect(first.captureFunctions).toBe(1);
    expect(first.gcSingletons).toBe(1);
    // Exactly one trigger per watched table, NONE on users, and the pages/spaces triggers column-scoped.
    expect(first.triggers.map((t) => `${t.rel}:${t.tgname}`)).toEqual([
      'group_users:authz_outbox_group_users',
      'page_access:authz_outbox_page_access',
      'page_permissions:authz_outbox_page_permissions',
      'pages:authz_outbox_pages',
      'space_members:authz_outbox_space_members',
      'spaces:authz_outbox_spaces',
    ]);
    // pg_get_triggerdef schema-qualifies the relation; the scoping clause is what matters.
    expect(first.triggers.find((t) => t.rel === 'pages')?.def).toMatch(
      /AFTER INSERT OR DELETE OR UPDATE OF space_id, parent_page_id, deleted_at ON (\w+\.)?pages FOR EACH ROW/,
    );
    expect(first.triggers.find((t) => t.rel === 'spaces')?.def).toMatch(
      /AFTER INSERT OR DELETE OR UPDATE OF workspace_id, deleted_at ON (\w+\.)?spaces FOR EACH ROW/,
    );
    for (const rel of ['space_members', 'group_users', 'page_access', 'page_permissions']) {
      expect(first.triggers.find((t) => t.rel === rel)?.def).toMatch(
        new RegExp(`AFTER INSERT OR DELETE OR UPDATE ON (\\w+\\.)?${rel} FOR EACH ROW`),
      );
    }
    expect(first.columns.find((c) => c.column_name === 'xact_id')).toEqual({
      column_name: 'xact_id',
      data_type: 'xid8',
      is_nullable: 'NO',
      column_default: 'pg_current_xact_id()',
    });
    expect(first.indexes.map((i) => i.indexname)).toEqual([
      'authz_outbox_created_at_idx',
      'authz_outbox_gc_pkey',
      'authz_outbox_pkey',
      'authz_outbox_unprocessed_idx',
      'authz_outbox_xact_idx',
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('G1 trigger chain: every authz-table INSERT/UPDATE/DELETE lands an outbox OBJECT that the real feed maps to the expected typed event', async () => {
    await install();

    const W = uuid(100);
    const S = uuid(1);
    const U = uuid(2);
    const G = uuid(3);
    const P1 = uuid(10);
    const P2 = uuid(11);

    // (a) Exact row production, read straight off the table (NOT xmin-gated, so a sibling spec's in-flight
    //     transaction can never hide a row). Also guards the payload shape: a jsonb OBJECT, never a string.
    let lastId = 0;
    const newRows = async () => {
      const rows = await pg<{ id: number; op: string; table_name: string; t: string }[]>`
        select id, op, table_name, jsonb_typeof(payload) as t from authz_outbox where id > ${lastId} order by id`;
      if (rows.length) lastId = rows[rows.length - 1].id;
      return rows.map((r) => ({ op: r.op, table: r.table_name, t: r.t }));
    };
    const row = (op: string, table: string) => ({ op, table, t: 'object' });

    // (b) The REAL feed under the production Kysely config, cursored like the platform relay. The commit-safety
    //     spec (same database, parallel worker) holds transactions open on purpose, which moves the cluster-wide
    //     xmin and can briefly WITHHOLD settled rows; poll (bounded) until the expected count has been served.
    let cursor = '0.0';
    const drain = async (expected: number): Promise<AuthzChangeEvent[]> => {
      const out: AuthzChangeEvent[] = [];
      const deadline = Date.now() + 15_000;
      for (;;) {
        const res = await feed.getChanges(cursor, 0, 100);
        cursor = res.nextCursor;
        out.push(...res.events);
        if (out.length >= expected || Date.now() > deadline) return out;
        await sleep(25);
      }
    };
    const seq = expect.any(Number);

    // users: deliberately NO trigger (platform-admin is never derived from Docmost roles).
    await pg`insert into users (id, email, role) values (${U}, 'u@example.test', 'member')`;
    await pg`update users set role = 'admin' where id = ${U}`;
    await pg`insert into groups (id, name) values (${G}, 'g')`;
    expect(await newRows()).toEqual([]);

    // spaces: INSERT; a non-structural edit (name) is silent; deleted_at is structural.
    await pg`insert into spaces (id, name, workspace_id) values (${S}, 'space', ${W})`;
    expect(await newRows()).toEqual([row('INSERT', 'spaces')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'SpaceChanged',
        spaceId: S,
        workspaceId: W,
        deleted: false,
      },
    ]);
    await pg`update spaces set name = 'renamed' where id = ${S}`;
    expect(await newRows()).toEqual([]);
    await pg`update spaces set deleted_at = now() where id = ${S}`;
    expect(await newRows()).toEqual([row('UPDATE', 'spaces')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'SpaceChanged',
        spaceId: S,
        workspaceId: W,
        deleted: true,
      },
    ]);
    await pg`update spaces set deleted_at = null where id = ${S}`;
    expect(await newRows()).toEqual([row('UPDATE', 'spaces')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'SpaceChanged',
        spaceId: S,
        workspaceId: W,
        deleted: false,
      },
    ]);

    // space_members: a user member (INSERT, role UPDATE, hard DELETE) and a group member (INSERT).
    await pg`insert into space_members (user_id, space_id, role) values (${U}, ${S}, 'reader')`;
    expect(await newRows()).toEqual([row('INSERT', 'space_members')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'SpaceMemberChanged',
        spaceId: S,
        userId: U,
        groupId: null,
        role: 'reader',
        removed: false,
      },
    ]);
    await pg`update space_members set role = 'writer' where space_id = ${S} and user_id = ${U}`;
    expect(await newRows()).toEqual([row('UPDATE', 'space_members')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'SpaceMemberChanged',
        spaceId: S,
        userId: U,
        groupId: null,
        role: 'writer',
        removed: false,
      },
    ]);
    await pg`insert into space_members (group_id, space_id, role) values (${G}, ${S}, 'reader')`;
    expect(await newRows()).toEqual([row('INSERT', 'space_members')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'SpaceMemberChanged',
        spaceId: S,
        userId: null,
        groupId: G,
        role: 'reader',
        removed: false,
      },
    ]);
    await pg`delete from space_members where space_id = ${S} and user_id = ${U}`;
    expect(await newRows()).toEqual([row('DELETE', 'space_members')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'SpaceMemberChanged',
        spaceId: S,
        userId: U,
        groupId: null,
        role: 'writer',
        removed: true,
      },
    ]);

    // group_users: INSERT, UPDATE (full-row trigger), DELETE.
    await pg`insert into group_users (user_id, group_id) values (${U}, ${G})`;
    expect(await newRows()).toEqual([row('INSERT', 'group_users')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'GroupMemberChanged',
        groupId: G,
        userId: U,
        removed: false,
      },
    ]);
    await pg`update group_users set user_id = ${U} where group_id = ${G}`;
    expect(await newRows()).toEqual([row('UPDATE', 'group_users')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'GroupMemberChanged',
        groupId: G,
        userId: U,
        removed: false,
      },
    ]);
    await pg`delete from group_users where group_id = ${G} and user_id = ${U}`;
    expect(await newRows()).toEqual([row('DELETE', 'group_users')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'GroupMemberChanged',
        groupId: G,
        userId: U,
        removed: true,
      },
    ]);

    // pages: INSERT; title/content edits are silent; parent move + trash/restore are structural; hard DELETE.
    await pg`insert into pages (id, title, space_id, workspace_id) values (${P1}, 'root', ${S}, ${W})`;
    await pg`insert into pages (id, title, space_id, workspace_id) values (${P2}, 'child', ${S}, ${W})`;
    expect(await newRows()).toEqual([row('INSERT', 'pages'), row('INSERT', 'pages')]);
    expect(await drain(2)).toEqual([
      {
        seq,
        type: 'PageStructureChanged',
        pageId: P1,
        spaceId: S,
        parentPageId: null,
        deleted: false,
      },
      {
        seq,
        type: 'PageStructureChanged',
        pageId: P2,
        spaceId: S,
        parentPageId: null,
        deleted: false,
      },
    ]);
    await pg`update pages set title = 'edited', content = ${pg.json({ type: 'doc' })} where id = ${P2}`;
    expect(await newRows()).toEqual([]);
    await pg`update pages set parent_page_id = ${P1} where id = ${P2}`;
    expect(await newRows()).toEqual([row('UPDATE', 'pages')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'PageStructureChanged',
        pageId: P2,
        spaceId: S,
        parentPageId: P1,
        deleted: false,
      },
    ]);
    await pg`update pages set deleted_at = now() where id = ${P2}`;
    expect(await newRows()).toEqual([row('UPDATE', 'pages')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'PageStructureChanged',
        pageId: P2,
        spaceId: S,
        parentPageId: P1,
        deleted: true,
      },
    ]);
    await pg`update pages set deleted_at = null where id = ${P2}`;
    expect(await newRows()).toEqual([row('UPDATE', 'pages')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'PageStructureChanged',
        pageId: P2,
        spaceId: S,
        parentPageId: P1,
        deleted: false,
      },
    ]);

    // page_access (restriction marker): INSERT restricts; an UPDATE re-asserts; page_permissions rides on it
    // with page_id ENRICHED by the trigger (resolved from page_access) so the feed never needs a lookup.
    await pg`insert into page_access (page_id, workspace_id, space_id, access_level) values (${P2}, ${W}, ${S}, 'restricted')`;
    expect(await newRows()).toEqual([row('INSERT', 'page_access')]);
    expect(await drain(1)).toEqual([{ seq, type: 'PageRestrictionChanged', pageId: P2, restricted: true }]);
    await pg`update page_access set access_level = 'restricted_v2' where page_id = ${P2}`;
    expect(await newRows()).toEqual([row('UPDATE', 'page_access')]);
    expect(await drain(1)).toEqual([{ seq, type: 'PageRestrictionChanged', pageId: P2, restricted: true }]);

    await pg`insert into page_permissions (page_access_id, user_id, role) select id, ${U}, 'reader' from page_access where page_id = ${P2}`;
    expect(await newRows()).toEqual([row('INSERT', 'page_permissions')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'PagePermissionChanged',
        pageId: P2,
        userId: U,
        groupId: null,
        role: 'reader',
        removed: false,
      },
    ]);
    await pg`update page_permissions set role = 'writer' where user_id = ${U}`;
    expect(await newRows()).toEqual([row('UPDATE', 'page_permissions')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'PagePermissionChanged',
        pageId: P2,
        userId: U,
        groupId: null,
        role: 'writer',
        removed: false,
      },
    ]);
    await pg`delete from page_permissions where user_id = ${U}`;
    expect(await newRows()).toEqual([row('DELETE', 'page_permissions')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'PagePermissionChanged',
        pageId: P2,
        userId: U,
        groupId: null,
        role: 'writer',
        removed: true,
      },
    ]);

    // Unrestrict WITH a grant still present: the page_access DELETE cascades to page_permissions. The engine
    // has already removed the page_access row when the cascaded page_permissions trigger runs, so its page_id
    // cannot be enriched: that row is the ONE documented no-op skip (covered by PageRestrictionChanged{false},
    // which clears every grant on the page), it must NOT trip the DROPPED detector, and the cursor advances.
    await pg`insert into page_permissions (page_access_id, group_id, role) select id, ${G}, 'reader' from page_access where page_id = ${P2}`;
    expect(await newRows()).toEqual([row('INSERT', 'page_permissions')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'PagePermissionChanged',
        pageId: P2,
        userId: null,
        groupId: G,
        role: 'reader',
        removed: false,
      },
    ]);
    await pg`delete from page_access where page_id = ${P2}`;
    expect(await newRows()).toEqual([row('DELETE', 'page_access'), row('DELETE', 'page_permissions')]);
    const cascaded = await pg<{ op: string; table_name: string; page_id: string | null }[]>`
      select op, table_name, payload ->> 'page_id' as page_id from authz_outbox where id = ${lastId}`;
    expect(cascaded.map((c) => ({ ...c }))).toEqual([{ op: 'DELETE', table_name: 'page_permissions', page_id: null }]);
    expect(
      isExpectedSkip({
        id: lastId,
        op: 'DELETE',
        tableName: 'page_permissions',
        payload: {},
      }),
    ).toBe(true);
    expect(await drain(1)).toEqual([{ seq, type: 'PageRestrictionChanged', pageId: P2, restricted: false }]);

    // Hard DELETEs: the child page, then the space (cascading the root page + the group membership).
    await pg`delete from pages where id = ${P2}`;
    expect(await newRows()).toEqual([row('DELETE', 'pages')]);
    expect(await drain(1)).toEqual([
      {
        seq,
        type: 'PageStructureChanged',
        pageId: P2,
        spaceId: S,
        parentPageId: P1,
        deleted: true,
      },
    ]);
    await pg`delete from spaces where id = ${S}`;
    const cascade = await newRows();
    expect(cascade).toHaveLength(3);
    expect(cascade).toEqual(
      expect.arrayContaining([row('DELETE', 'spaces'), row('DELETE', 'pages'), row('DELETE', 'space_members')]),
    );
    expect(await drain(3)).toEqual(
      expect.arrayContaining([
        {
          seq,
          type: 'SpaceChanged',
          spaceId: S,
          workspaceId: W,
          deleted: true,
        },
        {
          seq,
          type: 'PageStructureChanged',
          pageId: P1,
          spaceId: S,
          parentPageId: null,
          deleted: true,
        },
        {
          seq,
          type: 'SpaceMemberChanged',
          spaceId: S,
          userId: null,
          groupId: G,
          role: 'reader',
          removed: true,
        },
      ]),
    );

    // The feed served every row (the cursor is at the table's head) and the #181 detector never fired.
    const tail = await feed.getChanges(cursor, 0, 100);
    expect(tail.events).toEqual([]);
    expect(cursor).toMatch(new RegExp(`^\\d+\\.${lastId}$`));
    const dropped = warnSpy.mock.calls.filter((c) => String(c[0]).includes('AUTHZ_CHANGE_EVENT_DROPPED'));
    expect(dropped).toEqual([]);
  });
});
