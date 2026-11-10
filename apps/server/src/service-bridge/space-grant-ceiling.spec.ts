import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { spyKysely } from './kysely-spy.testkit';
import {
  GrantNeedsPdp,
  pdpChecksFor,
  SpaceGrantCeiling,
  withGrantCeiling,
} from './space-grant-ceiling';

/**
 * wiki-v2 #797 INV-2 — the ceiling's decision table and its two-phase protocol, without a database (the real-Postgres
 * matrix is `space-grant-ceiling.pg.spec.ts`). Pins: which PDP checks cover which role (admin is the workspace cascade,
 * never `space#administer`), that the PDP is asked for the integrator's principal id, that `local` mode never asks the
 * PDP, that a PDP failure is a 503 and anything but a full allow a 403, and that `withGrantCeiling` fences BEFORE the
 * second attempt and only when the first could not decide.
 */
const WS = 'ws-1';
const S = 'sp-1';

const mk = (localRoles: string[], pdp: { tryCheckBulk?: jest.Mock; settleProjection?: jest.Mock } = {}) => {
  const spy = spyKysely((q) => (/from space_members sm/i.test(q.sql) ? localRoles.map((role) => ({ role })) : []));
  const authz = {
    tryCheckBulk: pdp.tryCheckBulk ?? jest.fn(async (_s: unknown, checks: unknown[]) => checks.map(() => true)),
    settleProjection: pdp.settleProjection ?? jest.fn(async () => ({ status: 'confirmed' })),
  };
  return { ceiling: new SpaceGrantCeiling(spy.db, authz as any), authz, spy };
};

const input = (role: 'reader' | 'writer' | 'admin', actorUserId: string | null = 'u-actor') => ({
  workspaceId: WS,
  spaceId: S,
  actorUserId,
  actorExternalId: 'ident-actor',
  role,
});

describe('pdpChecksFor (INV-2 remainder)', () => {
  it('reader ⇐ space view; writer ⇐ space edit AND share; admin ⇐ workspace admin_cascade (never space administer)', () => {
    expect(pdpChecksFor('reader', S, WS)).toEqual([{ permission: 'view', resourceType: 'space', resourceId: S }]);
    expect(pdpChecksFor('writer', S, WS)).toEqual([
      { permission: 'edit', resourceType: 'space', resourceId: S },
      { permission: 'share', resourceType: 'space', resourceId: S },
    ]);
    expect(pdpChecksFor('admin', S, WS)).toEqual([{ permission: 'admin_cascade', resourceType: 'workspace', resourceId: WS }]);
  });
});

describe('SpaceGrantCeiling.assertCovers', () => {
  it.each([
    [['reader'], 'reader', true],
    [['reader'], 'writer', false],
    [['writer'], 'writer', true],
    [['writer'], 'admin', false],
    [['admin'], 'admin', true],
    [['reader', 'admin'], 'admin', true], // own reader row + a group's admin row
    [[], 'reader', false],
  ] as const)('local rows %j cover %s: %s (no PDP call either way in local mode)', async (rows, role, covered) => {
    const { ceiling, authz, spy } = mk([...rows]);
    const run = spy.db.transaction().execute((trx) => ceiling.assertCovers(trx, 'local', input(role)));
    if (covered) await expect(run).resolves.toBeUndefined();
    else await expect(run).rejects.toBeInstanceOf(GrantNeedsPdp);
    expect(authz.tryCheckBulk).not.toHaveBeenCalled();
  });

  it('reads the actor own rows AND rows of live groups the actor is in, live rows only, under the caller transaction', async () => {
    const { ceiling, spy } = mk(['admin']);
    await spy.db.transaction().execute((trx) => ceiling.assertCovers(trx, 'local', input('admin')));
    const q = spy.calls.find((c) => /from space_members sm/i.test(c.sql))!;
    expect(q.sql).toMatch(/sm\.deleted_at is null/i);
    expect(q.sql).toMatch(/group_users gu/i);
    expect(q.sql).toMatch(/g\.deleted_at is null/i);
    expect(q.parameters).toEqual([S, 'u-actor', 'u-actor']);
  });

  it('an actor with no shadow user holds no local row (no query) and goes to the PDP', async () => {
    const { ceiling, authz, spy } = mk(['admin']);
    await spy.db.transaction().execute((trx) => ceiling.assertCovers(trx, 'pdp', input('admin', null)));
    expect(spy.calls.some((c) => /from space_members sm/i.test(c.sql))).toBe(false);
    expect(authz.tryCheckBulk).toHaveBeenCalledWith({ principalId: 'ident-actor', subjectType: 'user' }, pdpChecksFor('admin', S, WS));
  });

  it('pdp mode: a full allow passes; any deny is 403 grant_exceeds_actor; a PDP failure is a retryable 503', async () => {
    const allowAll = mk([]);
    await expect(allowAll.spy.db.transaction().execute((t) => allowAll.ceiling.assertCovers(t, 'pdp', input('writer')))).resolves.toBeUndefined();

    const partial = mk([], { tryCheckBulk: jest.fn(async () => [true, false]) }); // edit without share
    const err = await partial.spy.db
      .transaction()
      .execute((t) => partial.ceiling.assertCovers(t, 'pdp', input('writer')))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: 'grant_exceeds_actor' });

    const empty = mk([], { tryCheckBulk: jest.fn(async () => []) });
    await expect(empty.spy.db.transaction().execute((t) => empty.ceiling.assertCovers(t, 'pdp', input('reader')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const down = mk([], { tryCheckBulk: jest.fn(async () => null) });
    await expect(down.spy.db.transaction().execute((t) => down.ceiling.assertCovers(t, 'pdp', input('reader')))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('SpaceGrantCeiling.fence', () => {
  it('settles to the max committed outbox position; anything but confirmed is 503 grant_unconfirmed', async () => {
    const ok = mk([]);
    await expect(ok.ceiling.fence()).resolves.toBeUndefined();
    expect(ok.authz.settleProjection).toHaveBeenCalledTimes(1);
    expect(ok.spy.calls.some((c) => /from authz_outbox/i.test(c.sql))).toBe(true);
    expect(ok.spy.tx).toEqual([]); // read outside any transaction

    const pending = mk([], { settleProjection: jest.fn(async () => ({ status: 'pending', reason: 'timeout' })) });
    jest.spyOn((pending.ceiling as any).logger, 'warn').mockImplementation();
    const err = await pending.ceiling.fence().catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: 'grant_unconfirmed' });
  });
});

describe('withGrantCeiling', () => {
  it('a local decision runs once and never fences', async () => {
    const fence = jest.fn(async () => undefined);
    const attempt = jest.fn(async (mode: string) => mode);
    await expect(withGrantCeiling({ fence }, attempt)).resolves.toBe('local');
    expect(fence).not.toHaveBeenCalled();
    expect(attempt.mock.calls).toEqual([['local']]);
  });

  it('an undecided first attempt fences, THEN runs once more in pdp mode', async () => {
    const order: string[] = [];
    const fence = jest.fn(async () => void order.push('fence'));
    const attempt = jest.fn(async (mode: string) => {
      order.push(mode);
      if (mode === 'local') throw new GrantNeedsPdp();
      return 'done';
    });
    await expect(withGrantCeiling({ fence }, attempt)).resolves.toBe('done');
    expect(order).toEqual(['local', 'fence', 'pdp']);
  });

  it('a fence failure stops before the second attempt; any other error passes through without a fence', async () => {
    const boom = new ServiceUnavailableException('unconfirmed');
    const attempt = jest.fn(async () => {
      throw new GrantNeedsPdp();
    });
    await expect(withGrantCeiling({ fence: async () => Promise.reject(boom) }, attempt)).rejects.toBe(boom);
    expect(attempt).toHaveBeenCalledTimes(1);

    const fence = jest.fn(async () => undefined);
    const other = new ForbiddenException('self_grant');
    await expect(withGrantCeiling({ fence }, async () => Promise.reject(other))).rejects.toBe(other);
    expect(fence).not.toHaveBeenCalled();
  });
});
