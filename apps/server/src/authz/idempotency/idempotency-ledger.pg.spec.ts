import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { PG_URL, bootstrapSchema, mkReadModelDb, mkReadModelPg } from '../../service-bridge/read-model-pg.testkit';
import { IdempotencyLedgerInstaller } from './idempotency-ledger.installer';
import { IdempotencyLedgerSweeper } from './idempotency-ledger.sweeper';
import {
  boundLedgerTx,
  IdempotencyClaim,
  IdempotencyLedgerService,
  namespaceDigest,
  Reservation,
  sha256hex,
  userPrincipal,
} from './idempotency-ledger.service';

/**
 * #616 create-idempotency ledger on real Postgres — what the spy Kysely cannot prove:
 *   - the installer is idempotent (twice → the same table, primary key and index; no error), and inert in native;
 *   - a concurrent same-key reservation WAITS inside its INSERT for the in-flight twin (observed in pg_locks) and then
 *     replays the twin's committed resource — or, when the twin rolls back, reserves fresh;
 *   - the waiter is bounded by the transaction's lock_timeout (55P03, which the controllers answer 503 engine_busy);
 *   - a transaction that rolls back leaves no row;
 *   - the sweep deletes only rows older than 24h, and skips a row a replay is reading.
 * Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG idempotency ledger gate', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'idempotency_ledger_pg_spec';
const FP = 'a'.repeat(64);
const PAGE_A = '00000000-0000-4000-8000-00000000000a';
const PAGE_B = '00000000-0000-4000-8000-00000000000b';

d('IdempotencyLedgerService on real Postgres (#616)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;
  const ledger = new IdempotencyLedgerService();

  const claim = (over: Partial<IdempotencyClaim> = {}): IdempotencyClaim => ({
    workspaceId: 'ws-1',
    principal: userPrincipal('user-1'),
    namespace: 'user:ext-1',
    op: 'page.create',
    key: 'key-1',
    fingerprint: FP,
    ...over,
  });
  const rows = () =>
    pg<{ op: string; fingerprint: string; resourceId: string | null }[]>`
      select op, fingerprint, resource_id as "resourceId" from ccc_idempotency_ledger order by created_at`;
  const waitForLockWaiter = async () => {
    for (let i = 0; i < 150; i++) {
      const [{ c }] = await pg<{ c: number }[]>`select count(*)::int as c from pg_locks where not granted`;
      if (c > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no session ever waited on a lock');
  };

  /** Reserve (and, when fresh, complete with `resourceId`) in one bounded transaction; `hold` runs before commit. */
  const reserveTx = (c: IdempotencyClaim, resourceId: string, hold?: () => Promise<void>): Promise<Reservation> =>
    db.transaction().execute(async (trx) => {
      await boundLedgerTx(trx as never);
      const r = await ledger.reserve(trx as never, c);
      if (r.outcome === 'fresh') await ledger.complete(trx as never, r.slot, resourceId);
      if (hold) await hold();
      return r;
    });

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 2);
    appPg = mkReadModelPg(SCHEMA, 6);
    db = mkReadModelDb(appPg);
  });

  afterEach(async () => {
    await pg`delete from ccc_idempotency_ledger`.catch(() => undefined);
  });

  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  describe('the installer', () => {
    it('native mode creates nothing', async () => {
      await new IdempotencyLedgerInstaller(db as never, 'native').onApplicationBootstrap();
      const [{ t }] = await pg<{ t: string | null }[]>`select to_regclass('ccc_idempotency_ledger')::text as t`;
      expect(t).toBeNull();
    });

    it('is idempotent: two runs (one via the boot hook) → one table, its primary key and the created_at index', async () => {
      const installer = new IdempotencyLedgerInstaller(db as never, 'remote');
      await installer.onApplicationBootstrap();
      await installer.install();
      const cols = await pg<{ column_name: string; data_type: string; is_nullable: string }[]>`
        select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = ${SCHEMA} and table_name = 'ccc_idempotency_ledger' order by ordinal_position`;
      expect(cols.map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`)).toEqual([
        'namespace_digest:text:NO',
        'op:text:NO',
        'key_digest:text:NO',
        'fingerprint:text:NO',
        'resource_id:uuid:YES',
        'created_at:timestamp with time zone:NO',
      ]);
      const idx = await pg<{ indexdef: string }[]>`
        select indexdef from pg_indexes where schemaname = ${SCHEMA} and tablename = 'ccc_idempotency_ledger' order by indexname`;
      expect(idx.map((i) => i.indexdef.replace(`${SCHEMA}.`, ''))).toEqual([
        'CREATE INDEX ccc_idempotency_ledger_created_at_idx ON ccc_idempotency_ledger USING btree (created_at)',
        'CREATE UNIQUE INDEX ccc_idempotency_ledger_pkey ON ccc_idempotency_ledger USING btree (namespace_digest, op, key_digest)',
      ]);
    });
  });

  const installed = () => new IdempotencyLedgerInstaller(db as never, 'remote').install();

  describe('reserve / complete', () => {
    beforeAll(installed);

    it('fresh → replay (same fingerprint) → mismatch (different); only digests are stored', async () => {
      expect(await reserveTx(claim(), PAGE_A)).toMatchObject({ outcome: 'fresh' });
      expect(await reserveTx(claim(), PAGE_B)).toEqual({ outcome: 'replay', resourceId: PAGE_A });
      expect(await reserveTx(claim({ fingerprint: 'b'.repeat(64) }), PAGE_B)).toEqual({ outcome: 'mismatch' });
      expect(await rows()).toEqual([{ op: 'page.create', fingerprint: FP, resourceId: PAGE_A }]);
      const [raw] = await pg<{ namespaceDigest: string; keyDigest: string }[]>`
        select namespace_digest as "namespaceDigest", key_digest as "keyDigest" from ccc_idempotency_ledger`;
      expect(raw).toEqual({ namespaceDigest: namespaceDigest(claim()), keyDigest: sha256hex('key-1') });
    });

    it('the same key is a separate entry per user, per namespace, per workspace and per op', async () => {
      await reserveTx(claim(), PAGE_A);
      for (const over of [
        { principal: userPrincipal('user-2') },
        { namespace: 'user:ext-1:obo:x' },
        { workspaceId: 'ws-2' },
        { op: 'space.create' as const },
      ]) {
        expect(await reserveTx(claim(over), PAGE_B)).toMatchObject({ outcome: 'fresh' });
      }
      expect(await rows()).toHaveLength(5);
    });

    it('a reservation whose transaction rolls back leaves no row, and the key is free again', async () => {
      await expect(
        reserveTx(claim(), PAGE_A, async () => {
          throw new Error('the create failed');
        }),
      ).rejects.toThrow('the create failed');
      expect(await rows()).toEqual([]);
      expect(await reserveTx(claim(), PAGE_B)).toMatchObject({ outcome: 'fresh' });
    });

    it('a concurrent twin WAITS inside its INSERT for the first, then replays the committed resource', async () => {
      let twin!: Promise<Reservation>;
      const first = await reserveTx(claim(), PAGE_A, async () => {
        twin = reserveTx(claim(), PAGE_B);
        await waitForLockWaiter(); // the twin is blocked on our uncommitted row
      });
      expect(first).toMatchObject({ outcome: 'fresh' });
      expect(await twin).toEqual({ outcome: 'replay', resourceId: PAGE_A });
      expect(await rows()).toEqual([{ op: 'page.create', fingerprint: FP, resourceId: PAGE_A }]);
    });

    it('when the first rolls back, the waiting twin reserves fresh and completes with ITS resource', async () => {
      let twin!: Promise<Reservation>;
      await expect(
        reserveTx(claim(), PAGE_A, async () => {
          twin = reserveTx(claim(), PAGE_B);
          await waitForLockWaiter();
          throw new Error('first create failed');
        }),
      ).rejects.toThrow('first create failed');
      expect(await twin).toMatchObject({ outcome: 'fresh' });
      expect(await rows()).toEqual([{ op: 'page.create', fingerprint: FP, resourceId: PAGE_B }]);
    });

    it('a twin with a DIFFERENT fingerprint also waits, then gets mismatch', async () => {
      let twin!: Promise<Reservation>;
      await reserveTx(claim(), PAGE_A, async () => {
        twin = reserveTx(claim({ fingerprint: 'b'.repeat(64) }), PAGE_B);
        await waitForLockWaiter();
      });
      expect(await twin).toEqual({ outcome: 'mismatch' });
    });

    it('the wait is bounded by lock_timeout: a twin held past 2s fails 55P03 (→ 503 engine_busy), nothing written', async () => {
      const side = await appPg.reserve();
      try {
        await side`begin`;
        const c = claim();
        await side`insert into ccc_idempotency_ledger (namespace_digest, op, key_digest, fingerprint)
                   values (${namespaceDigest(c)}, ${c.op}, ${sha256hex(c.key)}, ${FP})`;
        const started = Date.now();
        await expect(reserveTx(c, PAGE_B)).rejects.toMatchObject({ code: '55P03' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      } finally {
        await side`rollback`;
        side.release();
      }
      expect(await rows()).toEqual([]);
    });
  });

  describe('the sweep', () => {
    beforeAll(installed);

    it('deletes only rows older than 24h', async () => {
      await reserveTx(claim({ key: 'old' }), PAGE_A);
      await reserveTx(claim({ key: 'young' }), PAGE_B);
      await reserveTx(claim({ key: 'edge' }), PAGE_B);
      await pg`update ccc_idempotency_ledger set created_at = now() - interval '25 hours' where key_digest = ${sha256hex('old')}`;
      await pg`update ccc_idempotency_ledger set created_at = now() - interval '23 hours 59 minutes' where key_digest = ${sha256hex('edge')}`;
      const sweeper = new IdempotencyLedgerSweeper(db as never, 'remote');
      expect(await sweeper.sweep()).toBe(1);
      const left = await pg<{ keyDigest: string }[]>`select key_digest as "keyDigest" from ccc_idempotency_ledger`;
      expect(left.map((r) => r.keyDigest).sort()).toEqual([sha256hex('edge'), sha256hex('young')].sort());
      expect(await sweeper.sweep()).toBe(0);
      // An expired key is free again once swept.
      expect(await reserveTx(claim({ key: 'old' }), PAGE_B)).toMatchObject({ outcome: 'fresh' });
    });

    it('skips an expired row another transaction is reading (FOR SHARE), and gets it on the next run', async () => {
      await reserveTx(claim(), PAGE_A);
      await pg`update ccc_idempotency_ledger set created_at = now() - interval '30 hours'`;
      const side = await appPg.reserve();
      try {
        await side`begin`;
        await side`select 1 from ccc_idempotency_ledger for share`;
        expect(await new IdempotencyLedgerSweeper(db as never, 'remote').sweep()).toBe(0);
      } finally {
        await side`rollback`;
        side.release();
      }
      expect(await new IdempotencyLedgerSweeper(db as never, 'remote').sweep()).toBe(1);
    });
  });
});
