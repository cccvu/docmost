import * as postgres from 'postgres';
import { Kysely, sql } from 'kysely';
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PdpShareRepo } from '../pdp-share.repo';
import { ShareExpiryInstaller, SHARE_EXPIRY_INSTALL_LOCK_KEY } from './share-expiry.installer';
import { ShareExpirySweeper } from './share-expiry.sweeper';
import { ShareExpiryController, SHARE_EXPIRY_UPDATED } from './share-expiry.controller';
import { createShareTables } from './share-pg.testkit';
import { PublicDiscoveryRepo } from '../public-discovery/public-discovery.repo';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';

/**
 * CCC share lifecycle test — NOT upstream Docmost code (#335, ADR 0032).
 *
 * Real-Postgres proof of the expiry machinery around the read-time gate (which pdp-share.repo.pg.spec.ts proves):
 *  - `ShareExpiryInstaller`: creates the table once, backfills `now() + 90 days` ONLY on the run that created it,
 *    is idempotent under two concurrent installers (exactly one creates), native installs nothing, and a remote
 *    boot that cannot install refuses to boot;
 *  - `ShareExpirySweeper`: deletes only expired shares (the cascade takes the expiry row), audits each as a system
 *    `share.deleted` with `reason: 'expired'`, two concurrent sweepers take disjoint rows without waiting, a renewal
 *    holding the row (or one that committed after the sweep's first snapshot) is never swept, a failure never throws;
 *  - `ShareExpiryController`: viewer reads, editor writes, cross-workspace / expired / trashed are 404, "Never" is
 *    stored as null, an expiry that lands between the authorization and the lock is re-checked under the lock, and
 *    a lock timeout is a retryable 503.
 * Concurrency is deterministic: promise handoffs and `pg_locks` polling, no sleeps on the pass path.
 * Lives in the `docmost-authz-pg` CI lane; self-skips without AUTHZ_TEST_PG_URL.
 */
/** Clear every row the spec writes (the expiry table only when it exists). Inline in the spec, not the testkit: the
 *  sink-scan fitness specs (remote-refusal, remote-purge) inventory every non-spec `delete from` in src/. */
const clearShareRows = async (pg: postgres.Sql): Promise<void> => {
  const exp = await pg<{ present: boolean }[]>`select to_regclass('ccc_share_expiry') is not null as present`;
  if (exp[0]?.present) await pg`delete from ccc_share_expiry`;
  await pg`delete from shares`;
  await pg`delete from pages`;
  await pg`delete from group_users`;
  await pg`delete from space_members`;
  await pg`delete from users`;
  await pg`delete from spaces`;
  await pg`delete from workspaces`;
};

const d = PG_URL ? describe : describe.skip;

describe('real-PG share lifecycle', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'share_lifecycle_pg_spec';
const WS = uuid(100);
const WS_OTHER = uuid(101);
const SPACE = uuid(1);
const SPACE_OTHER = uuid(2);
const EDITOR = uuid(900);
const CREATOR = uuid(901);

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

/** Poll until `cond` holds (a state the test is waiting for another connection to reach). Bounded. */
const until = async (cond: () => Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 500; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
};

d('share lifecycle on real Postgres (#335)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;

  const page = (id: string, opts: { ws?: string; space?: string; trashed?: boolean } = {}) =>
    pg`insert into pages (id, slug_id, title, space_id, workspace_id, creator_id, deleted_at)
       values (${id}, ${'s-' + id.slice(-4)}, ${'Page ' + id.slice(-4)}, ${opts.space ?? SPACE}, ${opts.ws ?? WS},
               ${CREATOR}, ${opts.trashed ? pg`now()` : null})`;
  const share = async (
    id: string,
    pageId: string,
    opts: { ws?: string; space?: string; createdAgo?: number; expiry?: 'never' | string } = {},
  ) => {
    await pg`
      insert into shares (id, key, page_id, space_id, workspace_id, creator_id, include_sub_pages, search_indexing, created_at)
      values (${id}, ${'k' + id.slice(-6)}, ${pageId}, ${opts.space ?? SPACE}, ${opts.ws ?? WS}, ${CREATOR}, true, false,
              now() - make_interval(days => ${opts.createdAgo ?? 0}))`;
    if (opts.expiry === 'never') await pg`insert into ccc_share_expiry (share_id, expires_at) values (${id}, null)`;
    else if (opts.expiry)
      await pg`insert into ccc_share_expiry (share_id, expires_at) values (${id}, now() + ${opts.expiry}::interval)`;
  };
  const shareIds = async () => (await pg`select id from shares order by id`).map((r) => r.id as string);
  const expiryRow = async (id: string) =>
    (await pg`select expires_at, extract(epoch from (expires_at - now()))::float8 as secs_left
              from ccc_share_expiry where share_id = ${id}`)[0];

  const mkRepo = () => new PdpShareRepo(db as any, {} as any, {} as any);
  const mkAudit = () => ({ log: jest.fn(), logBatchWithContext: jest.fn() });

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 6);
    await createShareTables(pg);
    db = mkReadModelDb(appPg);
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  describe('ShareExpiryInstaller', () => {
    beforeEach(async () => {
      await pg`drop table if exists ccc_share_expiry`;
      await clearShareRows(pg);
      await pg`insert into workspaces (id, name) values (${WS}, 'W')`;
      await page(uuid(10));
      await page(uuid(11));
    });

    it('creates the table and backfills now() + 90 days for every share that existed — only on that run', async () => {
      await share(uuid(210), uuid(10), { createdAgo: 400 }); // would be dead under created_at + 90d
      await share(uuid(211), uuid(11), { createdAgo: 1 });
      const installer = new ShareExpiryInstaller(db as any, 'remote');
      expect(await installer.install()).toEqual({ created: true, backfilled: 2 });
      for (const id of [uuid(210), uuid(211)]) {
        const row = await expiryRow(id);
        expect(Math.abs(row.secs_left - 90 * 86400)).toBeLessThan(120);
      }
      expect((await mkRepo().findById(uuid(210)))?.id).toBe(uuid(210)); // the old share survived the first boot

      // A later boot: no DDL, no backfill — a share created after install keeps the created_at default (no row).
      await pg`delete from shares where id = ${uuid(211)}`;
      await share(uuid(212), uuid(11), { createdAgo: 91 });
      expect(await installer.install()).toEqual({ created: false, backfilled: 0 });
      expect(await expiryRow(uuid(212))).toBeUndefined();
      expect(await mkRepo().findById(uuid(212))).toBeUndefined(); // 91 days old, no row: dead by default
      // The cascade from shares (installed FK) took the deleted share's expiry row.
      expect(await expiryRow(uuid(211))).toBeUndefined();
    });

    it('two concurrent installers: exactly one creates and backfills, the other sees it present', async () => {
      await share(uuid(210), uuid(10));
      // Hold the install lock so both installers are provably inside their transaction, waiting, at once.
      const hold = postgres(PG_URL as string, { max: 1, onnotice: () => {} });
      const release = deferred();
      const held = deferred();
      const holder = hold.begin(async (t) => {
        const tx = t as unknown as postgres.Sql;
        await tx`select pg_advisory_xact_lock(${SHARE_EXPIRY_INSTALL_LOCK_KEY})`;
        held.resolve();
        await release.promise;
      });
      try {
        await held.promise;
        const a = new ShareExpiryInstaller(db as any, 'remote').install();
        const b = new ShareExpiryInstaller(db as any, 'remote').install();
        await until(async () => {
          const r = await pg`
            select count(*)::int as n from pg_locks
            where locktype = 'advisory' and not granted and classid = 0 and objid = ${SHARE_EXPIRY_INSTALL_LOCK_KEY}`;
          return r[0].n === 2;
        }, 'both installers waiting on the install lock');
        release.resolve();
        const results = await Promise.all([a, b]);
        expect(results.filter((r) => r.created)).toEqual([{ created: true, backfilled: 1 }]);
        expect(results.filter((r) => !r.created)).toEqual([{ created: false, backfilled: 0 }]);
        expect((await pg`select count(*)::int as n from ccc_share_expiry`)[0].n).toBe(1);
      } finally {
        release.resolve();
        await holder.catch(() => undefined);
        await hold.end({ timeout: 5 });
      }
    });

    it('native mode installs nothing; a remote boot that cannot install refuses to boot', async () => {
      await new ShareExpiryInstaller(db as any, 'native').onApplicationBootstrap();
      expect((await pg`select to_regclass('ccc_share_expiry') as t`)[0].t).toBeNull();

      process.env.SHARE_EXPIRY_INSTALL_MAX_ATTEMPTS = '1';
      try {
        await pg`alter table shares rename to shares_gone`;
        await expect(new ShareExpiryInstaller(db as any, 'remote').onApplicationBootstrap()).rejects.toThrow(
          /share expiry install failed in remote mode/,
        );
      } finally {
        delete process.env.SHARE_EXPIRY_INSTALL_MAX_ATTEMPTS;
        await pg`alter table if exists shares_gone rename to shares`;
      }
      expect((await pg`select to_regclass('ccc_share_expiry') as t`)[0].t).toBeNull(); // the failed run left nothing
    });
  });

  describe('with the table installed', () => {
    beforeAll(async () => {
      await pg`drop table if exists ccc_share_expiry`;
      await clearShareRows(pg);
      await new ShareExpiryInstaller(db as any, 'remote').install();
    });

    beforeEach(async () => {
      await pg`insert into workspaces (id, name) values (${WS}, 'W'), (${WS_OTHER}, 'Other')`;
      await pg`insert into spaces (id, name, slug, workspace_id) values
        (${SPACE}, 'S', 's', ${WS}), (${SPACE_OTHER}, 'O', 'o', ${WS_OTHER})`;
      for (let i = 10; i < 20; i++) await page(uuid(i));
      await page(uuid(20), { ws: WS_OTHER, space: SPACE_OTHER });
    });

    afterEach(async () => {
      await clearShareRows(pg);
    });

    describe('ShareExpirySweeper', () => {
      /** A sweeper that pauses inside its batch transaction right after locking (step 1), until released. */
      class PausingSweeper extends ShareExpirySweeper {
        locked = deferred<string[]>();
        release = deferred();
        override async lockExpired(trx: any): Promise<string[]> {
          const ids = await super.lockExpired(trx);
          this.locked.resolve(ids);
          await this.release.promise;
          return ids;
        }
      }

      it('deletes ONLY expired shares, cascades their expiry rows, and audits each as a system share.deleted', async () => {
        await share(uuid(210), uuid(10), { createdAgo: 91 }); // expired by default
        await share(uuid(211), uuid(11), { expiry: '-1 second' }); // expired explicitly
        await share(uuid(212), uuid(20), { ws: WS_OTHER, space: SPACE_OTHER, createdAgo: 200 }); // expired, other ws
        await share(uuid(213), uuid(13), { createdAgo: 89 }); // live by default
        await share(uuid(214), uuid(14), { createdAgo: 1000, expiry: 'never' });
        await share(uuid(215), uuid(15), { createdAgo: 400, expiry: '1 day' }); // renewed
        const audit = mkAudit();
        const sweeper = new ShareExpirySweeper(db as any, 'remote', audit as any);
        const log = jest.spyOn((sweeper as any).logger, 'log');

        expect(await sweeper.sweep()).toBe(3);
        expect(await shareIds()).toEqual([uuid(213), uuid(214), uuid(215)]);
        expect((await pg`select share_id from ccc_share_expiry order by share_id`).map((r) => r.share_id)).toEqual([
          uuid(214),
          uuid(215),
        ]);
        expect(log).toHaveBeenCalledWith('SHARE_EXPIRY_SWEEP removed=3');

        expect(audit.log).not.toHaveBeenCalled();
        expect(audit.logBatchWithContext).toHaveBeenCalledTimes(2); // one batch per workspace
        const byWs = new Map(audit.logBatchWithContext.mock.calls.map(([p, c]) => [c.workspaceId, { p, c }]));
        expect(byWs.get(WS)!.c).toEqual({ workspaceId: WS, actorType: 'system' });
        expect(byWs.get(WS_OTHER)!.c).toEqual({ workspaceId: WS_OTHER, actorType: 'system' });
        const ev = byWs.get(WS)!.p.find((p: any) => p.resourceId === uuid(211));
        expect(ev).toMatchObject({
          event: 'share.deleted',
          resourceType: 'share',
          resourceId: uuid(211),
          spaceId: SPACE,
          metadata: { reason: 'expired' },
          changes: {
            before: { pageId: uuid(11), spaceId: SPACE, includeSubPages: true, searchIndexing: false },
          },
        });
        expect(new Date(ev.changes.before.expiresAt).getTime()).toBeLessThanOrEqual(Date.now());
        expect(byWs.get(WS)!.p.map((p: any) => p.resourceId).sort()).toEqual([uuid(210), uuid(211)]);

        // Nothing left to do: no log line, no audit.
        log.mockClear();
        expect(await sweeper.sweep()).toBe(0);
        expect(log).not.toHaveBeenCalled();
        expect(audit.logBatchWithContext).toHaveBeenCalledTimes(2);
      });

      it('two concurrent sweepers take disjoint rows and never wait on each other (SKIP LOCKED)', async () => {
        for (let i = 10; i < 15; i++) await share(uuid(200 + i), uuid(i), { createdAgo: 100 + i });
        await share(uuid(215), uuid(15), { createdAgo: 1 }); // live: step 1 must not even lock it
        const auditA = mkAudit();
        const auditB = mkAudit();
        const a = new PausingSweeper(db as any, 'remote', auditA as any);
        const b = new ShareExpirySweeper(db as any, 'remote', auditB as any);
        const warnB = jest.spyOn((b as any).logger, 'warn');

        const runA = a.sweep();
        try {
          const lockedByA = await a.locked.promise;
          expect(lockedByA.sort()).toEqual([210, 211, 212, 213, 214].map((i) => uuid(i)));
          // B runs to completion while A holds every expired row: it skips them all, without waiting for a lock.
          expect(await b.sweep()).toBe(0);
          expect(warnB).not.toHaveBeenCalled();
        } finally {
          a.release.resolve(); // never leave A's transaction (and its pooled connection) open on a failure
        }
        expect(await runA).toBe(5);
        expect(await shareIds()).toEqual([uuid(215)]);
        expect(auditB.logBatchWithContext).not.toHaveBeenCalled();
        expect(auditA.logBatchWithContext.mock.calls[0][0]).toHaveLength(5);
      });

      it('a row another transaction holds (a renewal in flight) is skipped, and a committed renewal survives', async () => {
        await share(uuid(210), uuid(10), { createdAgo: 100 });
        await share(uuid(211), uuid(11), { createdAgo: 100 });
        const renew = postgres(PG_URL as string, { max: 1, onnotice: () => {}, connection: { search_path: SCHEMA } });
        const release = deferred();
        const locked = deferred();
        // The expiry API's write, paused before commit: the shares row FOR UPDATE, then the expiry upsert.
        const renewal = renew.begin(async (t) => {
        const tx = t as unknown as postgres.Sql;
          await tx`select id from shares where id = ${uuid(210)} for update`;
          await tx`insert into ccc_share_expiry (share_id, expires_at) values (${uuid(210)}, now() + interval '30 days')
                   on conflict (share_id) do update set expires_at = excluded.expires_at`;
          locked.resolve();
          await release.promise;
        });
        try {
          await locked.promise;
          const sweeper = new ShareExpirySweeper(db as any, 'remote', mkAudit() as any);
          expect(await sweeper.sweep()).toBe(1); // only the row nobody holds
          expect(await shareIds()).toEqual([uuid(210)]);
          release.resolve();
          await renewal;
          expect(await sweeper.sweep()).toBe(0); // renewed: live, never swept
          expect(await shareIds()).toEqual([uuid(210)]);
        } finally {
          release.resolve();
          await renewal.catch(() => undefined);
          await renew.end({ timeout: 5 });
        }
      });

      it('step 2 re-checks liveness: a share renewed after step 1\'s snapshot is kept even though it was locked', async () => {
        await share(uuid(210), uuid(10), { createdAgo: 100 }); // expired
        await share(uuid(211), uuid(11), { createdAgo: 100, expiry: '30 days' }); // renewed (committed)
        // Step 1 as a stale snapshot would report it: both ids, both locked.
        class StaleSnapshotSweeper extends ShareExpirySweeper {
          override async lockExpired(trx: any): Promise<string[]> {
            const ids = await super.lockExpired(trx);
            await sql`select 1 from shares where id = ${uuid(211)} for update`.execute(trx);
            return [...ids, uuid(211)];
          }
        }
        const audit = mkAudit();
        expect(await new StaleSnapshotSweeper(db as any, 'remote', audit as any).sweep()).toBe(1);
        expect(await shareIds()).toEqual([uuid(211)]);
        expect(audit.logBatchWithContext.mock.calls[0][0].map((p: any) => p.resourceId)).toEqual([uuid(210)]);
      });

      it('never throws: a failed batch logs SHARE_EXPIRY_SWEEP_FAILED and deletes nothing; a failing audit is contained', async () => {
        await share(uuid(210), uuid(10), { createdAgo: 100 });
        const sweeper = new ShareExpirySweeper(db as any, 'remote', mkAudit() as any);
        const warn = jest.spyOn((sweeper as any).logger, 'warn');
        await pg`alter table ccc_share_expiry rename to ccc_share_expiry_gone`;
        try {
          expect(await sweeper.sweep()).toBe(0);
        } finally {
          await pg`alter table ccc_share_expiry_gone rename to ccc_share_expiry`;
        }
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^SHARE_EXPIRY_SWEEP_FAILED removed=0 /));
        expect(await shareIds()).toEqual([uuid(210)]);

        const throwing = new ShareExpirySweeper(db as any, 'remote', {
          logBatchWithContext: () => {
            throw new Error('sink down');
          },
        } as any);
        expect(await throwing.sweep()).toBe(1);
        expect(await shareIds()).toEqual([]);
      });

      it('native mode: no timer, and sweep() touches nothing', async () => {
        await share(uuid(210), uuid(10), { createdAgo: 100 });
        const sweeper = new ShareExpirySweeper(db as any, 'native', mkAudit() as any);
        sweeper.onApplicationBootstrap();
        expect((sweeper as any).timer).toBeNull();
        expect(await sweeper.sweep()).toBe(0);
        expect(await shareIds()).toEqual([uuid(210)]);
      });
    });

    describe('PublicDiscoveryRepo (remote): an expired share is never discoverable', () => {
      const listed = async (mode: 'remote' | 'native') =>
        (await new PublicDiscoveryRepo(db as any, mode).listPublicPages({ workspaceId: WS, perPage: 50 })).items
          .map((r) => r.id)
          .sort();

      it('lists live and "Never" shares, never an expired one (default or explicit); no sweeper involved', async () => {
        await share(uuid(210), uuid(10)); // live: created now, default created_at + 90d
        await share(uuid(211), uuid(11), { createdAgo: 91 }); // expired by default, no row
        await share(uuid(212), uuid(12), { expiry: '-1 second' }); // explicit expiry, past
        await share(uuid(213), uuid(13), { createdAgo: 400, expiry: 'never' }); // "Never"
        await pg`update shares set search_indexing = true`;
        expect(await listed('remote')).toEqual([uuid(210), uuid(213)]);
        // control: without the liveness predicate the expired rows would be listed (they are otherwise public)
        expect(await listed('native')).toEqual([uuid(210), uuid(211), uuid(212), uuid(213)]);
      });

      it('fails closed: a remote list with the expiry table unreadable throws, never lists', async () => {
        await share(uuid(210), uuid(10));
        await pg`update shares set search_indexing = true`;
        await pg`alter table ccc_share_expiry rename to ccc_share_expiry_gone`;
        try {
          await expect(listed('remote')).rejects.toThrow(/ccc_share_expiry/);
        } finally {
          await pg`alter table ccc_share_expiry_gone rename to ccc_share_expiry`;
        }
      });
    });

    describe('ShareExpiryController', () => {
      const user = { id: EDITOR } as any;
      const ws = { id: WS } as any;
      let access: { canView: boolean; canEdit: boolean; onEdit?: () => Promise<void> };
      let audit: ReturnType<typeof mkAudit>;
      let controller: ShareExpiryController;

      beforeEach(() => {
        access = { canView: true, canEdit: true };
        audit = mkAudit();
        const pageRepo = {
          findById: (id: string) => db.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirst(),
        };
        const pageAccessService = {
          validateCanView: jest.fn(async () => {
            if (!access.canView) throw new ForbiddenException();
          }),
          validateCanEdit: jest.fn(async () => {
            if (!access.canEdit) throw new ForbiddenException();
            await access.onEdit?.();
            return { hasRestriction: false };
          }),
        };
        // The #704 publish gate allows here (its decisions are share-publish.pg.spec.ts's): this block is the expiry write.
        const publishGate = { requirePublish: jest.fn(async () => undefined) };
        controller = new ShareExpiryController(
          db as any,
          mkRepo(),
          pageRepo as any,
          pageAccessService as any,
          audit as any,
          publishGate as any,
        );
      });

      it('info: a viewer reads the effective expiry (default created_at + 90d; Never → null)', async () => {
        await share(uuid(210), uuid(10), { createdAgo: 10 });
        await share(uuid(211), uuid(11), { expiry: 'never' });
        access.canEdit = false; // view is enough to read
        const created = (await pg`select created_at from shares where id = ${uuid(210)}`)[0].created_at as Date;
        expect(await controller.info({ shareId: uuid(210) }, user, ws)).toEqual({
          expiresAt: new Date(created.getTime() + 90 * 86400_000).toISOString(),
        });
        expect(await controller.info({ shareId: uuid(211) }, user, ws)).toEqual({ expiresAt: null });
      });

      it('info: a non-viewer is refused; expired, cross-workspace, trashed and unknown are all "Share not found"', async () => {
        await share(uuid(210), uuid(10));
        await share(uuid(211), uuid(11), { createdAgo: 91 });
        await share(uuid(212), uuid(20), { ws: WS_OTHER, space: SPACE_OTHER });
        await pg`update pages set deleted_at = now() where id = ${uuid(13)}`;
        await share(uuid(213), uuid(13));
        access.canView = false;
        await expect(controller.info({ shareId: uuid(210) }, user, ws)).rejects.toBeInstanceOf(ForbiddenException);
        access.canView = true;
        for (const id of [uuid(211), uuid(212), uuid(213), uuid(299)]) {
          await expect(controller.info({ shareId: id }, user, ws)).rejects.toBeInstanceOf(NotFoundException);
        }
      });

      it('set: an editor sets a preset (counted from now) and Never (stored as null), audited before/after', async () => {
        await share(uuid(210), uuid(10), { createdAgo: 80 });
        const r30 = await controller.set({ shareId: uuid(210), expiresInDays: 30 }, user, ws);
        const row30 = await expiryRow(uuid(210));
        expect(Math.abs(row30.secs_left - 30 * 86400)).toBeLessThan(120);
        expect(r30).toEqual({ expiresAt: (row30.expires_at as Date).toISOString() });
        expect(audit.log).toHaveBeenLastCalledWith({
          event: SHARE_EXPIRY_UPDATED,
          resourceType: 'share',
          resourceId: uuid(210),
          spaceId: SPACE,
          changes: { before: { expiresAt: expect.any(String) }, after: { expiresAt: r30.expiresAt } },
          metadata: { pageId: uuid(10), expiresInDays: 30 },
        });

        expect(await controller.set({ shareId: uuid(210), expiresInDays: null }, user, ws)).toEqual({ expiresAt: null });
        const never = await pg`select expires_at from ccc_share_expiry where share_id = ${uuid(210)}`;
        expect(never).toEqual([{ expires_at: null }]);
        expect(audit.log.mock.calls[1][0].changes).toEqual({
          before: { expiresAt: r30.expiresAt },
          after: { expiresAt: null },
        });
        expect(await controller.info({ shareId: uuid(210) }, user, ws)).toEqual({ expiresAt: null });
      });

      it('a share row in another workspace is 404 even when its page row is in the caller\'s (both are checked)', async () => {
        await share(uuid(210), uuid(10), { ws: WS_OTHER, space: SPACE_OTHER });
        await expect(controller.info({ shareId: uuid(210) }, user, ws)).rejects.toBeInstanceOf(NotFoundException);
        await expect(controller.set({ shareId: uuid(210), expiresInDays: 7 }, user, ws)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(await expiryRow(uuid(210))).toBeUndefined();
      });

      it('set: a non-editor (a viewer) is refused and nothing is written', async () => {
        await share(uuid(210), uuid(10));
        access.canEdit = false;
        await expect(controller.set({ shareId: uuid(210), expiresInDays: 365 }, user, ws)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(await expiryRow(uuid(210))).toBeUndefined();
        expect(audit.log).not.toHaveBeenCalled();
      });

      it('set: an expired share is dead (404, re-share instead); cross-workspace is 404; nothing written', async () => {
        await share(uuid(210), uuid(10), { createdAgo: 91 });
        await share(uuid(211), uuid(20), { ws: WS_OTHER, space: SPACE_OTHER });
        for (const id of [uuid(210), uuid(211)]) {
          await expect(controller.set({ shareId: id, expiresInDays: 90 }, user, ws)).rejects.toBeInstanceOf(
            NotFoundException,
          );
          expect(await expiryRow(id)).toBeUndefined();
        }
        expect(audit.log).not.toHaveBeenCalled();
      });

      it('set: liveness is re-checked under the row lock (an expiry landing after the authorization is a 404)', async () => {
        await share(uuid(210), uuid(10), { expiry: '1 day' });
        access.onEdit = async () => {
          await pg`update ccc_share_expiry set expires_at = now() - interval '1 second' where share_id = ${uuid(210)}`;
        };
        await expect(controller.set({ shareId: uuid(210), expiresInDays: 365 }, user, ws)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect((await expiryRow(uuid(210))).secs_left).toBeLessThan(0); // not resurrected
        expect(audit.log).not.toHaveBeenCalled();
      });

      it('set: waits on the sweeper\'s row lock (same lock order) and answers 404 once it swept the share', async () => {
        await share(uuid(210), uuid(10), { expiry: '1 day' });
        // The sweeper locks the share inside its batch (a stale step 1 that claims it), and pauses.
        const locked = deferred();
        const release = deferred();
        class Holding extends ShareExpirySweeper {
          override async lockExpired(trx: any): Promise<string[]> {
            await sql`select 1 from shares where id = ${uuid(210)} for update`.execute(trx);
            await sql`update ccc_share_expiry set expires_at = now() - interval '1 second' where share_id = ${uuid(210)}`.execute(trx);
            locked.resolve();
            await release.promise;
            return [uuid(210)];
          }
        }
        const sweep = new Holding(db as any, 'remote', mkAudit() as any).sweep();
        let write: Promise<unknown>;
        try {
          await locked.promise;
          write = controller.set({ shareId: uuid(210), expiresInDays: 30 }, user, ws);
          write.catch(() => undefined); // asserted below
          await until(async () => {
            const r = await pg`
              select count(*)::int as n from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and query like '%from shares s where s.id = $1 for update of s%'`;
            return r[0].n === 1;
          }, 'the expiry write waiting on the sweeper\'s row lock');
        } finally {
          release.resolve();
        }
        expect(await sweep).toBe(1);
        await expect(write).rejects.toBeInstanceOf(NotFoundException);
        expect(await shareIds()).toEqual([]);
      });

      it('set: a lock held past lock_timeout is a retryable 503 engine_busy', async () => {
        await share(uuid(210), uuid(10));
        const hold = postgres(PG_URL as string, { max: 1, onnotice: () => {}, connection: { search_path: SCHEMA } });
        const release = deferred();
        const locked = deferred();
        const holder = hold.begin(async (t) => {
        const tx = t as unknown as postgres.Sql;
          await tx`select id from shares where id = ${uuid(210)} for update`;
          locked.resolve();
          await release.promise;
        });
        try {
          await locked.promise;
          const err = await controller.set({ shareId: uuid(210), expiresInDays: 7 }, user, ws).catch((e) => e);
          expect(err).toBeInstanceOf(ServiceUnavailableException);
          expect(err.getResponse()).toMatchObject({ code: 'engine_busy' });
        } finally {
          release.resolve();
          await holder.catch(() => undefined);
          await hold.end({ timeout: 5 });
        }
        expect(await expiryRow(uuid(210))).toBeUndefined();
      });
    });
  });
});
