import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { Logger } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../../core/page/services/page.service';
import { AuthzOutboxInstaller } from '../../service-bridge/authz-outbox.installer';
import { PageCycleGuardInstaller } from '../../service-bridge/page-cycle-guard.installer';
import { PageRestrictionGuardInstaller } from '../../service-bridge/page-restriction-guard.installer';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';

// PageService imports the collab gateway, whose lib0/hocuspocus ESM graph jest cannot load; the paths driven here
// never touch it (the same stub the purge pg spec uses).
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { RemoteTrashRetentionService } from './remote-trash-retention.service';

/**
 * #589 on real Postgres: the remote trash retention against the REAL upstream `PageService.forceDelete` (and the
 * parent foreign key's cascade it relies on), the real guard triggers and the authz outbox. What these prove:
 *  - an expired trash subtree is purged, its attachment jobs queued once;
 *  - a LIVE child under a trashed parent (a half-restore) keeps BOTH alive — upstream's cascade purged the child;
 *  - a subtree touching an archived space is never purged; and an UNARCHIVE restarts the clock;
 *  - an unexpired descendant, or a dead workspace, leaves everything untouched;
 *  - two concurrent runs delete each page once.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG remote trash retention gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'remote_trash_retention_pg_spec';
const WS = uuid(100);
const DEAD_WS = uuid(101);
const S1 = uuid(50);
const S2 = uuid(51);
const S_DEAD = uuid(52);
const USER = uuid(900);
const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

d('RemoteTrashRetentionService on real Postgres (#589)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  let retention: RemoteTrashRetentionService;
  const jobs: string[] = [];
  const logs: string[] = [];

  const page = (id: string, parent: string | null, opts: { space?: string; ws?: string; trashedDaysAgo?: number } = {}) => pg`
    insert into pages (id, workspace_id, space_id, parent_page_id, position, deleted_at, deleted_by_id)
    values (${id}, ${opts.ws ?? WS}, ${opts.space ?? S1}, ${parent}, 'a0000',
            ${opts.trashedDaysAgo === undefined ? null : days(opts.trashedDaysAgo)},
            ${opts.trashedDaysAgo === undefined ? null : USER})`;
  const exists = async (...ids: string[]) =>
    (await pg<{ id: string }[]>`select id from pages where id in ${pg(ids)} order by id`).map((r) => r.id);
  const skipped = (id: string, reason: string) => logs.includes(`TRASH_RETENTION_SKIPPED page=${id} reason=${reason}`);

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 6);
    db = mkReadModelDb(appPg);
    await pg`create table workspaces (id uuid primary key, trash_retention_days int, deleted_at timestamptz)`;
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
    await pg`insert into workspaces (id, trash_retention_days) values (${WS}, null)`;
    await pg`insert into workspaces (id, trash_retention_days, deleted_at) values (${DEAD_WS}, 1, now())`;

    await (new AuthzOutboxInstaller(db as never, 'remote') as unknown as { install(): Promise<void> }).install();
    await new PageCycleGuardInstaller(db as never, 'remote').install();
    await new PageRestrictionGuardInstaller(db as never, 'remote').install();

    const events = { emit: () => true };
    const pageRepo = new PageRepo(db as never, {} as never, events as never);
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
    retention = new RemoteTrashRetentionService(db as never, pages, {
      add: async (_j: string, data: { pageId: string }) => void jobs.push(data.pageId),
    } as never);
  });

  beforeEach(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logs.push(String(args[0])));
    }
    // Spaces whose last change is long before any cutoff (a fresh row's updated_at is now()).
    await pg`insert into spaces (id, workspace_id, updated_at) values
               (${S1}, ${WS}, ${days(400)}), (${S2}, ${WS}, ${days(400)}), (${S_DEAD}, ${DEAD_WS}, ${days(400)})`;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jobs.length = 0;
    logs.length = 0;
    await pg`delete from pages`;
    await pg`delete from spaces`;
    await pg`delete from authz_outbox`;
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  it('an expired trash subtree is purged — root and trashed descendants — and each page’s job queued once', async () => {
    await page(uuid(1), null, { trashedDaysAgo: 40 });
    await page(uuid(2), uuid(1), { trashedDaysAgo: 40 });
    await page(uuid(3), uuid(2), { trashedDaysAgo: 45 });
    await page(uuid(9), null);
    await retention.cleanupOldTrash();
    expect(await exists(uuid(1), uuid(2), uuid(3), uuid(9))).toEqual([uuid(9)]);
    expect([...jobs].sort()).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it('a LIVE child under a trashed parent (a half-restore): both survive, skip logged — upstream’s cascade purged the child', async () => {
    await page(uuid(1), null, { trashedDaysAgo: 40 });
    await page(uuid(2), uuid(1)); // restored on its own, still under the trashed parent
    await retention.cleanupOldTrash();
    expect(await exists(uuid(1), uuid(2))).toEqual([uuid(1), uuid(2)]);
    expect(skipped(uuid(1), 'live_descendant')).toBe(true);
    expect(jobs).toEqual([]);
  });

  it('an unexpired descendant keeps the whole subtree; nothing is purged before its own retention', async () => {
    await page(uuid(1), null, { trashedDaysAgo: 40 });
    await page(uuid(2), uuid(1), { trashedDaysAgo: 2 });
    await retention.cleanupOldTrash();
    expect(await exists(uuid(1), uuid(2))).toEqual([uuid(1), uuid(2)]);
    expect(skipped(uuid(1), 'not_expired')).toBe(true);
  });

  it('a descendant in an ARCHIVED space → skipped; a root in an archived space is not even a candidate', async () => {
    await page(uuid(1), null, { trashedDaysAgo: 40 });
    await page(uuid(2), uuid(1), { space: S2, trashedDaysAgo: 40 });
    await page(uuid(5), null, { space: S2, trashedDaysAgo: 40 });
    await pg`update spaces set deleted_at = now() where id = ${S2}`;
    await retention.cleanupOldTrash();
    expect(await exists(uuid(1), uuid(2), uuid(5))).toEqual([uuid(1), uuid(2), uuid(5)]);
    expect(skipped(uuid(1), 'space_archived')).toBe(true);
    expect(logs.some((l) => l.includes(`page=${uuid(5)}`))).toBe(false);
  });

  it('an UNARCHIVE restarts the clock: pages trashed long ago survive until a full retention after the restore', async () => {
    await page(uuid(1), null, { trashedDaysAgo: 90 });
    await pg`update spaces set deleted_at = now() - interval '80 days', updated_at = now() - interval '80 days' where id = ${S1}`;
    await retention.cleanupOldTrash();
    expect(await exists(uuid(1))).toEqual([uuid(1)]); // archived: not a candidate

    // The workspace admin restores the space (service-space.service.ts `unarchive` stamps updated_at).
    await pg`update spaces set deleted_at = null, updated_at = now() where id = ${S1}`;
    await retention.cleanupOldTrash();
    expect(await exists(uuid(1))).toEqual([uuid(1)]);
    expect(skipped(uuid(1), 'space_recently_changed')).toBe(true);

    // A full retention period after the restore, it goes.
    await pg`update spaces set updated_at = now() - interval '31 days' where id = ${S1}`;
    await retention.cleanupOldTrash();
    expect(await exists(uuid(1))).toEqual([]);
  });

  it('a dead workspace is untouched, and so is unexpired trash', async () => {
    await page(uuid(1), null, { ws: DEAD_WS, space: S_DEAD, trashedDaysAgo: 400 });
    await page(uuid(2), null, { trashedDaysAgo: 5 });
    await retention.cleanupOldTrash();
    expect(await exists(uuid(1), uuid(2))).toEqual([uuid(1), uuid(2)]);
  });

  it('two concurrent runs: each page is deleted once, and its job queued once', async () => {
    for (let i = 1; i <= 6; i++) await page(uuid(i), null, { trashedDaysAgo: 40 });
    await page(uuid(7), uuid(1), { trashedDaysAgo: 40 });
    await Promise.all([retention.cleanupOldTrash(), retention.cleanupOldTrash()]);
    expect(await exists(...Array.from({ length: 7 }, (_, i) => uuid(i + 1)))).toEqual([]);
    expect([...jobs].sort()).toEqual(Array.from({ length: 7 }, (_, i) => uuid(i + 1)));
    expect(logs.filter((l) => l.startsWith('TRASH_RETENTION_FAILED'))).toEqual([]);
  });
});
