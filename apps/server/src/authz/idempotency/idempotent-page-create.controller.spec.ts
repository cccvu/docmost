import { ForbiddenException, HttpException, NotFoundException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { spyKysely } from '../../service-bridge/kysely-spy.testkit';

// PageService's module graph pulls in the collab WebSocket stack (lib0 ESM) that jest cannot parse. Stub it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { IdempotentCreatePageDto, IdempotentPageCreateController } from './idempotent-page-create.controller';
import { Reservation } from './idempotency-ledger.service';
import { OpSemaphore } from '../page-write/op-semaphore';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

/**
 * #616 — `POST /api/pages/idempotent-create`, the request-level contract (real Postgres: idempotent-page-create.pg.spec.ts):
 *   1. the NATIVE create preamble runs first and unchanged (parent 404s / validateCanEdit, else CASL Create Page), and a
 *      refusal opens no transaction and touches no ledger;
 *   2. content is parsed BEFORE the transaction, under exactly the native parse condition;
 *   3. inside one bounded transaction: reserve → PageService.create(…, trx) → complete; the view check and the audit
 *      happen after the commit, as native orders them;
 *   4. a replay re-runs nothing (no create, no audit) but is still re-authorized; a mismatch is 409
 *      `idempotency_key_reused`; the key is bound to the fork-authenticated user;
 *   5. busy SQLSTATEs and a full slot are a retryable 503 `engine_busy`; everything else passes through.
 */
const WS = { id: 'ws-1' } as never;
const USER = { id: 'user-1' } as never;
const SPACE = '00000000-0000-4000-8000-000000000050';
const FP = 'c'.repeat(64);
const PAGE = {
  id: 'page-new',
  slugId: 'slug-new',
  title: 'Created',
  icon: null,
  spaceId: SPACE,
  workspaceId: 'ws-1',
  parentPageId: null,
  deletedAt: null,
};

const build = (opts: {
  reservation?: Reservation;
  reserveThrows?: unknown;
  parent?: unknown;
  replayed?: unknown;
  canEditParent?: boolean;
  canCreateInSpace?: boolean;
  canView?: boolean;
  createThrows?: unknown;
} = {}) => {
  const calls: string[] = [];
  const spy = spyKysely((q) => {
    calls.push(`sql:${q.sql.replace(/\s+/g, ' ').trim()}`);
    return [];
  });
  const slot = { namespaceDigest: 'n'.repeat(64), op: 'page.create' as const, keyDigest: 'k'.repeat(64) };
  const ledger = {
    reserve: jest.fn(async (_trx: unknown, _claim: unknown) => {
      calls.push(`reserve:${spy.tx.join('>')}`);
      if (opts.reserveThrows) throw opts.reserveThrows;
      return opts.reservation ?? { outcome: 'fresh' as const, slot };
    }),
    complete: jest.fn(async (_trx: unknown, s: unknown, id: string) => {
      calls.push(`complete:${id}`);
      expect(s).toBe(slot);
    }),
  };
  const pageRepo = {
    findById: jest.fn(async (ref: string, o?: { trx?: unknown }) => {
      calls.push(`findById:${ref}${o?.trx ? ':trx' : ''}`);
      if (ref === 'parent-1') return 'parent' in opts ? opts.parent : { id: 'parent-1', spaceId: SPACE, deletedAt: null };
      return 'replayed' in opts ? opts.replayed : { ...PAGE, id: ref };
    }),
  };
  const pageService = {
    create: jest.fn(async (_u: string, _w: string, _dto: unknown, trx?: unknown) => {
      calls.push(`create:${trx ? 'trx' : 'no-trx'}`);
      if (opts.createThrows) throw opts.createThrows;
      return { ...PAGE };
    }),
    parseProsemirrorContent: jest.fn(async (content: unknown, format: string) => {
      calls.push(`parse:${format}:${spy.tx.join('>')}`);
      return { type: 'doc', parsedFrom: content };
    }),
  };
  const pageAccessService = {
    validateCanEdit: jest.fn(async (page: { id: string }) => {
      calls.push(`validateCanEdit:${page.id}`);
      if (opts.canEditParent === false) throw new ForbiddenException();
      return { hasRestriction: false };
    }),
    validateCanViewWithPermissions: jest.fn(async (page: { id: string }) => {
      calls.push(`validateCanView:${page.id}:${spy.tx.join('>')}`);
      if (opts.canView === false) throw new ForbiddenException();
      return { canEdit: true, hasRestriction: false };
    }),
  };
  const spaceAbility = {
    createForUser: jest.fn(async (_u: unknown, spaceId: string) => {
      calls.push(`ability:${spaceId}`);
      const can = (a: string, s: string) => (a === 'create' && s === 'page' ? opts.canCreateInSpace !== false : true);
      return { can, cannot: (a: string, s: string) => !can(a, s) };
    }),
  };
  const auditService = {
    log: jest.fn((p: { event: string }) => {
      calls.push(`audit:${p.event}:${spy.tx.join('>')}`);
    }),
  };
  const controller = new IdempotentPageCreateController(
    spy.db,
    pageRepo as never,
    pageService as never,
    pageAccessService as never,
    spaceAbility as never,
    auditService as never,
    ledger as never,
  );
  return { controller, calls, spy, ledger, pageRepo, pageService, pageAccessService, spaceAbility, auditService, slot };
};

const body = (over: Partial<IdempotentCreatePageDto> = {}) =>
  ({
    spaceId: SPACE,
    title: 'Created',
    idempotencyKey: 'key-1',
    idempotencyNamespace: 'user:ext-1',
    fingerprint: FP,
    ...over,
  }) as IdempotentCreatePageDto;

const statusOf = async (p: Promise<unknown>): Promise<{ status: number; body: unknown }> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error('expected a rejection');
};

describe('IdempotentCreatePageDto', () => {
  const check = async (plain: Record<string, unknown>) =>
    (await validate(plainToInstance(IdempotentCreatePageDto, plain), { whitelist: true, forbidNonWhitelisted: true })).map(
      (e) => e.property,
    );

  it('is the native CreatePageDto plus the three keyed fields (none stripped by the whitelist pipe)', async () => {
    expect(await check({ ...body(), parentPageId: 'parent-1', icon: '📄', content: '<p>x</p>', format: 'html' })).toEqual([]);
    expect(await check({ ...body(), spaceId: 'not-a-uuid' })).toEqual(['spaceId']); // inherited validation
  });

  it.each([
    ['idempotencyKey', undefined],
    ['idempotencyKey', ''],
    ['idempotencyKey', 'k'.repeat(256)],
    ['idempotencyNamespace', undefined],
    ['idempotencyNamespace', 'n'.repeat(129)],
    ['fingerprint', undefined],
    ['fingerprint', 'C'.repeat(64)],
    ['fingerprint', 'c'.repeat(63)],
    ['fingerprint', 'g'.repeat(64)],
  ])('refuses %s = %p', async (field, value) => {
    expect(await check({ ...body(), [field]: value })).toEqual([field]);
  });

  it('accepts the bounds exactly', async () => {
    expect(await check({ ...body(), idempotencyKey: 'k'.repeat(255), idempotencyNamespace: 'n'.repeat(128) })).toEqual([]);
  });
});

describe('the route', () => {
  it('is POST /pages/idempotent-create, 200, RemoteOnlyGuard BEFORE JwtAuthGuard (404 in native, never a session check)', () => {
    const handler = IdempotentPageCreateController.prototype.create;
    expect(Reflect.getMetadata(PATH_METADATA, IdempotentPageCreateController)).toBe('pages');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('idempotent-create');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    expect(Reflect.getMetadata(GUARDS_METADATA, IdempotentPageCreateController)).toEqual([RemoteOnlyGuard, JwtAuthGuard]);
  });
});

describe('the native preamble, replicated', () => {
  it('under a parent: the parent must exist, be live and be in the same space (404), then validateCanEdit(parent)', async () => {
    for (const parent of [null, { id: 'parent-1', spaceId: SPACE, deletedAt: new Date() }, { id: 'parent-1', spaceId: 'other', deletedAt: null }]) {
      const t = build({ parent });
      const r = await statusOf(t.controller.create(body({ parentPageId: 'parent-1' }), USER, WS));
      expect(r).toEqual({ status: 404, body: expect.objectContaining({ message: 'Parent page not found' }) });
      expect(t.spy.tx).toEqual([]);
      expect(t.ledger.reserve).not.toHaveBeenCalled();
      expect(t.pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    }
    const ok = build();
    await ok.controller.create(body({ parentPageId: 'parent-1' }), USER, WS);
    expect(ok.calls.slice(0, 2)).toEqual(['findById:parent-1', 'validateCanEdit:parent-1']);
    expect(ok.spaceAbility.createForUser).not.toHaveBeenCalled(); // native: no space CASL on the parent path
  });

  it('under a parent the caller cannot edit: 403, no transaction, no ledger', async () => {
    const t = build({ canEditParent: false });
    await expect(t.controller.create(body({ parentPageId: 'parent-1' }), USER, WS)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.spy.tx).toEqual([]);
    expect(t.ledger.reserve).not.toHaveBeenCalled();
  });

  it('at the root: CASL Create Page on the requested space; refused → 403, no transaction, no ledger', async () => {
    const t = build({ canCreateInSpace: false });
    await expect(t.controller.create(body(), USER, WS)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.spaceAbility.createForUser).toHaveBeenCalledWith(USER, SPACE);
    expect(t.spy.tx).toEqual([]);
    expect(t.ledger.reserve).not.toHaveBeenCalled();
  });
});

describe('a fresh keyed create', () => {
  it('reserve → create(trx) → complete in ONE bounded transaction; view check + audit after the commit', async () => {
    const t = build();
    const res = await t.controller.create(body(), USER, WS);
    expect(res).toEqual({ ...PAGE, permissions: { canEdit: true, hasRestriction: false }, replayed: false });
    expect(t.calls).toEqual([
      `ability:${SPACE}`,
      "sql:SET LOCAL lock_timeout = '2s'",
      "sql:SET LOCAL statement_timeout = '15s'",
      'reserve:begin',
      'create:trx',
      'complete:page-new',
      'validateCanView:page-new:begin>commit',
      'audit:page.created:begin>commit',
    ]);
    const [trx] = t.ledger.reserve.mock.calls[0];
    expect(t.pageService.create.mock.calls[0][3]).toBe(trx); // the same transaction
  });

  it('binds the key to the workspace and the fork-authenticated user; transport fields never reach PageService.create', async () => {
    const t = build();
    await t.controller.create(body({ parentPageId: 'parent-1', icon: 'i' }), USER, WS);
    expect(t.ledger.reserve.mock.calls[0][1]).toEqual({
      workspaceId: 'ws-1',
      principal: 'user:user-1',
      namespace: 'user:ext-1',
      op: 'page.create',
      key: 'key-1',
      fingerprint: FP,
    });
    const [userId, wsId, dto] = t.pageService.create.mock.calls[0];
    expect([userId, wsId]).toEqual(['user-1', 'ws-1']);
    expect(dto).toEqual({ spaceId: SPACE, title: 'Created', parentPageId: 'parent-1', icon: 'i' });
  });

  it('the audit payload is the native one', async () => {
    const t = build();
    await t.controller.create(body(), USER, WS);
    expect(t.auditService.log).toHaveBeenCalledWith({
      event: 'page.created',
      resourceType: 'page',
      resourceId: 'page-new',
      spaceId: SPACE,
      changes: { after: { title: 'Created', spaceId: SPACE } },
    });
  });

  it('parses html/markdown BEFORE the transaction and hands PageService.create canonical JSON', async () => {
    const t = build();
    await t.controller.create(body({ content: '<p>hi</p>', format: 'html' }), USER, WS);
    expect(t.calls).toContain('parse:html:'); // no transaction had begun
    expect(t.calls.indexOf('parse:html:')).toBeLessThan(t.calls.indexOf('reserve:begin'));
    expect(t.pageService.create.mock.calls[0][2]).toMatchObject({
      content: { type: 'doc', parsedFrom: '<p>hi</p>' },
      format: 'json',
    });
  });

  it('parses under the native condition only (content AND format): no content / empty content pass through untouched', async () => {
    for (const over of [{}, { content: '', format: 'html' as const }, { content: { type: 'doc' } }]) {
      const t = build();
      await t.controller.create(body(over), USER, WS);
      expect(t.pageService.parseProsemirrorContent).not.toHaveBeenCalled();
      expect(t.pageService.create.mock.calls[0][2]).toEqual({ spaceId: SPACE, title: 'Created', ...over });
    }
  });

  it('echoes the native body: no content on the create response, so no format conversion', async () => {
    const t = build();
    const res = await t.controller.create(body({ content: '# hi', format: 'markdown' }), USER, WS);
    expect(res).not.toHaveProperty('content');
  });

  it('a failed create rolls the reservation back with it, and the error passes through', async () => {
    const t = build({ createThrows: new NotFoundException('Parent page not found') });
    await expect(t.controller.create(body(), USER, WS)).rejects.toBeInstanceOf(NotFoundException);
    expect(t.spy.tx).toEqual(['begin', 'rollback']);
    expect(t.ledger.complete).not.toHaveBeenCalled();
    expect(t.auditService.log).not.toHaveBeenCalled();
  });
});

describe('a keyed retry', () => {
  it('same key + same body → the page it created, replayed: true; nothing re-run (no create, no complete, no audit)', async () => {
    const t = build({ reservation: { outcome: 'replay', resourceId: 'page-old' } });
    const res = await t.controller.create(body(), USER, WS);
    expect(res).toEqual({ ...PAGE, id: 'page-old', permissions: { canEdit: true, hasRestriction: false }, replayed: true });
    expect(t.calls).toContain('findById:page-old:trx');
    expect(t.pageService.create).not.toHaveBeenCalled();
    expect(t.ledger.complete).not.toHaveBeenCalled();
    expect(t.auditService.log).not.toHaveBeenCalled();
    expect(t.calls).toContain('validateCanView:page-old:begin>commit'); // still re-authorized
  });

  it('a replay the caller may no longer view is 403 — never an answer from the ledger alone', async () => {
    const t = build({ reservation: { outcome: 'replay', resourceId: 'page-old' }, canView: false });
    await expect(t.controller.create(body(), USER, WS)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a replay whose page is gone (or in another workspace) → 404 idempotency_resource_gone', async () => {
    for (const replayed of [undefined, { ...PAGE, id: 'page-old', workspaceId: 'ws-other' }]) {
      const t = build({ reservation: { outcome: 'replay', resourceId: 'page-old' }, replayed });
      const r = await statusOf(t.controller.create(body(), USER, WS));
      expect(r).toEqual({ status: 404, body: expect.objectContaining({ code: 'idempotency_resource_gone' }) });
    }
  });

  it('same key + different body → 409 idempotency_key_reused, rolled back, nothing created', async () => {
    const t = build({ reservation: { outcome: 'mismatch' } });
    const r = await statusOf(t.controller.create(body(), USER, WS));
    expect(r).toEqual({ status: 409, body: { message: expect.any(String), code: 'idempotency_key_reused' } });
    expect(t.pageService.create).not.toHaveBeenCalled();
    expect(t.spy.tx).toEqual(['begin', 'rollback']);
  });
});

describe('a busy engine', () => {
  it.each(['55P03', '40P01', '57014'])('SQLSTATE %s → 503 engine_busy', async (code) => {
    const t = build({ reserveThrows: Object.assign(new Error('busy'), { code }) });
    const r = await statusOf(t.controller.create(body(), USER, WS));
    expect(r).toEqual({ status: 503, body: { message: expect.any(String), code: 'engine_busy' } });
  });

  it('any other database error passes through unchanged', async () => {
    const err = Object.assign(new Error('unique'), { code: '23505' });
    const t = build({ reserveThrows: err });
    await expect(t.controller.create(body(), USER, WS)).rejects.toBe(err);
  });

  it('no free slot within the wait → 503 engine_busy, and the preamble never holds a slot', async () => {
    const t = build();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    (t.controller as unknown as { slots: OpSemaphore }).slots = new OpSemaphore(1, 20);
    t.ledger.reserve.mockImplementationOnce(async () => {
      await held;
      return { outcome: 'mismatch' };
    });
    const first = statusOf(t.controller.create(body(), USER, WS));
    await new Promise((r) => setTimeout(r, 5));
    const second = await statusOf(t.controller.create(body({ idempotencyKey: 'key-2' }), USER, WS));
    expect(second).toEqual({ status: 503, body: { message: expect.any(String), code: 'engine_busy' } });
    release();
    expect((await first).status).toBe(409);
  });
});
