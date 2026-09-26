import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';
import {
  boundLedgerTx,
  IdempotencyClaim,
  IdempotencyLedgerService,
  idempotencyKeyReused,
  namespaceDigest,
  sha256hex,
  userPrincipal,
} from './idempotency-ledger.service';
import { IdempotencyLedgerInstaller } from './idempotency-ledger.installer';
import { IdempotencyLedgerSweeper, SWEEP_BATCH_SIZE, SWEEP_MAX_BATCHES } from './idempotency-ledger.sweeper';

/**
 * #616 create-idempotency ledger — the unit contract (the real-Postgres behaviour is in idempotency-ledger.pg.spec.ts):
 *   1. the stored key is bound to workspace + the fork-authenticated principal + the caller's namespace, unambiguously,
 *      and neither the raw key nor the raw namespace is ever stored;
 *   2. reserve = INSERT … ON CONFLICT DO NOTHING RETURNING, then a FOR SHARE read of the colliding row → replay /
 *      mismatch; a vanished row reserves again; a committed row without a resource is a loud 500, never a replay;
 *   3. complete only fills THIS reservation's empty resource, else throws (the create rolls back);
 *   4. the installer is remote-only, advisory-locked and fail-closed; the sweep is bounded, SKIP LOCKED, never throws.
 */
const FP = 'a'.repeat(64);
const claim = (over: Partial<IdempotencyClaim> = {}): IdempotencyClaim => ({
  workspaceId: 'ws-1',
  principal: userPrincipal('user-1'),
  namespace: 'user:ext-1',
  op: 'page.create',
  key: 'the-raw-key',
  fingerprint: FP,
  ...over,
});
const flat = (q: SpyQuery) => q.sql.replace(/\s+/g, ' ').trim();

describe('namespaceDigest — who a key belongs to', () => {
  const base = { workspaceId: 'ws-1', principal: 'user:u1', namespace: 'ns' };

  it('changes with each of workspace, principal and namespace', () => {
    const d = namespaceDigest(base);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(namespaceDigest({ ...base, workspaceId: 'ws-2' })).not.toBe(d);
    expect(namespaceDigest({ ...base, principal: 'user:u2' })).not.toBe(d);
    expect(namespaceDigest({ ...base, namespace: 'ns2' })).not.toBe(d);
    expect(namespaceDigest({ ...base })).toBe(d);
  });

  it('keeps the part boundaries: no namespace string can collide with another principal (no concatenation)', () => {
    expect(namespaceDigest({ workspaceId: 'w', principal: 'user:a', namespace: 'b|c' })).not.toBe(
      namespaceDigest({ workspaceId: 'w', principal: 'user:a|b', namespace: 'c' }),
    );
    expect(namespaceDigest({ workspaceId: 'w', principal: 'user:a', namespace: '","x' })).not.toBe(
      namespaceDigest({ workspaceId: 'w', principal: 'user:a","', namespace: 'x' }),
    );
  });
});

describe('IdempotencyLedgerService.reserve', () => {
  const run = async (respond: (q: SpyQuery, i: number) => unknown[], c: IdempotencyClaim = claim()) => {
    let i = 0;
    const spy = spyKysely((q) => respond(q, i++));
    const svc = new IdempotencyLedgerService();
    const result = await spy.db.transaction().execute((trx) => svc.reserve(trx as never, c));
    return { result, spy };
  };

  it('a new key: one INSERT … ON CONFLICT DO NOTHING RETURNING → fresh, with the digests (never the raw key/namespace)', async () => {
    const { result, spy } = await run(() => [{ reserved: 1 }]);
    const slot = { namespaceDigest: namespaceDigest(claim()), op: 'page.create', keyDigest: sha256hex('the-raw-key') };
    expect(result).toEqual({ outcome: 'fresh', slot });
    expect(spy.calls).toHaveLength(1);
    expect(flat(spy.calls[0])).toMatch(
      /^insert into ccc_idempotency_ledger \(namespace_digest, op, key_digest, fingerprint\) values \(\$1, \$2, \$3, \$4\) on conflict \(namespace_digest, op, key_digest\) do nothing returning 1 as reserved$/,
    );
    expect(spy.calls[0].parameters).toEqual([slot.namespaceDigest, 'page.create', slot.keyDigest, FP]);
    expect(JSON.stringify(spy.calls)).not.toContain('the-raw-key');
    expect(JSON.stringify(spy.calls)).not.toContain('user:ext-1');
  });

  it('a used key, same fingerprint: reads the row FOR SHARE → replay of its resource', async () => {
    const { result, spy } = await run((q) => (/^\s*insert/i.test(q.sql) ? [] : [{ fingerprint: FP, resourceId: 'page-9' }]));
    expect(result).toEqual({ outcome: 'replay', resourceId: 'page-9' });
    expect(flat(spy.calls[1])).toMatch(/^select fingerprint, resource_id as "resourceId" from ccc_idempotency_ledger where .* for share$/);
    expect(spy.calls[1].parameters).toEqual([namespaceDigest(claim()), 'page.create', sha256hex('the-raw-key')]);
  });

  it('a used key, different fingerprint → mismatch (the caller answers 409 idempotency_key_reused)', async () => {
    const { result } = await run((q) => (/^\s*insert/i.test(q.sql) ? [] : [{ fingerprint: 'b'.repeat(64), resourceId: 'page-9' }]));
    expect(result).toEqual({ outcome: 'mismatch' });
    const e = idempotencyKeyReused();
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toEqual({ message: expect.any(String), code: 'idempotency_key_reused' });
  });

  it('a colliding row that vanished before the read (swept) → reserves again', async () => {
    const { result, spy } = await run((_q, i) => (i === 2 ? [{ reserved: 1 }] : []));
    expect(result).toMatchObject({ outcome: 'fresh' });
    expect(spy.calls.map((q) => flat(q).split(' ')[0])).toEqual(['insert', 'select', 'insert']);
  });

  it('never loops: a row that keeps vanishing is a 500 after two rounds', async () => {
    await expect(run(() => [])).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('a committed row with NO resource is a loud 500 — never a replay of nothing, never a second create', async () => {
    await expect(
      run((q) => (/^\s*insert/i.test(q.sql) ? [] : [{ fingerprint: FP, resourceId: null }])),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it.each([
    ['fingerprint (uppercase)', { fingerprint: 'A'.repeat(64) }],
    ['fingerprint (short)', { fingerprint: 'a'.repeat(63) }],
    ['key (empty)', { key: '' }],
    ['key (256)', { key: 'k'.repeat(256) }],
    ['namespace (129)', { namespace: 'n'.repeat(129) }],
    ['principal', { principal: '' }],
    ['workspaceId', { workspaceId: '' }],
    ['op', { op: 'page.delete' as never }],
  ])('refuses a malformed claim before touching the database: %s', async (_what, over) => {
    const spy = spyKysely(() => []);
    const svc = new IdempotencyLedgerService();
    await expect(svc.reserve(spy.db as never, claim(over))).rejects.toThrow(/invalid/);
    expect(spy.calls).toEqual([]);
  });
});

describe('IdempotencyLedgerService.complete', () => {
  const slot = { namespaceDigest: 'n'.repeat(64), op: 'page.create' as const, keyDigest: 'k'.repeat(64) };

  it('fills only this reservation’s EMPTY resource', async () => {
    const spy = spyKysely(() => [{ completed: 1 }]);
    await new IdempotencyLedgerService().complete(spy.db as never, slot, 'page-1');
    expect(flat(spy.calls[0])).toMatch(
      /^update ccc_idempotency_ledger set resource_id = \$1::uuid where namespace_digest = \$2 and op = \$3 and key_digest = \$4 and resource_id is null returning 1 as completed$/,
    );
    expect(spy.calls[0].parameters).toEqual(['page-1', slot.namespaceDigest, 'page.create', slot.keyDigest]);
  });

  it('throws when nothing was updated, so the create rolls back', async () => {
    const spy = spyKysely(() => []);
    await expect(new IdempotencyLedgerService().complete(spy.db as never, slot, 'page-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('boundLedgerTx', () => {
  it('sets lock_timeout 2s and statement_timeout 15s, transaction-local', async () => {
    const spy = spyKysely(() => []);
    await spy.db.transaction().execute((trx) => boundLedgerTx(trx as never));
    expect(spy.calls.map(flat)).toEqual(["SET LOCAL lock_timeout = '2s'", "SET LOCAL statement_timeout = '15s'"]);
  });
});

describe('IdempotencyLedgerInstaller', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('native mode installs nothing', async () => {
    const spy = spyKysely(() => []);
    await new IdempotencyLedgerInstaller(spy.db, 'native').onApplicationBootstrap();
    expect(spy.calls).toEqual([]);
  });

  it('remote: advisory-locked DDL in one transaction; the index only when missing', async () => {
    for (const present of [false, true]) {
      const spy = spyKysely((q) => (/to_regclass/.test(q.sql) ? [{ present }] : []));
      await new IdempotencyLedgerInstaller(spy.db, 'remote').onApplicationBootstrap();
      const sqls = spy.calls.map(flat);
      expect(sqls[0]).toBe("SET LOCAL lock_timeout = '5s'");
      expect(sqls[1]).toMatch(/^select pg_advisory_xact_lock\(\$1\)$/);
      expect(sqls[2]).toMatch(
        /^create table if not exists ccc_idempotency_ledger \( namespace_digest text not null, op text not null, key_digest text not null, fingerprint text not null, resource_id uuid, created_at timestamptz not null default now\(\), primary key \(namespace_digest, op, key_digest\) \)$/,
      );
      expect(sqls.some((s) => /create index if not exists ccc_idempotency_ledger_created_at_idx on ccc_idempotency_ledger \(created_at\)/.test(s))).toBe(
        !present,
      );
      expect(spy.tx).toEqual(['begin', 'commit']);
    }
  });

  it('fail-closed: a persistent failure fails the boot after the bounded retry', async () => {
    process.env.IDEMPOTENCY_LEDGER_INSTALL_MAX_ATTEMPTS = '2';
    process.env.IDEMPOTENCY_LEDGER_INSTALL_RETRY_MS = '0';
    const spy = spyKysely(() => {
      throw new Error('connection refused');
    });
    await expect(new IdempotencyLedgerInstaller(spy.db, 'remote').onApplicationBootstrap()).rejects.toThrow(
      /idempotency ledger install failed in remote mode: connection refused/,
    );
    expect(spy.tx.filter((t) => t === 'begin')).toHaveLength(2);
  });
});

describe('IdempotencyLedgerSweeper', () => {
  it('deletes only rows older than 24h, in SKIP LOCKED batches, and stops at the first short batch', async () => {
    const sizes = [SWEEP_BATCH_SIZE, 3];
    const spy = spyKysely(() => Array.from({ length: sizes.shift() ?? 0 }, () => ({ gone: 1 })));
    const removed = await new IdempotencyLedgerSweeper(spy.db, 'remote').sweep();
    expect(removed).toBe(SWEEP_BATCH_SIZE + 3);
    expect(spy.calls).toHaveLength(2);
    expect(flat(spy.calls[0])).toBe(
      'delete from ccc_idempotency_ledger where (namespace_digest, op, key_digest) in ( select namespace_digest, op, key_digest ' +
        'from ccc_idempotency_ledger where created_at < now() - make_interval(hours => 24) order by created_at ' +
        `limit ${SWEEP_BATCH_SIZE} for update skip locked ) returning 1 as gone`,
    );
    expect(spy.tx).toEqual([]); // each batch is its own short autocommit statement
  });

  it('is bounded per run', async () => {
    const spy = spyKysely(() => Array.from({ length: SWEEP_BATCH_SIZE }, () => ({ gone: 1 })));
    expect(await new IdempotencyLedgerSweeper(spy.db, 'remote').sweep()).toBe(SWEEP_BATCH_SIZE * SWEEP_MAX_BATCHES);
    expect(spy.calls).toHaveLength(SWEEP_MAX_BATCHES);
  });

  it('never throws (a failed run is retried next time)', async () => {
    const spy = spyKysely(() => {
      throw new Error('boom');
    });
    await expect(new IdempotencyLedgerSweeper(spy.db, 'remote').sweep()).resolves.toBe(0);
  });

  it('schedules nothing in native mode; unref’d timers in remote, cleared on shutdown', () => {
    jest.useFakeTimers();
    try {
      const spy = spyKysely(() => []);
      const native = new IdempotencyLedgerSweeper(spy.db, 'native');
      native.onApplicationBootstrap();
      expect(jest.getTimerCount()).toBe(0);
      const remote = new IdempotencyLedgerSweeper(spy.db, 'remote');
      remote.onApplicationBootstrap();
      expect(jest.getTimerCount()).toBe(2);
      remote.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
