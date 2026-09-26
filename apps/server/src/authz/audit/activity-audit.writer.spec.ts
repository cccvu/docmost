import { SpyQuery, spyKysely } from '../../service-bridge/kysely-spy.testkit';
import { AUDIT_CONTEXT_KEY } from '../../common/middlewares/audit-context.middleware';
import { AuditLogPayload } from '../../common/events/audit-events';
import { ACTIVITY_AUDIT_TYPES } from '../../service-bridge/dto/content-activity.dto';
import {
  ACTIVITY_AUDIT_EVENTS,
  ActivityAuditWriter,
  DEFAULT_AUDIT_RETENTION_DAYS,
  StandaloneAuditService,
  auditRetentionDays,
  toActivityAuditRow,
} from './activity-audit.writer';

/**
 * CCC activity persistence (#615) — unit half. The allowlist, every skip rule and the comment `pageId`
 * normalization are pinned on the pure mapper; the writer's fire-and-forget posture (never throws, never
 * rejects, one INSERT for the allowlisted subset only) on a compiling Kysely spy. What lands in a real
 * `audit` table, and the retention prune, are proven in activity-audit.writer.pg.spec.ts.
 */
const WS = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const PAGE = '33333333-3333-4333-8333-333333333333';
const SPACE = '44444444-4444-4444-8444-444444444444';
const COMMENT = '55555555-5555-4555-8555-555555555555';
const PAGE_V7 = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b'; // Docmost ids are uuidv7

const ctx = { workspaceId: WS, actorId: ACTOR, actorType: 'user', ipAddress: '10.0.0.1', userAgent: 'jest' };

const pageEvent = (event: string, over: Partial<AuditLogPayload> = {}): AuditLogPayload =>
  ({ event, resourceType: 'page', resourceId: PAGE, spaceId: SPACE, ...over }) as AuditLogPayload;
const commentEvent = (event: string, over: Partial<AuditLogPayload> = {}): AuditLogPayload =>
  ({ event, resourceType: 'comment', resourceId: COMMENT, spaceId: SPACE, metadata: { pageId: PAGE }, ...over }) as AuditLogPayload;

describe('toActivityAuditRow (allowlist + skip rules)', () => {
  it('the allowlist is exactly the six lifecycle events the activity feed reads', () => {
    expect([...ACTIVITY_AUDIT_EVENTS].sort()).toEqual(
      [
        'comment.deleted',
        'comment.reopened',
        'comment.resolved',
        'page.moved_to_space',
        'page.restored',
        'page.trashed',
      ].sort(),
    );
  });

  it('writer and reader agree: the events persisted are exactly the ones activity/list reads', () => {
    // A drift here silently drops a lifecycle event from the feed (written, never read) or reads one never written.
    expect([...ACTIVITY_AUDIT_EVENTS].sort()).toEqual([...ACTIVITY_AUDIT_TYPES].sort());
  });

  it.each(['page.trashed', 'page.restored', 'page.moved_to_space'])('%s → a page row with no metadata', (event) => {
    expect(toActivityAuditRow(pageEvent(event, { metadata: { title: 'Secret plans' } }), ctx)).toEqual({
      workspaceId: WS,
      actorId: ACTOR,
      actorType: 'user',
      event,
      resourceType: 'page',
      resourceId: PAGE,
      spaceId: SPACE,
      metadata: null,
    });
  });

  it.each(['comment.deleted', 'comment.resolved', 'comment.reopened'])('%s → a comment row carrying {pageId}', (event) => {
    expect(toActivityAuditRow(commentEvent(event), ctx)).toEqual({
      workspaceId: WS,
      actorId: ACTOR,
      actorType: 'user',
      event,
      resourceType: 'comment',
      resourceId: COMMENT,
      spaceId: SPACE,
      metadata: { pageId: PAGE },
    });
  });

  it.each([
    'page.created',
    'page.deleted', // a permanent delete: the page is no longer authorizable, so the feed never shows it
    'page.duplicated',
    'page.restricted',
    'comment.created', // the feed reads creates from the comments table itself
    'comment.updated',
    'user.login',
    'workspace.retention_updated',
    'constructor', // a Map lookup, never an object-prototype key
  ])('skips a non-allowlisted event (%s)', (event) => {
    expect(toActivityAuditRow(pageEvent(event), ctx)).toBeNull();
    expect(toActivityAuditRow(commentEvent(event), ctx)).toBeNull();
  });

  it('skips an allowlisted event whose resource type is not the one its emitter sends', () => {
    expect(toActivityAuditRow(pageEvent('page.trashed', { resourceType: 'comment' as never }), ctx)).toBeNull();
    expect(toActivityAuditRow(commentEvent('comment.resolved', { resourceType: 'page' as never }), ctx)).toBeNull();
  });

  describe('comment pageId normalization', () => {
    it('reads metadata.pageId (the fork resolve/reopen emitter)', () => {
      expect(toActivityAuditRow(commentEvent('comment.resolved'), ctx).metadata).toEqual({ pageId: PAGE });
    });

    it('falls back to changes.before.pageId (upstream comment delete)', () => {
      const p = commentEvent('comment.deleted', { metadata: undefined, changes: { before: { pageId: PAGE_V7, creatorId: ACTOR } } });
      expect(toActivityAuditRow(p, ctx).metadata).toEqual({ pageId: PAGE_V7 });
    });

    it('prefers metadata.pageId over changes.before.pageId', () => {
      const p = commentEvent('comment.deleted', { changes: { before: { pageId: PAGE_V7 } } });
      expect(toActivityAuditRow(p, ctx).metadata).toEqual({ pageId: PAGE });
    });

    it('keeps ONLY pageId from the metadata', () => {
      const p = commentEvent('comment.resolved', { metadata: { pageId: PAGE, title: 'x', body: { type: 'doc' } } });
      expect(toActivityAuditRow(p, ctx).metadata).toEqual({ pageId: PAGE });
    });

    it.each([
      ['no page id anywhere', { metadata: undefined, changes: undefined }],
      ['an empty metadata object', { metadata: {}, changes: { before: {} } }],
      ['a non-uuid page id', { metadata: { pageId: 'not-a-uuid' } }],
      ['a non-string page id', { metadata: { pageId: 42 } }],
    ])('skips a comment event with %s', (_name, over) => {
      expect(toActivityAuditRow(commentEvent('comment.deleted', over as Partial<AuditLogPayload>), ctx)).toBeNull();
    });
  });

  it.each([
    ['no context at all', undefined],
    ['a null workspace', { ...ctx, workspaceId: null }],
    ['a missing workspace', { actorId: ACTOR }],
    ['a non-uuid workspace', { ...ctx, workspaceId: 'default' }],
  ])('skips the row with %s — the tenant is never guessed', (_name, context) => {
    expect(toActivityAuditRow(pageEvent('page.trashed'), context as never)).toBeNull();
  });

  it.each([
    ['a missing resource id', { resourceId: undefined }],
    ['a non-uuid resource id', { resourceId: 'pg1' }],
  ])('skips the row with %s', (_name, over) => {
    expect(toActivityAuditRow(pageEvent('page.trashed', over), ctx)).toBeNull();
  });

  it('keeps the row but nulls an actor id that is not a uuid (or absent)', () => {
    expect(toActivityAuditRow(pageEvent('page.trashed'), { ...ctx, actorId: 'system' }).actorId).toBeNull();
    expect(toActivityAuditRow(pageEvent('page.trashed'), { workspaceId: WS }).actorId).toBeNull();
  });

  it('keeps a known actor type and defaults anything else to user', () => {
    expect(toActivityAuditRow(pageEvent('page.trashed'), { ...ctx, actorType: 'api_key' }).actorType).toBe('api_key');
    expect(toActivityAuditRow(pageEvent('page.trashed'), { ...ctx, actorType: 'system' }).actorType).toBe('system');
    expect(toActivityAuditRow(pageEvent('page.trashed'), { ...ctx, actorType: 'root' }).actorType).toBe('user');
    expect(toActivityAuditRow(pageEvent('page.trashed'), { workspaceId: WS }).actorType).toBe('user');
  });

  it('nulls a space id that is not a uuid instead of failing the insert', () => {
    expect(toActivityAuditRow(pageEvent('page.trashed', { spaceId: 'general' }), ctx).spaceId).toBeNull();
  });

  it('never carries the IP, user agent or changes, whatever the context and payload hold', () => {
    const row = toActivityAuditRow(
      pageEvent('page.moved_to_space', { changes: { before: { spaceId: SPACE }, after: { spaceId: WS } } }),
      ctx,
    ) as unknown as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ['actorId', 'actorType', 'event', 'metadata', 'resourceId', 'resourceType', 'spaceId', 'workspaceId'].sort(),
    );
  });
});

describe('auditRetentionDays', () => {
  it.each([
    [null, DEFAULT_AUDIT_RETENTION_DAYS],
    [undefined, DEFAULT_AUDIT_RETENTION_DAYS],
    [0, DEFAULT_AUDIT_RETENTION_DAYS],
    [-5, DEFAULT_AUDIT_RETENTION_DAYS],
    [1.5, DEFAULT_AUDIT_RETENTION_DAYS],
    ['abc', DEFAULT_AUDIT_RETENTION_DAYS],
    [30, 30],
    ['90', 90], // int8 read without the bigint parser
    [10_000_000, 36500], // clamped inside make_interval's int range
  ])('%p → %p', (input, expected) => {
    expect(auditRetentionDays(input)).toBe(expected);
  });
});

describe('ActivityAuditWriter.record (fire-and-forget)', () => {
  const inserts = (calls: SpyQuery[]) => calls.filter((c) => /^insert into "audit"/.test(c.sql));

  it('writes the allowlisted subset of a batch in ONE insert, and nothing else', async () => {
    const spy = spyKysely(() => []);
    const writer = new ActivityAuditWriter(spy.db);
    await writer.record(
      [pageEvent('page.created'), pageEvent('page.trashed'), commentEvent('comment.resolved'), pageEvent('user.login')],
      ctx,
    );
    const ins = inserts(spy.calls);
    expect(ins).toHaveLength(1);
    expect(ins[0].sql).toContain('"workspace_id"');
    expect(ins[0].sql).not.toContain('ip_address');
    expect(ins[0].sql).not.toContain('"changes"');
    expect(ins[0].parameters).toEqual(expect.arrayContaining(['page.trashed', 'comment.resolved']));
    expect(ins[0].parameters).not.toContain('page.created');
    expect(ins[0].parameters).not.toContain('10.0.0.1');
    expect(ins[0].parameters).not.toContain('jest');
  });

  it('issues no query when nothing is allowlisted', async () => {
    const spy = spyKysely(() => []);
    await new ActivityAuditWriter(spy.db).record([pageEvent('page.created'), pageEvent('page.deleted')], ctx);
    expect(spy.calls).toHaveLength(0);
  });

  it('never rejects, and logs the drop, when the insert fails', async () => {
    const spy = spyKysely(() => {
      throw new Error('insert or update on table "audit" violates foreign key constraint');
    });
    const writer = new ActivityAuditWriter(spy.db);
    const warn = jest.spyOn((writer as unknown as { logger: { warn: jest.Mock } }).logger, 'warn').mockImplementation();
    await expect(writer.record([pageEvent('page.trashed')], ctx)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('dropped 1 row(s)');
    warn.mockRestore();
  });

  it('never throws synchronously, even on a malformed batch', async () => {
    const spy = spyKysely(() => []);
    const writer = new ActivityAuditWriter(spy.db);
    jest.spyOn((writer as unknown as { logger: { warn: jest.Mock } }).logger, 'warn').mockImplementation();
    let p: Promise<void>;
    expect(() => {
      p = writer.record(null as never, ctx);
    }).not.toThrow();
    await expect(p).resolves.toBeUndefined();
    expect(spy.calls).toHaveLength(0);
  });

  it('snapshots the context at call time (a later CLS mutation does not rewrite the row)', async () => {
    const spy = spyKysely(() => []);
    const live = { ...ctx };
    const p = new ActivityAuditWriter(spy.db).record([pageEvent('page.trashed')], live);
    // setActorId mutates the SAME CLS object in place; the row must already hold the actor it was logged with.
    live.actorId = '99999999-9999-4999-8999-999999999999';
    await p;
    expect(inserts(spy.calls)[0].parameters).toContain(ACTOR);
    expect(inserts(spy.calls)[0].parameters).not.toContain('99999999-9999-4999-8999-999999999999');
  });
});

describe('ActivityAuditWriter retention prune (posture)', () => {
  it('never rejects when the database is unreachable, and logs it', async () => {
    const spy = spyKysely(() => {
      throw new Error('connect ECONNREFUSED');
    });
    const writer = new ActivityAuditWriter(spy.db);
    const warn = jest.spyOn((writer as unknown as { logger: { warn: jest.Mock } }).logger, 'warn').mockImplementation();
    await expect(writer.pruneExpired()).resolves.toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('deletes ONLY allowlisted events, workspace-pinned, older than the retention, in a bounded batch', async () => {
    const spy = spyKysely((q) => (/from "workspaces"/.test(q.sql) ? [{ id: WS, auditRetentionDays: 30 }] : []));
    await new ActivityAuditWriter(spy.db).pruneExpired();
    const del = spy.calls.find((c) => /delete from audit/.test(c.sql));
    expect(del).toBeDefined();
    expect(del.sql).toMatch(/workspace_id = \$1::uuid/);
    expect(del.sql).toMatch(/event = any\(\$2::text\[\]\)/);
    expect(del.sql).toMatch(/make_interval\(days => \$3::int\)/);
    expect(del.sql).toMatch(/limit \$4/);
    expect(del.sql).toMatch(/for update skip locked/);
    expect(del.parameters[0]).toBe(WS);
    expect([...(del.parameters[1] as string[])].sort()).toEqual([...ACTIVITY_AUDIT_EVENTS].sort());
    expect(del.parameters[2]).toBe(30);
  });

  it('does not overlap itself: a second call while one is in flight is a no-op', async () => {
    let workspaceReads = 0;
    const spy = spyKysely((q) => {
      if (/from "workspaces"/.test(q.sql)) workspaceReads++;
      return [];
    });
    const writer = new ActivityAuditWriter(spy.db);
    const first = writer.pruneExpired(); // in flight until its first query resolves
    await expect(writer.pruneExpired()).resolves.toBe(0);
    await first;
    expect(workspaceReads).toBe(1);
    // …and the flag is released afterwards, so the next hourly tick runs.
    await writer.pruneExpired();
    expect(workspaceReads).toBe(2);
  });

  it('schedules an unref’d hourly timer on init and clears it on destroy', () => {
    const unref = jest.fn();
    const handle = { unref } as unknown as ReturnType<typeof setInterval>;
    const set = jest.spyOn(global, 'setInterval').mockReturnValue(handle as never);
    const clear = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
    const writer = new ActivityAuditWriter(spyKysely(() => []).db);
    writer.onModuleInit();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][1]).toBe(60 * 60 * 1000);
    expect(unref).toHaveBeenCalledTimes(1);
    writer.onModuleDestroy();
    expect(clear).toHaveBeenCalledWith(handle);
    set.mockRestore();
    clear.mockRestore();
  });
});

describe('StandaloneAuditService (native AUDIT_SERVICE)', () => {
  const makeWriter = () => ({ record: jest.fn(async () => undefined) });
  const makeCls = (c: unknown) => ({ get: jest.fn((key: string) => (key === AUDIT_CONTEXT_KEY ? c : undefined)), set: jest.fn() });

  it('log() records with the ambient CLS actor context (and nothing else from it)', () => {
    const writer = makeWriter();
    const svc = new StandaloneAuditService(makeCls({ ...ctx }) as never, writer as never);
    svc.log(pageEvent('page.trashed'));
    expect(writer.record).toHaveBeenCalledWith([pageEvent('page.trashed')], {
      workspaceId: WS,
      actorId: ACTOR,
      actorType: 'user',
    });
  });

  it('logWithContext / logBatchWithContext record with the explicit context', () => {
    const writer = makeWriter();
    const svc = new StandaloneAuditService(makeCls(undefined) as never, writer as never);
    const explicit = { workspaceId: WS, actorId: ACTOR, actorType: 'system' as const };
    svc.logWithContext(pageEvent('page.restored'), explicit);
    svc.logBatchWithContext([pageEvent('page.trashed'), commentEvent('comment.deleted')], explicit);
    expect(writer.record).toHaveBeenNthCalledWith(1, [pageEvent('page.restored')], explicit);
    expect(writer.record).toHaveBeenNthCalledWith(2, [pageEvent('page.trashed'), commentEvent('comment.deleted')], explicit);
  });

  it('never throws into the request path, even if the writer does', () => {
    const svc = new StandaloneAuditService(makeCls({ ...ctx }) as never, {
      record: () => {
        throw new Error('boom');
      },
    } as never);
    expect(() => svc.log(pageEvent('page.trashed'))).not.toThrow();
    const rejecting = new StandaloneAuditService(makeCls({ ...ctx }) as never, {
      record: () => Promise.reject(new Error('boom')),
    } as never);
    expect(() => rejecting.log(pageEvent('page.trashed'))).not.toThrow();
  });

  it('keeps the stock no-op actor setters (native behaviour unchanged)', () => {
    const cls = makeCls({ ...ctx });
    const svc = new StandaloneAuditService(cls as never, makeWriter() as never);
    svc.setActorId(ACTOR);
    svc.setActorType('api_key');
    expect(cls.set).not.toHaveBeenCalled();
  });
});
