import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { ConflictException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageService } from '../../core/page/services/page.service';
import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import { HttpAuthzClient } from '../http-authz.client';
import { AuthzOutboxInstaller } from '../../service-bridge/authz-outbox.installer';
import { CYCLE_LOCK_CLASS, PageCycleGuardInstaller } from '../../service-bridge/page-cycle-guard.installer';
import { PageRestrictionGuardInstaller } from '../../service-bridge/page-restriction-guard.installer';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';
import { RESTRICTED_COPY, RESTRICTED_COPY_MESSAGES } from './copy-restriction.guard';

// PageService imports the collab gateway, whose lib0/hocuspocus ESM graph jest cannot load; duplicate never touches it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

/**
 * Real-Postgres proof of #573: the REAL upstream `PageService.duplicatePage` over the REAL `PdpPagePermissionRepo`
 * (the PDP stubbed at `HttpAuthzClient.tryFilterResources`), with the REAL #485/#545 guard DDL installed so the
 * per-workspace lock is the one g0/g1/g2 take. A copy that would drop a restriction is refused inside the insert's
 * transaction — zero pages, zero outbox rows, no PAGE_CREATED — including when the restriction lands after upstream
 * read the tree (a stale PDP allow, or a restrict committed while the duplicate is in flight). A copy that keeps
 * every restriction it could see still works, and never carries a page the PDP hid. A page filter the PDP could not
 * answer (#716, on any chunk) is a 503 with nothing written, never a copy of part of the tree. Self-skips without
 * AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG duplicate restriction gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'duplicate_restriction_pg_spec';
const WS = uuid(100);
const S1 = uuid(50);
const S2 = uuid(51);
const USER = uuid(900);
const X = uuid(1); // a parent
const R = uuid(2); // the duplicated root
const C = uuid(3); // a child of R
const D = uuid(4); // a second child of R
const G = uuid(5); // a grandchild under D

jest.setTimeout(30_000);

d('PageService.duplicatePage refuses a copy that would drop a restriction (#573), on real Postgres', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  /** Second session for races and lock holds. */
  let side: postgres.Sql;
  let db: Kysely<any>;
  let pageRepo: PageRepo;
  let remote: PageService;
  let native: PageService;
  /** What the stubbed PDP reports viewable (null = everything asked). */
  let visible: Set<string> | null = null;
  /** Runs inside the PDP call, i.e. after upstream read the tree and before its insert. */
  let duringPdp: (() => Promise<void>) | null = null;
  /** #716: the page filter could not answer (the client's `null`). Point decisions are not involved here. */
  let filterDown = false;
  let filterCalls = 0;
  /** The same service over the REAL HttpAuthzClient (fetch stubbed), so the client's 1000-id chunking is exercised. */
  let remoteRealClient: PageService;
  const fetchMock = jest.fn();
  const realFetch = global.fetch;
  const events: string[] = [];

  const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const page = (id: string, parent: string | null, title: string, space = S1) => pg`
    insert into pages (id, slug_id, title, workspace_id, space_id, parent_page_id, position, content)
    values (${id}, ${'slug-' + id.slice(-4)}, ${title}, ${WS}, ${space}, ${parent}, 'a0', ${pg.json(doc(`body of ${title}`))})`;
  const restrict = (id: string, via: postgres.Sql = pg) =>
    via`insert into page_access (page_id, workspace_id, space_id, access_level) values (${id}, ${WS}, ${S1}, 'members')`;
  const grant = async (id: string) => {
    const [{ aid }] = await pg<{ aid: string }[]>`select id as aid from page_access where page_id = ${id}`;
    await pg`insert into page_permissions (page_access_id, user_id, role) values (${aid}, ${USER}, 'reader')`;
  };
  const seeded = new Set<string>();
  const copies = async () =>
    (
      await pg<{ id: string; title: string; parentPageId: string | null; spaceId: string; content: unknown; textContent: string }[]>`
        select id, title, parent_page_id as "parentPageId", space_id as "spaceId", content, text_content as "textContent"
        from pages`
    )
      .filter((r) => !seeded.has(r.id))
      .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  const pageCount = async () => (await pg<{ c: number }[]>`select count(*)::int as c from pages`)[0].c;
  /** Outbox rows a copy would write (its `pages` inserts) — a racing restrict writes its own `page_access` row. */
  const outboxCount = async () =>
    (await pg<{ c: number }[]>`select count(*)::int as c from authz_outbox where table_name = 'pages'`)[0].c;
  const duplicate = async (svc: PageService, id: string, target?: string) =>
    svc.duplicatePage(await pageRepo.findById(id), target, { id: USER, workspaceId: WS } as never);
  /** The refusal (or 'ok') — and that a refusal wrote nothing at all. */
  const refusedWith = async (p: Promise<unknown>) => {
    const pagesBefore = await pageCount();
    const outboxBefore = await outboxCount();
    const eventsBefore = events.length;
    const result = await p.then(
      () => 'ok' as const,
      (e) => e as Error,
    );
    if (result !== 'ok') {
      expect(await pageCount()).toBe(pagesBefore);
      expect(await outboxCount()).toBe(outboxBefore);
      expect(events.length).toBe(eventsBefore);
    }
    return result;
  };
  const expect409 = (e: unknown, kind: keyof typeof RESTRICTED_COPY_MESSAGES) => {
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as HttpException).getResponse()).toEqual({ message: RESTRICTED_COPY_MESSAGES[kind], code: RESTRICTED_COPY });
  };
  /** Resolves once some session WAITS on an advisory lock. */
  const waitForAdvisoryWaiter = async () => {
    for (let i = 0; i < 100; i++) {
      const [{ c }] = await pg<{ c: number }[]>`select count(*)::int as c from pg_locks where locktype = 'advisory' and not granted`;
      if (c > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no session ever waited on the workspace lock');
  };
  /** Resolves once some session WAITS on a row lock (a transaction id or a tuple). */
  const waitForRowWaiter = async () => {
    for (let i = 0; i < 100; i++) {
      const [{ c }] = await pg<{ c: number }[]>`
        select count(*)::int as c from pg_locks where locktype in ('transactionid', 'tuple') and not granted`;
      if (c > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no session ever waited on a row lock');
  };

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 4);
    side = mkReadModelPg(SCHEMA, 2);
    db = mkReadModelDb(appPg);
    await pg`create table users (id uuid primary key, name varchar, avatar_url varchar, deleted_at timestamptz)`;
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
        id uuid primary key default gen_random_uuid(), slug_id varchar, title varchar, icon varchar, cover_photo varchar,
        position varchar, parent_page_id uuid references pages (id) on delete cascade, creator_id uuid,
        last_updated_by_id uuid, space_id uuid not null references spaces (id) on delete cascade,
        workspace_id uuid not null, is_locked boolean not null default false, is_base boolean not null default false,
        contributor_ids uuid[], content jsonb, text_content text, ydoc bytea,
        created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default now(),
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
    await pg`insert into spaces (id, name, slug, workspace_id) values (${S1}, 'one', 'one', ${WS}), (${S2}, 'two', 'two', ${WS})`;

    await (new AuthzOutboxInstaller(db as never, 'remote') as unknown as { install(): Promise<void> }).install();
    await new PageCycleGuardInstaller(db as never, 'remote').install();
    await new PageRestrictionGuardInstaller(db as never, 'remote').install();

    const emitter = { emit: (name: string) => (events.push(name), true) };
    pageRepo = new PageRepo(db as never, {} as never, emitter as never);
    const pdp = {
      tryFilterResources: async (_subject: unknown, permission: string, type: string, ids: string[]) => {
        expect([permission, type]).toEqual(['view', 'page']);
        filterCalls++;
        if (duringPdp) await duringPdp();
        if (filterDown) return null;
        return visible ? ids.filter((id) => visible!.has(id)) : ids;
      },
    };
    const pdpRepo = new PdpPagePermissionRepo(db as never, {} as never, {} as never, pdp as never);
    const stockRepo = new PagePermissionRepo(db as never, {} as never, {} as never);
    const queue = { add: async () => undefined };
    const transclusions = { insertTransclusionsForPages: async () => undefined, insertReferencesForPages: async () => undefined };
    const build = (repo: PagePermissionRepo) =>
      new PageService(
        pageRepo,
        repo,
        {} as never,
        db as never,
        {} as never,
        queue as never,
        queue as never,
        queue as never,
        emitter as never,
        {} as never,
        {} as never,
        transclusions as never,
      );
    remote = build(pdpRepo);
    native = build(stockRepo);
    process.env.PLATFORM_AUTHZ_URL = 'http://platform.test';
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = 'sekret';
    remoteRealClient = build(new PdpPagePermissionRepo(db as never, {} as never, {} as never, new HttpAuthzClient()));
  });

  beforeEach(async () => {
    // X (open parent) → R (root) → C, D → G
    await page(X, null, 'X parent');
    await page(R, X, 'R root');
    await page(C, R, 'C child');
    await page(D, R, 'D child');
    await page(G, D, 'G grandchild');
    for (const id of [X, R, C, D, G]) seeded.add(id);
  });

  afterEach(async () => {
    visible = null;
    duringPdp = null;
    filterDown = false;
    filterCalls = 0;
    fetchMock.mockReset();
    global.fetch = realFetch;
    events.length = 0;
    seeded.clear();
    await pg`delete from page_access`;
    await pg`delete from pages`;
    await pg`delete from authz_outbox`;
  });

  afterAll(async () => {
    await db?.destroy();
    await side?.end({ timeout: 5 });
    await pg?.end({ timeout: 5 });
  });

  describe('refused, with nothing written', () => {
    it('a restricted root the copier can see', async () => {
      await restrict(R);
      expect409(await refusedWith(duplicate(remote, R)), 'own');
    });

    it('a restricted descendant the copier can see (the root is open)', async () => {
      await restrict(D);
      expect409(await refusedWith(duplicate(remote, R)), 'own');
    });

    it('a stale PDP allow: the PDP still says viewable, but the page has a restriction (not projected yet)', async () => {
      await restrict(C);
      visible = new Set([R, C, D, G]); // the PDP has not seen C's #restricted yet
      expect409(await refusedWith(duplicate(remote, R)), 'own');
    });

    it('a copy to ANOTHER space of a root in a restricted section (the copy would land open at the root)', async () => {
      await restrict(X);
      visible = new Set([R, C, D, G]);
      expect409(await refusedWith(duplicate(remote, R, S2)), 'section');
    });

    it('a copy to another space whose root lineage cannot be walked to a root (fails closed)', async () => {
      // R's parent chain stops at a page in another workspace: incomplete ⇒ treated as restricted.
      await pg`update pages set workspace_id = ${uuid(200)} where id = ${X}`;
      expect409(await refusedWith(duplicate(remote, R, S2)), 'section');
    });

    it('the PDP dropped the root (a PDP error fails closed by dropping pages) → 503, not an upstream crash', async () => {
      visible = new Set([C, D, G]);
      const e = await refusedWith(duplicate(remote, R));
      expect(e).toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('#716 the page filter could not answer: a 503 with nothing written, never a partial copy', () => {
    it('the filter returns null (point decisions are not consulted here): 503, zero pages, zero outbox rows', async () => {
      filterDown = true;
      const e = await refusedWith(duplicate(remote, R));
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      expect(filterCalls).toBe(1); // the filter ran and was what failed
      expect(await copies()).toEqual([]);
    });

    it('over the real client, the SECOND 1000-id chunk fails: 503, never a copy of the first chunk', async () => {
      // R's subtree is R, C, D, G + 997 more children = 1001 ids → two filter-resources chunks.
      await pg`
        insert into pages (id, slug_id, title, workspace_id, space_id, parent_page_id, position)
        select gen_random_uuid(), 'bulk-' || g, 'bulk ' || g, ${WS}, ${S1}, ${R}, 'a0' from generate_series(1, 997) g`;
      for (const r of await pg<{ id: string }[]>`select id from pages where slug_id like 'bulk-%'`) seeded.add(r.id);
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      fetchMock.mockImplementationOnce(async (_url: string, init: { body: string }) =>
        ok({ ids: JSON.parse(init.body).candidateIds }),
      );
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
      (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
      const e = await refusedWith(duplicate(remoteRealClient, R));
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).candidateIds).toHaveLength(1000);
      expect(await copies()).toEqual([]);
    });
  });

  describe('races: the check sees every restriction committed before the insert', () => {
    it('a restrict committed AFTER upstream read the tree (during the PDP call) is refused', async () => {
      duringPdp = async () => {
        await restrict(C, side);
      };
      expect409(await refusedWith(duplicate(remote, R)), 'own');
      expect((await pg`select 1 from page_access where page_id = ${C}`).length).toBe(1);
    });

    it('a restrict in flight (holding the workspace lock) makes the duplicate wait, then refuses it on commit', async () => {
      const x = await side.reserve();
      let duplicating: Promise<unknown>;
      try {
        await x`begin`;
        await restrict(D, x as unknown as postgres.Sql); // g0 takes the workspace lock and holds it until commit
        duplicating = refusedWith(duplicate(remote, R));
        await waitForAdvisoryWaiter(); // the duplicate's guard is parked on that lock, after its tree read
      } finally {
        await x`commit`;
        x.release();
      }
      expect409(await duplicating!, 'own');
    });

    it('the duplicate holds the workspace lock until it commits: a restrict racing its insert waits (serialized)', async () => {
      // Park the duplicate's insert after its guard ran: hold X's row so the FK check on the copy's parent waits.
      const rowHolder = await side.reserve();
      const restrictor = await side.reserve();
      let duplicating: Promise<unknown>;
      let restricting: Promise<unknown>;
      try {
        await rowHolder`begin`;
        await rowHolder`select 1 from pages where id = ${X} for update`;
        duplicating = refusedWith(duplicate(remote, R));
        await waitForRowWaiter(); // the duplicate is inside its transaction, past the guard, holding the lock
        restricting = restrict(C, restrictor as unknown as postgres.Sql).execute(); // postgres.js is lazy: start it now
        await waitForAdvisoryWaiter(); // the restrict's g0 waits for the duplicate's workspace lock
      } finally {
        await rowHolder`rollback`;
        rowHolder.release();
      }
      try {
        expect(await duplicating!).toBe('ok'); // "duplicate, then restrict": legal
        await restricting!;
      } finally {
        restrictor.release();
      }
      expect((await copies()).map((r) => r.title)).toEqual(['C child', 'Copy of R root', 'D child', 'G grandchild']);
      expect((await pg`select 1 from page_access where page_id = ${C}`).length).toBe(1);
    });

    it('the workspace lock held elsewhere: the duplicate waits, then gives up with a retryable 503 engine_busy', async () => {
      const holder = await side.reserve();
      let e: unknown;
      try {
        await holder`begin`;
        await holder`select pg_advisory_xact_lock(${CYCLE_LOCK_CLASS}, hashtext(${WS}::text))`;
        const duplicating = refusedWith(duplicate(remote, R));
        await waitForAdvisoryWaiter();
        e = await duplicating;
      } finally {
        await holder`rollback`;
        holder.release();
      }
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      expect((e as HttpException).getResponse()).toMatchObject({ code: 'engine_busy' });
    });
  });

  describe('allowed copies never carry a page the PDP hid', () => {
    it('a hidden restricted child drops its whole subtree — even a grandchild the PDP would show', async () => {
      await page(uuid(6), D, 'H secret sub-page');
      seeded.add(uuid(6));
      await restrict(D);
      visible = new Set([R, C, G, uuid(6)]); // D hidden; G and H "visible" but pruned under the hidden D
      expect(await refusedWith(duplicate(remote, R))).toBe('ok');
      const made = await copies();
      expect(made.map((r) => r.title)).toEqual(['C child', 'Copy of R root']);
      const blob = JSON.stringify(made);
      for (const hidden of ['D child', 'G grandchild', 'H secret sub-page']) expect(blob).not.toContain(hidden);
      for (const id of [D, G, uuid(6)]) expect(blob).not.toContain(id);
      const root = made.find((r) => r.title === 'Copy of R root')!;
      expect(root.parentPageId).toBe(X);
      expect(made.find((r) => r.title === 'C child')!.parentPageId).toBe(root.id);
      expect(events).toContain('page.created');
      expect(await pg`select 1 from page_access where page_id in ${pg(made.map((r) => r.id))}`).toHaveLength(0);
    });

    it('control: an unrestricted tree copies whole, same space and cross-space', async () => {
      expect(await refusedWith(duplicate(remote, R))).toBe('ok');
      expect((await copies()).map((r) => r.title)).toEqual(['C child', 'Copy of R root', 'D child', 'G grandchild']);
      await pg`delete from pages where not (id = any(${[...seeded]}::uuid[]))`;
      expect(await refusedWith(duplicate(remote, R, S2))).toBe('ok');
      const made = await copies();
      expect(made.every((r) => r.spaceId === S2)).toBe(true);
      expect(made.find((r) => r.title === 'R root')!.parentPageId).toBeNull();
    });

    it('control: a SAME-space copy of a root under a restricted parent works — it keeps the parent, so it inherits', async () => {
      await restrict(X);
      visible = new Set([R, C, D, G]);
      expect(await refusedWith(duplicate(remote, R))).toBe('ok');
      expect((await copies()).find((r) => r.title === 'Copy of R root')!.parentPageId).toBe(X);
    });
  });

  it('native mode (the stock repo has no guard): upstream duplicate, unchanged — a granted restricted root copies', async () => {
    await restrict(R);
    await grant(R);
    expect(await refusedWith(duplicate(native, R))).toBe('ok');
    expect((await copies()).map((r) => r.title)).toEqual(['C child', 'Copy of R root', 'D child', 'G grandchild']);
  });
});
