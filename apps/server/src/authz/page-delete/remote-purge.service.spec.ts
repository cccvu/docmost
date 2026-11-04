import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';

// PageService's module graph pulls in the collab WebSocket stack (lib0 ESM) that jest cannot parse. Stub it, and the
// live-session revalidator (imported only for the settle-knob cross-check below).
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));
jest.mock('../live-access/live-access.revalidator', () => ({ LiveAccessRevalidator: class {} }));

import { narrowingSettleTimeoutMs } from '../live-access/narrowing-settle.interceptor';
import { pageEtagOpaque } from '../page-write/page-etag';
import { PURGE_CHECK_CHUNK, PURGE_MAX_PASSES, purgeSettleWaitMs, RemotePurgeService } from './remote-purge.service';

/**
 * #636 W6 — the remote purge routine, request-level (mocked PDP and settle; the real-Postgres locking and races are
 * `remote-purge.pg.spec.ts`). What these pin, in order:
 *   1. the order: a pre-check that takes no lock, then BEGIN → SET LOCAL bounds → the subtree locked FOR UPDATE (id
 *      order, workspace-scoped) and re-walked → the ETag → the fence → the decisions → forceDelete(trx) → COMMIT →
 *      jobs → the native `page.deleted` audit;
 *   2. the decision: an affirmative `page#edit` on EVERY locked id (chunked to the platform's cap), plus upstream's
 *      space-admin check, again after the fence;
 *   3. fail closed with nothing changed: a deny (403), an unplaced page (403), a pending/disabled settle or a PDP error
 *      (503, the PDP never asked on a pending settle), an unstable or mismatched subtree (409), busy (503).
 */
const WS = 'ws-1';
const USER = { id: 'user-1' } as never;
const TARGET = {
  id: 'page-a',
  slugId: 'slug-a',
  title: 'Purged',
  spaceId: 'space-1',
  workspaceId: WS,
  parentPageId: null,
  updatedAt: new Date('2026-09-26T10:00:00.123Z'),
  lastUpdatedById: 'user-0',
  deletedAt: new Date('2026-10-01T00:00:00.000Z'),
  content: { type: 'doc', content: [] },
};
const FRESH = pageEtagOpaque(TARGET);

type Opts = {
  /** Each successive subtree walk's ids (the last one repeats). */
  walks?: string[][];
  /** The rows the FOR UPDATE returns (default: every id it asked for). */
  lockable?: (ids: string[]) => string[];
  target?: Record<string, unknown> | null;
  resolved?: { id: string; workspaceId: string; spaceId: string } | null;
  settle?: { status: 'confirmed' } | { status: 'pending'; reason: string };
  /** `page#edit` per id (default all true), or null for a failed call. */
  edit?: ((id: string) => boolean) | null;
  /** Space Manage-Settings per successive CASL call (default all true). */
  admin?: boolean[];
  deleted?: string[];
  lockError?: unknown;
};

const build = (opts: Opts = {}) => {
  const calls: string[] = [];
  const walks = opts.walks ?? [['page-a', 'page-b', 'page-c']];
  let walk = 0;
  const spy = spyKysely((q: SpyQuery) => {
    if (/set local/i.test(q.sql)) {
      calls.push(`sql:${q.sql.replace(/\s+/g, ' ').trim()}`);
      return [];
    }
    if (/with recursive "page_descendants"/i.test(q.sql)) {
      calls.push('walk');
      const ids = walks[Math.min(walk++, walks.length - 1)];
      return ids.map((id) => ({ id }));
    }
    if (/for update/i.test(q.sql)) {
      if (opts.lockError) throw opts.lockError;
      const ids = q.parameters.filter((p) => typeof p === 'string' && p !== WS) as string[];
      calls.push(`lock:${ids.join(',')}`);
      return (opts.lockable ? opts.lockable(ids) : ids).map((id) => ({ id }));
    }
    if (/from "authz_outbox"|from authz_outbox/i.test(q.sql)) {
      calls.push('fence-read');
      return [{ xactId: '900', id: '7' }];
    }
    if (/"content"/.test(q.sql)) {
      calls.push('read-target');
      return opts.target === null ? [] : [{ ...TARGET, ...(opts.target ?? {}) }];
    }
    calls.push(`sql:${q.sql}`);
    return [];
  });
  const pageRepo = {
    findById: jest.fn(async (ref: string) => {
      calls.push(`resolve:${ref}`);
      return opts.resolved === undefined ? { id: 'page-a', workspaceId: WS, spaceId: 'space-1' } : opts.resolved;
    }),
  };
  let casl = 0;
  const spaceAbility = {
    createForUser: jest.fn(async (_u: unknown, spaceId: string) => {
      const allowed = (opts.admin ?? [])[casl++] ?? true;
      calls.push(`casl:${spaceId}:${spy.tx.join('>') || 'no-tx'}`);
      return { can: () => allowed, cannot: () => !allowed };
    }),
  };
  const authz = {
    settleProjection: jest.fn(async (position: string, waitMs: number) => {
      calls.push(`settle:${position}:${waitMs}`);
      return opts.settle ?? { status: 'confirmed' as const };
    }),
    tryCheckBulk: jest.fn(async (subject: unknown, checks: { permission: string; resourceType: string; resourceId: string }[]) => {
      calls.push(`decide:${checks.length}`);
      if (opts.edit === null) return null;
      return checks.map((c) => (opts.edit ? opts.edit(c.resourceId) : true));
    }),
  };
  const pageService = {
    forceDelete: jest.fn(async (id: string, ws: string, trx: unknown) => {
      calls.push(`forceDelete:${id}:${ws}:${trx ? 'trx' : 'no-trx'}`);
      return opts.deleted ?? walks[walks.length - 1];
    }),
  };
  const auditService = { log: jest.fn((p: { event: string }) => void calls.push(`audit:${p.event}:${spy.tx.join('>')}`)) };
  const attachmentQueue = {
    add: jest.fn(async (_n: string, data: { pageId: string }) => void calls.push(`job:${data.pageId}:${spy.tx.join('>')}`)),
  };
  const service = new RemotePurgeService(
    spy.db,
    pageRepo as never,
    pageService as never,
    spaceAbility as never,
    authz as never,
    auditService as never,
    attachmentQueue as never,
  );
  return { service, calls, spy, pageRepo, spaceAbility, authz, pageService, auditService, attachmentQueue };
};

const refusal = async (p: Promise<unknown>): Promise<{ status: number; body: unknown }> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error('expected a refusal');
};

/** Nothing irreversible happened: no delete, no job, no audit, and the transaction (if any) rolled back. */
const nothingChanged = (t: ReturnType<typeof build>, tx: string[] = ['begin', 'rollback']) => {
  expect(t.pageService.forceDelete).not.toHaveBeenCalled();
  expect(t.attachmentQueue.add).not.toHaveBeenCalled();
  expect(t.auditService.log).not.toHaveBeenCalled();
  expect(t.spy.tx).toEqual(tx);
};

describe('RemotePurgeService — the order of the routine', () => {
  it('pre-check → bounds → lock → re-walk → target → fence → space admin → edit on all → forceDelete(trx) → commit → jobs → audit', async () => {
    const t = build();
    await expect(t.service.purge(USER, 'slug-a', WS)).resolves.toMatchObject({
      page: { id: 'page-a' },
      deletedIds: ['page-a', 'page-b', 'page-c'],
    });
    expect(t.calls).toEqual([
      'resolve:slug-a',
      'casl:space-1:no-tx', // the fast refusal takes no lock
      "sql:SET LOCAL lock_timeout = '2s'",
      "sql:SET LOCAL statement_timeout = '15s'",
      'walk',
      'lock:page-a,page-b,page-c',
      'walk',
      'read-target',
      'fence-read',
      'settle:900.7:3000',
      'casl:space-1:begin', // the authoritative check, on the settled PDP
      'decide:3',
      'forceDelete:page-a:ws-1:trx',
      'job:page-a:begin>commit',
      'job:page-b:begin>commit',
      'job:page-c:begin>commit',
      'audit:page.deleted:begin>commit',
    ]);
  });

  it('locks FOR UPDATE (never FOR NO KEY UPDATE), in id order, workspace-scoped; asks edit on every id for the human', async () => {
    const t = build();
    await t.service.purge(USER, 'page-a', WS);
    const lock = t.spy.calls.find((q) => /for update/i.test(q.sql))!;
    expect(lock.sql).not.toMatch(/no key update/i);
    expect(lock.sql).toMatch(/order by "id"/i);
    expect(lock.sql).toMatch(/"workspace_id" = \$\d/);
    const [subject, checks] = t.authz.tryCheckBulk.mock.calls[0];
    expect(subject).toEqual({ provider: 'docmost', externalId: 'user-1' });
    expect(checks).toEqual(['page-a', 'page-b', 'page-c'].map((resourceId) => ({ permission: 'edit', resourceType: 'page', resourceId })));
  });

  it('audits exactly the native handler’s `page.deleted` payload, about the locked target', async () => {
    const t = build();
    await t.service.purge(USER, 'page-a', WS);
    expect(t.auditService.log).toHaveBeenCalledWith({
      event: 'page.deleted',
      resourceType: 'page',
      resourceId: 'page-a',
      spaceId: 'space-1',
      changes: { before: { pageId: 'page-a', slugId: 'slug-a', title: 'Purged', spaceId: 'space-1' } },
    });
  });

  it('a child that appeared while it waited is locked on the next walk, and decided with the rest', async () => {
    const t = build({ walks: [['page-a', 'page-b'], ['page-a', 'page-b', 'page-new']] });
    await t.service.purge(USER, 'page-a', WS);
    expect(t.calls.filter((c) => c.startsWith('lock:') || c === 'walk')).toEqual([
      'walk',
      'lock:page-a,page-b',
      'walk',
      'lock:page-new',
      'walk',
    ]);
    expect(t.authz.tryCheckBulk.mock.calls[0][1].map((c: { resourceId: string }) => c.resourceId)).toEqual([
      'page-a',
      'page-b',
      'page-new',
    ]);
  });

  it('chunks the decision to the platform’s check-bulk cap', async () => {
    const ids = ['page-a', ...Array.from({ length: PURGE_CHECK_CHUNK + 43 }, (_, i) => `p-${String(i).padStart(4, '0')}`)];
    const t = build({ walks: [ids] });
    await t.service.purge(USER, 'page-a', WS);
    expect(t.authz.tryCheckBulk.mock.calls.map((c) => c[1].length)).toEqual([PURGE_CHECK_CHUNK, 44]);
  });

  it('compares the ETag on the locked target: any matching tag (or `*`) passes, before the fence', async () => {
    for (const tags of [[FRESH], ['f'.repeat(64), FRESH], ['*']]) {
      const t = build();
      await expect(t.service.purge(USER, 'page-a', WS, tags)).resolves.toBeDefined();
    }
  });
});

describe('RemotePurgeService — refusals change nothing', () => {
  it('one uneditable descendant → 403 purge_needs_edit', async () => {
    const t = build({ edit: (id) => id !== 'page-c' });
    expect(await refusal(t.service.purge(USER, 'page-a', WS))).toEqual({
      status: 403,
      body: { message: 'a permanent delete needs edit access to every page it removes', code: 'purge_needs_edit' },
    });
    nothingChanged(t);
  });

  it('an unplaced target (the PDP has no edit for it) → 403, never a fallback', async () => {
    const t = build({ edit: (id) => id !== 'page-a' });
    expect((await refusal(t.service.purge(USER, 'page-a', WS))).status).toBe(403);
    nothingChanged(t);
  });

  it.each([
    ['a pending settle', { settle: { status: 'pending' as const, reason: 'timeout' } }],
    ['an unreachable platform', { settle: { status: 'pending' as const, reason: 'settle-unreachable' } }],
  ])('%s → 503 purge_unconfirmed, and the PDP is never asked', async (_l, o) => {
    const t = build(o);
    expect(await refusal(t.service.purge(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'purge_unconfirmed' } });
    expect(t.authz.tryCheckBulk).not.toHaveBeenCalled();
    expect(t.spaceAbility.createForUser).toHaveBeenCalledTimes(1); // only the pre-check
    nothingChanged(t);
  });

  it('a PDP error is a 503, not a deny and never a pass', async () => {
    const t = build({ edit: null });
    expect(await refusal(t.service.purge(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'purge_unconfirmed' } });
    nothingChanged(t);
  });

  it('not a space admin → upstream’s 403 before any lock or settle', async () => {
    const t = build({ admin: [false] });
    expect(await refusal(t.service.purge(USER, 'page-a', WS))).toEqual({
      status: 403,
      body: expect.objectContaining({ message: 'Only space admins can permanently delete pages' }),
    });
    expect(t.authz.settleProjection).not.toHaveBeenCalled();
    nothingChanged(t, []);
  });

  it('space admin lost by the time of the fence (the authoritative re-check) → 403', async () => {
    const t = build({ admin: [true, false] });
    await expect(t.service.purge(USER, 'page-a', WS)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.authz.tryCheckBulk).not.toHaveBeenCalled();
    nothingChanged(t);
  });

  it('missing page, or a page in another workspace → 404 before anything', async () => {
    for (const resolved of [null, { id: 'page-a', workspaceId: 'ws-other', spaceId: 'space-1' }]) {
      const t = build({ resolved });
      await expect(t.service.purge(USER, 'page-a', WS)).rejects.toBeInstanceOf(NotFoundException);
      expect(t.spaceAbility.createForUser).not.toHaveBeenCalled();
      nothingChanged(t, []);
    }
  });

  it('the target gone by the time it is locked → 404', async () => {
    for (const o of [{ walks: [[]] }, { target: null }]) {
      const t = build(o);
      await expect(t.service.purge(USER, 'page-a', WS)).rejects.toBeInstanceOf(NotFoundException);
      nothingChanged(t);
    }
  });

  it('a stale ETag → 412 before the fence', async () => {
    const t = build();
    expect(await refusal(t.service.purge(USER, 'page-a', WS, ['f'.repeat(64)]))).toEqual({
      status: 412,
      body: { message: 'page changed', code: 'precondition_failed' },
    });
    expect(t.authz.settleProjection).not.toHaveBeenCalled();
    nothingChanged(t);
  });

  it(`a subtree still growing after ${PURGE_MAX_PASSES} walks → 409 purge_subtree_changed`, async () => {
    const t = build({ walks: Array.from({ length: 10 }, (_, i) => ['page-a', ...Array.from({ length: i + 1 }, (_, j) => `c-${j}`)]) });
    expect(await refusal(t.service.purge(USER, 'page-a', WS))).toMatchObject({ status: 409, body: { code: 'purge_subtree_changed' } });
    expect(t.calls.filter((c) => c === 'walk')).toHaveLength(PURGE_MAX_PASSES + 1);
    expect(t.authz.settleProjection).not.toHaveBeenCalled();
    nothingChanged(t);
  });

  it('a row the lock could not take (another workspace) never counts as locked → 409', async () => {
    const t = build({ lockable: (ids) => ids.filter((id) => id !== 'page-c') });
    expect((await refusal(t.service.purge(USER, 'page-a', WS))).status).toBe(409);
    nothingChanged(t);
  });

  it('the deleted set is not the locked set → 409 and the delete rolls back (no job, no audit)', async () => {
    for (const deleted of [['page-a', 'page-b'], ['page-a', 'page-b', 'page-c', 'page-x']]) {
      const t = build({ deleted });
      expect(await refusal(t.service.purge(USER, 'page-a', WS))).toMatchObject({ status: 409, body: { code: 'purge_subtree_changed' } });
      expect(t.pageService.forceDelete).toHaveBeenCalled();
      expect(t.attachmentQueue.add).not.toHaveBeenCalled();
      expect(t.auditService.log).not.toHaveBeenCalled();
      expect(t.spy.tx).toEqual(['begin', 'rollback']);
    }
  });

  it.each(['55P03', '40P01', '57014'])('busy SQLSTATE %s → 503 engine_busy, rolled back', async (code) => {
    const t = build({ lockError: Object.assign(new Error('busy'), { code }) });
    expect(await refusal(t.service.purge(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'engine_busy' } });
    nothingChanged(t);
  });

  it('any other driver error passes through (not a 503)', async () => {
    const t = build({ lockError: Object.assign(new Error('boom'), { code: '42P01' }) });
    await expect(t.service.purge(USER, 'page-a', WS)).rejects.toThrow('boom');
    nothingChanged(t);
  });

  it('a failed attachment enqueue after the commit does not turn the committed purge into an error', async () => {
    const t = build();
    t.attachmentQueue.add.mockRejectedValue(new Error('redis down'));
    await expect(t.service.purge(USER, 'page-a', WS)).resolves.toBeDefined();
    expect(t.auditService.log).toHaveBeenCalled();
  });
});

describe('the settle wait', () => {
  const OLD = process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS;
    else process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS = OLD;
  });

  it.each([undefined, '', ' ', '0', '1', '250', '2999', '3000', '4000', '5000', '9999', '-1', 'abc', '12.7', 'Infinity'])(
    'reads AUTHZ_NARROWING_SETTLE_TIMEOUT_MS=%p exactly as the narrowing routes do, capped at 3s',
    (raw) => {
      expect(purgeSettleWaitMs(raw)).toBe(Math.min(narrowingSettleTimeoutMs(raw), 3000));
    },
  );

  it('0 (the narrowing rollback switch) refuses every purge: no fence can be proven', async () => {
    process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS = '0';
    const t = build();
    expect(await refusal(t.service.purge(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'purge_unconfirmed' } });
    expect(t.authz.settleProjection).not.toHaveBeenCalled();
    nothingChanged(t);
  });
});
