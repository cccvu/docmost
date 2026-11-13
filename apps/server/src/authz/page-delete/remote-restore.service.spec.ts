import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';

// The service's module graph can reach the collab WebSocket stack (lib0 ESM) that jest cannot parse. Stub it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { RESTRICTION_STRIP } from '../../service-bridge/page-restriction-guard.installer';
import { PAGE_GUARD_CONFLICTS } from '../../service-bridge/page-guard-conflict.interceptor';
import { RESTORE_MAX_CONCURRENT, RemoteRestoreService } from './remote-restore.service';
import { RESTORE_RESTRICTION_STRIP_MESSAGE } from './page-delete-errors';

/**
 * #556 — the remote restore routine, request-level (mocked PDP and settle; the real-Postgres locking, the batch walk,
 * the g2 rollback and the races are `remote-restore.pg.spec.ts`). What these pin:
 *   1. the order: 404 → upstream's space CASL Edit → upstream's `validateCanEdit` (no lock) → BEGIN → SET LOCAL bounds →
 *      the FULL subtree locked FOR NO KEY UPDATE and re-walked → the target (live → noop) → the batch walk under the
 *      locks → `page#edit` on every batch page (human, then the delegated service account) →
 *      restorePage(trx, {pageIds: batch}) → COMMIT → the native `page.restored` audit → the page read back;
 *   2. a deny is fenced once OUTSIDE the transaction and retried; an allow is never fenced;
 *   3. fail closed with nothing changed: a deny (403), a PDP error or an unconfirmed fence (503), a moving tree or a
 *      busy SQLSTATE (503 engine_busy), a page guard (409, restore wording for g2);
 *   4. the service account only narrows: never asked when the human is denied.
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
  parentPageId: 'page-p',
  updatedAt: new Date('2026-09-26T10:00:00.123Z'),
  lastUpdatedById: 'user-0',
  deletedAt: new Date('2026-10-01T00:00:00.000Z'),
  content: { type: 'doc', content: [] },
};
const ANSWER = { id: 'page-a', slugId: 'slug-a', hasChildren: true };

type Subject = { provider?: string; externalId?: string; principalId?: string; subjectType?: string };
type Opts = {
  /** Each successive FULL subtree walk's ids (the last one repeats). */
  walks?: string[][];
  /** The batch walk's ids (default: page-a and page-b). */
  batch?: string[];
  target?: Record<string, unknown> | null;
  resolved?: { id: string; workspaceId: string; spaceId: string } | null;
  settles?: ({ status: 'confirmed' } | { status: 'pending'; reason: string })[];
  onSettle?: () => void;
  edit?: ((subject: Subject, id: string) => boolean) | null;
  lockError?: unknown;
  restoreError?: unknown;
  canEdit?: boolean;
  spaceEdit?: boolean;
  pdpGate?: Promise<void>;
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
    if (/with recursive batch/i.test(q.sql)) {
      calls.push('walk-batch');
      return (opts.batch ?? ['page-b', 'page-a']).map((id) => ({ id }));
    }
    if (/with recursive "page_descendants"/i.test(q.sql)) {
      calls.push('walk');
      return walks[Math.min(walk++, walks.length - 1)].map((id) => ({ id }));
    }
    if (/for (no key )?update/i.test(q.sql)) {
      if (opts.lockError) throw opts.lockError;
      const ids = q.parameters.filter((p) => typeof p === 'string' && p !== WS) as string[];
      calls.push(`lock:${ids.join(',')}`);
      return ids.map((id) => ({ id, spaceId: 'space-1', workspaceId: WS, parentPageId: null, deletedAt: new Date() }));
    }
    if (/from "authz_outbox"|from authz_outbox/i.test(q.sql)) {
      calls.push(`fence-read:${spy.tx.join('>') || 'no-tx'}`);
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
    findById: jest.fn(async (ref: string, o?: { includeHasChildren?: boolean }) => {
      if (o?.includeHasChildren) {
        calls.push(`read-back:${ref}:${spy.tx.join('>') || 'no-tx'}`);
        return ANSWER;
      }
      calls.push(`resolve:${ref}`);
      return opts.resolved === undefined ? { id: 'page-a', workspaceId: WS, spaceId: 'space-1' } : opts.resolved;
    }),
    restorePage: jest.fn(async (id: string, ws: string, trx: unknown, o: { pageIds: string[] }) => {
      calls.push(`restorePage:${id}:${ws}:${trx ? 'trx' : 'no-trx'}:${o?.pageIds?.join(',')}`);
      if (opts.restoreError) throw opts.restoreError;
      return [...o.pageIds];
    }),
  };
  const spaceAbility = {
    createForUser: jest.fn(async (_u: unknown, spaceId: string) => {
      calls.push(`casl:${spaceId}:${spy.tx.join('>') || 'no-tx'}`);
      const can = opts.spaceEdit !== false;
      return { can: () => can, cannot: () => !can };
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
  const auditService = { log: jest.fn((p: { event: string }) => void calls.push(`audit:${p.event}:${spy.tx.join('>')}`)) };
  const service = new RemoteRestoreService(
    spy.db,
    pageRepo as never,
    spaceAbility as never,
    pageAccessService as never,
    authz as never,
    auditService as never,
  );
  return { service, calls, spy, pageRepo, spaceAbility, pageAccessService, authz, auditService };
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

/** Nothing restored (or rolled back), no audit, nothing read back. */
const nothingChanged = (t: ReturnType<typeof build>, tx: string[] = ['begin', 'rollback']) => {
  expect(t.auditService.log).not.toHaveBeenCalled();
  expect(t.calls.some((c) => c.startsWith('read-back:'))).toBe(false);
  expect(t.spy.tx).toEqual(tx);
};
const decided = (t: ReturnType<typeof build>, who: 'human' | 'sa') => t.calls.filter((c) => c.startsWith(`decide:${who}:`));
const guardError = (constraint: string) => Object.assign(new Error('guard'), { code: '23514', constraint_name: constraint });

describe('RemoteRestoreService — the order of the routine', () => {
  it('404 → CASL → root check → bounds → lock → re-walk → target → batch → edit on batch → restorePage(trx, batch) → commit → audit → read back', async () => {
    const t = build();
    await expect(t.service.restore(USER, 'slug-a', WS)).resolves.toEqual({ outcome: 'applied', page: ANSWER });
    expect(t.calls).toEqual([
      'resolve:slug-a',
      'casl:space-1:no-tx', // upstream's space Edit, before any lock
      'validateCanEdit:no-tx', // upstream's own root check
      "sql:SET LOCAL lock_timeout = '2s'",
      "sql:SET LOCAL statement_timeout = '15s'",
      'walk',
      'lock:page-a,page-b,page-c',
      'walk',
      'read-target',
      'walk-batch',
      'decide:human:page-a,page-b', // the batch, sorted: never the live page-c
      'restorePage:page-a:ws-1:trx:page-a,page-b',
      'audit:page.restored:begin>commit',
      'read-back:page-a:begin>commit',
    ]);
    expect(t.authz.settleProjection).not.toHaveBeenCalled(); // an allow is never fenced
  });

  it('locks FOR NO KEY UPDATE (never FOR UPDATE: the #616 rule), in id order, workspace-scoped; decides page#edit for the human', async () => {
    const t = build();
    await t.service.restore(USER, 'page-a', WS);
    const lock = t.spy.calls.find((q) => /for no key update/i.test(q.sql))!;
    expect(lock).toBeDefined();
    expect(t.spy.calls.some((q) => /for update/i.test(q.sql))).toBe(false);
    expect(lock.sql).toMatch(/order by "id"/i);
    expect(lock.sql).toMatch(/"workspace_id" = \$\d/);
    expect(t.authz.tryCheckBulk.mock.calls[0][0]).toEqual({ provider: 'docmost', externalId: 'user-1' });
    expect(t.authz.tryCheckBulk.mock.calls[0][1]).toEqual(
      ['page-a', 'page-b'].map((resourceId) => ({ permission: 'edit', resourceType: 'page', resourceId })),
    );
  });

  it('the batch walk follows the root’s exact stamp (IS NOT DISTINCT FROM, cycle-safe UNION) and starts only at a trashed root', async () => {
    const t = build();
    await t.service.restore(USER, 'page-a', WS);
    const walk = t.spy.calls.find((q) => /with recursive batch/i.test(q.sql))!.sql.replace(/\s+/g, ' ');
    expect(walk).toMatch(/where id = \$1 and deleted_at is not null/);
    expect(walk).toMatch(/\bunion select\b/);
    expect(walk).not.toMatch(/union all/);
    expect(walk).toMatch(/p\.deleted_at is not distinct from b\.deleted_at/);
    expect(walk).toMatch(/p\.deleted_by_id is not distinct from b\.deleted_by_id/);
  });

  it('audits exactly the native handler’s `page.restored` payload, about the locked target, after the commit', async () => {
    const t = build();
    await t.service.restore(USER, 'page-a', WS);
    expect(t.auditService.log).toHaveBeenCalledTimes(1);
    expect(t.auditService.log).toHaveBeenCalledWith({
      event: 'page.restored',
      resourceType: 'page',
      resourceId: 'page-a',
      spaceId: 'space-1',
      changes: { after: { title: 'Trashed', spaceId: 'space-1' } },
    });
  });

  it('a LIVE target is `noop`: no batch, nothing decided, nothing restored, no audit — and the page is still answered', async () => {
    const t = build({ target: { deletedAt: null } });
    await expect(t.service.restore(USER, 'page-a', WS)).resolves.toEqual({ outcome: 'noop', page: ANSWER });
    expect(t.calls).not.toContain('walk-batch');
    expect(t.authz.tryCheckBulk).not.toHaveBeenCalled();
    expect(t.pageRepo.restorePage).not.toHaveBeenCalled();
    expect(t.auditService.log).not.toHaveBeenCalled();
    expect(t.spy.tx).toEqual(['begin', 'commit']);
  });
});

describe('RemoteRestoreService — a deny is fenced once, outside the transaction', () => {
  it('deny → rollback → settle (read on no transaction) → rerun → allow: restored', async () => {
    let projected = false;
    const t = build({ onSettle: () => (projected = true), edit: (_s, id) => projected || id !== 'page-b' });
    await expect(t.service.restore(USER, 'page-a', WS)).resolves.toMatchObject({ outcome: 'applied' });
    expect(t.spy.tx).toEqual(['begin', 'rollback', 'begin', 'commit']);
    expect(t.calls).toContain('fence-read:begin>rollback');
    expect(t.authz.settleProjection).toHaveBeenCalledTimes(1);
    expect(decided(t, 'human')).toHaveLength(2);
    expect(t.pageRepo.restorePage).toHaveBeenCalledTimes(1);
  });

  it('a deny that persists after the fence → 403 restore_needs_edit, nothing restored (a fixed body: no ids or counts)', async () => {
    const t = build({ edit: (_s, id) => id !== 'page-b' });
    expect(await refusal(t.service.restore(USER, 'page-a', WS))).toEqual({
      status: 403,
      body: {
        message: 'restoring a page needs edit access to it and to every sub-page trashed with it; nothing was restored',
        code: 'restore_needs_edit',
      },
    });
    expect(t.pageRepo.restorePage).not.toHaveBeenCalled();
    nothingChanged(t, ['begin', 'rollback', 'begin', 'rollback']);
  });

  it.each([
    ['a pending settle', 'timeout'],
    ['an unreachable platform', 'settle-unreachable'],
  ])('a deny with %s → 503 restore_unconfirmed, never rerun', async (_l, reason) => {
    const t = build({ edit: (_s, id) => id !== 'page-b', settles: [{ status: 'pending', reason }] });
    expect(await refusal(t.service.restore(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'restore_unconfirmed' } });
    nothingChanged(t);
  });

  it('a deny with the fence switched off (AUTHZ_NARROWING_SETTLE_TIMEOUT_MS=0) → 403, no settle asked', async () => {
    const old = process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS;
    process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS = '0';
    try {
      const t = build({ edit: (_s, id) => id !== 'page-b' });
      expect(await refusal(t.service.restore(USER, 'page-a', WS))).toMatchObject({ status: 403, body: { code: 'restore_needs_edit' } });
      expect(t.authz.settleProjection).not.toHaveBeenCalled();
      nothingChanged(t);
    } finally {
      if (old === undefined) delete process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS;
      else process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS = old;
    }
  });

  it('a PDP failure is a 503 restore_unconfirmed — never a 403, never fenced, never a pass', async () => {
    const t = build({ edit: null });
    expect(await refusal(t.service.restore(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'restore_unconfirmed' } });
    expect(t.authz.settleProjection).not.toHaveBeenCalled();
    nothingChanged(t);
  });
});

describe('RemoteRestoreService — refusals change nothing', () => {
  it('missing page, or a page in another workspace → 404 before anything', async () => {
    for (const resolved of [null, { id: 'page-a', workspaceId: 'ws-other', spaceId: 'space-1' }]) {
      const t = build({ resolved });
      await expect(t.service.restore(USER, 'page-a', WS)).rejects.toBeInstanceOf(NotFoundException);
      expect(t.spaceAbility.createForUser).not.toHaveBeenCalled();
      nothingChanged(t, []);
    }
  });

  it('upstream’s space CASL Edit refuses → 403 before the root check and any transaction', async () => {
    const t = build({ spaceEdit: false });
    await expect(t.service.restore(USER, 'page-a', WS)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    nothingChanged(t, []);
  });

  it('upstream’s root check refuses → 403 before any transaction', async () => {
    const t = build({ canEdit: false });
    await expect(t.service.restore(USER, 'page-a', WS)).rejects.toBeInstanceOf(ForbiddenException);
    nothingChanged(t, []);
  });

  it('the target gone by the time it is locked → 404', async () => {
    for (const o of [{ walks: [[]] }, { target: null }]) {
      const t = build(o);
      await expect(t.service.restore(USER, 'page-a', WS)).rejects.toBeInstanceOf(NotFoundException);
      nothingChanged(t);
    }
  });

  it('a batch page outside the locked set → 503 engine_busy, nothing asked', async () => {
    const t = build({ batch: ['page-a', 'page-new'] });
    expect(await refusal(t.service.restore(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'engine_busy' } });
    expect(t.authz.tryCheckBulk).not.toHaveBeenCalled();
    nothingChanged(t);
  });

  it('a subtree still growing after 3 walks → 503 engine_busy', async () => {
    const t = build({ walks: Array.from({ length: 10 }, (_, i) => ['page-a', ...Array.from({ length: i + 1 }, (_, j) => `c-${j}`)]) });
    expect(await refusal(t.service.restore(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'engine_busy' } });
    nothingChanged(t);
  });

  it.each(['55P03', '40P01', '57014'])('busy SQLSTATE %s → 503 engine_busy, rolled back (on the lock and inside the write)', async (code) => {
    for (const o of [{ lockError: Object.assign(new Error('busy'), { code }) }, { restoreError: Object.assign(new Error('busy'), { code }) }]) {
      const t = build(o);
      expect(await refusal(t.service.restore(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'engine_busy' } });
      nothingChanged(t);
    }
  });

  it('the g2 guard refusing the detach → 409 with the guard’s code and the RESTORE wording; rolled back, no audit', async () => {
    const t = build({ restoreError: guardError(RESTRICTION_STRIP) });
    expect(await refusal(t.service.restore(USER, 'page-a', WS))).toEqual({
      status: 409,
      body: { message: RESTORE_RESTRICTION_STRIP_MESSAGE, code: RESTRICTION_STRIP },
    });
    expect(RESTORE_RESTRICTION_STRIP_MESSAGE).not.toBe(PAGE_GUARD_CONFLICTS[RESTRICTION_STRIP]);
    nothingChanged(t);
  });

  it('any other page guard keeps the shared mapping (code and text); a non-guard 23514 passes through', async () => {
    const t = build({ restoreError: guardError('ccc_page_no_cycle') });
    const r = await refusal(t.service.restore(USER, 'page-a', WS));
    expect(r).toEqual({ status: 409, body: { message: PAGE_GUARD_CONFLICTS.ccc_page_no_cycle, code: 'ccc_page_no_cycle' } });
    const other = build({ restoreError: guardError('some_other_check') });
    await expect(other.service.restore(USER, 'page-a', WS)).rejects.not.toBeInstanceOf(ConflictException);
    nothingChanged(other);
  });

  it('any other driver error passes through (not a 503)', async () => {
    const t = build({ lockError: Object.assign(new Error('boom'), { code: '42P01' }) });
    await expect(t.service.restore(USER, 'page-a', WS)).rejects.toThrow('boom');
    nothingChanged(t);
  });
});

describe('RemoteRestoreService — a slot per attempt', () => {
  const slotsInUse = (t: ReturnType<typeof build>) => (t.service as unknown as { slots: { inUse: number } }).slots.inUse;

  it(`at most ${RESTORE_MAX_CONCURRENT} attempts in flight: one more waits, then 503 engine_busy with no transaction opened`, async () => {
    let open!: () => void;
    const t = build({ pdpGate: new Promise<void>((r) => (open = r)) });
    const held = Array.from({ length: RESTORE_MAX_CONCURRENT }, () => t.service.restore(USER, 'page-a', WS));
    await new Promise((r) => setImmediate(r));
    expect(slotsInUse(t)).toBe(RESTORE_MAX_CONCURRENT);
    const begun = t.spy.tx.filter((x) => x === 'begin').length;
    expect(await refusal(t.service.restore(USER, 'page-a', WS))).toMatchObject({ status: 503, body: { code: 'engine_busy' } });
    expect(t.spy.tx.filter((x) => x === 'begin').length).toBe(begun);
    open();
    expect((await Promise.all(held)).map((r) => r.outcome)).toEqual(Array(RESTORE_MAX_CONCURRENT).fill('applied'));
    expect(slotsInUse(t)).toBe(0);
  }, 10_000);

  it('the settle between the two attempts holds no slot; every slot is freed after a 403', async () => {
    const seen: string[] = [];
    const t = build();
    t.authz.tryCheckBulk.mockImplementation(async (_s: Subject, checks: { resourceId: string }[]) => {
      seen.push(`decide:${slotsInUse(t)}`);
      return checks.map(() => false);
    });
    t.authz.settleProjection.mockImplementation(async () => {
      seen.push(`settle:${slotsInUse(t)}`);
      return { status: 'confirmed' as const };
    });
    expect(await refusal(t.service.restore(USER, 'page-a', WS))).toMatchObject({ status: 403 });
    expect(seen).toEqual(['decide:1', 'settle:0', 'decide:1']);
    expect(slotsInUse(t)).toBe(0);
  });
});

describe('RemoteRestoreService — the delegated service account only narrows', () => {
  const isSa = (s: Subject) => s.subjectType === 'service';

  it('absent → no service-account check at all', async () => {
    const t = build();
    await t.service.restore(USER, 'page-a', WS);
    expect(decided(t, 'sa')).toEqual([]);
  });

  it('present and allowed → asked AFTER the human, on the same batch, as a service subject; restored', async () => {
    const t = build();
    await expect(t.service.restore(USER, 'page-a', WS, SA)).resolves.toMatchObject({ outcome: 'applied' });
    expect(t.calls.filter((c) => c.startsWith('decide:'))).toEqual(['decide:human:page-a,page-b', 'decide:sa:page-a,page-b']);
    expect(t.authz.tryCheckBulk.mock.calls[1][0]).toEqual({ principalId: SA, subjectType: 'service' });
  });

  it('the service account cannot edit one batch page → fenced, then 403; nothing restored', async () => {
    const t = build({ edit: (s, id) => !isSa(s) || id === 'page-a' });
    expect(await refusal(t.service.restore(USER, 'page-a', WS, SA))).toMatchObject({ status: 403, body: { code: 'restore_needs_edit' } });
    expect(t.pageRepo.restorePage).not.toHaveBeenCalled();
    nothingChanged(t, ['begin', 'rollback', 'begin', 'rollback']);
  });

  it('anti-bypass: the human is denied and the service account can edit everything → 403, the account is NEVER asked', async () => {
    const t = build({ edit: (s, id) => isSa(s) || id !== 'page-b' });
    expect((await refusal(t.service.restore(USER, 'page-a', WS, SA))).status).toBe(403);
    expect(decided(t, 'sa')).toEqual([]);
    nothingChanged(t, ['begin', 'rollback', 'begin', 'rollback']);
  });

  it('a PDP failure on the service leg → 503 restore_unconfirmed', async () => {
    const t = build();
    t.authz.tryCheckBulk.mockImplementation(async (s: Subject, checks: unknown[]) => (isSa(s) ? null : checks.map(() => true)));
    expect(await refusal(t.service.restore(USER, 'page-a', WS, SA))).toMatchObject({ status: 503, body: { code: 'restore_unconfirmed' } });
    nothingChanged(t);
  });
});
