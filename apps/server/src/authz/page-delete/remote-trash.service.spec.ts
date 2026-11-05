import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';

// PageService's module graph pulls in the collab WebSocket stack (lib0 ESM) that jest cannot parse. Stub it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { pageEtagOpaque } from '../page-write/page-etag';
import { RemoteTrashService, TRASH_MAX_CONCURRENT } from './remote-trash.service';

/**
 * #661 / #634 / #670 — the remote trash routine, request-level (mocked PDP and settle; the real-Postgres locking and
 * races are `remote-trash.pg.spec.ts`). What these pin:
 *   1. the order: upstream's root check (no lock) → BEGIN → SET LOCAL bounds → the FULL subtree locked FOR NO KEY
 *      UPDATE and re-walked → the target (trashed → noop) → the ETag → the LIVE walk under the locks → `page#edit` on
 *      every live page (human, then the delegated service account) → removePage(trx, {pageIds: live}) → COMMIT → the
 *      native `page.trashed` audit;
 *   2. a deny is fenced once OUTSIDE the transaction and retried; an allow is never fenced;
 *   3. fail closed with nothing changed: a deny (403), a PDP error or an unconfirmed fence (503), a tree that moved
 *      (409), busy (503);
 *   4. the service account only narrows: never asked when the human is denied, never turns a deny into an allow.
 */
const WS = 'ws-1';
const USER = { id: 'user-1' } as never;
const SA = '0198c2a1-0000-7000-8000-00000000005a';
const TARGET = {
  id: 'page-a',
  slugId: 'slug-a',
  title: 'Trashed',
  spaceId: 'space-1',
  workspaceId: WS,
  parentPageId: null,
  updatedAt: new Date('2026-09-26T10:00:00.123Z'),
  lastUpdatedById: 'user-0',
  deletedAt: null,
  content: { type: 'doc', content: [] },
};
const FRESH = pageEtagOpaque(TARGET);

type Subject = { provider?: string; externalId?: string; principalId?: string; subjectType?: string };
type Opts = {
  /** Each successive FULL subtree walk's ids (the last one repeats). */
  walks?: string[][];
  /** The live walk's ids (default: the last full walk minus `trashed`). */
  live?: string[];
  /** Pages already in the trash (their locked rows carry deletedAt). */
  trashed?: string[];
  target?: Record<string, unknown> | null;
  resolved?: { id: string; workspaceId: string; spaceId: string } | null;
  /** The settle answers, in order (default confirmed). */
  settles?: ({ status: 'confirmed' } | { status: 'pending'; reason: string })[];
  /** Runs when the platform is asked to settle (the relay catches up). */
  onSettle?: () => void;
  /** `page#edit` per (subject, page) (default all true), or null for a failed call. */
  edit?: ((subject: Subject, id: string) => boolean) | null;
  /** The ids removePage reports it trashed (default: the ids it was given). */
  trashedNow?: string[];
  lockError?: unknown;
  canEdit?: boolean;
  /** Awaited inside every PDP call (the decision holds its transaction, locks and slot until it resolves). */
  pdpGate?: Promise<void>;
};

const build = (opts: Opts = {}) => {
  const calls: string[] = [];
  const walks = opts.walks ?? [['page-a', 'page-b', 'page-c']];
  const trashed = new Set(opts.trashed ?? []);
  let walk = 0;
  const lastWalk = () => walks[Math.min(walk, walks.length) - 1] ?? walks[0];
  const spy = spyKysely((q: SpyQuery) => {
    const where = spy.tx.join('>') || 'no-tx';
    if (/set local/i.test(q.sql)) {
      calls.push(`sql:${q.sql.replace(/\s+/g, ' ').trim()}`);
      return [];
    }
    if (/with recursive "page_descendants"/i.test(q.sql) && /"deleted_at" is null/i.test(q.sql)) {
      calls.push('walk-live');
      const ids = opts.live ?? lastWalk().filter((id) => !trashed.has(id));
      return ids.map((id) => ({ id }));
    }
    if (/with recursive "page_descendants"/i.test(q.sql)) {
      calls.push('walk');
      const ids = walks[Math.min(walk++, walks.length - 1)];
      return ids.map((id) => ({ id }));
    }
    if (/for (no key )?update/i.test(q.sql)) {
      if (opts.lockError) throw opts.lockError;
      const ids = q.parameters.filter((p) => typeof p === 'string' && p !== WS) as string[];
      calls.push(`lock:${ids.join(',')}`);
      return ids.map((id) => ({
        id,
        spaceId: 'space-1',
        workspaceId: WS,
        parentPageId: null,
        deletedAt: trashed.has(id) ? new Date() : null,
      }));
    }
    if (/from "authz_outbox"|from authz_outbox/i.test(q.sql)) {
      calls.push(`fence-read:${where}`);
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
  const pageAccessService = {
    validateCanEdit: jest.fn(async () => {
      calls.push(`validateCanEdit:${spy.tx.join('>') || 'no-tx'}`);
      if (opts.canEdit === false) throw new ForbiddenException();
      return { hasRestriction: false };
    }),
  };
  let settleN = 0;
  const authz = {
    settleProjection: jest.fn(async (position: string, waitMs: number) => {
      calls.push(`settle:${position}:${waitMs}`);
      opts.onSettle?.();
      const answers = opts.settles ?? [{ status: 'confirmed' as const }];
      return answers[Math.min(settleN++, answers.length - 1)];
    }),
    tryCheckBulk: jest.fn(async (subject: Subject, checks: { permission: string; resourceType: string; resourceId: string }[]) => {
      const who = subject.subjectType === 'service' ? 'sa' : 'human';
      calls.push(`decide:${who}:${checks.map((c) => c.resourceId).join(',')}`);
      if (opts.pdpGate) await opts.pdpGate;
      if (opts.edit === null) return null;
      return checks.map((c) => (opts.edit ? opts.edit(subject, c.resourceId) : true));
    }),
  };
  const pageService = {
    removePage: jest.fn(async (id: string, userId: string, ws: string, trx: unknown, o: { pageIds: string[] }) => {
      calls.push(`removePage:${id}:${userId}:${ws}:${trx ? 'trx' : 'no-trx'}:${o?.pageIds?.join(',')}`);
      return opts.trashedNow ?? [...o.pageIds];
    }),
  };
  const auditService = { log: jest.fn((p: { event: string }) => void calls.push(`audit:${p.event}:${spy.tx.join('>')}`)) };
  const service = new RemoteTrashService(
    spy.db,
    pageRepo as never,
    pageService as never,
    pageAccessService as never,
    authz as never,
    auditService as never,
  );
  return { service, calls, spy, pageRepo, pageAccessService, authz, pageService, auditService };
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

/** Nothing trashed, no audit, and every transaction rolled back. */
const nothingChanged = (t: ReturnType<typeof build>, tx: string[] = ['begin', 'rollback']) => {
  expect(t.pageService.removePage).not.toHaveBeenCalled();
  expect(t.auditService.log).not.toHaveBeenCalled();
  expect(t.spy.tx).toEqual(tx);
};
const decided = (t: ReturnType<typeof build>, who: 'human' | 'sa') =>
  t.calls.filter((c) => c.startsWith(`decide:${who}:`));

describe('RemoteTrashService — the order of the routine', () => {
  it('root check → bounds → lock → re-walk → target → live walk → edit on live → removePage(trx, live) → commit → audit', async () => {
    const t = build();
    await expect(t.service.trash(USER, 'slug-a', WS)).resolves.toMatchObject({ outcome: 'applied', page: { id: 'page-a' } });
    expect(t.calls).toEqual([
      'resolve:slug-a',
      'validateCanEdit:no-tx', // upstream's own root check, a fast refusal that takes no lock
      "sql:SET LOCAL lock_timeout = '2s'",
      "sql:SET LOCAL statement_timeout = '15s'",
      'walk',
      'lock:page-a,page-b,page-c',
      'walk',
      'read-target',
      'walk-live',
      'decide:human:page-a,page-b,page-c',
      'removePage:page-a:user-1:ws-1:trx:page-a,page-b,page-c',
      'audit:page.trashed:begin>commit',
    ]);
    expect(t.authz.settleProjection).not.toHaveBeenCalled(); // an allow is never fenced
  });

  it('locks FOR NO KEY UPDATE (never FOR UPDATE: the #616 rule), in id order, workspace-scoped', async () => {
    const t = build();
    await t.service.trash(USER, 'page-a', WS);
    const lock = t.spy.calls.find((q) => /for no key update/i.test(q.sql))!;
    expect(lock).toBeDefined();
    expect(t.spy.calls.some((q) => /for update/i.test(q.sql))).toBe(false);
    expect(lock.sql).toMatch(/order by "id"/i);
    expect(lock.sql).toMatch(/"workspace_id" = \$\d/);
    expect(t.authz.tryCheckBulk.mock.calls[0][0]).toEqual({ provider: 'docmost', externalId: 'user-1' });
    expect(t.authz.tryCheckBulk.mock.calls[0][1]).toEqual(
      ['page-a', 'page-b', 'page-c'].map((resourceId) => ({ permission: 'edit', resourceType: 'page', resourceId })),
    );
  });

  it('decides and trashes exactly the LIVE set: a descendant already in the trash is locked but never asked or re-trashed', async () => {
    const t = build({ walks: [['page-a', 'page-b', 'page-c', 'page-d']], trashed: ['page-d'] });
    await t.service.trash(USER, 'page-a', WS);
    expect(decided(t, 'human')).toEqual(['decide:human:page-a,page-b,page-c']);
    expect(t.pageService.removePage.mock.calls[0][4]).toEqual({ pageIds: ['page-a', 'page-b', 'page-c'] });
  });

  it('audits exactly the native handler’s `page.trashed` payload, about the locked target, after the commit', async () => {
    const t = build();
    await t.service.trash(USER, 'page-a', WS);
    expect(t.auditService.log).toHaveBeenCalledTimes(1);
    expect(t.auditService.log).toHaveBeenCalledWith({
      event: 'page.trashed',
      resourceType: 'page',
      resourceId: 'page-a',
      spaceId: 'space-1',
      changes: { before: { pageId: 'page-a', slugId: 'slug-a', title: 'Trashed', spaceId: 'space-1' } },
    });
  });

  it('an already-trashed target is `noop`: nothing decided, nothing trashed, no audit (whatever the tag)', async () => {
    for (const tags of [undefined, ['f'.repeat(64)]]) {
      const t = build({ target: { deletedAt: new Date() } });
      await expect(t.service.trash(USER, 'page-a', WS, tags)).resolves.toMatchObject({ outcome: 'noop' });
      expect(t.authz.tryCheckBulk).not.toHaveBeenCalled();
      expect(t.pageService.removePage).not.toHaveBeenCalled();
      expect(t.auditService.log).not.toHaveBeenCalled();
      expect(t.spy.tx).toEqual(['begin', 'commit']);
    }
  });

  it('compares the ETag on the locked target: any matching tag (or `*`) passes; a stale one → 412 before any decision', async () => {
    for (const tags of [[FRESH], ['f'.repeat(64), FRESH], ['*']]) {
      const t = build();
      await expect(t.service.trash(USER, 'page-a', WS, tags)).resolves.toMatchObject({ outcome: 'applied' });
    }
    const t = build();
    expect(await refusal(t.service.trash(USER, 'page-a', WS, ['f'.repeat(64)]))).toEqual({
      status: 412,
      body: { message: 'page changed', code: 'precondition_failed' },
    });
    expect(t.authz.tryCheckBulk).not.toHaveBeenCalled();
    nothingChanged(t);
  });
});

describe('RemoteTrashService — a deny is fenced once, outside the transaction', () => {
  it('deny → rollback → settle (read on no transaction) → rerun → allow: trashed', async () => {
    let projected = false;
    const t = build({ onSettle: () => (projected = true), edit: (_s, id) => projected || id !== 'page-c' });
    await expect(t.service.trash(USER, 'page-a', WS)).resolves.toMatchObject({ outcome: 'applied' });
    expect(t.spy.tx).toEqual(['begin', 'rollback', 'begin', 'commit']);
    expect(t.calls).toContain('fence-read:begin>rollback'); // after the rollback, before the second BEGIN
    expect(t.calls.indexOf('fence-read:begin>rollback')).toBeLessThan(t.calls.lastIndexOf("sql:SET LOCAL lock_timeout = '2s'"));
    expect(t.authz.settleProjection).toHaveBeenCalledTimes(1);
    expect(decided(t, 'human')).toHaveLength(2);
    expect(t.pageService.removePage).toHaveBeenCalledTimes(1);
  });

  it('a deny that persists after the fence → 403 trash_needs_edit, nothing trashed (no ids or counts in the body)', async () => {
    const t = build({ edit: (_s, id) => id !== 'page-c' });
    expect(await refusal(t.service.trash(USER, 'page-a', WS))).toEqual({
      status: 403,
      body: {
        message: 'moving a page to the trash needs edit access to it and to every sub-page it moves',
        code: 'trash_needs_edit',
      },
    });
    expect(t.authz.settleProjection).toHaveBeenCalledTimes(1);
    nothingChanged(t, ['begin', 'rollback', 'begin', 'rollback']);
  });

  it.each([
    ['a pending settle', 'timeout'],
    ['an unreachable platform', 'settle-unreachable'],
  ])('a deny with %s → 503 trash_unconfirmed, never rerun', async (_l, reason) => {
    const t = build({ edit: (_s, id) => id !== 'page-c', settles: [{ status: 'pending', reason }] });
    expect(await refusal(t.service.trash(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'trash_unconfirmed' } });
    nothingChanged(t);
  });

  it('a deny with the fence switched off (AUTHZ_NARROWING_SETTLE_TIMEOUT_MS=0) → 403, no settle asked', async () => {
    const old = process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS;
    process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS = '0';
    try {
      const t = build({ edit: (_s, id) => id !== 'page-c' });
      expect(await refusal(t.service.trash(USER, 'page-a', WS))).toMatchObject({ status: 403, body: { code: 'trash_needs_edit' } });
      expect(t.authz.settleProjection).not.toHaveBeenCalled();
      nothingChanged(t);
    } finally {
      if (old === undefined) delete process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS;
      else process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS = old;
    }
  });

  it('a PDP failure is a 503 trash_unconfirmed — never a 403, never fenced, never a pass', async () => {
    const t = build({ edit: null });
    expect(await refusal(t.service.trash(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'trash_unconfirmed' } });
    expect(t.authz.settleProjection).not.toHaveBeenCalled();
    nothingChanged(t);
  });
});

describe('RemoteTrashService — refusals change nothing', () => {
  it('upstream’s root check refuses → 403 before any transaction', async () => {
    const t = build({ canEdit: false });
    await expect(t.service.trash(USER, 'page-a', WS)).rejects.toBeInstanceOf(ForbiddenException);
    nothingChanged(t, []);
  });

  it('missing page, or a page in another workspace → 404 before anything', async () => {
    for (const resolved of [null, { id: 'page-a', workspaceId: 'ws-other', spaceId: 'space-1' }]) {
      const t = build({ resolved });
      await expect(t.service.trash(USER, 'page-a', WS)).rejects.toBeInstanceOf(NotFoundException);
      expect(t.pageAccessService.validateCanEdit).not.toHaveBeenCalled();
      nothingChanged(t, []);
    }
  });

  it('the target gone by the time it is locked → 404', async () => {
    for (const o of [{ walks: [[]] }, { target: null }]) {
      const t = build(o);
      await expect(t.service.trash(USER, 'page-a', WS)).rejects.toBeInstanceOf(NotFoundException);
      nothingChanged(t);
    }
  });

  it('a live page outside the locked set (a child committed after the last walk) → 409 trash_subtree_changed, nothing asked', async () => {
    const t = build({ live: ['page-a', 'page-b', 'page-c', 'page-new'] });
    expect(await refusal(t.service.trash(USER, 'page-a', WS))).toMatchObject({ status: 409, body: { code: 'trash_subtree_changed' } });
    expect(t.authz.tryCheckBulk).not.toHaveBeenCalled();
    nothingChanged(t);
  });

  it('a subtree still growing after 3 walks → 409 trash_subtree_changed', async () => {
    const t = build({ walks: Array.from({ length: 10 }, (_, i) => ['page-a', ...Array.from({ length: i + 1 }, (_, j) => `c-${j}`)]) });
    expect(await refusal(t.service.trash(USER, 'page-a', WS))).toMatchObject({ status: 409, body: { code: 'trash_subtree_changed' } });
    nothingChanged(t);
  });

  it('the trashed set is not the decided set → 409 and rolled back (no audit)', async () => {
    for (const trashedNow of [['page-a', 'page-b'], ['page-a', 'page-b', 'page-c', 'page-x']]) {
      const t = build({ trashedNow });
      expect(await refusal(t.service.trash(USER, 'page-a', WS))).toMatchObject({ status: 409, body: { code: 'trash_subtree_changed' } });
      expect(t.auditService.log).not.toHaveBeenCalled();
      expect(t.spy.tx).toEqual(['begin', 'rollback']);
    }
  });

  it.each(['55P03', '40P01', '57014'])('busy SQLSTATE %s → 503 engine_busy, rolled back', async (code) => {
    const t = build({ lockError: Object.assign(new Error('busy'), { code }) });
    expect(await refusal(t.service.trash(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'engine_busy' } });
    nothingChanged(t);
  });

  it('any other driver error passes through (not a 503)', async () => {
    const t = build({ lockError: Object.assign(new Error('boom'), { code: '42P01' }) });
    await expect(t.service.trash(USER, 'page-a', WS)).rejects.toThrow('boom');
    nothingChanged(t);
  });
});

describe('RemoteTrashService — a slot per attempt (each holds a pooled connection and row locks across its PDP calls)', () => {
  const slotsInUse = (t: ReturnType<typeof build>) => (t.service as unknown as { slots: { inUse: number } }).slots.inUse;

  it(`at most ${TRASH_MAX_CONCURRENT} attempts in flight: one more waits, then 503 engine_busy with no transaction opened`, async () => {
    let open!: () => void;
    const t = build({ pdpGate: new Promise<void>((r) => (open = r)) });
    const held = Array.from({ length: TRASH_MAX_CONCURRENT }, () => t.service.trash(USER, 'page-a', WS));
    await new Promise((r) => setImmediate(r));
    expect(slotsInUse(t)).toBe(TRASH_MAX_CONCURRENT);
    const begun = t.spy.tx.filter((x) => x === 'begin').length;

    expect(await refusal(t.service.trash(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'engine_busy' } });
    expect(t.spy.tx.filter((x) => x === 'begin').length).toBe(begun); // the refused trash never began a transaction

    open();
    expect((await Promise.all(held)).map((r) => r.outcome)).toEqual(Array(TRASH_MAX_CONCURRENT).fill('applied'));
    expect(slotsInUse(t)).toBe(0);
  }, 10_000);

  it('the settle between the two attempts holds no slot; each attempt holds one; every slot is freed after a 403', async () => {
    const seen: string[] = [];
    const t = build({ edit: () => false });
    t.authz.tryCheckBulk.mockImplementation(async (_s: Subject, checks: { resourceId: string }[]) => {
      seen.push(`decide:${slotsInUse(t)}`);
      return checks.map(() => false);
    });
    t.authz.settleProjection.mockImplementation(async () => {
      seen.push(`settle:${slotsInUse(t)}`);
      return { status: 'confirmed' as const };
    });
    expect(await refusal(t.service.trash(USER, 'page-a', WS))).toMatchObject({ status: 403 });
    expect(seen).toEqual(['decide:1', 'settle:0', 'decide:1']);
    expect(slotsInUse(t)).toBe(0);
  });
});

describe('RemoteTrashService — the delegated service account only narrows (#670, #634)', () => {
  const isSa = (s: Subject) => s.subjectType === 'service';

  it('absent → no service-account check at all', async () => {
    const t = build();
    await t.service.trash(USER, 'page-a', WS);
    expect(decided(t, 'sa')).toEqual([]);
  });

  it('present and allowed → asked AFTER the human, on the same live set, as a service subject; trashed', async () => {
    const t = build();
    await expect(t.service.trash(USER, 'page-a', WS, undefined, SA)).resolves.toMatchObject({ outcome: 'applied' });
    expect(t.calls.filter((c) => c.startsWith('decide:'))).toEqual([
      'decide:human:page-a,page-b,page-c',
      'decide:sa:page-a,page-b,page-c',
    ]);
    expect(t.authz.tryCheckBulk.mock.calls[1][0]).toEqual({ principalId: SA, subjectType: 'service' });
  });

  it('the service account cannot edit one sub-page (#634: a page-bound account does not reach a child) → fenced, then 403', async () => {
    const t = build({ edit: (s, id) => !isSa(s) || id === 'page-a' });
    expect(await refusal(t.service.trash(USER, 'page-a', WS, undefined, SA))).toMatchObject({ status: 403, body: { code: 'trash_needs_edit' } });
    nothingChanged(t, ['begin', 'rollback', 'begin', 'rollback']);
  });

  it('an unknown service account (no relations: the PDP denies everything) → 403', async () => {
    const t = build({ edit: (s) => !isSa(s) });
    expect((await refusal(t.service.trash(USER, 'page-a', WS, undefined, SA))).status).toBe(403);
    nothingChanged(t, ['begin', 'rollback', 'begin', 'rollback']);
  });

  it('a PDP failure on the service leg → 503, nothing trashed', async () => {
    const t = build();
    t.authz.tryCheckBulk.mockImplementation(async (s: Subject, checks: unknown[]) => (isSa(s) ? null : checks.map(() => true)));
    expect(await refusal(t.service.trash(USER, 'page-a', WS, undefined, SA))).toMatchObject({ status: 503, body: { code: 'trash_unconfirmed' } });
    nothingChanged(t);
  });

  it('anti-bypass: the human is denied and the service account can edit everything → 403, and the account is NEVER asked', async () => {
    const t = build({ edit: (s, id) => isSa(s) || id !== 'page-b' });
    expect((await refusal(t.service.trash(USER, 'page-a', WS, undefined, SA))).status).toBe(403);
    expect(decided(t, 'sa')).toEqual([]); // not on the first attempt, not on the fenced retry
    nothingChanged(t, ['begin', 'rollback', 'begin', 'rollback']);
  });

  it('the matrix: outcome = human ∧ service, for every header state', async () => {
    const cases: [string, boolean, string | undefined, boolean, string][] = [
      ['human allow, header absent', true, undefined, true, 'applied'],
      ['human allow, SA allowed', true, SA, true, 'applied'],
      ['human allow, SA denied', true, SA, false, '403'],
      ['human deny, header absent', false, undefined, true, '403'],
      ['human deny, SA allowed', false, SA, true, '403'],
      ['human deny, SA denied', false, SA, false, '403'],
    ];
    for (const [label, human, sa, saAllowed, expected] of cases) {
      const t = build({ edit: (s) => (isSa(s) ? saAllowed : human) });
      const got = await t.service.trash(USER, 'page-a', WS, undefined, sa).then(
        (r) => r.outcome,
        (e) => String((e as HttpException).getStatus()),
      );
      expect([label, got]).toEqual([label, expected]);
      if (!human) expect([label, decided(t, 'sa')]).toEqual([label, []]);
    }
  });
});
