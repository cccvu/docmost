import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';

// PageService's module graph pulls in the collab WebSocket stack (lib0 ESM) that jest cannot parse. Stub it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import {
  ConditionalDeletePageDto,
  ConditionalMovePageDto,
  ConditionalMovePageToSpaceDto,
  ConditionalPageOpsController,
  ConditionalUpdatePageMetaDto,
  metadataConverged,
  toEngineBusy,
} from './conditional-page-ops.controller';
import { OpSemaphore } from './op-semaphore';
import { pageEtagOpaque } from './page-etag';

/**
 * #616 — atomic compare-and-write page operations, the request-level contract. What these pin, in order:
 *   1. a refused precondition changes NOTHING (no upstream write, the transaction rolls back, no audit, no job);
 *   2. the fork re-decides authorization itself with the NATIVE preambles, before convergence or the compare;
 *   3. convergence (a write that already happened) answers `noop` whatever the tag — never for a permanent delete;
 *   4. the upstream call gets the transaction, the lock is FOR NO KEY UPDATE under SET LOCAL timeouts, and side
 *      effects that cannot roll back (audit, attachment-deletion jobs) happen only after the commit;
 *   5. busy SQLSTATEs and a full semaphore are a retryable 503 `engine_busy`; everything else passes through.
 */
const WS = { id: 'ws-1' } as never;
const USER = { id: 'user-1' } as never;
const ROW = {
  id: 'page-uuid-1',
  slugId: 'slug-1',
  title: 'Current title',
  icon: null,
  coverPhoto: null,
  position: 'a0000',
  parentPageId: null as string | null,
  creatorId: 'user-0',
  lastUpdatedById: 'user-0',
  spaceId: 'space-1',
  workspaceId: 'ws-1',
  isLocked: false,
  isBase: false,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-26T10:00:00.123Z'),
  deletedAt: null as Date | null,
  contributorIds: ['user-0'],
  content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
};
const FRESH = pageEtagOpaque(ROW);
const STALE = 'f'.repeat(64);

type Row = typeof ROW;

const build = (opts: {
  row?: Partial<Row> | null;
  resolved?: unknown;
  canEdit?: 'ok' | 'deny';
  can?: (action: string, subject: string, spaceId: string) => boolean;
  targetParent?: unknown;
  serviceThrows?: unknown;
  holdEdit?: Promise<void>;
} = {}) => {
  const calls: string[] = [];
  const row = opts.row === null ? null : { ...ROW, ...(opts.row ?? {}) };
  const spy = spyKysely((q: SpyQuery) => {
    if (/set local/i.test(q.sql)) {
      calls.push(`sql:${q.sql.replace(/\s+/g, ' ').trim()}`);
      return [];
    }
    if (/for no key update/i.test(q.sql)) {
      calls.push('lock');
      return row ? [row] : [];
    }
    calls.push(`sql:${q.sql}`);
    return [];
  });
  const pageRepo = {
    findById: jest.fn(async (ref: string, o?: { trx?: unknown }) => {
      calls.push(`findById:${ref}`);
      expect(o?.trx).toBeDefined(); // every read in the op joins its transaction
      if (ref === 'target-parent') return 'targetParent' in opts ? opts.targetParent : { id: 'target-parent', spaceId: 'space-1', deletedAt: null };
      if ('resolved' in opts) return opts.resolved;
      return row ? { id: row.id, workspaceId: row.workspaceId } : null;
    }),
  };
  const svc = (name: string, ret: unknown) =>
    jest.fn(async (..._args: unknown[]) => {
      calls.push(name);
      if (opts.serviceThrows) throw opts.serviceThrows;
      return ret;
    });
  const pageService = {
    forceDelete: svc('forceDelete', ['page-uuid-1', 'child-1']),
    removePage: svc('removePage', undefined),
    movePage: svc('movePage', undefined),
    movePageToSpace: svc('movePageToSpace', { childPageIds: ['child-1'] }),
    update: svc('update', { id: 'page-uuid-1' }),
  };
  const pageAccessService = {
    validateCanEdit: jest.fn(async (page: { id: string }) => {
      calls.push(`validateCanEdit:${page.id}`);
      if (opts.holdEdit) await opts.holdEdit;
      if (opts.canEdit === 'deny') throw new ForbiddenException();
      return { hasRestriction: false };
    }),
  };
  const spaceAbility = {
    createForUser: jest.fn(async (_u: unknown, spaceId: string) => {
      calls.push(`ability:${spaceId}`);
      const can = (a: string, s: string) => (opts.can ? opts.can(a, s, spaceId) : true);
      return { can, cannot: (a: string, s: string) => !can(a, s) };
    }),
  };
  const auditService = {
    log: jest.fn((p: { event: string }) => {
      calls.push(`audit:${p.event}:${spy.tx.join('>')}`);
    }),
  };
  const attachmentQueue = {
    add: jest.fn(async (_n: string, data: { pageId: string }) => {
      calls.push(`queue:${data.pageId}:${spy.tx.join('>')}`);
    }),
  };
  const controller = new ConditionalPageOpsController(
    spy.db,
    pageRepo as never,
    pageService as never,
    pageAccessService as never,
    spaceAbility as never,
    auditService as never,
    attachmentQueue as never,
  );
  return { controller, calls, spy, pageRepo, pageService, pageAccessService, spaceAbility, auditService, attachmentQueue };
};

const del = (over: Partial<ConditionalDeletePageDto> = {}) =>
  ({ pageId: 'page-uuid-1', expectedEtags: [FRESH], ...over }) as ConditionalDeletePageDto;
const mv = (over: Partial<ConditionalMovePageDto> = {}) =>
  ({ pageId: 'page-uuid-1', parentPageId: null, position: 'a0001', expectedEtags: [FRESH], ...over }) as ConditionalMovePageDto;
const mvs = (over: Partial<ConditionalMovePageToSpaceDto> = {}) =>
  ({ pageId: 'page-uuid-1', spaceId: 'space-2', expectedEtags: [FRESH], ...over }) as ConditionalMovePageToSpaceDto;
const meta = (over: Partial<ConditionalUpdatePageMetaDto> = {}) =>
  ({ pageId: 'page-uuid-1', title: 'New title', expectedEtags: [FRESH], ...over }) as ConditionalUpdatePageMetaDto;

const codeOf = async (p: Promise<unknown>): Promise<{ status: number; body: unknown }> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error('expected a rejection');
};

describe('ConditionalPageOpsController — the transaction and the lock', () => {
  it('sets the lock/statement timeouts, then locks the row FOR NO KEY UPDATE (never FOR UPDATE), workspace-scoped', async () => {
    const t = build();
    await t.controller.conditionalDelete(del(), USER, WS);
    const lockSql = t.spy.calls.find((q) => /for no key update/i.test(q.sql))!;
    expect(lockSql.sql).not.toMatch(/\bfor update\b/i);
    expect(lockSql.sql).toMatch(/"workspace_id" = \$\d/);
    expect(lockSql.parameters).toEqual(expect.arrayContaining(['page-uuid-1', 'ws-1']));
    expect(t.calls.slice(0, 3)).toEqual([
      "sql:SET LOCAL lock_timeout = '2s'",
      "sql:SET LOCAL statement_timeout = '15s'",
      'findById:page-uuid-1',
    ]);
    expect(t.calls[3]).toBe('lock');
    expect(t.spy.tx).toEqual(['begin', 'commit']);
  });

  it('resolves a slug first and locks by the resolved id', async () => {
    const t = build();
    await t.controller.conditionalMove(mv({ pageId: 'slug-1' }), USER, WS);
    expect(t.pageRepo.findById).toHaveBeenCalledWith('slug-1', expect.anything());
    expect(t.spy.calls.find((q) => /for no key update/i.test(q.sql))!.parameters).toContain('page-uuid-1');
    expect((t.pageService.movePage.mock.calls[0][0] as { pageId: string }).pageId).toBe('page-uuid-1');
  });

  it('404s a missing page, and a page in another workspace, before any decision', async () => {
    for (const t of [build({ row: null }), build({ resolved: { id: 'page-uuid-1', workspaceId: 'ws-other' } })]) {
      await expect(t.controller.conditionalDelete(del(), USER, WS)).rejects.toBeInstanceOf(NotFoundException);
      expect(t.spaceAbility.createForUser).not.toHaveBeenCalled();
      expect(t.spy.tx).toEqual(['begin', 'rollback']);
    }
  });
});

describe('conditional-delete (trash / permanent)', () => {
  it('fresh tag → trashes with the transaction, then audits PAGE_TRASHED after the commit', async () => {
    const t = build();
    await expect(t.controller.conditionalDelete(del(), USER, WS)).resolves.toEqual({ outcome: 'applied', pageId: 'page-uuid-1' });
    const [id, userId, wsId, trx] = t.pageService.removePage.mock.calls[0];
    expect([id, userId, wsId]).toEqual(['page-uuid-1', 'user-1', 'ws-1']);
    expect(trx).toBeDefined();
    expect(t.calls).toContain('audit:page.trashed:begin>commit');
    // native preamble: space ability for the page's space, then validateCanEdit on the page
    expect(t.calls.indexOf('ability:space-1')).toBeLessThan(t.calls.indexOf('validateCanEdit:page-uuid-1'));
  });

  it('stale tag → 412 precondition_failed, NOTHING changed, rolled back, no audit', async () => {
    const t = build();
    const r = await codeOf(t.controller.conditionalDelete(del({ expectedEtags: [STALE] }), USER, WS));
    expect(r).toEqual({ status: 412, body: { message: 'page changed', code: 'precondition_failed' } });
    expect(t.pageService.removePage).not.toHaveBeenCalled();
    expect(t.auditService.log).not.toHaveBeenCalled();
    expect(t.spy.tx).toEqual(['begin', 'rollback']);
  });

  it('any of several tags matching passes', async () => {
    const t = build();
    await expect(t.controller.conditionalDelete(del({ expectedEtags: [STALE, FRESH] }), USER, WS)).resolves.toMatchObject({ outcome: 'applied' });
  });

  it('already trashed → noop whatever the tag (a retry never 412s on its own write)', async () => {
    const t = build({ row: { deletedAt: new Date() } });
    await expect(t.controller.conditionalDelete(del({ expectedEtags: [STALE] }), USER, WS)).resolves.toEqual({ outcome: 'noop', pageId: 'page-uuid-1' });
    expect(t.pageService.removePage).not.toHaveBeenCalled();
    expect(t.auditService.log).not.toHaveBeenCalled();
    expect(t.calls).toContain('validateCanEdit:page-uuid-1'); // authorization is decided BEFORE convergence
  });

  it('a no-op is still authorized: an already-trashed page the caller cannot edit is 403, not noop', async () => {
    const t = build({ row: { deletedAt: new Date() }, canEdit: 'deny' });
    await expect(t.controller.conditionalDelete(del(), USER, WS)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('permanent NEVER converges: a trashed page with a stale tag is 412', async () => {
    const t = build({ row: { deletedAt: new Date() } });
    const r = await codeOf(t.controller.conditionalDelete(del({ permanentlyDelete: true, expectedEtags: [STALE] }), USER, WS));
    expect(r.status).toBe(412);
    expect(t.pageService.forceDelete).not.toHaveBeenCalled();
    expect(t.attachmentQueue.add).not.toHaveBeenCalled();
  });

  it('permanent: space Manage-Settings is required exactly as native (no validateCanEdit)', async () => {
    const t = build({ can: (a, s) => !(a === 'manage' && s === 'settings') });
    const r = await codeOf(t.controller.conditionalDelete(del({ permanentlyDelete: true }), USER, WS));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ message: 'Only space admins can permanently delete pages' });
    expect(t.pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    expect(t.pageService.forceDelete).not.toHaveBeenCalled();
  });

  it('permanent: deletes with the transaction; attachment jobs + PAGE_DELETED audit only AFTER the commit', async () => {
    const t = build({ row: { deletedAt: new Date() } });
    await expect(t.controller.conditionalDelete(del({ permanentlyDelete: true }), USER, WS)).resolves.toEqual({ outcome: 'applied', pageId: 'page-uuid-1' });
    const [id, wsId, trx] = t.pageService.forceDelete.mock.calls[0];
    expect([id, wsId]).toEqual(['page-uuid-1', 'ws-1']);
    expect(trx).toBeDefined();
    expect(t.calls).toEqual(
      expect.arrayContaining(['queue:page-uuid-1:begin>commit', 'queue:child-1:begin>commit', 'audit:page.deleted:begin>commit']),
    );
    expect(t.attachmentQueue.add).toHaveBeenCalledWith(
      'delete-page-attachments',
      { pageId: 'child-1' },
      { jobId: 'delete-page-attachments-child-1', attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );
  });

  it('permanent: a failed enqueue after the commit does not turn the committed delete into an error', async () => {
    const t = build();
    t.attachmentQueue.add.mockRejectedValue(new Error('redis down'));
    await expect(t.controller.conditionalDelete(del({ permanentlyDelete: true }), USER, WS)).resolves.toMatchObject({ outcome: 'applied' });
    expect(t.auditService.log).toHaveBeenCalled();
  });

  it('["*"] passes on any live row', async () => {
    const t = build();
    await expect(t.controller.conditionalDelete(del({ expectedEtags: ['*'] }), USER, WS)).resolves.toMatchObject({ outcome: 'applied' });
  });
});

describe('conditional-move (same space)', () => {
  it('fresh → native preamble (CASL Edit on the space, validateCanEdit), then movePage with the transaction', async () => {
    const t = build();
    await expect(t.controller.conditionalMove(mv(), USER, WS)).resolves.toEqual({ outcome: 'applied', pageId: 'page-uuid-1' });
    const [dto, page, trx] = t.pageService.movePage.mock.calls[0] as [Record<string, unknown>, { id: string }, unknown];
    expect(dto).toEqual({ pageId: 'page-uuid-1', parentPageId: null, position: 'a0001' });
    expect(page.id).toBe('page-uuid-1');
    expect(trx).toBeDefined();
    expect(t.auditService.log).not.toHaveBeenCalled(); // the native move audits nothing either
  });

  it('CASL Edit denied → 403 before anything else', async () => {
    const t = build({ can: (a) => a !== 'edit' });
    await expect(t.controller.conditionalMove(mv(), USER, WS)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    expect(t.pageService.movePage).not.toHaveBeenCalled();
  });

  it('stale → 412 with nothing moved', async () => {
    const t = build();
    expect((await codeOf(t.controller.conditionalMove(mv({ expectedEtags: [STALE] }), USER, WS))).status).toBe(412);
    expect(t.pageService.movePage).not.toHaveBeenCalled();
    expect(t.spy.tx).toEqual(['begin', 'rollback']);
  });

  it('same parent AND same position → noop whatever the tag (omitted parent = the root, as upstream reads it)', async () => {
    for (const d of [mv({ position: 'a0000', expectedEtags: [STALE] }), mv({ parentPageId: undefined, position: 'a0000', expectedEtags: [STALE] })]) {
      const t = build();
      await expect(t.controller.conditionalMove(d, USER, WS)).resolves.toEqual({ outcome: 'noop', pageId: 'page-uuid-1' });
      expect(t.pageService.movePage).not.toHaveBeenCalled();
    }
  });

  it('same parent, different position → not a no-op (412 when stale)', async () => {
    const t = build();
    expect((await codeOf(t.controller.conditionalMove(mv({ position: 'a0002', expectedEtags: [STALE] }), USER, WS))).status).toBe(412);
  });

  it('a trashed page is 404 (never moved)', async () => {
    const t = build({ row: { deletedAt: new Date() } });
    const r = await codeOf(t.controller.conditionalMove(mv(), USER, WS));
    expect(r).toMatchObject({ status: 404, body: { message: 'Moved page not found' } });
    expect(t.pageService.movePage).not.toHaveBeenCalled();
  });

  it('a new parent is checked like native: missing/trashed → 404; else validateCanEdit on it', async () => {
    const gone = build({ targetParent: { id: 'target-parent', deletedAt: new Date() } });
    expect(await codeOf(gone.controller.conditionalMove(mv({ parentPageId: 'target-parent' }), USER, WS))).toMatchObject({
      status: 404,
      body: { message: 'Target parent page not found' },
    });
    const ok = build();
    await ok.controller.conditionalMove(mv({ parentPageId: 'target-parent' }), USER, WS);
    expect(ok.calls).toContain('validateCanEdit:target-parent');
    const denied = build({ canEdit: 'deny' });
    await expect(denied.controller.conditionalMove(mv({ parentPageId: 'target-parent' }), USER, WS)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('conditional-move-to-space', () => {
  it('fresh → CASL Edit on BOTH spaces + validateCanEdit, movePageToSpace with the transaction, audit after commit', async () => {
    const t = build();
    await expect(t.controller.conditionalMoveToSpace(mvs(), USER, WS)).resolves.toEqual({ outcome: 'applied', pageId: 'page-uuid-1' });
    expect(t.calls).toEqual(expect.arrayContaining(['ability:space-1', 'ability:space-2', 'validateCanEdit:page-uuid-1']));
    const [page, spaceId, userId, trx] = t.pageService.movePageToSpace.mock.calls[0] as [{ id: string }, string, string, unknown];
    expect([page.id, spaceId, userId]).toEqual(['page-uuid-1', 'space-2', 'user-1']);
    expect(trx).toBeDefined();
    expect(t.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'page.moved_to_space',
        changes: { before: { spaceId: 'space-1' }, after: { spaceId: 'space-2' } },
        metadata: { title: 'Current title', childPageIds: ['child-1'] },
      }),
    );
    expect(t.calls).toContain('audit:page.moved_to_space:begin>commit');
  });

  it('Edit denied on the TARGET space → 403', async () => {
    const t = build({ can: (a, _s, spaceId) => !(a === 'edit' && spaceId === 'space-2') });
    await expect(t.controller.conditionalMoveToSpace(mvs(), USER, WS)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.pageService.movePageToSpace).not.toHaveBeenCalled();
  });

  it('already in the space (parent omitted, or null at the root) → noop whatever the tag', async () => {
    for (const d of [mvs({ spaceId: 'space-1', expectedEtags: [STALE] }), mvs({ spaceId: 'space-1', parentPageId: null, expectedEtags: [STALE] })]) {
      const t = build();
      await expect(t.controller.conditionalMoveToSpace(d, USER, WS)).resolves.toEqual({ outcome: 'noop', pageId: 'page-uuid-1' });
      expect(t.pageService.movePageToSpace).not.toHaveBeenCalled();
      expect(t.auditService.log).not.toHaveBeenCalled();
    }
  });

  it('in the space but NOT at its root with parentPageId null → the native 400, not a no-op', async () => {
    const t = build({ row: { parentPageId: 'some-parent' } });
    const r = await codeOf(t.controller.conditionalMoveToSpace(mvs({ spaceId: 'space-1', parentPageId: null }), USER, WS));
    expect(r).toMatchObject({ status: 400, body: { message: 'Page is already in this space' } });
  });

  it('stale → 412 with nothing moved; trashed → 404', async () => {
    const t = build();
    expect((await codeOf(t.controller.conditionalMoveToSpace(mvs({ expectedEtags: [STALE] }), USER, WS))).status).toBe(412);
    expect(t.pageService.movePageToSpace).not.toHaveBeenCalled();
    const trashed = build({ row: { deletedAt: new Date() } });
    expect((await codeOf(trashed.controller.conditionalMoveToSpace(mvs(), USER, WS))).status).toBe(404);
  });
});

describe('conditional-update-meta', () => {
  it('fresh → validateCanEdit, then PageService.update(page, metadata, user, trx) without transport fields', async () => {
    const t = build();
    await expect(t.controller.conditionalUpdateMeta(meta({ icon: '📄' }), USER, WS)).resolves.toEqual({ outcome: 'applied', pageId: 'page-uuid-1' });
    const [page, dto, user, trx] = t.pageService.update.mock.calls[0] as [{ id: string }, Record<string, unknown>, unknown, unknown];
    expect(page.id).toBe('page-uuid-1');
    expect(dto).toEqual({ pageId: 'page-uuid-1', title: 'New title', icon: '📄' });
    expect(user).toBe(USER);
    expect(trx).toBeDefined();
  });

  it.each([
    ['content', { content: '<p>x</p>' }],
    ['operation', { operation: 'replace' }],
    ['format', { format: 'html' }],
  ])('400s %s before touching the database', async (_n, extra) => {
    const t = build();
    await expect(t.controller.conditionalUpdateMeta(meta(extra as never), USER, WS)).rejects.toBeInstanceOf(BadRequestException);
    expect(t.spy.tx).toEqual([]);
  });

  it('every provided field already equal → noop whatever the tag', async () => {
    const t = build();
    await expect(
      t.controller.conditionalUpdateMeta(meta({ title: 'Current title', icon: null as never, expectedEtags: [STALE] }), USER, WS),
    ).resolves.toEqual({ outcome: 'noop', pageId: 'page-uuid-1' });
    expect(t.pageService.update).not.toHaveBeenCalled();
  });

  it('one differing field → not a no-op (412 when stale); trashed → 404', async () => {
    const t = build();
    expect((await codeOf(t.controller.conditionalUpdateMeta(meta({ expectedEtags: [STALE] }), USER, WS))).status).toBe(412);
    expect(t.pageService.update).not.toHaveBeenCalled();
    const trashed = build({ row: { deletedAt: new Date() } });
    expect((await codeOf(trashed.controller.conditionalUpdateMeta(meta(), USER, WS))).status).toBe(404);
  });

  it('metadataConverged: only title/icon converge; an unknown provided field means apply', () => {
    const page = ROW as never;
    expect(metadataConverged({ pageId: 'x', title: 'Current title' }, page)).toBe(true);
    expect(metadataConverged({ pageId: 'x', title: 'Current title', parentPageId: 'p' }, page)).toBe(true); // ignored upstream
    expect(metadataConverged({ title: 'Current title', coverPhoto: 'x' }, page)).toBe(false);
    expect(metadataConverged({ icon: 'x' }, page)).toBe(false);
  });
});

describe('busy engine → retryable 503 engine_busy', () => {
  it.each(['55P03', '40P01', '57014'])('maps SQLSTATE %s from inside the operation', async (code) => {
    const t = build({ serviceThrows: Object.assign(new Error('busy'), { code }) });
    const r = await codeOf(t.controller.conditionalMove(mv(), USER, WS));
    expect(r).toEqual({ status: 503, body: { message: 'the page is busy; retry shortly', code: 'engine_busy' } });
    expect(t.spy.tx).toEqual(['begin', 'rollback']);
  });

  it('any other error passes through untouched (a guard 23514 is mapped to 409 by the global interceptor)', async () => {
    const guard = Object.assign(new Error('refused'), { code: '23514', constraint_name: 'ccc_page_restriction_strip' });
    const t = build({ serviceThrows: guard });
    await expect(t.controller.conditionalMove(mv(), USER, WS)).rejects.toBe(guard);
    expect(toEngineBusy(guard)).toBeNull();
    expect(toEngineBusy(new Error('x'))).toBeNull();
  });

  it('a full semaphore (2 in flight) refuses the third after the bounded wait, then frees on completion', async () => {
    let open!: () => void;
    const held = new Promise<void>((r) => (open = r));
    const t = build({ holdEdit: held });
    (t.controller as unknown as { slots: OpSemaphore }).slots = new OpSemaphore(2, 20);
    const a = t.controller.conditionalMove(mv(), USER, WS);
    const b = t.controller.conditionalMove(mv(), USER, WS);
    const third = await codeOf(t.controller.conditionalMove(mv(), USER, WS));
    expect(third).toEqual({ status: 503, body: { message: 'the page is busy; retry shortly', code: 'engine_busy' } });
    open();
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    await expect(t.controller.conditionalMove(mv(), USER, WS)).resolves.toMatchObject({ outcome: 'applied' });
  });
});

describe('DTO validation (the global ValidationPipe’s plainToInstance + validate)', () => {
  const errs = async <T extends object>(cls: new () => T, body: object) =>
    (await validate(plainToInstance(cls, body) as object)).map((e) => e.property);

  it('expectedEtags: 1..8 items, each 1..128 chars, "*" only alone', async () => {
    const base = { pageId: 'p' };
    expect(await errs(ConditionalDeletePageDto, { ...base, expectedEtags: [FRESH] })).toEqual([]);
    expect(await errs(ConditionalDeletePageDto, { ...base, expectedEtags: ['*'] })).toEqual([]);
    expect(await errs(ConditionalDeletePageDto, { ...base, expectedEtags: Array(8).fill('a') })).toEqual([]);
    for (const bad of [[], Array(9).fill('a'), ['a'.repeat(129)], [''], ['*', FRESH], [FRESH, '*'], 'abc', [1]]) {
      expect(await errs(ConditionalDeletePageDto, { ...base, expectedEtags: bad })).toEqual(['expectedEtags']);
    }
    expect(await errs(ConditionalDeletePageDto, base)).toEqual(['expectedEtags']);
  });

  it('each DTO keeps its native constraints (move position 5..12; move-to-space spaceId required)', async () => {
    expect(await errs(ConditionalMovePageDto, { pageId: 'p', position: 'a0', expectedEtags: ['*'] })).toEqual(['position']);
    expect(await errs(ConditionalMovePageDto, { pageId: 'p', position: 'a0000', parentPageId: null, expectedEtags: ['*'] })).toEqual([]);
    expect(await errs(ConditionalMovePageToSpaceDto, { pageId: 'p', expectedEtags: ['*'] })).toEqual(['spaceId']);
    expect(await errs(ConditionalUpdatePageMetaDto, { pageId: 'p', title: 't', expectedEtags: ['*'] })).toEqual([]);
  });

  it('move-to-space: parentPageId only null or omitted (the engine lands at the root)', async () => {
    const base = { pageId: 'p', spaceId: 's', expectedEtags: ['*'] };
    expect(await errs(ConditionalMovePageToSpaceDto, base)).toEqual([]);
    expect(await errs(ConditionalMovePageToSpaceDto, { ...base, parentPageId: null })).toEqual([]);
    expect(await errs(ConditionalMovePageToSpaceDto, { ...base, parentPageId: 'some-page' })).toEqual(['parentPageId']);
  });

  it('update-meta: an absent format/operation stays absent (their @Transform defaults never fire)', () => {
    const dto = plainToInstance(ConditionalUpdatePageMetaDto, { pageId: 'p', title: 't', expectedEtags: ['*'] });
    expect(dto.format).toBeUndefined();
    expect(dto.operation).toBeUndefined();
    expect(dto.content).toBeUndefined();
  });
});
