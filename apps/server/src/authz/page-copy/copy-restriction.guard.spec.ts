import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { KyselyTransaction } from '@docmost/db/types/kysely.types';
import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import { CYCLE_LOCK_CLASS } from '../../service-bridge/page-cycle-guard.installer';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';
import {
  assertCopyKeepsRestrictions,
  hasCopyRestrictionGuard,
  RESTRICTED_COPY,
  RESTRICTED_COPY_MESSAGES,
} from './copy-restriction.guard';

/**
 * #573 unit: the copy guard's decisions and their mapping, against a spy Kysely that compiles the real queries. The
 * real-Postgres proof (the lock, the race, nothing inserted, through the real `PageService.duplicatePage`) is
 * `duplicate-restriction.pg.spec.ts`.
 */
const WS = '00000000-0000-4000-8000-000000000100';
const S1 = '00000000-0000-4000-8000-000000000050';
const S2 = '00000000-0000-4000-8000-000000000051';
const ROOT = { id: 'r', spaceId: S1, parentPageId: 'parent', workspaceId: WS };

/** Run the guard in a spy transaction. `restricted` = ids with a page_access row; `lineage` = the walk's rows. */
async function run(
  args: Partial<Parameters<typeof assertCopyKeepsRestrictions>[1]>,
  opts: { restricted?: string[]; lineage?: unknown[]; fail?: (q: SpyQuery) => void } = {},
) {
  const spy = spyKysely((q) => {
    opts.fail?.(q);
    if (/from "page_access"/.test(q.sql)) {
      return (opts.restricted ?? []).filter((id) => q.parameters.includes(id)).map((pageId) => ({ pageId }));
    }
    if (/with recursive anc/.test(q.sql)) return opts.lineage ?? [];
    return [];
  });
  const outcome = await spy.db
    .transaction()
    .execute((trx) =>
      assertCopyKeepsRestrictions(trx as KyselyTransaction, {
        pageIds: ['r', 'c'],
        rootPage: ROOT,
        targetSpaceId: S1,
        ...args,
      }),
    )
    .then(
      () => 'ok' as const,
      (e) => e as Error,
    );
  return { outcome, calls: spy.calls.map((c) => c.sql), tx: spy.tx };
}

describe('hasCopyRestrictionGuard — the remote repo carries the guard, the stock repo does not', () => {
  it('true for PdpPagePermissionRepo (remote mode)', () => {
    const repo = new PdpPagePermissionRepo({} as never, {} as never, {} as never, {} as never);
    expect(hasCopyRestrictionGuard(repo)).toBe(true);
  });

  it('false for the stock PagePermissionRepo (native mode keeps upstream duplicate)', () => {
    const repo = new PagePermissionRepo({} as never, {} as never, {} as never);
    expect(hasCopyRestrictionGuard(repo)).toBe(false);
  });

  it('the repo method IS the guard (delegates, no extra decision)', async () => {
    const repo = new PdpPagePermissionRepo({} as never, {} as never, {} as never, {} as never);
    const spy = spyKysely((q) => (/from "page_access"/.test(q.sql) ? [{ pageId: 'c' }] : []));
    const err = await spy.db
      .transaction()
      .execute((trx) =>
        repo.assertCopyKeepsRestrictions(trx as KyselyTransaction, { pageIds: ['r', 'c'], rootPage: ROOT, targetSpaceId: S1 }),
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
  });
});

describe('assertCopyKeepsRestrictions', () => {
  it('bounds its waits BEFORE the per-workspace guard lock, and reads only after it', async () => {
    const { outcome, calls } = await run({});
    expect(outcome).toBe('ok');
    const lockAt = calls.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    expect(calls.findIndex((s) => /lock_timeout/.test(s))).toBeLessThan(lockAt);
    expect(calls.findIndex((s) => /statement_timeout/.test(s))).toBeLessThan(lockAt);
    expect(calls[lockAt]).toContain(`pg_advisory_xact_lock(${CYCLE_LOCK_CLASS}, hashtext($1::text))`);
    expect(calls.findIndex((s) => /from "page_access"/.test(s))).toBeGreaterThan(lockAt);
  });

  it('a page in the set with its own restriction → 409 ccc_page_restricted_copy with the actionable text', async () => {
    const { outcome } = await run({}, { restricted: ['c'] });
    expect(outcome).toBeInstanceOf(ConflictException);
    expect((outcome as ConflictException).getResponse()).toEqual({
      message: RESTRICTED_COPY_MESSAGES.own,
      code: RESTRICTED_COPY,
    });
  });

  it('the PDP dropped the root → 503 before any statement (no lock taken for nothing)', async () => {
    const { outcome, calls } = await run({ pageIds: [] });
    expect(outcome).toBeInstanceOf(ServiceUnavailableException);
    expect(calls).toEqual([]);
    const again = await run({ pageIds: ['c'] });
    expect(again.outcome).toBeInstanceOf(ServiceUnavailableException);
  });

  it.each(['55P03', '40P01', '57014'])('a busy SQLSTATE (%s) → 503 engine_busy', async (code) => {
    const { outcome } = await run(
      {},
      {
        fail: (q) => {
          if (q.sql.includes('pg_advisory_xact_lock')) throw Object.assign(new Error('busy'), { code });
        },
      },
    );
    expect(outcome).toBeInstanceOf(ServiceUnavailableException);
    expect((outcome as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'engine_busy' });
  });

  it('any other error passes through untouched', async () => {
    const boom = Object.assign(new Error('boom'), { code: 'XX000' });
    const { outcome } = await run({}, { fail: () => { throw boom; } });
    expect(outcome).toBe(boom);
  });

  describe('cross-space: the root lineage', () => {
    const open = [{ id: 'parent', parentPageId: null, depth: 0, restricted: false }];
    it('restricted lineage → 409 (section text)', async () => {
      const { outcome } = await run(
        { targetSpaceId: S2 },
        { lineage: [{ id: 'parent', parentPageId: null, depth: 0, restricted: true }] },
      );
      expect((outcome as ConflictException).getResponse()).toEqual({
        message: RESTRICTED_COPY_MESSAGES.section,
        code: RESTRICTED_COPY,
      });
    });

    it('incomplete lineage (walk did not reach a root) → 409', async () => {
      const { outcome } = await run(
        { targetSpaceId: S2 },
        { lineage: [{ id: 'parent', parentPageId: 'gone', depth: 0, restricted: false }] },
      );
      expect(outcome).toBeInstanceOf(ConflictException);
      expect((await run({ targetSpaceId: S2 }, { lineage: [] })).outcome).toBeInstanceOf(ConflictException);
    });

    it('open lineage → allowed; the walk is pinned to the root workspace', async () => {
      const { outcome, calls } = await run({ targetSpaceId: S2 }, { lineage: open });
      expect(outcome).toBe('ok');
      expect(calls.some((s) => /with recursive anc/.test(s) && /p\.workspace_id = \$\d/.test(s))).toBe(true);
    });

    it('a root at the space root has no lineage to walk', async () => {
      const { outcome, calls } = await run({ targetSpaceId: S2, rootPage: { ...ROOT, parentPageId: null } });
      expect(outcome).toBe('ok');
      expect(calls.some((s) => /with recursive anc/.test(s))).toBe(false);
    });
  });

  it('same space: the copy keeps the parent (inherits), so the lineage is not walked', async () => {
    for (const targetSpaceId of [S1, undefined]) {
      const { outcome, calls } = await run(
        { targetSpaceId },
        { lineage: [{ id: 'parent', parentPageId: null, depth: 0, restricted: true }] },
      );
      expect(outcome).toBe('ok');
      expect(calls.some((s) => /with recursive anc/.test(s))).toBe(false);
    }
  });
});
