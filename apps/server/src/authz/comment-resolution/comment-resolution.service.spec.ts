import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  RequestMethod,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

// The service takes CollaborationGateway as a constructor TYPE, but Nest emits its runtime require for DI
// metadata, which pulls in the collab WebSocket stack (lib0 ESM) jest cannot parse. Stub the module.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { QueueJob } from '../../integrations/queue/constants';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';
import { CommentResolutionService } from './comment-resolution.service';
import { CommentResolutionController } from './comment-resolution.controller';
import { ResolveCommentDto } from './dto';

/**
 * CCC authorization integration test — comment resolve / reopen (#615).
 *
 * What these pin, in order of importance:
 *   1. the check ORDER: the page (one 404) → the fork's own `validateCanComment` (403) → the comment belongs
 *      to that page (the SAME 404) → top-level only (400). A caller who may not comment on a page learns
 *      nothing about which comment ids exist, and a caller who may learns nothing about other pages' comments;
 *   2. an already-applied state is a true no-op: no write, no mark, no event, no notification, no audit;
 *   3. the write is a compare-and-set, so a lost race emits nothing;
 *   4. the side effects: the highlight mark only for an inline comment and never fatal, the full row on the
 *      socket, the resolved notification on resolve only, one audit event per transition.
 * The compare-and-set SQL runs against real Postgres in comment-resolution.pg.spec.ts.
 */
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const COMMENT_ID = '22222222-2222-4222-8222-222222222222';
const WS_ID = '33333333-3333-4333-8333-333333333333';
const SPACE_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const AUTHOR_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_ID = '77777777-7777-4777-8777-777777777777';

const USER = { id: USER_ID, name: 'Resolver' } as never;
const WORKSPACE = { id: WS_ID } as never;

const PAGE = {
  id: PAGE_ID,
  slugId: 'abc123',
  spaceId: SPACE_ID,
  workspaceId: WS_ID,
  deletedAt: null,
};

const OPEN_COMMENT = {
  id: COMMENT_ID,
  pageId: PAGE_ID,
  workspaceId: WS_ID,
  spaceId: SPACE_ID,
  parentCommentId: null,
  type: 'page',
  creatorId: AUTHOR_ID,
  deletedAt: null,
  resolvedAt: null,
  resolvedById: null,
  creator: { id: AUTHOR_ID, name: 'Author', avatarUrl: null },
  resolvedBy: null,
};

const RESOLVED_COMMENT = {
  ...OPEN_COMMENT,
  resolvedAt: new Date('2026-09-20T10:00:00Z'),
  resolvedById: USER_ID,
  resolvedBy: { id: USER_ID, name: 'Resolver', avatarUrl: null },
};

const dto = (over: Partial<ResolveCommentDto> = {}): ResolveCommentDto => ({
  commentId: COMMENT_ID,
  pageId: PAGE_ID,
  resolved: true,
  ...over,
});

const build = (
  opts: {
    page?: unknown;
    canComment?: boolean;
    /** The row the first read returns (before the write). */
    comment?: unknown;
    /** The rows later reads return, in order (the re-read after the write, or after a lost race). */
    rereads?: unknown[];
    /** Whether the compare-and-set wins (returns the id). Default true. */
    casWins?: boolean;
    markThrows?: boolean;
    wsRejects?: boolean;
    queueRejects?: boolean;
  } = {},
) => {
  const calls: string[] = [];
  const pageRepo = {
    findById: jest.fn(async () => {
      calls.push('page');
      return 'page' in opts ? opts.page : PAGE;
    }),
  };
  const pageAccessService = {
    validateCanComment: jest.fn(async () => {
      calls.push('validateCanComment');
      if (opts.canComment === false) throw new ForbiddenException();
    }),
  };
  const first = 'comment' in opts ? opts.comment : OPEN_COMMENT;
  const rereads = [...(opts.rereads ?? [])];
  let reads = 0;
  const commentRepo = {
    findById: jest.fn(async () => {
      calls.push('readComment');
      reads += 1;
      return reads === 1 ? first : rereads.shift();
    }),
  };
  const spy = spyKysely((q: SpyQuery) => {
    calls.push('update');
    return opts.casWins === false ? [] : [{ id: COMMENT_ID }];
  });
  const gateway = {
    handleYjsEvent: jest.fn(async () => {
      calls.push('mark');
      if (opts.markThrows) throw new Error('collab node unavailable');
      return undefined;
    }),
  };
  const wsService = {
    emitCommentEvent: jest.fn(async () => {
      calls.push('ws');
      if (opts.wsRejects) throw new Error('redis down');
    }),
  };
  const notificationQueue = {
    add: jest.fn(async () => {
      calls.push('notify');
      if (opts.queueRejects) throw new Error('queue down');
    }),
  };
  const auditService = {
    log: jest.fn(() => {
      calls.push('audit');
    }),
  };
  const svc = new CommentResolutionService(
    spy.db,
    pageRepo as never,
    commentRepo as never,
    pageAccessService as never,
    gateway as never,
    wsService as never,
    notificationQueue as never,
    auditService as never,
  );
  return {
    svc,
    calls,
    spy,
    pageRepo,
    pageAccessService,
    commentRepo,
    gateway,
    wsService,
    notificationQueue,
    auditService,
  };
};

/** Runs the call and returns what it threw (fails the test if it did not throw). */
const thrown = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the call to throw');
};

const SIDE_EFFECTS = ['update', 'mark', 'ws', 'notify', 'audit'];
const noSideEffects = (calls: string[]) =>
  expect(calls.filter((c) => SIDE_EFFECTS.includes(c))).toEqual([]);

describe('CommentResolutionService.setResolved — the page (step 1: one 404)', () => {
  it.each([
    ['the page does not exist', undefined],
    // findById resolves a slug too: a row whose id differs from the requested id is not "this page".
    ['the id resolved to a different page (slug-shaped lookup)', { ...PAGE, id: OTHER_ID }],
    ['the page is in another workspace', { ...PAGE, workspaceId: OTHER_ID }],
    ['the page is trashed', { ...PAGE, deletedAt: new Date() }],
  ])('%s → 404 before any permission check or comment read', async (_label, page) => {
    const t = build({ page });
    const err = await thrown(t.svc.setResolved(dto(), USER, WORKSPACE));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('comment not found');
    expect(t.pageAccessService.validateCanComment).not.toHaveBeenCalled();
    expect(t.commentRepo.findById).not.toHaveBeenCalled();
    noSideEffects(t.calls);
  });

  it('accepts the page id in upper case (Postgres matches a UUID in any case)', async () => {
    const t = build({ rereads: [RESOLVED_COMMENT] });
    await expect(
      t.svc.setResolved(dto({ pageId: PAGE_ID.toUpperCase() }), USER, WORKSPACE),
    ).resolves.toBe(RESOLVED_COMMENT);
  });
});

describe('CommentResolutionService.setResolved — the permission check (step 2)', () => {
  it('re-runs validateCanComment with the page, the user and the caller workspace', async () => {
    const t = build({ rereads: [RESOLVED_COMMENT] });
    await t.svc.setResolved(dto(), USER, WORKSPACE);
    expect(t.pageAccessService.validateCanComment).toHaveBeenCalledWith(PAGE, USER, WS_ID);
  });

  it('a caller who may not comment gets 403 BEFORE the comment is looked up (no comment-id oracle)', async () => {
    const t = build({ canComment: false });
    const err = await thrown(t.svc.setResolved(dto(), USER, WORKSPACE));
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(t.commentRepo.findById).not.toHaveBeenCalled();
    noSideEffects(t.calls);
  });

  it('runs in order: page → permission → comment', async () => {
    const t = build({ rereads: [RESOLVED_COMMENT] });
    await t.svc.setResolved(dto(), USER, WORKSPACE);
    expect(t.calls.slice(0, 3)).toEqual(['page', 'validateCanComment', 'readComment']);
  });
});

describe('CommentResolutionService.setResolved — the comment (steps 3–4)', () => {
  it.each([
    ['the comment does not exist', undefined],
    ['the comment is on another page', { ...OPEN_COMMENT, pageId: OTHER_ID }],
    ['the comment is in another workspace', { ...OPEN_COMMENT, workspaceId: OTHER_ID }],
    ['the comment is deleted', { ...OPEN_COMMENT, deletedAt: new Date() }],
  ])('%s → the SAME 404 as a missing page', async (_label, comment) => {
    const pageMissing = await thrown(build({ page: undefined }).svc.setResolved(dto(), USER, WORKSPACE));
    const t = build({ comment });
    const err = await thrown(t.svc.setResolved(dto(), USER, WORKSPACE));
    expect(err).toBeInstanceOf(NotFoundException);
    // Indistinguishable on the wire: same class, same status, same body.
    expect((err as NotFoundException).getResponse()).toEqual(
      (pageMissing as NotFoundException).getResponse(),
    );
    noSideEffects(t.calls);
  });

  it('a reply → 400, nothing written', async () => {
    const t = build({ comment: { ...OPEN_COMMENT, parentCommentId: OTHER_ID } });
    const err = await thrown(t.svc.setResolved(dto(), USER, WORKSPACE));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe("only a thread's first comment can be resolved");
    noSideEffects(t.calls);
  });
});

describe('CommentResolutionService.setResolved — already in the requested state (step 5)', () => {
  it('resolving a resolved thread returns the row unchanged with zero side effects', async () => {
    const t = build({ comment: RESOLVED_COMMENT });
    await expect(t.svc.setResolved(dto({ resolved: true }), USER, WORKSPACE)).resolves.toBe(
      RESOLVED_COMMENT,
    );
    noSideEffects(t.calls);
    expect(t.spy.calls).toEqual([]);
  });

  it('reopening an open inline thread returns the row unchanged with zero side effects', async () => {
    const open = { ...OPEN_COMMENT, type: 'inline' };
    const t = build({ comment: open });
    await expect(t.svc.setResolved(dto({ resolved: false }), USER, WORKSPACE)).resolves.toBe(open);
    noSideEffects(t.calls);
    expect(t.spy.calls).toEqual([]);
  });
});

describe('CommentResolutionService.setResolved — the write', () => {
  it('resolve is a compare-and-set on an OPEN row, pinned to the comment, page and workspace', async () => {
    const t = build({ rereads: [RESOLVED_COMMENT] });
    await t.svc.setResolved(dto(), USER, WORKSPACE);
    expect(t.spy.calls).toHaveLength(1);
    const { sql, parameters } = t.spy.calls[0];
    expect(sql).toMatch(/^update "comments" set "resolved_at" = \$1, "resolved_by_id" = \$2, "updated_at" = \$3/);
    expect(sql).toContain(
      'where "id" = $4 and "page_id" = $5 and "workspace_id" = $6 and "deleted_at" is null and "resolved_at" is null',
    );
    expect(sql).toContain('returning "id"');
    expect(parameters[0]).toBeInstanceOf(Date);
    expect(parameters.slice(1)).toEqual([USER_ID, parameters[2], COMMENT_ID, PAGE_ID, WS_ID]);
  });

  it('reopen clears resolvedAt/resolvedById and only matches a RESOLVED row', async () => {
    const t = build({ comment: RESOLVED_COMMENT, rereads: [OPEN_COMMENT] });
    await t.svc.setResolved(dto({ resolved: false }), USER, WORKSPACE);
    const { sql, parameters } = t.spy.calls[0];
    expect(sql).toMatch(/^update "comments" set "resolved_at" = \$1, "resolved_by_id" = \$2, "updated_at" = \$3/);
    expect(sql).toContain('"resolved_at" is not null');
    expect(parameters.slice(0, 2)).toEqual([null, null]);
  });

  it('a lost compare-and-set returns the current row and emits NOTHING (the winner did)', async () => {
    const t = build({ casWins: false, rereads: [RESOLVED_COMMENT] });
    await expect(t.svc.setResolved(dto(), USER, WORKSPACE)).resolves.toBe(RESOLVED_COMMENT);
    expect(t.calls.filter((c) => ['mark', 'ws', 'notify', 'audit'].includes(c))).toEqual([]);
  });

  it('a lost compare-and-set on a comment deleted in between → 404', async () => {
    const t = build({ casWins: false, rereads: [undefined] });
    const err = await thrown(t.svc.setResolved(dto(), USER, WORKSPACE));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(t.calls.filter((c) => ['mark', 'ws', 'notify', 'audit'].includes(c))).toEqual([]);
  });
});

describe('CommentResolutionService.setResolved — side effects', () => {
  it('resolve a page comment: no mark; full row on the socket; notification; audit; returns the re-read row', async () => {
    const t = build({ rereads: [RESOLVED_COMMENT] });
    const out = await t.svc.setResolved(dto(), USER, WORKSPACE);

    expect(out).toBe(RESOLVED_COMMENT);
    expect(t.calls).toEqual([
      'page',
      'validateCanComment',
      'readComment',
      'update',
      'readComment',
      'ws',
      'notify',
      'audit',
    ]);
    expect(t.gateway.handleYjsEvent).not.toHaveBeenCalled();
    expect(t.commentRepo.findById).toHaveBeenLastCalledWith(COMMENT_ID, {
      includeCreator: true,
      includeResolvedBy: true,
    });
    expect(t.wsService.emitCommentEvent).toHaveBeenCalledWith(SPACE_ID, PAGE_ID, {
      operation: 'commentResolved',
      pageId: PAGE_ID,
      comment: RESOLVED_COMMENT,
    });
    expect(t.notificationQueue.add).toHaveBeenCalledWith(QueueJob.COMMENT_RESOLVED_NOTIFICATION, {
      commentId: COMMENT_ID,
      commentCreatorId: AUTHOR_ID,
      pageId: PAGE_ID,
      spaceId: SPACE_ID,
      workspaceId: WS_ID,
      actorId: USER_ID,
    });
    expect(t.auditService.log).toHaveBeenCalledTimes(1);
    expect(t.auditService.log).toHaveBeenCalledWith({
      event: 'comment.resolved',
      resourceType: 'comment',
      resourceId: COMMENT_ID,
      spaceId: SPACE_ID,
      metadata: { pageId: PAGE_ID },
    });
  });

  it('resolve an inline comment: the mark is updated after the write and before the socket event', async () => {
    const inline = { ...OPEN_COMMENT, type: 'inline' };
    const t = build({ comment: inline, rereads: [{ ...RESOLVED_COMMENT, type: 'inline' }] });
    await t.svc.setResolved(dto(), USER, WORKSPACE);
    expect(t.gateway.handleYjsEvent).toHaveBeenCalledWith('resolveCommentMark', `page.${PAGE_ID}`, {
      commentId: COMMENT_ID,
      resolved: true,
      user: USER,
    });
    expect(t.calls.slice(3)).toEqual(['update', 'mark', 'readComment', 'ws', 'notify', 'audit']);
  });

  it('reopen an inline comment: mark resolved=false; NO notification; audit comment.reopened', async () => {
    const inline = { ...RESOLVED_COMMENT, type: 'inline' };
    const t = build({ comment: inline, rereads: [{ ...OPEN_COMMENT, type: 'inline' }] });
    await t.svc.setResolved(dto({ resolved: false }), USER, WORKSPACE);
    expect(t.gateway.handleYjsEvent).toHaveBeenCalledWith('resolveCommentMark', `page.${PAGE_ID}`, {
      commentId: COMMENT_ID,
      resolved: false,
      user: USER,
    });
    expect(t.notificationQueue.add).not.toHaveBeenCalled();
    expect(t.wsService.emitCommentEvent).toHaveBeenCalledTimes(1);
    expect(t.auditService.log).toHaveBeenCalledWith({
      event: 'comment.reopened',
      resourceType: 'comment',
      resourceId: COMMENT_ID,
      spaceId: SPACE_ID,
      metadata: { pageId: PAGE_ID },
    });
  });

  it('reopen a page comment: no mark, no notification', async () => {
    const t = build({ comment: RESOLVED_COMMENT, rereads: [OPEN_COMMENT] });
    await expect(t.svc.setResolved(dto({ resolved: false }), USER, WORKSPACE)).resolves.toBe(OPEN_COMMENT);
    expect(t.gateway.handleYjsEvent).not.toHaveBeenCalled();
    expect(t.notificationQueue.add).not.toHaveBeenCalled();
  });

  it('a failed mark update is tolerated: the resolution is saved and every later side effect still runs', async () => {
    const t = build({
      comment: { ...OPEN_COMMENT, type: 'inline' },
      rereads: [RESOLVED_COMMENT],
      markThrows: true,
    });
    await expect(t.svc.setResolved(dto(), USER, WORKSPACE)).resolves.toBe(RESOLVED_COMMENT);
    expect(t.calls.slice(3)).toEqual(['update', 'mark', 'readComment', 'ws', 'notify', 'audit']);
  });

  it('a failed socket emit or notification enqueue never fails the request, and the audit still runs', async () => {
    const t = build({ rereads: [RESOLVED_COMMENT], wsRejects: true, queueRejects: true });
    await expect(t.svc.setResolved(dto(), USER, WORKSPACE)).resolves.toBe(RESOLVED_COMMENT);
    expect(t.auditService.log).toHaveBeenCalledTimes(1);
    // Let the swallowed rejections settle (an unhandled one would fail the run).
    await new Promise((r) => setImmediate(r));
  });

  it('a thread whose author was removed resolves and audits, with nobody to notify', async () => {
    const t = build({
      comment: { ...OPEN_COMMENT, creatorId: null, creator: null },
      rereads: [{ ...RESOLVED_COMMENT, creatorId: null, creator: null }],
    });
    await t.svc.setResolved(dto(), USER, WORKSPACE);
    expect(t.notificationQueue.add).not.toHaveBeenCalled();
    expect(t.auditService.log).toHaveBeenCalledTimes(1);
  });

  it('a comment deleted right after the write: still notified and audited, no socket event, then 404', async () => {
    const t = build({ rereads: [undefined] });
    const err = await thrown(t.svc.setResolved(dto(), USER, WORKSPACE));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(t.wsService.emitCommentEvent).not.toHaveBeenCalled();
    expect(t.notificationQueue.add).toHaveBeenCalledTimes(1);
    expect(t.auditService.log).toHaveBeenCalledTimes(1);
  });
});

describe('ResolveCommentDto', () => {
  const errorsFor = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(ResolveCommentDto, body))).map((e) => e.property);

  it('accepts two UUIDs and a boolean', async () => {
    expect(await errorsFor({ commentId: COMMENT_ID, pageId: PAGE_ID, resolved: true })).toEqual([]);
    expect(await errorsFor({ commentId: COMMENT_ID, pageId: PAGE_ID, resolved: false })).toEqual([]);
  });

  it('refuses a slug page id, a non-UUID comment id, and a missing or non-boolean `resolved`', async () => {
    expect(await errorsFor({ commentId: COMMENT_ID, pageId: 'abc123', resolved: true })).toEqual(['pageId']);
    expect(await errorsFor({ commentId: 'c1', pageId: PAGE_ID, resolved: true })).toEqual(['commentId']);
    expect(await errorsFor({ commentId: COMMENT_ID, pageId: PAGE_ID })).toEqual(['resolved']);
    expect(await errorsFor({ commentId: COMMENT_ID, pageId: PAGE_ID, resolved: 'false' })).toEqual([
      'resolved',
    ]);
  });
});

describe('CommentResolutionController', () => {
  it('is POST /comments/resolve, 200, behind JwtAuthGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CommentResolutionController)).toContain(JwtAuthGuard);
    expect(Reflect.getMetadata(PATH_METADATA, CommentResolutionController)).toBe('comments');
    const handler = CommentResolutionController.prototype.resolve;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('resolve');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(HttpStatus.OK);
  });

  it('delegates to the service with the body, the user and the workspace', async () => {
    const service = { setResolved: jest.fn(async () => RESOLVED_COMMENT) };
    const controller = new CommentResolutionController(service as never);
    await expect(controller.resolve(dto(), USER, WORKSPACE)).resolves.toBe(RESOLVED_COMMENT);
    expect(service.setResolved).toHaveBeenCalledWith(dto(), USER, WORKSPACE);
  });
});
